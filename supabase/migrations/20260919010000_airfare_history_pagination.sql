-- Additive history transport. Apply this entire migration in one transaction.
-- The legacy readers and collector/archive permissions remain unchanged.
-- Measured on 16k synthetic observations: deep-page key selection changed from
-- a route scan/sort (9.99ms) to a bounded index-only scan (0.18ms). Keep existing
-- month indexes. Baseline's existing natural-key/range indexes remain sufficient.
create index if not exists fare_snapshots_history_cursor_idx
  on public.fare_snapshots(origin,destination,captured_at_text,source_line,record_id);

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

create or replace function public.read_airfare_history_page(
  p_origin text, p_destination text, p_departure text,
  p_snapshot_months text[], p_since text, p_until text,
  p_revision text, p_dataset text, p_cursor jsonb default null, p_page_size integer default 100
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_revision bigint;
  v_key text;
  v_after1 text;
  v_after2 text;
  v_after_id text;
  v_after_line bigint;
  v_items jsonb[] := array[]::jsonb[];
  v_item jsonb;
  v_order jsonb;
  v_cursor jsonb;
  v_envelope jsonb;
  v_response jsonb;
  v_previous jsonb;
  v_row record;
begin
  v_key := public.airfare_history_query_key(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until);
  if p_page_size is null or p_page_size not between 1 and 250
    or p_dataset is null or p_dataset not in ('snapshots','baseline')
    or p_revision is null or p_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_revision::numeric > 9223372036854775807 then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(p_cursor) k)
        is distinct from array['after','dataset','protocolVersion','queryKey','revision']
      or p_cursor->'protocolVersion' is distinct from '1'::jsonb
      or p_cursor->'queryKey' is distinct from to_jsonb(v_key)
      or p_cursor->'revision' is distinct from to_jsonb(p_revision)
      or p_cursor->'dataset' is distinct from to_jsonb(p_dataset)
      or jsonb_typeof(p_cursor->'after') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if jsonb_array_length(p_cursor->'after') <> 3
      or exists (select 1 from jsonb_array_elements(p_cursor->'after') e where jsonb_typeof(e) <> 'string') then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    v_after1 := p_cursor#>>'{after,0}';
    v_after2 := p_cursor#>>'{after,1}';
    v_after_id := p_cursor#>>'{after,2}';
    if v_after_id !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if p_dataset = 'snapshots' then
      if v_after2 !~ '^[1-9][0-9]{0,18}$' then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
      if v_after2::numeric > 9223372036854775807 then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
      v_after_line := v_after2::bigint;
    else
      if v_after1 !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or v_after2 !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or not pg_input_is_valid(v_after1,'date') or not pg_input_is_valid(v_after2,'date') then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
    end if;
  end if;
  select revision into v_revision from public.airfare_history_revision where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  if p_revision <> v_revision::text then
    raise exception using errcode = '40001', message = 'airfare_history_revision_changed';
  end if;
  v_envelope := jsonb_build_object('protocolVersion',1,'queryKey',v_key,'revision',p_revision,'dataset',p_dataset);
  v_previous := v_envelope || jsonb_build_object('items',v_items,'nextCursor',null);

  -- Limit key-only candidates BEFORE joining payloads. Only one dataset branch
  -- runs. The extra key establishes continuation even when the byte cap trims.
  for v_row in
    with candidates as materialized (
      (select s.record_id, s.captured_at_text as order1, ''::text as order2, s.source_line as line
       from public.fare_snapshots s
       where p_dataset = 'snapshots' and s.origin=p_origin and s.destination=p_destination
         and (coalesce(p_since,'')='' or s.captured_at_text >= p_since)
         and (coalesce(p_until,'')='' or s.captured_at_text <= p_until)
         and (p_snapshot_months is null or exists (
           select 1 from unnest(p_snapshot_months) m
           where s.flight_date >= (m || '-01')::date
             and s.flight_date < (m || '-01')::date + interval '1 month'))
         and (p_cursor is null or (s.captured_at_text,s.source_line,s.record_id) > (v_after1,v_after_line,v_after_id))
       order by s.captured_at_text,s.source_line,s.record_id limit p_page_size + 1)
      union all
      (select b.record_id, b.flight_date::text as order1, b.price_date::text as order2, 0::bigint as line
       from public.fare_baseline_points b
       where p_dataset = 'baseline' and b.origin=p_origin and b.destination=p_destination
         and (coalesce(p_departure,'')='' or starts_with(b.flight_date::text,p_departure))
         and (p_cursor is null or (b.flight_date,b.price_date,b.record_id) > (v_after1::date,v_after2::date,v_after_id))
       order by b.flight_date,b.price_date,b.record_id limit p_page_size + 1)
    ), numbered as materialized (
      select c.*, row_number() over(order by order1,line,order2,record_id) as position,
        count(*) over() as total from candidates c
    )
    select n.*, case when p_dataset='snapshots' then s.payload else b.payload end as payload
    from numbered n
    left join public.fare_snapshots s on p_dataset='snapshots' and s.record_id=n.record_id
    left join public.fare_baseline_points b on p_dataset='baseline' and b.record_id=n.record_id
    where n.position <= p_page_size
    order by n.position
  loop
    v_order := jsonb_build_array(v_row.order1,
      case when p_dataset='snapshots' then v_row.line::text else v_row.order2 end,v_row.record_id);
    v_item := jsonb_build_object('recordId',v_row.record_id,'order',v_order,'payload',v_row.payload);
    v_cursor := case when v_row.position < v_row.total then
      v_envelope || jsonb_build_object('after',v_order) else null end;
    v_response := v_envelope || jsonb_build_object('items',array_append(v_items,v_item),'nextCursor',v_cursor);
    if octet_length(convert_to(v_response::text,'UTF8')) > 1048576 then
      if cardinality(v_items) = 0 then
        raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
      end if;
      return v_previous;
    end if;
    v_items := array_append(v_items,v_item);
    v_previous := v_response;
  end loop;
  return v_previous;
end;
$$;
revoke all on function public.read_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer) from public, anon, authenticated, service_role;
grant execute on function public.read_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer) to service_role;

create or replace function public.read_owner_airfare_history_page(
  p_origin text, p_destination text, p_departure text,
  p_snapshot_months text[], p_since text, p_until text,
  p_revision text, p_dataset text, p_cursor jsonb default null, p_page_size integer default 100
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id=auth.uid()
  ) then
    raise exception using errcode='42501', message='not_edicius_owner';
  end if;
  return public.read_airfare_history_page(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until,p_revision,p_dataset,p_cursor,p_page_size);
end;
$$;
revoke all on function public.read_owner_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer) from public, anon, authenticated, service_role;
grant execute on function public.read_owner_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer) to authenticated, service_role;
