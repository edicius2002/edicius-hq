create table public.fare_snapshots (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date not null,
  captured_at timestamptz not null,
  captured_at_text text not null,
  -- One-based physical JSONL line, supplied by the importer, never arrival order.
  source_line bigint not null check (source_line > 0),
  source text not null,
  currency text not null,
  cheapest_price numeric,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);

create index fare_snapshots_route_flight_capture_idx
  on public.fare_snapshots (origin, destination, flight_date, captured_at);
create index fare_snapshots_route_capture_idx
  on public.fare_snapshots (origin, destination, captured_at);
create unique index fare_snapshots_route_observation_source_line_idx
  on public.fare_snapshots (origin, destination, captured_at_text, source_line);

create table public.fare_baseline_points (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date not null,
  price_date date not null,
  price numeric not null,
  currency text not null,
  source text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);
create index fare_baseline_route_flight_price_date_idx
  on public.fare_baseline_points (origin, destination, flight_date, price_date);

create table public.fare_calendar_captures (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  captured_at timestamptz not null,
  source_line bigint not null check (source_line > 0),
  from_date date not null,
  to_date date not null,
  source text not null,
  currency text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);
create index fare_calendar_route_capture_idx
  on public.fare_calendar_captures (origin, destination, captured_at desc);
-- Reused line numbers at different times are harmless; an equal-time duplicate
-- position is ambiguous source metadata and must be rejected by the importer.
create unique index fare_calendar_route_observation_source_line_idx
  on public.fare_calendar_captures (origin, destination, (payload->>'capturedAt'), source_line);

create table public.fare_checks (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('board', 'calendar')),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date,
  checked_at timestamptz not null,
  outcome text not null,
  offers integer not null default 0 check (offers >= 0),
  cheapest numeric,
  error_code text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now(),
  check ((kind = 'board' and flight_date is not null) or kind = 'calendar')
);
create index fare_checks_board_health_idx
  on public.fare_checks (kind, origin, destination, flight_date, checked_at);
create index fare_checks_calendar_health_idx
  on public.fare_checks (kind, origin, destination, checked_at);

create table public.fare_airports (
  code text primary key check (code ~ '^[A-Z0-9]{3}$'),
  name text,
  city text,
  country text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  replicated_at timestamptz not null default now()
);

create table public.airfare_documents (
  key text primary key check (key = 'airfare-routes'),
  value jsonb not null,
  source_updated_at timestamptz not null,
  replicated_at timestamptz not null default now()
);

create table public.airfare_import_runs (
  run_id uuid primary key,
  mode text not null check (mode in ('full', 'incremental')),
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null check (status in ('running', 'complete', 'failed')),
  source_manifest jsonb not null default '{}'::jsonb,
  destination_manifest jsonb not null default '{}'::jsonb,
  error text
);

-- Text observation bounds intentionally retain the local archive's inclusive,
-- lexicographic comparison. Month bounds use indexed departure-date columns.
create function public.read_airfare_history(
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
    -- Keep the legacy whole-route path separate so a generic parameter plan
    -- does not turn the bounded path into a route scan plus a month filter.
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
      -- Retain the correlated range-scan boundary when the planner considers
      -- flattening this lateral subquery into a whole-route join.
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
    'snapshots', (
      select coalesce(jsonb_agg(s.payload order by s.captured_at_text, s.source_line, s.record_id), '[]'::jsonb)
      from selected_snapshots s
    ),
    'baseline', (
      select coalesce(jsonb_agg(b.payload order by b.flight_date, b.price_date, b.record_id), '[]'::jsonb)
      from public.fare_baseline_points b
      where b.origin = p_origin and b.destination = p_destination
        and (coalesce(p_departure, '') = '' or starts_with(b.flight_date::text, p_departure))
    ),
    'health', (select body from health),
    'airports', (
      select coalesce(jsonb_agg(a.payload order by array_position(array[p_origin, p_destination], a.code)), '[]'::jsonb)
      from public.fare_airports a
      where a.code in (p_origin, p_destination)
    ),
    'pairReference', (select body from pair_reference)
  );
$$;

create function public.read_airfare_calendar(p_origin text, p_destination text)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with curves as (
    select record_id, source_line, from_date, to_date, source, currency, payload,
           payload->>'capturedAt' as captured_at_text
    from public.fare_calendar_captures
    where origin = p_origin and destination = p_destination
  ),
  newest as (
    select * from curves order by captured_at_text desc, source_line desc, record_id desc limit 1
  ),
  bounds as (
    select newest.from_date, (select max(to_date) from curves) as to_date
    from newest
  ),
  -- Original JSONL uses a date-to-price object. Accept the list form used by
  -- wire fixtures too, without changing either stored document.
  expanded as (
    select c.record_id, c.source_line, c.captured_at_text, p.departure_date, p.price, p.ordinality
    from curves c
    cross join lateral (
      select key as departure_date, value as price, 0::bigint as ordinality
      from jsonb_each(case when jsonb_typeof(c.payload->'prices') = 'object'
                          then c.payload->'prices' else '{}'::jsonb end)
      union all
      select point->>'departureDate', point->'price', ordinality
      from jsonb_array_elements(
        case when jsonb_typeof(c.payload->'prices') = 'array'
             then c.payload->'prices' else '[]'::jsonb end
      ) with ordinality as points(point, ordinality)
    ) p
    cross join bounds b
    where p.departure_date >= b.from_date::text and p.departure_date <= b.to_date::text
  ),
  answered as (
    -- Presence wins, including an explicit null. A gap falls through to an
    -- older curve; dates behind the newest near boundary never return.
    select distinct on (departure_date) departure_date, price, captured_at_text
    from expanded
    order by departure_date, captured_at_text desc, source_line desc, record_id desc, ordinality
  ),
  horizon as (
    select jsonb_build_object(
      'capturedAt', coalesce((select max(captured_at_text) from answered), n.captured_at_text),
      'source', n.source,
      'currency', n.currency,
      'fromDate', b.from_date,
      'toDate', b.to_date,
      'prices', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'departureDate', departure_date,
          'price', price,
          'observedAt', captured_at_text
        ) order by departure_date), '[]'::jsonb)
        from answered
      )
    ) as body
    from newest n cross join bounds b
  ),
  health as (
    select jsonb_build_object(
      'lastCheckedAt', max(payload->>'at'),
      'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')
    ) as body
    from public.fare_checks
    where kind = 'calendar' and origin = p_origin and destination = p_destination
  )
  select jsonb_build_object(
    'origin', p_origin,
    'destination', p_destination,
    'horizon', (select body from horizon),
    'health', (select body from health)
  );
$$;

-- Nonempty groups only. Digests are SHA-256 of lexically sorted record IDs
-- joined with one LF and no trailing LF, encoded as UTF-8.
create function public.airfare_dataset_manifest()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with records as (
    select 'snapshots' as dataset, origin, destination, record_id from public.fare_snapshots
    union all
    select 'baseline', origin, destination, record_id from public.fare_baseline_points
    union all
    select 'calendar', origin, destination, record_id from public.fare_calendar_captures
    union all
    select kind || '_checks', origin, destination, record_id from public.fare_checks
  ),
  groups as (
    select dataset, origin || '-' || destination as route, count(*) as count,
           encode(sha256(convert_to(string_agg(record_id, chr(10) order by record_id), 'UTF8')), 'hex') as digest
    from records
    group by dataset, origin, destination
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'dataset', dataset, 'route', route, 'count', count, 'digest', digest
  ) order by dataset, route), '[]'::jsonb)
  from groups;
$$;

-- No browser role can reach the archive. Backend upserts need SELECT, INSERT,
-- and UPDATE; neither deletes nor schema/sequence ownership are required.
alter table public.fare_snapshots enable row level security;
revoke all on table public.fare_snapshots from public, anon, authenticated, service_role;
grant select, insert, update on table public.fare_snapshots to service_role;

alter table public.fare_baseline_points enable row level security;
revoke all on table public.fare_baseline_points from public, anon, authenticated, service_role;
grant select, insert, update on table public.fare_baseline_points to service_role;

alter table public.fare_calendar_captures enable row level security;
revoke all on table public.fare_calendar_captures from public, anon, authenticated, service_role;
grant select, insert, update on table public.fare_calendar_captures to service_role;

alter table public.fare_checks enable row level security;
revoke all on table public.fare_checks from public, anon, authenticated, service_role;
grant select, insert, update on table public.fare_checks to service_role;

alter table public.fare_airports enable row level security;
revoke all on table public.fare_airports from public, anon, authenticated, service_role;
grant select, insert, update on table public.fare_airports to service_role;

alter table public.airfare_documents enable row level security;
revoke all on table public.airfare_documents from public, anon, authenticated, service_role;
grant select, insert, update on table public.airfare_documents to service_role;

alter table public.airfare_import_runs enable row level security;
revoke all on table public.airfare_import_runs from public, anon, authenticated, service_role;
grant select, insert, update on table public.airfare_import_runs to service_role;

revoke all on all sequences in schema public from public, anon, authenticated;

revoke all on function public.read_airfare_history(text, text, text, text[], text, text) from public, anon, authenticated, service_role;
grant execute on function public.read_airfare_history(text, text, text, text[], text, text) to service_role;

revoke all on function public.read_airfare_calendar(text, text) from public, anon, authenticated, service_role;
grant execute on function public.read_airfare_calendar(text, text) to service_role;

revoke all on function public.airfare_dataset_manifest() from public, anon, authenticated, service_role;
grant execute on function public.airfare_dataset_manifest() to service_role;
