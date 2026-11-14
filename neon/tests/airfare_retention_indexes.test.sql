begin;
set search_path=public,extensions;
select no_plan();
select ok(to_regclass('public.fare_baseline_route_flight_price_date_idx') is null,
  'redundant baseline route/date index is absent');
select ok((select indisunique from pg_index where indexrelid='public.fare_baseline_natural_key_idx'::regclass),
  'baseline natural key remains unique');
select is((select pg_get_indexdef('public.fare_checks_calendar_health_idx'::regclass)),
  'CREATE INDEX fare_checks_calendar_health_idx ON public.fare_checks USING btree (origin, destination, checked_at) WHERE (kind = ''calendar''::text)',
  'calendar health index is partial and starts with the route');
select * from finish();
rollback;
