begin;
select plan(82);

select has_table('public'::name, 'fare_snapshots'::name);
select has_table('public'::name, 'fare_baseline_points'::name);
select has_table('public'::name, 'fare_calendar_captures'::name);
select has_table('public'::name, 'fare_checks'::name);
select has_table('public'::name, 'fare_airports'::name);
select has_table('public'::name, 'airfare_documents'::name);
select has_table('public'::name, 'airfare_import_runs'::name);

-- Catch missing keys/indexes and accidental exposure on every archive table.
select has_pk('public'::name, name::name) from unnest(array[
  'fare_snapshots', 'fare_baseline_points', 'fare_calendar_captures',
  'fare_checks', 'fare_airports', 'airfare_documents', 'airfare_import_runs'
]) as tables(name);

select has_index('public'::name, table_name::name, index_name::name)
from (values
  ('fare_snapshots', 'fare_snapshots_route_flight_capture_idx'),
  ('fare_snapshots', 'fare_snapshots_route_capture_idx'),
  ('fare_baseline_points', 'fare_baseline_route_flight_price_date_idx'),
  ('fare_calendar_captures', 'fare_calendar_route_capture_idx'),
  ('fare_checks', 'fare_checks_board_health_idx'),
  ('fare_checks', 'fare_checks_calendar_health_idx')
) as indexes(table_name, index_name);

select assertions.result
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral (values
       (ok(c.relrowsecurity, c.relname || ' has RLS')),
       (ok(not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
          c.relname || ' denies anon')),
       (ok(not has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
          c.relname || ' denies authenticated')),
       (ok(has_table_privilege('service_role', c.oid, 'SELECT')
          and has_table_privilege('service_role', c.oid, 'INSERT')
          and has_table_privilege('service_role', c.oid, 'UPDATE')
          and not has_table_privilege('service_role', c.oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'),
          c.relname || ' grants only sync/read operations'))
) as assertions(result)
where n.nspname = 'public' and c.relname = any(array[
  'fare_snapshots', 'fare_baseline_points', 'fare_calendar_captures',
  'fare_checks', 'fare_airports', 'airfare_documents', 'airfare_import_runs'
]);

select is(
  (select relrowsecurity from pg_class where oid = 'public.fare_snapshots'::regclass),
  true,
  'fare snapshots have RLS enabled'
);
select is(
  has_table_privilege('anon', 'public.fare_snapshots', 'select'),
  false,
  'anon cannot read fare snapshots'
);
select is(
  has_table_privilege('authenticated', 'public.fare_snapshots', 'select'),
  false,
  'authenticated cannot read fare snapshots'
);

select has_function('public'::name, 'read_airfare_history'::name);
select has_function('public'::name, 'read_airfare_calendar'::name);
select has_function('public'::name, 'airfare_dataset_manifest'::name);

select ok(not has_function_privilege('anon', p.oid, 'EXECUTE')
          and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and has_function_privilege('service_role', p.oid, 'EXECUTE'),
          p.proname || ' is callable only by the backend')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = any(array[
  'read_airfare_history', 'read_airfare_calendar', 'airfare_dataset_manifest'
]) order by p.proname;

-- Exercise the data path with the backend role, including its RLS bypass.
set local role service_role;

insert into public.fare_snapshots
  (record_id, origin, destination, flight_date, captured_at, captured_at_text,
   source, currency, cheapest_price, payload)
values
  (repeat('a', 64), 'AQP', 'LIM', '2027-03-01', '2026-09-01T00:00:00Z',
   '2026-09-01T00:00:00+00:00', 'google-flights', 'USD', 100,
   '{"capturedAt":"2026-09-01T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","flightDate":"2027-03-01","returnDate":null,"currency":"USD","insights":null,"offers":[{"price":150},{"price":100}]}'::jsonb),
  (repeat('b', 64), 'AQP', 'LIM', '2027-04-01', '2026-09-02T00:00:00Z',
   '2026-09-02T00:00:00+00:00', 'google-flights', 'USD', 300,
   '{"capturedAt":"2026-09-02T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","flightDate":"2027-04-01","returnDate":null,"currency":"USD","insights":null,"offers":[{"price":300}]}'::jsonb);

insert into public.fare_baseline_points
  (record_id, origin, destination, flight_date, price_date, price, currency, source, payload)
values
  (repeat('c', 64), 'AQP', 'LIM', '2027-03-01', '2026-09-01', 120, 'USD',
   'google-flights',
   '{"flightDate":"2027-03-01","date":"2026-09-01","price":120,"currency":"USD","source":"google-flights"}'::jsonb);

insert into public.fare_checks
  (record_id, kind, origin, destination, flight_date, checked_at, outcome, offers, payload)
values
  (repeat('d', 64), 'board', 'AQP', 'LIM', '2027-03-01',
   '2026-09-01T00:00:00Z', 'changed', 2,
   '{"at":"2026-09-01T00:00:00+00:00","flightDate":"2027-03-01","outcome":"changed","offers":2}'::jsonb);

insert into public.fare_airports
  (code, name, city, country, latitude, longitude, payload)
values
  ('AQP', 'Rodríguez Ballón', 'Arequipa', 'Peru', -16.3411, -71.5831,
   '{"code":"AQP","name":"Rodríguez Ballón","city":"Arequipa","country":"Peru","latitude":-16.3411,"longitude":-71.5831}'::jsonb);

insert into public.fare_calendar_captures
  (record_id, origin, destination, captured_at, from_date, to_date, source, currency, payload)
values
  (repeat('e', 64), 'AQP', 'LIM', '2026-09-01T00:00:00Z', '2026-10-01',
   '2027-09-01', 'google-flights', 'USD',
   '{"capturedAt":"2026-09-01T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","currency":"USD","from":"2026-10-01","to":"2027-09-01","prices":[{"departureDate":"2026-10-01","price":90},{"departureDate":"2026-10-02","price":80},{"departureDate":"2027-09-01","price":500}]}'::jsonb),
  (repeat('f', 64), 'AQP', 'LIM', '2026-09-02T00:00:00Z', '2026-10-02',
   '2027-03-01', 'google-flights', 'USD',
   '{"capturedAt":"2026-09-02T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","currency":"USD","from":"2026-10-02","to":"2027-03-01","prices":[{"departureDate":"2026-10-02","price":null},{"departureDate":"2027-03-01","price":400}]}'::jsonb);

create temporary table history_result as
select public.read_airfare_history(
  'AQP', 'LIM', '2027-03', array['2027-03'], null, null
) as body;

select is((body->'pairReference'->>'value')::numeric, 200::numeric,
          'pair reference is median of per-departure minima') from history_result;
select is((body->'pairReference'->>'dates')::integer, 2,
          'pair reference counts every priced departure') from history_result;
select is(jsonb_array_length(body->'snapshots'), 1,
          'snapshot month bounds the returned payload') from history_result;
select is(jsonb_array_length(body->'baseline'), 1,
          'departure prefix bounds baseline') from history_result;
select is((body->'health'->>'checks')::integer, 1,
          'health is aggregated from checks') from history_result;
select is(jsonb_array_length(body->'airports'), 1,
          'route airports are returned') from history_result;

create temporary table calendar_result as
select public.read_airfare_calendar('AQP', 'LIM') as body;

select is(body->'horizon'->>'fromDate', '2026-10-02',
          'newest curve supplies near boundary') from calendar_result;
select is(body->'horizon'->>'toDate', '2027-09-01',
          'furthest curve supplies far boundary') from calendar_result;
select is(
  (select point->>'observedAt'
   from calendar_result,
        jsonb_array_elements(body->'horizon'->'prices') point
   where point->>'departureDate' = '2027-09-01'),
  '2026-09-01T00:00:00+00:00',
  'inherited far price retains its observation time'
);
select ok(
  (select point ? 'price' and point->'price' = 'null'::jsonb
   from calendar_result,
        jsonb_array_elements(body->'horizon'->'prices') point
   where point->>'departureDate' = '2026-10-02'),
  'newer explicit null is not overwritten by an older fare'
);

select is((body->'health'->>'changes')::integer, 1, 'health counts changed checks') from history_result;
select is(body->'health'->>'lastCheckedAt', '2026-09-01T00:00:00+00:00', 'health retains source timestamp') from history_result;
select is(public.read_airfare_history('XXX', 'YYY', null, null, null, null)->'pairReference',
          'null'::jsonb, 'unpriced route has no pair reference');
select is(public.read_airfare_calendar('XXX', 'YYY')->'horizon',
          'null'::jsonb, 'uncaptured route has no horizon');
select is(jsonb_array_length(body->'horizon'->'prices'), 3,
          'departed dates are not resurrected') from calendar_result;
select is(body->'horizon'->>'capturedAt', '2026-09-02T00:00:00+00:00',
          'horizon timestamp describes freshest visible price') from calendar_result;
select is(jsonb_array_length(public.read_airfare_history(
  'AQP', 'LIM', null, array['2027-03','2027-04'], '2026-09-02', null
)->'snapshots'), 1, 'snapshot months union respects inclusive observation lower bound');
select is(jsonb_array_length(public.read_airfare_history(
  'AQP', 'LIM', null, null, null, '2026-09-01T00:00:00+00:00'
)->'snapshots'), 1, 'snapshot observation upper bound compares original timestamp text');
select is(jsonb_array_length(public.read_airfare_history(
  'AQP', 'LIM', '2027-04', null, null, null
)->'snapshots'), 2, 'departure prefix does not filter snapshots');

-- Manifest digests hash the sorted IDs joined by a newline, without a trailing newline.
select is((select (entry->>'count')::integer
           from jsonb_array_elements(public.airfare_dataset_manifest()) entry
           where entry->>'dataset' = 'snapshots' and entry->>'route' = 'AQP-LIM'),
          2, 'manifest counts unique snapshots');
select is((select entry->>'digest'
           from jsonb_array_elements(public.airfare_dataset_manifest()) entry
           where entry->>'dataset' = 'snapshots' and entry->>'route' = 'AQP-LIM'),
          encode(sha256(convert_to(repeat('a', 64) || chr(10) || repeat('b', 64), 'UTF8')), 'hex'),
          'manifest digests ordered record IDs');
select is(jsonb_array_length(public.airfare_dataset_manifest()), 4,
          'manifest groups snapshots, baseline, calendar and board checks');

update public.fare_calendar_captures
set payload = jsonb_set(payload, '{prices}', '{"2026-10-02":null,"2027-03-01":400}'::jsonb)
where record_id = repeat('f', 64);
select is(public.read_airfare_calendar('AQP', 'LIM'), (select body from calendar_result),
          'original date-to-price object payload yields the same horizon');

insert into public.fare_snapshots
  (record_id, origin, destination, flight_date, captured_at, captured_at_text,
   source, currency, cheapest_price, payload)
select repeat('1', 64), origin, destination, flight_date, captured_at,
       captured_at_text, source, currency, 900,
       jsonb_set(payload, '{offers}', '[{"price":900}]'::jsonb)
from public.fare_snapshots where record_id = repeat('a', 64);
select is(public.read_airfare_history('AQP', 'LIM', null, null, null, null)->'pairReference',
          '{"value":200,"dates":2}'::jsonb,
          'repeat observations do not weight the per-departure median');

-- A newer empty curve sets the boundary but does not claim older visible prices.
insert into public.fare_calendar_captures
  (record_id, origin, destination, captured_at, from_date, to_date, source, currency, payload)
values
  (repeat('2', 64), 'AQP', 'LIM', '2026-09-03T00:00:00Z', '2026-10-03',
   '2027-03-01', 'google-flights', 'USD',
   '{"capturedAt":"2026-09-03T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","currency":"USD","from":"2026-10-03","to":"2027-03-01","prices":{}}'::jsonb);
select is(public.read_airfare_calendar('AQP', 'LIM')->'horizon'->>'capturedAt',
          '2026-09-02T00:00:00+00:00', 'empty curve does not refresh inherited observation time');

select * from finish();
rollback;
