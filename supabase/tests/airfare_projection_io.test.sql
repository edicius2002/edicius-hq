-- Local pgTAP ordering and physical-write regression. All changes roll back.
-- Full legacy/new output parity is exercised by the opt-in I/O benchmark.
begin;
set local search_path = public, extensions;
select plan(13);

insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,
   source_line,source,currency,cheapest_price,payload)
select repeat(id,64),'IOT','DST','2027-03-09',stamp::timestamptz,stamp,
  line,'test','USD',price,jsonb_build_object('offers',offers)
from (values
  ('a','2026-09-20T00:00:00Z',1,null::numeric,
   '[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":null,"label":"unpriced"}]'::jsonb),
  ('c','2026-09-20T01:00:00Z',1,100,
   '[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":100,"label":"first","extra":{"keep":true}},
     {"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":100,"label":"duplicate"},
     {"airline":"BB","departureAt":"2027-03-09T11:00","price":50}]'::jsonb),
  ('b','2026-09-20T01:00:00Z',2,90,
   '[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":90,"label":"middle"}]'::jsonb),
  ('d','2026-09-20T02:00:00Z',3,100,
   '[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":100,"label":"latest"}]'::jsonb)
) s(id,stamp,line,price,offers);

set local role service_role;
select public.refresh_fare_month_projection('IOT','DST','2027-03');
reset role;

select is((select payload->'priceDays' from public.fare_month_projections where origin='IOT'),
  '[{"key":"2026-09-20","low":90,"high":100,"middle":100,"count":3}]'::jsonb,
  'month aggregation preserves all priced snapshot minima');
select is((select count(*) from public.fare_flight_projections where origin='IOT'),2::bigint,
  'first refresh inserts both priced flights');
select is((select offer->>'label' from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  'first','first priced offer respects source line before record ID and then ordinality');
select is((select offer#>>'{extra,keep}' from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  'true','first priced offer retains its complete original JSON');
select is((select previous_price from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  90::numeric,'returning to an earlier price retains the preceding changed event');
select is((select sightings from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  4,'unpriced sightings count and duplicate offers do not double-count a snapshot');

create temporary table before_refresh as
select flight_key,ctid::text as row_version from public.fare_flight_projections where origin='IOT';
select public.refresh_fare_month_projection('IOT','DST','2027-03');
select results_eq(
  $$select flight_key,ctid::text from public.fare_flight_projections where origin='IOT' order by flight_key$$,
  $$select flight_key,row_version from before_refresh order by flight_key$$,
  'unchanged flight projections retain their physical rows');

-- Equal timestamps AND source positions leave record ID as the tie-breaker.
-- AA changes, BB stays identical, and CC is new in both tied observations.
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,
   source_line,source,currency,cheapest_price,payload)
select repeat(id,64),'IOT','DST','2027-03-09','2026-09-20T03:00:00Z',
  '2026-09-20T03:00:00Z',4,'test','USD',price,jsonb_build_object('offers',offers)
from (values
  ('e',110,'[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":110},
    {"airline":"CC","departureAt":"2027-03-09T13:00","price":30,"label":"record-e"}]'::jsonb),
  ('f',120,'[{"airline":"AA","flightNumber":"1","departureAt":"2027-03-09T10:00","price":120},
    {"airline":"CC","departureAt":"2027-03-09T13:00","price":40,"label":"record-f"}]'::jsonb)
) s(id,price,offers);
select public.refresh_fare_month_projection('IOT','DST','2027-03');
select is((select price from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  120::numeric,'a mixed refresh publishes changed prices');
select isnt((select ctid::text from public.fare_flight_projections where origin='IOT' and flight_key like 'AA|%'),
  (select row_version from before_refresh where flight_key like 'AA|%'),
  'a changed flight receives a new physical version');
select is((select ctid::text from public.fare_flight_projections where origin='IOT' and flight_key like 'BB|%'),
  (select row_version from before_refresh where flight_key like 'BB|%'),
  'an unchanged sibling retains its physical row during the same refresh');
select is((select jsonb_build_array(offer->>'label',first_price,previous_price,price)
  from public.fare_flight_projections where origin='IOT' and flight_key like 'CC|%'),
  '["record-e",30,30,40]'::jsonb,'record ID resolves equal time and source-line ties');

update public.fare_snapshots set payload=jsonb_set(payload,'{offers}',
  (select jsonb_agg(o) from jsonb_array_elements(payload->'offers') o where o->>'airline'='AA'))
where origin='IOT';
select public.refresh_fare_month_projection('IOT','DST','2027-03');
select is((select count(*) from public.fare_flight_projections where origin='IOT'),1::bigint,
  'a flight removed from all source snapshots is removed from the projection');
delete from public.fare_snapshots where origin='IOT';
select public.refresh_fare_month_projection('IOT','DST','2027-03');
select is((select count(*) from public.fare_flight_projections where origin='IOT'),0::bigint,
  'an empty replacement removes all obsolete flights');

select * from finish();
rollback;
