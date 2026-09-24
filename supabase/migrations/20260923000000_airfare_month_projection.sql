-- Read-optimized Airfare projections. The archive remains authoritative.
create table if not exists public.fare_month_projections (
  origin text not null,
  destination text not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  revision bigint not null,
  built_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (origin, destination, month)
);

create table if not exists public.fare_flight_projections (
  origin text not null,
  destination text not null,
  month text not null,
  flight_key text not null,
  offer jsonb not null,
  first_price numeric not null,
  price numeric not null,
  previous_price numeric,
  sightings integer not null check (sightings > 0),
  last_seen_at text not null,
  present boolean not null,
  category text not null check (category in ('rose','fell','unchanged','first','gone')),
  change_percent numeric,
  primary key (origin, destination, month, flight_key),
  foreign key (origin, destination, month)
    references public.fare_month_projections(origin, destination, month)
    on delete cascade
);
create index if not exists fare_flight_projections_price_idx
  on public.fare_flight_projections(origin,destination,month,price,flight_key);

create table if not exists public.fare_projection_dirty_routes (
  origin text not null,
  destination text not null,
  changed_at timestamptz not null default now(),
  primary key (origin,destination)
);

alter table public.fare_month_projections enable row level security;
alter table public.fare_flight_projections enable row level security;
alter table public.fare_projection_dirty_routes enable row level security;
revoke all on public.fare_month_projections, public.fare_flight_projections,
  public.fare_projection_dirty_routes
  from public, anon, authenticated, service_role;
grant select on public.fare_month_projections, public.fare_flight_projections to service_role;

create or replace function public.mark_fare_projection_dirty()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_origin text; v_destination text;
begin
  if TG_OP = 'DELETE' then
    v_origin := OLD.origin; v_destination := OLD.destination;
  else
    v_origin := NEW.origin; v_destination := NEW.destination;
  end if;
  insert into public.fare_projection_dirty_routes(origin,destination,changed_at)
  values(v_origin,v_destination,now())
  on conflict (origin,destination) do update set changed_at=excluded.changed_at;
  return null;
end;
$$;
revoke all on function public.mark_fare_projection_dirty()
  from public, anon, authenticated, service_role;

drop trigger if exists fare_projection_dirty on public.fare_snapshots;
create trigger fare_projection_dirty after insert or update or delete
  on public.fare_snapshots for each row execute function public.mark_fare_projection_dirty();
drop trigger if exists fare_projection_dirty on public.fare_baseline_points;
create trigger fare_projection_dirty after insert or update or delete
  on public.fare_baseline_points for each row execute function public.mark_fare_projection_dirty();
drop trigger if exists fare_projection_dirty on public.fare_checks;
create trigger fare_projection_dirty after insert or update or delete
  on public.fare_checks for each row execute function public.mark_fare_projection_dirty();

create or replace function public.refresh_fare_month_projection(
  p_origin text, p_destination text, p_month text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_from date;
  v_to date;
  v_revision bigint;
  v_metadata jsonb;
  v_payload jsonb;
begin
  if p_origin !~ '^[A-Z0-9]{3}$' or p_destination !~ '^[A-Z0-9]{3}$'
     or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = 'invalid_airfare_month_projection_request';
  end if;
  v_from := (p_month || '-01')::date;
  v_to := (v_from + interval '1 month')::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_origin || p_destination || p_month));
  select revision into v_revision from public.airfare_history_revision where singleton;
  v_metadata := public.read_airfare_history_meta(
    p_origin,p_destination,p_month,array[p_month],null,null,null
  );

  with month_snapshots as (
    select s.* from public.fare_snapshots s
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), price_days as (
    select left(captured_at_text,10) as day,
      min(cheapest_price) as low, max(cheapest_price) as high,
      percentile_cont(0.5) within group (order by cheapest_price) as middle,
      count(*) as observations
    from month_snapshots where cheapest_price is not null
    group by left(captured_at_text,10)
  ), unsold_days as (
    select left(captured_at_text,10) as day, count(*) as observations
    from month_snapshots where cheapest_price is null
    group by left(captured_at_text,10)
  ), provider_days as (
    select b.price_date::text as day,
      min(b.price) as low, max(b.price) as high,
      percentile_cont(0.5) within group (order by b.price) as middle,
      count(*) as observations
    from public.fare_baseline_points b
    where b.origin=p_origin and b.destination=p_destination
      and b.flight_date>=v_from and b.flight_date<v_to
    group by b.price_date
  ), latest_boards as (
    select distinct on (flight_date) flight_date, payload
    from month_snapshots
    order by flight_date, captured_at desc, source_line, record_id
  )
  select jsonb_build_object(
    'origin',p_origin,'destination',p_destination,'month',p_month,
    'revision',v_revision::text,
    'latestCapture',(select max(captured_at_text) from month_snapshots),
    'priceDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'low',low,'high',high,'middle',middle,'count',observations)
      order by day) from price_days),'[]'::jsonb),
    'unsoldDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'count',observations) order by day) from unsold_days),'[]'::jsonb),
    'providerDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'low',low,'high',high,'middle',middle,'count',observations)
      order by day) from provider_days),'[]'::jsonb),
    'latestBoards',coalesce((select jsonb_agg(payload order by flight_date)
      from latest_boards),'[]'::jsonb),
    'health',v_metadata->'health','airports',v_metadata->'airports',
    'pairReference',v_metadata->'pairReference'
  ) into v_payload;

  insert into public.fare_month_projections(origin,destination,month,revision,payload,built_at)
  values(p_origin,p_destination,p_month,v_revision,v_payload,now())
  on conflict (origin,destination,month) do update set
    revision=excluded.revision,payload=excluded.payload,built_at=excluded.built_at;

  delete from public.fare_flight_projections
  where origin=p_origin and destination=p_destination and month=p_month;

  with month_snapshots as (
    select s.* from public.fare_snapshots s
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), latest_boards as (
    select distinct on (flight_date) flight_date, payload
    from month_snapshots
    order by flight_date, captured_at desc, source_line, record_id
  ), latest_keys as (
    select distinct (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
      || '|' || (o.offer->>'departureAt') || '|'
      || coalesce(o.offer->>'arrivalAt','') as flight_key
    from latest_boards b cross join lateral jsonb_array_elements(b.payload->'offers') o(offer)
  ), all_offers as (
    select s.record_id,s.captured_at_text,s.source_line,o.ordinality,
      o.offer,(o.offer->>'price')::numeric as price,
      (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
        || '|' || (o.offer->>'departureAt') || '|'
        || coalesce(o.offer->>'arrivalAt','') as flight_key
    from month_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers')
        with ordinality o(offer,ordinality)
  ), offered as (
    select * from all_offers where price is not null
  ), ordered as (
    select o.*,lag(price) over (
      partition by flight_key order by captured_at_text,source_line,record_id,ordinality
    ) as prior_event_price
    from offered o
  ), changed as (
    select flight_key,price,
      row_number() over (partition by flight_key
        order by captured_at_text desc,source_line desc,record_id desc,ordinality desc) as reverse_rank
    from ordered where prior_event_price is distinct from price
  ), tracks as (
    select flight_key,
      (array_agg(offer order by captured_at_text,source_line,record_id,ordinality))[1] as offer
    from offered group by flight_key
  ), sightings as (
    select flight_key,count(distinct record_id)::integer as sightings,
      max(captured_at_text) as last_seen_at
    from all_offers group by flight_key
  ), prices as (
    select flight_key,
      max(price) filter (where reverse_rank=1) as price,
      max(price) filter (where reverse_rank=2) as previous_price,
      max(reverse_rank) as distinct_prices
    from changed group by flight_key
  ), first_prices as (
    select distinct on (flight_key) flight_key,price as first_price
    from changed order by flight_key,reverse_rank desc
  )
  insert into public.fare_flight_projections(
    origin,destination,month,flight_key,offer,first_price,price,previous_price,
    sightings,last_seen_at,present,category,change_percent
  )
  select p_origin,p_destination,p_month,t.flight_key,t.offer,f.first_price,p.price,
    p.previous_price,si.sightings,si.last_seen_at,
    (k.flight_key is not null),
    case when k.flight_key is null then 'gone'
      when p.previous_price is not null and p.previous_price <> p.price
        then case when p.price > p.previous_price then 'rose' else 'fell' end
      when si.sightings > 1 then 'unchanged' else 'first' end,
    case when k.flight_key is null or p.previous_price is null or p.previous_price=0
      then null else 100 * (p.price-p.previous_price)/p.previous_price end
  from tracks t join prices p using(flight_key)
    join first_prices f using(flight_key)
    join sightings si using(flight_key)
    left join latest_keys k using(flight_key);
end;
$$;

revoke all on function public.refresh_fare_month_projection(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_fare_month_projection(text,text,text) to service_role;

create or replace function public.list_fare_projection_dirty_routes()
returns table(origin text,destination text)
language sql stable security definer set search_path = '' as $$
  select d.origin,d.destination from public.fare_projection_dirty_routes d
  order by d.origin,d.destination;
$$;
revoke all on function public.list_fare_projection_dirty_routes()
  from public, anon, authenticated, service_role;
grant execute on function public.list_fare_projection_dirty_routes() to service_role;

create or replace function public.refresh_fare_route_projection(
  p_origin text,p_destination text
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_month text; v_count integer := 0;
begin
  -- The row lock makes a concurrent importer wait; its later dirty mark survives.
  perform 1 from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination for update;
  for v_month in
    select distinct month from (
      select to_char(flight_date,'YYYY-MM') as month from public.fare_snapshots
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_baseline_points
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_checks
        where kind='board' and origin=p_origin and destination=p_destination
    ) months order by month
  loop
    perform public.refresh_fare_month_projection(p_origin,p_destination,v_month);
    v_count := v_count + 1;
  end loop;
  delete from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination;
  return v_count;
end;
$$;
revoke all on function public.refresh_fare_route_projection(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_fare_route_projection(text,text) to service_role;

create or replace function public.read_owner_fare_month_projection(
  p_origin text,p_destination text,p_month text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_payload jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id=auth.uid()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  select payload into v_payload from public.fare_month_projections
  where origin=p_origin and destination=p_destination and month=p_month;
  return v_payload;
end;
$$;
revoke all on function public.read_owner_fare_month_projection(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_owner_fare_month_projection(text,text,text)
  to authenticated, service_role;

create or replace function public.read_owner_fare_flights(
  p_origin text,p_destination text,p_month text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_body jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id=auth.uid()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  select jsonb_build_object(
    'revision',m.revision::text,
    'latestCapture',m.payload->'latestCapture',
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'key',f.flight_key,'offer',f.offer,'price',f.price,
      'previousPrice',f.previous_price,'firstPrice',f.first_price,
      'sightings',f.sightings,'lastSeenAt',f.last_seen_at,
      'present',f.present,'category',f.category,'change',f.change_percent
    ) order by f.flight_key)
    from public.fare_flight_projections f
    where f.origin=m.origin and f.destination=m.destination and f.month=m.month),'[]'::jsonb)
  ) into v_body
  from public.fare_month_projections m
  where m.origin=p_origin and m.destination=p_destination and m.month=p_month;
  return v_body;
end;
$$;
revoke all on function public.read_owner_fare_flights(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_owner_fare_flights(text,text,text)
  to authenticated, service_role;
