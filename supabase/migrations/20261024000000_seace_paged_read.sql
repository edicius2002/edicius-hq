-- Keep the collector's payload-only upserts compatible while making view
-- membership cheap to evaluate for a paged browser read.
create function public.seace_peru_date(p_value text, p_end_of_day boolean default false)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare
  parts text[];
begin
  if p_value is null then return null; end if;
  parts := regexp_match(p_value,
    '^([0-9]{2})/([0-9]{2})/([0-9]{4})([[:space:]]+([0-9]{2}):([0-9]{2})(:([0-9]{2}))?)?');
  if parts is null then return null; end if;
  return make_timestamptz(parts[3]::integer, parts[2]::integer, parts[1]::integer,
    coalesce(parts[5]::integer, case when p_end_of_day then 23 else 0 end),
    coalesce(parts[6]::integer, case when p_end_of_day then 59 else 0 end),
    coalesce(parts[8]::integer, case when p_end_of_day then 59 else 0 end),
    'America/Lima');
exception when datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
  return null;
end;
$$;

-- Match JavaScript String.trim() for the saved exclusion-key format.
create function public.seace_js_trim(p_value text)
returns text language sql immutable set search_path = '' as $$
  select btrim(coalesce(p_value,''), E' \t\n\r\f\v' || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
    || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
    || chr(12288) || chr(65279));
$$;

alter table public.seace_records
  add column is_minor boolean,
  add column object_key text,
  add column open_until timestamptz;

create function public.set_seace_read_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.is_minor := new.payload->>'minor' = 'true';
  new.object_key := upper(regexp_replace(
    normalize(coalesce(new.payload->>'object',''), NFD), U&'[\0300-\036F]', '', 'g'));
  new.open_until := null;
  if new.kind = 'notices' and new.payload->>'state' = 'Vigente' then
    new.open_until := public.seace_peru_date(new.payload->>'end', false);
  elsif new.kind = 'processes' and coalesce(new.payload->>'state','') !~* 'adjudicad|desiert|cancelad|anulad|contratad|finalizad' then
    new.open_until := least(
      public.seace_peru_date(new.payload->>'end', true),
      public.seace_peru_date(new.payload->>'registrationEnd', true));
  end if;
  return new;
end;
$$;

create trigger seace_records_read_fields
before insert or update of kind, payload on public.seace_records
for each row execute function public.set_seace_read_fields();

-- Existing records use the exact same derivation as subsequent collector writes.
update public.seace_records set payload = payload;

create index seace_records_page_published_idx
  on public.seace_records (owner_id, region, year, kind, published_at desc nulls last);
create index seace_records_page_open_idx
  on public.seace_records (owner_id, region, year, kind, open_until);

create function public.read_owner_seace_page(
  p_region text, p_year integer, p_view text, p_minor_only boolean,
  p_object_filter text, p_excluded boolean, p_search text,
  p_sort_field text, p_ascending boolean, p_page integer,
  p_page_size integer, p_now timestamptz
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  result jsonb;
begin
  if p_region is null or p_year is null or p_year not between 2024 and 2100
    or p_view is null or p_view not in ('recent','open','closed','published')
    or p_minor_only is null or p_object_filter is null
    or p_object_filter not in ('Todos','Bien','Servicio','Obra','Consultoría de Obra')
    or p_excluded is null or p_search is null
    or p_sort_field is null or p_sort_field not in
      ('code','entity','description','object','published','start','end','amount','links','signed','termStart','termEnd')
    or p_ascending is null or p_page is null or p_page not between 1 and 1000000
    or p_page_size is null or p_page_size not between 1 and 100 or p_now is null then
    raise exception using errcode = '22023', message = 'invalid_seace_page_request';
  end if;

  with filtered as materialized (
    select r.owner_id, r.kind, r.record_key,
      case when p_sort_field in ('published','signed','start','end','termStart','termEnd') then
        coalesce(case when p_sort_field = 'published' and r.kind <> 'contracts'
          then r.published_at
          else public.seace_peru_date(r.payload->>
            (case when p_sort_field = 'published' then 'signed' else p_sort_field end))
          end, '1970-01-01 00:00+00'::timestamptz)
      end as sort_date,
      case when p_sort_field not in ('published','signed','start','end','termStart','termEnd')
        then case when p_sort_field = 'links' then ''
          else lower(coalesce(r.payload->>p_sort_field,'')) end
      end as sort_text
    from public.seace_records r
    where r.owner_id = auth.uid() and r.region = p_region and r.year = p_year
      and (case when p_view = 'published' then r.kind = 'contracts'
        else r.kind in ('notices','processes') end)
      and (not p_minor_only or r.is_minor is true)
      and (p_object_filter = 'Todos' or r.object_key like
        (case when p_object_filter = 'Consultoría de Obra' then 'CONSULTORIA'
          else upper(p_object_filter) end) || '%')
      and (case p_view
        when 'recent' then r.open_until > p_now and r.published_at between p_now - interval '24 hours' and p_now
        when 'open' then r.open_until > p_now and (r.published_at is null
          or r.published_at < p_now - interval '24 hours' or r.published_at > p_now)
        when 'closed' then r.open_until is null or r.open_until <= p_now
        else true end)
      and (p_search = '' or position(lower(p_search) in lower(coalesce(r.payload->>'code',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'entity',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'description',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'contractor',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'object',''))) > 0)
      and (exists (select 1 from public.seace_exclusions e
        where e.owner_id = r.owner_id and e.record_key = case
          when r.kind = 'processes' then 'process:' || array_to_json(array[
            coalesce(r.payload->>'region',''), coalesce(r.payload->>'code',''),
            coalesce(r.payload->>'published',''), coalesce(r.payload->>'entity','')])::text
          else 'minor:' || array_to_json(array[
            coalesce(r.payload->>'region',''), upper(public.seace_js_trim(r.payload->>'code'))])::text
          end) = p_excluded)
  ), ordered as (
    select f.*, row_number() over (order by
      case when p_ascending then f.sort_date end asc,
      case when not p_ascending then f.sort_date end desc,
      case when p_ascending then f.sort_text end asc,
      case when not p_ascending then f.sort_text end desc,
      case f.kind when 'notices' then 0 when 'processes' then 1 else 2 end,
      f.record_key) as position
    from filtered f
  ), page_rows as (
    select o.position, jsonb_build_object('kind',r.kind,'recordKey',r.record_key,'payload',r.payload) as item
    from ordered o join public.seace_records r
      on r.owner_id=o.owner_id and r.kind=o.kind and r.record_key=o.record_key
    where o.position > (p_page::bigint - 1) * p_page_size
      and o.position <= p_page::bigint * p_page_size
  )
  select jsonb_build_object('total',(select count(*) from filtered),
    'rows',coalesce((select jsonb_agg(item order by position) from page_rows),'[]'::jsonb))
    into result;
  return result;
end;
$$;

revoke all on function public.seace_peru_date(text,boolean), public.seace_js_trim(text),
  public.set_seace_read_fields(),
  public.read_owner_seace_page(text,integer,text,boolean,text,boolean,text,text,boolean,integer,integer,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.seace_peru_date(text,boolean) to authenticated, service_role;
grant execute on function public.seace_js_trim(text) to authenticated;
grant execute on function public.set_seace_read_fields() to service_role;
grant execute on function public.read_owner_seace_page(text,integer,text,boolean,text,boolean,text,text,boolean,integer,integer,timestamptz)
  to authenticated;
