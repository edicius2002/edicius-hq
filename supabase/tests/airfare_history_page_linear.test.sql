begin;
select plan(7);

set local role service_role;
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,
   source,currency,cheapest_price,payload)
select lpad(to_hex(n + 100000),64,'0'),'SPD','DST',date '2026-11-01',
  timestamptz '2026-09-19' + n * interval '1 second',
  to_char(timestamptz '2026-09-19' + n * interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  n,'test','USD',n,jsonb_build_object('text',repeat(md5(n::text),100))
from generate_series(1,250) n;
reset role;

select performs_ok(format(
  'select public.read_airfare_history_page(''SPD'',''DST'',null,null,null,null,%L,''snapshots'',null,250)',
  revision::text
), 250, 'a near-limit 250-row page is assembled without quadratic serialization')
from public.airfare_history_revision;

create temporary table measured_page as
select public.read_airfare_history_page('SPD','DST',null,null,null,null,
  (select revision::text from public.airfare_history_revision),'snapshots',null,250) body;
select is(jsonb_array_length(body->'items'),250,'the fast path preserves every requested row')
from measured_page;
select ok(octet_length(convert_to(body::text,'UTF8')) <= 1048576,
          'the fast path preserves the exact UTF8 response cap')
from measured_page;

set local role service_role;
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,
   source,currency,cheapest_price,payload)
select lpad(to_hex(n + 200000),64,'0'),'BND','DST',date '2026-11-01',
  timestamptz '2026-09-19' + n * interval '1 second',
  to_char(timestamptz '2026-09-19' + n * interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  n,'test','USD',n,jsonb_build_object('text',repeat(md5(n::text),16000))
from generate_series(1,250) n;
reset role;

select performs_ok(format(
  'select public.read_airfare_history_page(''BND'',''DST'',null,null,null,null,%L,''snapshots'',null,250)',
  revision::text
), 750, 'a 250-row large-payload page is bounded before whole-page serialization')
from public.airfare_history_revision;

create temporary table bounded_page as
select public.read_airfare_history_page('BND','DST',null,null,null,null,
  (select revision::text from public.airfare_history_revision),'snapshots',null,250) body;
select ok(jsonb_array_length(body->'items') between 1 and 249,
          'large payloads return a bounded non-empty prefix')
from bounded_page;
select is(jsonb_typeof(body->'nextCursor'),'object',
          'a size-bounded prefix retains its continuation cursor')
from bounded_page;
select ok(octet_length(convert_to(body::text,'UTF8')) <= 1048576,
          'the bounded large-payload page preserves the exact UTF8 response cap')
from bounded_page;

select * from finish();
rollback;
