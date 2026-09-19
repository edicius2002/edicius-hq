-- Keep ordered payloads in SQL arrays until the final JSONB response is built.
-- This avoids building and copying large intermediate JSONB arrays, or parsing
-- an intermediate JSON text document. An empty SQL array becomes JSON [].
-- Keep the signature, grants, filters, ordering and complete payloads unchanged.
create or replace function public.read_airfare_history(
  p_origin text,
  p_destination text,
  p_departure text,
  p_snapshot_months text[],
  p_since text,
  p_until text
) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with selected_snapshots as (
    select s.payload, s.captured_at_text, s.source_line, s.record_id
    from public.fare_snapshots s
    where p_snapshot_months is null
      and s.origin = p_origin and s.destination = p_destination
      and (coalesce(p_since, '') = '' or s.captured_at_text >= p_since)
      and (coalesce(p_until, '') = '' or s.captured_at_text <= p_until)
    union all
    select s.payload, s.captured_at_text, s.source_line, s.record_id
    from (
      select distinct (month || '-01')::date as from_date
      from unnest(p_snapshot_months) as requested(month)
    ) months
    cross join lateral (
      select s.payload, s.captured_at_text, s.source_line, s.record_id
      from public.fare_snapshots s
      where s.origin = p_origin and s.destination = p_destination
        and s.flight_date >= months.from_date
        and s.flight_date < months.from_date + interval '1 month'
        and (coalesce(p_since, '') = '' or s.captured_at_text >= p_since)
        and (coalesce(p_until, '') = '' or s.captured_at_text <= p_until)
      -- Preserve the correlated, indexed month-range scan boundary.
      offset 0
    ) s
  ),
  per_departure as (
    select flight_date, min(cheapest_price) as price
    from public.fare_snapshots
    where origin = p_origin and destination = p_destination
      and cheapest_price is not null
    group by flight_date
  ),
  pair_reference as (
    select case when count(*) = 0 then null else jsonb_build_object(
      'value', percentile_cont(0.5) within group (order by price),
      'dates', count(*)
    ) end as body
    from per_departure
  ),
  health as (
    select jsonb_build_object(
      'lastCheckedAt', max(payload->>'at'),
      'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')
    ) as body
    from public.fare_checks
    where kind = 'board' and origin = p_origin and destination = p_destination
      and (coalesce(p_departure, '') = '' or starts_with(flight_date::text, p_departure))
  )
  select jsonb_build_object(
    'origin', p_origin,
    'destination', p_destination,
    'snapshots', array(
      select s.payload
      from selected_snapshots s
      order by s.captured_at_text, s.source_line, s.record_id
    ),
    'baseline', array(
      select b.payload
      from public.fare_baseline_points b
      where b.origin = p_origin and b.destination = p_destination
        and (coalesce(p_departure, '') = '' or starts_with(b.flight_date::text, p_departure))
      order by b.flight_date, b.price_date, b.record_id
    ),
    'health', (select body from health),
    'airports', array(
      select a.payload
      from public.fare_airports a
      where a.code in (p_origin, p_destination)
      order by array_position(array[p_origin, p_destination], a.code)
    ),
    'pairReference', (select body from pair_reference)
  );
$$;
