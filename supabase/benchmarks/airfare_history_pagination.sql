-- Opt-in, synthetic data only, run in the isolated pagination test database.
-- Candidate indexes and all fixtures roll back. No production cache flushing.
begin;
set local statement_timeout = '30s';
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
select lpad(to_hex(n),64,'0'),'BEN','DST',date '2026-11-01'+(n%90),
  timestamptz '2026-09-01'+n*interval '1 second',
  to_char(timestamptz '2026-09-01'+n*interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  n,'test','USD',n%1000,jsonb_build_object('text',repeat(md5(n::text),100),'price',n%1000)
from generate_series(1,16000) n;
insert into public.fare_baseline_points
  (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
select lpad(to_hex(n+20000),64,'0'),'BEN','DST',date '2026-11-01'+(n%90),
  date '2024-01-01'+(n/90),n%1000,'USD','test',jsonb_build_object('price',n%1000)
from generate_series(1,60000) n;
analyze public.fare_snapshots;
analyze public.fare_baseline_points;
select 'before candidate indexes' as phase;
explain(analyze,buffers,format json)
select record_id from public.fare_snapshots where origin='BEN' and destination='DST'
and (captured_at_text,source_line,record_id)>('2026-09-01T03:00:00Z',10800,repeat('0',64))
order by captured_at_text,source_line,record_id limit 101;
explain(analyze,buffers,format json)
select record_id from public.fare_baseline_points where origin='BEN' and destination='DST'
and (flight_date,price_date,record_id)>(date '2026-12-01',date '2024-05-01',repeat('0',64))
order by flight_date,price_date,record_id limit 101;
create index if not exists fare_snapshots_history_cursor_idx
on public.fare_snapshots(origin,destination,captured_at_text,source_line,record_id);
create index if not exists fare_baseline_history_cursor_idx
on public.fare_baseline_points(origin,destination,flight_date,price_date,record_id);
select 'with candidate indexes' as phase;
explain(analyze,buffers,format json)
select record_id from public.fare_snapshots where origin='BEN' and destination='DST'
and (captured_at_text,source_line,record_id)>('2026-09-01T03:00:00Z',10800,repeat('0',64))
order by captured_at_text,source_line,record_id limit 101;
explain(analyze,buffers,format json)
select record_id from public.fare_snapshots where origin='BEN' and destination='DST'
and flight_date >= date '2026-11-01' and flight_date < date '2027-01-01'
and (captured_at_text,source_line,record_id)>('2026-09-01T03:00:00Z',10800,repeat('0',64))
order by captured_at_text,source_line,record_id limit 101;
explain(analyze,buffers,format json)
select record_id from public.fare_baseline_points where origin='BEN' and destination='DST'
and (flight_date,price_date,record_id)>(date '2026-12-01',date '2024-05-01',repeat('0',64))
order by flight_date,price_date,record_id limit 101;
explain(analyze,buffers,format json)
select public.read_airfare_history_meta('BEN','DST','2026-11',array['2026-11','2026-12'],null,null);
explain(analyze,buffers,format json)
select public.read_airfare_history_page('BEN','DST','2026-11',array['2026-11','2026-12'],null,null,
  (select revision::text from public.airfare_history_revision),'snapshots');
explain(analyze,buffers,format json)
select public.read_airfare_history_page('BEN','DST','2026-11',array['2026-11','2026-12'],null,null,
  (select revision::text from public.airfare_history_revision),'baseline');

-- LIKE copies indexes/constraints, not triggers. Compare equal 250-row upserts
-- without disabling the real revision guard, even in the test database.
create temporary table history_writer_control (like public.fare_snapshots including all);
insert into history_writer_control select * from public.fare_snapshots where origin='BEN';
grant select,insert,update on history_writer_control to service_role;
create function pg_temp.measure_writer(target regclass) returns jsonb language plpgsql as $$
declare started timestamptz := clock_timestamp();
begin
  for n in 1..20 loop
    execute format('insert into %s select * from public.fare_snapshots where origin=''BEN'' and source_line between 1 and 250 on conflict(record_id) do update set payload=excluded.payload,source_line=excluded.source_line',target);
  end loop;
  return jsonb_build_object('target',target::text,'batches',20,'rowsPerBatch',250,
    'milliseconds',extract(epoch from clock_timestamp()-started)*1000);
end;
$$;
set local role service_role;
select pg_temp.measure_writer('pg_temp.history_writer_control');
select pg_temp.measure_writer('public.fare_snapshots');
select pg_temp.measure_writer('pg_temp.history_writer_control');
select pg_temp.measure_writer('public.fare_snapshots');
reset role;
rollback;
