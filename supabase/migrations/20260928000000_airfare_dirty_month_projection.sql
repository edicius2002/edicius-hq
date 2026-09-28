-- Preserve the route row as the concurrency lock, but track which departure
-- months actually need rebuilding. Existing dirty routes get one full retry.
alter table public.fare_projection_dirty_routes
  add column needs_full_refresh boolean not null default false;
update public.fare_projection_dirty_routes set needs_full_refresh = true;

create table public.fare_projection_dirty_months (
  origin text not null,
  destination text not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  changed_at timestamptz not null default now(),
  primary key (origin,destination,month),
  foreign key (origin,destination)
    references public.fare_projection_dirty_routes(origin,destination) on delete cascade
);
alter table public.fare_projection_dirty_months enable row level security;
revoke all on public.fare_projection_dirty_months
  from public, anon, authenticated, service_role;

create function public.mark_fare_projection_month(
  p_origin text,p_destination text,p_month text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.fare_projection_dirty_routes(origin,destination,changed_at)
  values(p_origin,p_destination,now())
  on conflict (origin,destination) do update set changed_at=excluded.changed_at;
  insert into public.fare_projection_dirty_months(origin,destination,month,changed_at)
  values(p_origin,p_destination,p_month,now())
  on conflict (origin,destination,month) do update set changed_at=excluded.changed_at;
end;
$$;
revoke all on function public.mark_fare_projection_month(text,text,text)
  from public, anon, authenticated, service_role;

create or replace function public.mark_fare_projection_dirty()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_origin text;
  v_old_destination text;
  v_old_month text;
  v_new_month text;
  v_old_relevant boolean := false;
  v_new_relevant boolean := false;
begin
  if TG_OP <> 'INSERT' then
    v_old_relevant := TG_TABLE_NAME <> 'fare_checks';
    if TG_TABLE_NAME = 'fare_checks' then v_old_relevant := OLD.kind = 'board'; end if;
    if v_old_relevant then
      v_old_origin := OLD.origin;
      v_old_destination := OLD.destination;
      v_old_month := to_char(OLD.flight_date,'YYYY-MM');
      perform public.mark_fare_projection_month(v_old_origin,v_old_destination,v_old_month);
    end if;
  end if;
  if TG_OP <> 'DELETE' then
    v_new_relevant := TG_TABLE_NAME <> 'fare_checks';
    if TG_TABLE_NAME = 'fare_checks' then v_new_relevant := NEW.kind = 'board'; end if;
    if v_new_relevant then
      v_new_month := to_char(NEW.flight_date,'YYYY-MM');
      if (v_old_origin,v_old_destination,v_old_month)
         is distinct from (NEW.origin,NEW.destination,v_new_month) then
        perform public.mark_fare_projection_month(NEW.origin,NEW.destination,v_new_month);
      end if;
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.refresh_fare_route_projection(
  p_origin text,p_destination text
) returns integer language plpgsql security definer
  set search_path = '' set statement_timeout = '30s' as $$
declare
  v_full boolean;
  v_months text[];
  v_month text;
  v_from date;
  v_to date;
  v_count integer := 0;
  v_metadata jsonb;
begin
  -- The trigger first updates this row. Its lock keeps a concurrent dirty
  -- mark waiting until this refresh either commits or rolls back.
  select needs_full_refresh into v_full from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination for update;
  if not found then return 0; end if;

  if v_full then
    select coalesce(array_agg(month order by month),array[]::text[]) into v_months
    from (
      select to_char(flight_date,'YYYY-MM') as month from public.fare_snapshots
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_baseline_points
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_checks
        where kind='board' and origin=p_origin and destination=p_destination
      union
      select month from public.fare_month_projections
        where origin=p_origin and destination=p_destination
    ) months;
  else
    select coalesce(array_agg(month order by month),array[]::text[]) into v_months
    from public.fare_projection_dirty_months
    where origin=p_origin and destination=p_destination;
  end if;

  foreach v_month in array v_months loop
    v_from := (v_month || '-01')::date;
    v_to := (v_from + interval '1 month')::date;
    if exists (
      select 1 from public.fare_snapshots s where s.origin=p_origin
        and s.destination=p_destination and s.flight_date>=v_from and s.flight_date<v_to
    ) or exists (
      select 1 from public.fare_baseline_points b where b.origin=p_origin
        and b.destination=p_destination and b.flight_date>=v_from and b.flight_date<v_to
    ) or exists (
      select 1 from public.fare_checks c where c.kind='board' and c.origin=p_origin
        and c.destination=p_destination and c.flight_date>=v_from and c.flight_date<v_to
    ) then
      perform public.refresh_fare_month_projection(p_origin,p_destination,v_month);
      v_count := v_count + 1;
    else
      delete from public.fare_month_projections
        where origin=p_origin and destination=p_destination and month=v_month;
    end if;
  end loop;

  -- Pair reference spans the whole route; health is month-specific. Keep
  -- only the shared reference current in otherwise unchanged months.
  if exists (select 1 from public.fare_month_projections
             where origin=p_origin and destination=p_destination) then
    v_metadata := public.read_airfare_history_meta(
      p_origin,p_destination,'',array[]::text[],null,null,null
    );
    update public.fare_month_projections p set
      payload = p.payload || jsonb_build_object(
        'pairReference',v_metadata->'pairReference',
        'revision',v_metadata->'revision'
      ),
      revision = (v_metadata->>'revision')::bigint
    where p.origin=p_origin and p.destination=p_destination
      and p.payload->'pairReference' is distinct from v_metadata->'pairReference';
  end if;

  delete from public.fare_projection_dirty_months
    where origin=p_origin and destination=p_destination;
  delete from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination;
  return v_count;
end;
$$;
