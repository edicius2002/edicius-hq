begin;
select no_plan();
select has_table('airfare_retention_state');
select has_table('fare_departure_summaries');
select has_function('public','begin_airfare_retention',array['uuid','date']);
select is((select count(*) from jsonb_array_elements(public.airfare_dataset_manifest()) e where e->>'dataset'='retention'),1::bigint,'manifest includes retention state');
select ok(not has_function_privilege('authenticated','public.begin_airfare_retention(uuid,date)','execute'),'maintenance is service-only');
select ok(not has_table_privilege('service_role','public.fare_snapshots','delete'),'no general delete');
select throws_ok($$select public.begin_airfare_retention('00000000-0000-0000-0000-000000000001',current_date+1)$$,'22023','invalid_airfare_retention_cutoff','future cutoff rejected');
select lives_ok($$select public.begin_airfare_retention('00000000-0000-0000-0000-000000000001','2020-02-02')$$,'begin fences ingress');
select throws_ok($$select public.begin_airfare_retention('00000000-0000-0000-0000-000000000002','2020-02-01')$$,'22023','invalid_airfare_retention_cutoff','regression rejected');
select throws_ok($$select public.prune_airfare_departure('00000000-0000-0000-0000-000000000001','RET','DST','2020-01-01')$$,'55000','airfare_summary_required','unpublished departure cannot be pruned');
select throws_ok($$insert into public.fare_snapshots(record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,payload) values(repeat('9',64),'RET','DST','2020-01-01',now(),'2020-01-01T00:00:00Z',1,'test','USD','{"offers":[]}')$$,'22023','airfare_departure_expired','stale writer is fenced');
select throws_ok($$insert into public.fare_baseline_points(record_id,origin,destination,flight_date,price_date,price,currency,source,payload) values(repeat('8',64),'RET','DST','2020-01-01','2019-12-01',10,'USD','test','{}')$$,'22023','airfare_departure_expired','stale baseline is fenced');
select throws_ok($$insert into public.fare_checks(record_id,kind,origin,destination,flight_date,checked_at,outcome,payload) values(repeat('7',64),'board','RET','DST','2020-01-01',now(),'changed','{}')$$,'22023','airfare_departure_expired','stale board check is fenced');
select throws_ok($$insert into public.fare_calendar_captures(record_id,origin,destination,captured_at,source_line,from_date,to_date,source,currency,payload) values(repeat('6',64),'RET','DST',now(),1,'2020-01-01','2020-01-31','test','USD','{"prices":{"2020-01-01":10,"2020-01-31":20}}')$$,'22023','airfare_departure_expired','mixed stale calendar curve is fenced');
select lives_ok($$select public.finish_airfare_retention('00000000-0000-0000-0000-000000000001',public.airfare_dataset_manifest())$$,'verified empty run closes');
select throws_ok($$select public.prune_airfare_departure('00000000-0000-0000-0000-000000000001','RET','DST','2020-01-01')$$,'P0001','invalid_airfare_retention_partition','finished run cannot prune');
select throws_ok($$select public.publish_airfare_departure_summary('00000000-0000-0000-0000-000000000001','{}','')$$,'P0001','invalid_airfare_retention_partition','finished run cannot publish');
select * from finish();
rollback;
-- Exact mixed-month equivalence, including repeated prices and no-offer captures.
begin;
select no_plan();
insert into public.fare_snapshots(record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
select lpad(i::text,64,'0'),'RET','DST',case when i<=2 then date '2020-01-01' else date '2020-01-31' end,
 ('2019-12-01T0'||i||':00:00Z')::timestamptz,'2019-12-01T0'||i||':00:00Z',i,'test','USD',case when i<=2 then 10 else 30 end,
 jsonb_build_object('offers','[]'::jsonb,'flightDate',case when i<=2 then '2020-01-01' else '2020-01-31' end)
from generate_series(1,4) i;
insert into public.fare_baseline_points(record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
values(repeat('b',64),'RET','DST','2020-01-01','2019-12-01',10,'USD','test','{}'),
(repeat('c',64),'RET','DST','2020-01-31','2019-12-01',30,'USD','test','{}');
insert into public.fare_checks(record_id,kind,origin,destination,flight_date,checked_at,outcome,payload)
values(repeat('d',64),'board','RET','DST','2020-01-01','2019-12-01T05:00:00Z','changed','{"at":"2019-12-01T05:00:00Z"}'),
(repeat('e',64),'calendar','RET','DST',null,'2019-12-01T05:00:00Z','changed','{"at":"2019-12-01T05:00:00Z"}');
select public.refresh_fare_month_projection('RET','DST','2020-01');
create temporary table expected as select payload - array['revision','latestBoards','currentBoards','departureChecks','viaSequences','retention'] as historical from public.fare_month_projections where origin='RET';
create temporary table future_rows as select * from public.fare_snapshots where origin='RET' and flight_date='2020-01-31';
select public.begin_airfare_retention('00000000-0000-0000-0000-000000000003','2020-01-02');
create temporary table partition as select '{"version":1,"origin":"RET","destination":"DST","flight_date":"2020-01-01","price_days":{"2019-12-01":[["10",2]]},"provider_days":{"2019-12-01":[["10",1]]},"unsold_days":{},"minimum_price":"10","latest_capture":"2019-12-01T02:00:00Z","health":{"checks":1,"changes":1,"errors":0,"last_checked_at":"2019-12-01T05:00:00Z"}}'::jsonb payload;
select public.publish_airfare_departure_summary('00000000-0000-0000-0000-000000000003',payload,encode(sha256(convert_to(public.airfare_canonical_json(payload),'UTF8')),'hex')) from partition;
select public.publish_airfare_departure_summary('00000000-0000-0000-0000-000000000003',payload,encode(sha256(convert_to(public.airfare_canonical_json(payload),'UTF8')),'hex')) from partition;
select public.prune_airfare_departure('00000000-0000-0000-0000-000000000003','RET','DST','2020-01-01');
select public.prune_airfare_departure('00000000-0000-0000-0000-000000000003','RET','DST','2020-01-01');
select public.refresh_fare_route_projection('RET','DST');
select is((select payload - array['revision','latestBoards','currentBoards','departureChecks','viaSequences','retention'] from public.fare_month_projections where origin='RET'),(select historical from expected),'all historical values survive exact compaction');
select is((select (payload#>>'{priceDays,0,middle}')::numeric from public.fare_month_projections where origin='RET'),20::numeric,'weighted even median');
select is((select count(*) from public.fare_checks where origin='RET' and kind='calendar'),1::bigint,'calendar health survives');
select is((select jsonb_agg(to_jsonb(s) order by record_id) from public.fare_snapshots s where origin='RET' and flight_date='2020-01-31'),(select jsonb_agg(to_jsonb(s) order by record_id) from future_rows s),'future rows remain byte-equivalent');
select is((public.read_airfare_history_meta('RET','DST','2020-01',array['2020-01'],null,null)#>>'{priceDays,0,middle}')::numeric,20::numeric,'history fallback keeps the exact mixed median');
select lives_ok($$select public.finish_airfare_retention('00000000-0000-0000-0000-000000000003',public.airfare_dataset_manifest())$$,'mixed retention run verifies');
select is(public.read_airfare_history_meta('RET','DST','2020-01',array['2020-01'],null,null)#>>'{retention,detailExpired}','false','mixed month keeps future detail');
select * from finish();
rollback;
