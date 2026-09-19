-- Additive history transport. Apply this entire migration in one transaction.
-- The legacy readers and collector/archive permissions remain unchanged.
create table if not exists public.airfare_history_revision (
  singleton boolean primary key check (singleton),
  revision bigint not null check (revision > 0)
);
insert into public.airfare_history_revision values (true, 1) on conflict do nothing;
alter table public.airfare_history_revision enable row level security;
revoke all on public.airfare_history_revision from public, anon, authenticated, service_role;
grant select on public.airfare_history_revision to service_role;

create or replace function public.advance_airfare_history_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.airfare_history_revision set revision = revision + 1 where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  return null;
end;
$$;
revoke all on function public.advance_airfare_history_revision() from public, anon, authenticated, service_role;

do $$
declare v_table text;
begin
  foreach v_table in array array['fare_snapshots','fare_baseline_points','fare_checks','fare_airports'] loop
    execute format('drop trigger if exists airfare_history_revision_change on public.%I', v_table);
    execute format('create trigger airfare_history_revision_change after insert or update or delete or truncate on public.%I for each statement execute function public.advance_airfare_history_revision()', v_table);
  end loop;
end;
$$;

create or replace function public.airfare_history_query_key(
  p_origin text, p_destination text, p_departure text,
  p_snapshot_months text[], p_since text, p_until text
) returns text language plpgsql immutable security invoker set search_path = '' as $$
declare v_months text[];
begin
  if exists (select 1 from unnest(p_snapshot_months) m
    where m is null or m !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(m,4) = '0000') then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_snapshot_months is not null then
    v_months := array(select distinct m from unnest(p_snapshot_months) m order by m);
  end if;
  return md5(jsonb_build_array(1, p_origin, p_destination, nullif(p_departure,''),
    v_months, nullif(p_since,''), nullif(p_until,''))::text);
end;
$$;
revoke all on function public.airfare_history_query_key(text,text,text,text[],text,text) from public, anon, authenticated, service_role;
grant execute on function public.airfare_history_query_key(text,text,text,text[],text,text) to service_role;

create or replace function public.read_airfare_history_meta(
  p_origin text, p_destination text, p_departure text,
  p_snapshot_months text[], p_since text, p_until text,
  p_expected_revision text default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_revision bigint;
  v_key text;
  v_body jsonb;
begin
  v_key := public.airfare_history_query_key(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until);
  if p_expected_revision is not null then
    if p_expected_revision !~ '^[1-9][0-9]{0,18}$' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
    end if;
    if p_expected_revision::numeric > 9223372036854775807 then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
    end if;
  end if;
  select revision into v_revision from public.airfare_history_revision where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  if p_expected_revision is not null and p_expected_revision <> v_revision::text then
    raise exception using errcode = '40001', message = 'airfare_history_revision_changed';
  end if;
  with selected_snapshots as (
    select s.record_id from public.fare_snapshots s
    where p_snapshot_months is null and s.origin = p_origin and s.destination = p_destination
      and (coalesce(p_since,'') = '' or s.captured_at_text >= p_since)
      and (coalesce(p_until,'') = '' or s.captured_at_text <= p_until)
    union all
    select s.record_id from (
      select distinct (m || '-01')::date as from_date from unnest(p_snapshot_months) m
    ) months cross join lateral (
      select s.record_id from public.fare_snapshots s
      where s.origin = p_origin and s.destination = p_destination
        and s.flight_date >= months.from_date and s.flight_date < months.from_date + interval '1 month'
        and (coalesce(p_since,'') = '' or s.captured_at_text >= p_since)
        and (coalesce(p_until,'') = '' or s.captured_at_text <= p_until)
      offset 0
    ) s
  ), per_departure as (
    select flight_date, min(cheapest_price) as price from public.fare_snapshots
    where origin = p_origin and destination = p_destination and cheapest_price is not null
    group by flight_date
  ), pair_reference as (
    select case when count(*) = 0 then null else jsonb_build_object(
      'value', percentile_cont(0.5) within group (order by price), 'dates', count(*)
    ) end as body from per_departure
  ), health as (
    select jsonb_build_object('lastCheckedAt', max(payload->>'at'), 'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')) as body
    from public.fare_checks where kind = 'board' and origin = p_origin and destination = p_destination
      and (coalesce(p_departure,'') = '' or starts_with(flight_date::text,p_departure))
  )
  select jsonb_build_object(
    'protocolVersion',1,'queryKey',v_key,'revision',v_revision::text,
    'origin',p_origin,'destination',p_destination,
    'counts',jsonb_build_object('snapshots',(select count(*)::text from selected_snapshots),
      'baseline',(select count(*)::text from public.fare_baseline_points b
        where b.origin = p_origin and b.destination = p_destination
          and (coalesce(p_departure,'') = '' or starts_with(b.flight_date::text,p_departure)))),
    'health',(select body from health),
    'airports',array(select a.payload from public.fare_airports a
      where a.code in (p_origin,p_destination) order by array_position(array[p_origin,p_destination],a.code)),
    'pairReference',(select body from pair_reference)
  ) into v_body;
  if octet_length(convert_to(v_body::text,'UTF8')) > 1048576 then
    raise exception using errcode = '22023', message = 'airfare_history_metadata_too_large';
  end if;
  return v_body;
end;
$$;
revoke all on function public.read_airfare_history_meta(text,text,text,text[],text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.read_airfare_history_meta(text,text,text,text[],text,text,text) to service_role;

create or replace function public.read_owner_airfare_history_meta(
  p_origin text, p_destination text, p_departure text,
  p_snapshot_months text[], p_since text, p_until text,
  p_expected_revision text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_history_meta(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until,p_expected_revision);
end;
$$;
revoke all on function public.read_owner_airfare_history_meta(text,text,text,text[],text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.read_owner_airfare_history_meta(text,text,text,text[],text,text,text) to authenticated, service_role;
