begin;
select plan(25);

select has_column('public', 'fare_snapshots', 'source_line', 'snapshots retain source line order');
select has_column('public', 'fare_calendar_captures', 'source_line', 'calendar captures retain source line order');

-- These importer-shaped records intentionally have hashes opposite source order,
-- and are inserted in reverse order. jsonb_populate_record lets this regression
-- run against the pre-fix schema too: it ignores the then-unknown source_line.
create temporary table source_rows as
select line, jsonb_build_object(
  'record_id', repeat(id, 64), 'source_line', line,
  'origin', 'TIE', 'destination', 'DST',
  'flight_date', '2027-03-02',
  'captured_at', '2026-09-10T00:00:00Z',
  'captured_at_text', '2026-09-10T00:00:00+00:00',
  'source', provider, 'currency', currency, 'cheapest_price', price,
  'from_date', start_date, 'to_date', '2027-04-01',
  'imported_at', '2026-09-15T00:00:00Z',
  'payload', jsonb_build_object(
    'capturedAt', '2026-09-10T00:00:00+00:00', 'source', provider,
    'origin', 'TIE', 'destination', 'DST', 'currency', currency,
    'flightDate', '2027-03-02', 'offers', jsonb_build_array(jsonb_build_object('price', price)),
    'from', start_date, 'to', '2027-04-01',
    'prices', case when line = 10 then '{"2027-03-01":90,"2027-03-02":100,"2027-04-01":500}'::jsonb
                   else '{"2027-03-02":200}'::jsonb end
  )
) as body
from (values
  (10::bigint, '9', 100, 'first-provider', 'USD', '2027-03-01'),
  (20::bigint, '8', 200, 'last-provider', 'PEN', '2027-03-02')
) rows(line, id, price, provider, currency, start_date);
grant select on source_rows to service_role;

set local role service_role;
insert into public.fare_snapshots
select (jsonb_populate_record(null::public.fare_snapshots, body)).*
from source_rows order by line desc;
insert into public.fare_calendar_captures
select (jsonb_populate_record(null::public.fare_calendar_captures, body)).*
from source_rows order by line desc;

select is(public.read_airfare_history('TIE','DST',null,null,null,null)->'snapshots'->0->'offers'->0->>'price',
          '100', 'whole-route history preserves source order when timestamps tie');
select is(public.read_airfare_history('TIE','DST',null,array['2027-03'],null,null)->'snapshots'->0->'offers'->0->>'price',
          '100', 'month history preserves source order when timestamps tie');
select is(public.read_airfare_calendar('TIE','DST')->'horizon'->'prices'->0->>'price',
          '200', 'later source line wins the calendar fare even when imported first');
select is(public.read_airfare_calendar('TIE','DST')->'horizon'->>'fromDate',
          '2027-03-02', 'later source line supplies the near boundary');
select is(public.read_airfare_calendar('TIE','DST')->'horizon'->>'source',
          'last-provider', 'later source line supplies the provider');
select is(public.read_airfare_calendar('TIE','DST')->'horizon'->>'currency',
          'PEN', 'later source line supplies the currency');
select is(jsonb_array_length(public.read_airfare_calendar('TIE','DST')->'horizon'->'prices'),
          2, 'timestamp tie does not resurrect a departure before the later boundary');

select is((select attnotnull and not atthasdef and atttypid = 'bigint'::regtype
           from pg_attribute where attrelid = ('public.' || table_name)::regclass and attname = 'source_line'),
          true, table_name || ' requires importer-supplied bigint source_line without a default')
from unnest(array['fare_snapshots', 'fare_calendar_captures']) table_name;
select throws_ok(format($sql$
  insert into public.%1$I
  select (jsonb_populate_record(null::public.%1$I,
    (body - 'source_line') || jsonb_build_object('record_id', repeat('7',64)))).*
  from source_rows where line = 10
$sql$, table_name), '23502', null, table_name || ' rejects a missing source line')
from unnest(array['fare_snapshots', 'fare_calendar_captures']) table_name;
select throws_ok(format($sql$
  insert into public.%1$I
  select (jsonb_populate_record(null::public.%1$I,
    body || jsonb_build_object('record_id', repeat('6',64), 'source_line', 0))).*
  from source_rows where line = 10
$sql$, table_name), '23514', null, table_name || ' rejects a nonpositive source line')
from unnest(array['fare_snapshots', 'fare_calendar_captures']) table_name;
select lives_ok(format($sql$
  insert into public.%1$I
  select (jsonb_populate_record(null::public.%1$I,
    body || jsonb_build_object('record_id', repeat('5',64)))).*
  from source_rows where line = 10
$sql$, table_name), table_name || ' permits transient equal-time positions during replay; importer validates source ambiguity')
from unnest(array['fare_snapshots', 'fare_calendar_captures']) table_name;
select lives_ok(format($sql$
  insert into public.%1$I
  select (jsonb_populate_record(null::public.%1$I,
    jsonb_set(body || jsonb_build_object(
      'record_id', repeat('4',64),
      'captured_at', '2026-09-11T00:00:00Z',
      'captured_at_text', '2026-09-11T00:00:00+00:00'
    ), '{payload,capturedAt}', '"2026-09-11T00:00:00+00:00"'::jsonb))).*
  from source_rows where line = 10
$sql$, table_name), table_name || ' permits reused line positions at a different timestamp')
from unnest(array['fare_snapshots', 'fare_calendar_captures']) table_name;

reset role;
-- Representative sparse-month selection: 4,000 daily departures, two requested
-- months, one repeated month. The installed SQL body is planned/executed with
-- generic parameters, as an opaque SQL RPC cannot expose its nested plan.
insert into public.fare_snapshots
select (jsonb_populate_record(null::public.fare_snapshots, jsonb_build_object(
  'record_id', encode(sha256(convert_to('plan-' || n, 'UTF8')), 'hex'),
  'source_line', n + 1, 'origin', 'IDX', 'destination', 'DST',
  'flight_date', ('2026-01-01'::date + n),
  'captured_at', '2026-09-10T00:00:00Z',
  'captured_at_text', '2026-09-10T00:00:00+00:00',
  'source', 'test-provider', 'currency', 'USD', 'cheapest_price', 100,
  'imported_at', '2026-09-15T00:00:00Z',
  'payload', jsonb_build_object('flightDate', ('2026-01-01'::date + n), 'offers', '[]'::jsonb)
))).*
from generate_series(0, 3999) n;
analyze public.fare_snapshots;

create function pg_temp.history_plan() returns jsonb language plpgsql as $$
declare
  statement text;
  result jsonb;
  argument text;
  position integer := 0;
begin
  select prosrc into strict statement from pg_proc
  where oid = 'public.read_airfare_history(text,text,text,text[],text,text)'::regprocedure;
  foreach argument in array array['p_origin', 'p_destination', 'p_departure', 'p_snapshot_months', 'p_since', 'p_until']
  loop
    position := position + 1;
    statement := regexp_replace(statement, '\m' || argument || '\M', '$' || position, 'g');
  end loop;
  execute 'prepare airfare_history_plan(text,text,text,text[],text,text) as ' || statement;
  execute 'explain (analyze, format json) execute airfare_history_plan(''IDX'',''DST'',null,array[''2027-03'',''2027-05'',''2027-03''],null,null)'
    into result;
  deallocate airfare_history_plan;
  return result;
end;
$$;

set local enable_seqscan = off;
set local plan_cache_mode = force_generic_plan;
create temporary table history_explain as
with recursive nodes(node) as (
  select pg_temp.history_plan()->0->'Plan'
  union all
  select child from nodes cross join lateral jsonb_array_elements(node->'Plans') child
)
select node from nodes;

select ok(exists(
  select 1 from history_explain
  where node->>'Index Name' = 'fare_snapshots_route_flight_capture_idx'
    and (node->>'Actual Loops')::numeric > 0
    and node->>'Index Cond' like '%flight_date >=%'
    and node->>'Index Cond' like '%flight_date <%'),
  'requested months drive lower and upper departure bounds in the actual index condition');
select is((
  select sum(((node->>'Actual Rows')::numeric + coalesce((node->>'Rows Removed by Filter')::numeric, 0))
             * (node->>'Actual Loops')::numeric)
  from history_explain
  where node->>'Relation Name' = 'fare_snapshots' and node->>'Alias' ~ '^s(_[0-9]+)?$'
    and (node->>'Actual Loops')::numeric > 0),
  62::numeric, 'snapshot payload scans inspect only the 62 requested departures, not the whole 4000-row route');
select is(jsonb_array_length(public.read_airfare_history(
  'IDX','DST',null,array['2027-03','2027-05','2027-03'],null,null
)->'snapshots'), 62, 'noncontiguous requested months form a deduplicated union');
select is(jsonb_array_length(public.read_airfare_history(
  'IDX','DST',null,array[]::text[],null,null
)->'snapshots'), 0, 'an empty explicit month list returns no snapshots');
select is(jsonb_array_length(public.read_airfare_history(
  'IDX','DST',null,null,null,null
)->'snapshots'), 4000, 'omitted month list retains whole-route reads');
select is(jsonb_array_length(public.read_airfare_history(
  'IDX','DST',null,array['2027-03'],'2026-09-11',null
)->'snapshots'), 0, 'month-driven reads still apply observation bounds');

select * from finish();
rollback;
