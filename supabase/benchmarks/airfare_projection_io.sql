-- Opt-in LOCAL PostgreSQL 17 benchmark; never run against hosted production.
-- Apply all migrations, then psql -X -v ON_ERROR_STOP=1 -f this/file.sql.
-- Requires pgTAP; synthetic history and helper functions all roll back.
begin;
set local search_path = public, extensions;
set local work_mem = '2184kB';
select plan(4);

create temporary table candidate_projection as
select pg_get_functiondef('public.refresh_fare_month_projection(text,text,text)'::regprocedure) as definition;
\ir ../migrations/20261101000000_airfare_confirmed_empty.sql
do $$ begin
  execute replace(pg_get_functiondef('public.refresh_fare_month_projection(text,text,text)'::regprocedure),
    'FUNCTION public.refresh_fare_month_projection(', 'FUNCTION pg_temp.legacy_month_projection(');
  execute (select definition from candidate_projection);
end $$;

insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,
   source_line,source,currency,cheapest_price,payload)
select encode(sha256(convert_to('projection-io-'||n,'UTF8')),'hex'),
  'PRF','DST',departure,stamp,to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  n,'benchmark','USD',100+n%7,
  jsonb_build_object('flightDate',departure,'offers',(
    select jsonb_agg(jsonb_build_object('airline','AA','flightNumber',o::text,
      'departureAt',departure::text||'T10:00','arrivalAt',departure::text||'T12:00',
      'price',case when n%13=0 then null else 100+o+n%7 end,'currency','USD',
      'description',repeat(md5((n*o)::text),16),
      'viaPoints',jsonb_build_array(jsonb_build_object('code','VIA','label','Via airport'))))
    from generate_series(1,40) o))
from (select n,date '2027-03-01'+n%20 as departure,
  timestamptz '2026-09-01T00:00:00Z'+n*interval '1 hour' as stamp
  from generate_series(1,800) n) snapshots;
analyze public.fare_snapshots;

select pg_temp.legacy_month_projection('PRF','DST','2027-03');
create temporary table expected_month as
select payload from public.fare_month_projections where origin='PRF';
create temporary table expected_flights as
select * from public.fare_flight_projections where origin='PRF';
select public.refresh_fare_month_projection('PRF','DST','2027-03');
select is((select payload from public.fare_month_projections where origin='PRF'),
  (select payload from expected_month),'large month payload is exactly equivalent');
select results_eq(
  $$select * from public.fare_flight_projections where origin='PRF' order by flight_key$$,
  $$select * from expected_flights order by flight_key$$,
  'all large-history flight results are exactly equivalent');

create temporary table projection_io_samples (optimized boolean,measurement jsonb);
do $$ declare optimized boolean; measurement jsonb; fn text; begin
  -- Both functions are warm; interleave to limit ordering/cache bias.
  foreach optimized in array array[false,true,true,false,false,true] loop
    fn := case when optimized then 'public.refresh_fare_month_projection'
      else 'pg_temp.legacy_month_projection' end;
    execute format('explain (analyze,buffers,wal,timing off,format json) select %s(%L,%L,%L)',
      fn,'PRF','DST','2027-03') into measurement;
    insert into projection_io_samples values(optimized,measurement->0);
  end loop;
end $$;

create temporary view projection_io_medians as
select optimized,
  percentile_cont(0.5) within group(order by (measurement->>'Execution Time')::numeric) as ms,
  percentile_cont(0.5) within group(order by (measurement#>>'{Plan,Temp Written Blocks}')::numeric) as temp_written_blocks,
  percentile_cont(0.5) within group(order by (measurement#>>'{Plan,Temp Read Blocks}')::numeric) as temp_read_blocks,
  percentile_cont(0.5) within group(order by (measurement#>>'{Plan,WAL Bytes}')::numeric) as wal_bytes
from projection_io_samples group by optimized;

select ok((select temp_written_blocks from projection_io_medians where optimized)
  < 0.6*(select temp_written_blocks from projection_io_medians where not optimized),
  'temporary writes decrease by at least 40 percent at production work_mem');
select ok((select wal_bytes from projection_io_medians where optimized)
  < 0.6*(select wal_bytes from projection_io_medians where not optimized),
  'unchanged refresh WAL decreases by at least 40 percent');
select diag(jsonb_agg(to_jsonb(s))::text) from projection_io_medians s;
select * from finish();
rollback;
