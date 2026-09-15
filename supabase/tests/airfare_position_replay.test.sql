begin;
select plan(10);

create temporary table replay_rows as
select jsonb_build_object(
  'record_id', repeat(id,64), 'source_line', line,
  'origin', 'AAA', 'destination', 'BBB', 'flight_date', '2027-03-01',
  'captured_at', '2026-09-15T00:00:00Z', 'captured_at_text', '2026-09-15T00:00:00Z',
  'from_date', '2027-03-01', 'to_date', '2027-03-02',
  'source', 'test', 'currency', currency, 'imported_at', '2026-09-15T00:00:00Z',
  'payload', jsonb_build_object('capturedAt', '2026-09-15T00:00:00Z',
    'currency', currency, 'prices', jsonb_build_object('2027-03-01', price))) as body
from (values ('a',1,'USD',100), ('b',2,'PEN',200)) fixture(id,line,currency,price);
grant select on replay_rows to service_role;

create function pg_temp.replay_position(table_name text, id text, line integer)
returns void language plpgsql as $$
begin
  execute format('insert into public.%1$I select (jsonb_populate_record(null::public.%1$I,
    body || jsonb_build_object(''source_line'', $1))).* from replay_rows
    where body->>''record_id'' = repeat($2,64)
    on conflict (record_id) do update set source_line = excluded.source_line', table_name)
    using line, id;
end;
$$;

set local role service_role;
select pg_temp.replay_position(table_name, id, line)
from unnest(array['fare_snapshots','fare_calendar_captures']) table_name,
     (values ('a',1),('b',2)) fixture(id,line);

-- Each call is its own upsert batch. Old metadata may temporarily overlap
-- while a valid source replacement is being replayed, including after failure.
select lives_ok(format('select pg_temp.replay_position(%L,''a'',2)', table_name),
                table_name || ' shifts into an old occupied position')
from unnest(array['fare_snapshots','fare_calendar_captures']) table_name;
select lives_ok(format('select pg_temp.replay_position(%L,''a'',2);
                       select pg_temp.replay_position(%L,''b'',3)', table_name, table_name),
                table_name || ' retries a completed batch then finishes the shift')
from unnest(array['fare_snapshots','fare_calendar_captures']) table_name;
select lives_ok(format('select pg_temp.replay_position(%L,''a'',3);
                       select pg_temp.replay_position(%L,''b'',2)', table_name, table_name),
                table_name || ' swaps physical positions across upsert batches')
from unnest(array['fare_snapshots','fare_calendar_captures']) table_name;
select is((select count(*) from public.fare_snapshots), 2::bigint,
          'snapshot replay retains exactly the two content identities');
select is((select count(*) from public.fare_calendar_captures), 2::bigint,
          'calendar replay retains exactly the two content identities');
select is(public.read_airfare_history('AAA','BBB',null,null,null,null)->'snapshots'->0->>'currency',
          'PEN', 'history uses final physical ordering after swap');
select is(public.read_airfare_calendar('AAA','BBB')->'horizon'->>'currency',
          'USD', 'calendar uses final physical ordering after swap');

select * from finish();
rollback;
