-- Opt-in local performance regression (not a hosted production workload).
-- Run with psql after applying migrations, with pgTAP on the search path.
-- All generated rows and helpers roll back. No private archive is required.
begin;
select plan(2);

insert into public.fare_snapshots
  (record_id, source_line, origin, destination, flight_date, captured_at,
   captured_at_text, source, currency, cheapest_price, payload)
select encode(sha256(convert_to('history-json-benchmark-' || n, 'UTF8')), 'hex'),
  n, 'PRF', 'DST', '2026-11-01', '2026-09-19T00:00:00Z',
  '2026-09-19T00:00:00Z', 'benchmark', 'USD', 100,
  jsonb_build_object('flightDate', '2026-11-01', 'observation', n, 'offers', (
    select jsonb_agg(jsonb_build_object('price', 100 + offer, 'currency', 'USD',
      'airline', 'Synthetic Airline', 'durationMinutes', 180, 'stops', 0,
      'segments', jsonb_build_array(jsonb_build_object('origin', 'PRF',
        'destination', 'DST', 'departure', '2026-11-01T12:00:00Z'))))
    from generate_series(1, 40) offer
  ))
from generate_series(1, 800) n;
analyze public.fare_snapshots;

create function pg_temp.history_json_ms(use_rpc boolean) returns numeric
language plpgsql as $$
declare started timestamptz; response jsonb; elapsed numeric;
begin
  started := clock_timestamp();
  if use_rpc then
    response := public.read_airfare_history('PRF','DST','2026-11',array['2026-11'],null,null);
  else
    -- The legacy bottleneck alone: aggregate JSONB, then embed it in JSONB.
    -- It intentionally does LESS work than the complete RPC, making the
    -- comparison conservative rather than padding the old implementation.
    select jsonb_build_object('snapshots', jsonb_agg(payload
      order by captured_at_text, source_line, record_id)) into response
    from public.fare_snapshots where origin='PRF' and destination='DST'
      and flight_date >= '2026-11-01' and flight_date < '2026-12-01';
  end if;
  elapsed := extract(epoch from clock_timestamp() - started) * 1000;
  if jsonb_array_length(response->'snapshots') <> 800 then
    raise exception 'benchmark lost observations';
  end if;
  return elapsed;
end;
$$;

-- Warm both paths, then interleave samples to reduce cache/order effects.
do $$ begin
  perform pg_temp.history_json_ms(false);
  perform pg_temp.history_json_ms(true);
end; $$;
create temporary table history_json_timings (use_rpc boolean, ms numeric);
do $$ declare use_rpc boolean; begin
  foreach use_rpc in array array[false,true,true,false,false,true] loop
    insert into history_json_timings values(use_rpc, pg_temp.history_json_ms(use_rpc));
  end loop;
end; $$;

select is(jsonb_array_length(public.read_airfare_history(
  'PRF','DST','2026-11',array['2026-11'],null,null)->'snapshots'),
  800, 'large history returns every observation without downsampling');
with medians as (
  select use_rpc, percentile_cont(0.5) within group (order by ms) as ms
  from history_json_timings group by use_rpc
)
select ok((select ms from medians where use_rpc) < 0.75 * (select ms from medians where not use_rpc),
  'complete RPC is at least 25 percent faster than legacy nested JSONB construction');
select diag(jsonb_object_agg(use_rpc::text, samples)::text)
from (select use_rpc, jsonb_agg(ms order by ms) as samples from history_json_timings group by use_rpc) samples;

select * from finish();
rollback;
