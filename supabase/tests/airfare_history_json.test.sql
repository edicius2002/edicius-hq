begin;
select plan(10);

set local role service_role;
-- Equal timestamps and source positions still use record_id as the final tie
-- breaker. Payloads deliberately include values vulnerable to lossy conversion.
insert into public.fare_snapshots
  (record_id, source_line, origin, destination, flight_date, captured_at,
   captured_at_text, source, currency, cheapest_price, payload)
values
  (repeat('1', 64), 2, 'JSN', 'DST', '2026-11-01', '2026-09-19T00:00:00Z',
   '2026-09-19T00:00:00Z', 'test', 'USD', 12.5,
   '{"label":"third","offers":[{"price":12.50}],"nested":{"empty":[],"nil":null}}'),
  (repeat('3', 64), 1, 'JSN', 'DST', '2026-11-01', '2026-09-19T00:00:00Z',
   '2026-09-19T00:00:00Z', 'test', 'USD', 0,
   '{"label":"second","offers":[{"price":0}],"exact":9007199254740993.123456789}'),
  (repeat('2', 64), 1, 'JSN', 'DST', '2026-11-01', '2026-09-19T00:00:00Z',
   '2026-09-19T00:00:00Z', 'test', 'USD', null,
   '{"label":"first — Perú","offers":[{"price":null}],"text":"quote: \" slash: \\ newline: \n","bool":false}'),
  (repeat('4', 64), 3, 'JSN', 'DST', '2026-12-01', '2026-09-19T00:00:00Z',
   '2026-09-19T00:00:00Z', 'test', 'USD', 300,
   '{"label":"outside month","offers":[{"price":300}]}');

insert into public.fare_baseline_points
  (record_id, origin, destination, flight_date, price_date, price, currency, source, payload)
values
  (repeat('5',64), 'JSN','DST','2026-11-01','2026-09-02',120,'USD','test',
   '{"date":"2026-09-02","price":120,"extra":{"nil":null}}'),
  (repeat('6',64), 'JSN','DST','2026-11-01','2026-09-01',0,'USD','test',
   '{"date":"2026-09-01","price":0,"extra":{"empty":[]}}');
insert into public.fare_airports (code, latitude, longitude, payload)
values
  ('DST',0,0,'{"code":"DST","name":"Destination","optional":null}'),
  ('JSN',0,0,'{"code":"JSN","name":"Origen — Perú","extra":[]}');

create temporary table history_json_result as
select public.read_airfare_history('JSN', 'DST', '2026-11', array['2026-11'], null, null) as body;

select is(body, '{
  "origin":"JSN","destination":"DST",
  "snapshots":[
    {"label":"first — Perú","offers":[{"price":null}],"text":"quote: \" slash: \\ newline: \n","bool":false},
    {"label":"second","offers":[{"price":0}],"exact":9007199254740993.123456789},
    {"label":"third","offers":[{"price":12.50}],"nested":{"empty":[],"nil":null}}
  ],
  "baseline":[
    {"date":"2026-09-01","price":0,"extra":{"empty":[]}},
    {"date":"2026-09-02","price":120,"extra":{"nil":null}}
  ],
  "airports":[
    {"code":"JSN","name":"Origen — Perú","extra":[]},
    {"code":"DST","name":"Destination","optional":null}
  ],
  "health":{"lastCheckedAt":null,"checks":0,"changes":0,"errors":0},
  "pairReference":{"value":150,"dates":2}
}'::jsonb, 'complete JSON preserves order, precision, escaping, nulls, empty arrays and whole-pair reference')
from history_json_result;

select is(pg_typeof(body)::text, 'jsonb', 'RPC retains its JSONB return contract') from history_json_result;
select is(jsonb_array_length(public.read_airfare_history('JSN','DST',null,null,null,null)->'snapshots'),
  4, 'null months retains whole-route history');
select is(public.read_airfare_history('JSN','DST',null,array[]::text[],null,null)->'snapshots',
  '[]'::jsonb, 'empty month list is an empty snapshot array');
select is(public.read_airfare_history('JSN','DST','2026-11',array['2026-11','2026-11'],null,null),
  body, 'repeated months do not duplicate snapshots') from history_json_result;
select is(public.read_airfare_history('JSN','DST','2026-11',array['2026-11'],
  '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'), body,
  'equal observation bounds include the original timestamp') from history_json_result;
select is(public.read_airfare_history('JSN','DST','2026-11',array['2026-11'],
  '2026-09-20',null)->'snapshots', '[]'::jsonb, 'observation bounds still exclude older snapshots');
select is(public.read_airfare_history('NON','DST',null,null,null,null)->'pairReference',
  'null'::jsonb, 'missing route retains explicit null pair reference');

reset role;
select ok(not has_function_privilege('anon', 'public.read_airfare_history(text,text,text,text[],text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.read_airfare_history(text,text,text,text[],text,text)', 'execute')
  and has_function_privilege('service_role', 'public.read_airfare_history(text,text,text,text[],text,text)', 'execute'),
  'replacement preserves backend-only execution grants');
select ok(not prosecdef and provolatile = 's' and proconfig = array['search_path=""'],
  'replacement remains stable, security invoker and empty search path')
from pg_proc where oid = 'public.read_airfare_history(text,text,text,text[],text,text)'::regprocedure;

select * from finish();
rollback;
