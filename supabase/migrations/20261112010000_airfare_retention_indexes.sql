-- Retention makes the duplicate baseline index and full calendar-health index wasteful.
drop index if exists public.fare_baseline_route_flight_price_date_idx;
drop index if exists public.fare_checks_calendar_health_idx;
create index fare_checks_calendar_health_idx
  on public.fare_checks (origin, destination, checked_at)
  where kind = 'calendar';
