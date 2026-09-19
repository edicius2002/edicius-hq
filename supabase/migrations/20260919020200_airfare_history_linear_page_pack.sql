-- Preserve the V1 page protocol while replacing per-row whole-response
-- serialization with one full check and a logarithmic exact-prefix search.
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
  v_orders jsonb[] := array[]::jsonb[];
  v_item jsonb;
  v_order jsonb;
  v_cursor jsonb;
  v_envelope jsonb;
  v_response jsonb;
  v_best_response jsonb;
  v_row record;
  v_item_bytes integer;
  v_items_bytes bigint := 0;
  v_total integer := 0;
  v_count integer;
  v_low integer;
  v_high integer;
  v_mid integer;
begin
  v_key := public.airfare_history_query_key(
    p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until
  );
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
      or exists (
        select 1 from jsonb_array_elements(p_cursor->'after') e
        where jsonb_typeof(e) <> 'string'
      ) then
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
        or not pg_input_is_valid(v_after1,'date')
        or not pg_input_is_valid(v_after2,'date') then
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
  v_envelope := jsonb_build_object(
    'protocolVersion',1,'queryKey',v_key,'revision',p_revision,'dataset',p_dataset
  );

  -- Fetch payloads once. The extra key establishes whether the final included
  -- item needs a continuation cursor, including exact page-size boundaries.
  for v_row in
    with candidates as materialized (
      (select s.record_id, s.captured_at_text as order1, ''::text as order2,
          s.source_line as line
       from public.fare_snapshots s
       where p_dataset = 'snapshots' and s.origin=p_origin and s.destination=p_destination
         and (coalesce(p_since,'')='' or s.captured_at_text >= p_since)
         and (coalesce(p_until,'')='' or s.captured_at_text <= p_until)
         and (p_snapshot_months is null or exists (
           select 1 from unnest(p_snapshot_months) m
           where s.flight_date >= (m || '-01')::date
             and s.flight_date < (m || '-01')::date + interval '1 month'))
         and (p_cursor is null or
           (s.captured_at_text,s.source_line,s.record_id) > (v_after1,v_after_line,v_after_id))
       order by s.captured_at_text,s.source_line,s.record_id limit p_page_size + 1)
      union all
      (select b.record_id, b.flight_date::text as order1, b.price_date::text as order2,
          0::bigint as line
       from public.fare_baseline_points b
       where p_dataset = 'baseline' and b.origin=p_origin and b.destination=p_destination
         and (coalesce(p_departure,'')='' or starts_with(b.flight_date::text,p_departure))
         and (p_cursor is null or
           (b.flight_date,b.price_date,b.record_id) > (v_after1::date,v_after2::date,v_after_id))
       order by b.flight_date,b.price_date,b.record_id limit p_page_size + 1)
    ), numbered as materialized (
      select c.*, row_number() over(order by order1,line,order2,record_id) as position,
        count(*) over() as total from candidates c
    )
    select n.*, case when p_dataset='snapshots' then s.payload else b.payload end as payload
    from numbered n
    left join public.fare_snapshots s
      on p_dataset='snapshots' and s.record_id=n.record_id
    left join public.fare_baseline_points b
      on p_dataset='baseline' and b.record_id=n.record_id
    where n.position <= p_page_size
    order by n.position
  loop
    v_order := jsonb_build_array(
      v_row.order1,
      case when p_dataset='snapshots' then v_row.line::text else v_row.order2 end,
      v_row.record_id
    );
    v_item := jsonb_build_object(
      'recordId',v_row.record_id,'order',v_order,'payload',v_row.payload
    );
    v_total := v_row.total;
    v_item_bytes := octet_length(convert_to(v_item::text,'UTF8'));
    if v_item_bytes > 1048576 and cardinality(v_items) = 0 then
      raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
    end if;
    -- The final envelope can only add bytes, so stop before retaining more than
    -- one response budget of item bodies. Exact trimming happens below.
    if v_items_bytes + v_item_bytes > 1048576 then
      exit;
    end if;
    v_items := array_append(v_items,v_item);
    v_orders := array_append(v_orders,v_order);
    v_items_bytes := v_items_bytes + v_item_bytes;
  end loop;

  v_count := cardinality(v_items);
  if v_count = 0 then
    return v_envelope || jsonb_build_object('items',v_items,'nextCursor',null);
  end if;
  v_cursor := case when v_count < v_total then
    v_envelope || jsonb_build_object('after',v_orders[v_count]) else null end;
  v_response := v_envelope || jsonb_build_object('items',v_items,'nextCursor',v_cursor);
  if octet_length(convert_to(v_response::text,'UTF8')) <= 1048576 then
    return v_response;
  end if;

  -- The full page exceeded the wire budget. Find the longest exact prefix in
  -- O(log page-size) whole-response serializations instead of one per row.
  v_low := 1;
  v_high := v_count - 1;
  while v_low <= v_high loop
    v_mid := (v_low + v_high) / 2;
    v_cursor := v_envelope || jsonb_build_object('after',v_orders[v_mid]);
    v_response := v_envelope || jsonb_build_object(
      'items',v_items[1:v_mid],'nextCursor',v_cursor
    );
    if octet_length(convert_to(v_response::text,'UTF8')) <= 1048576 then
      v_best_response := v_response;
      v_low := v_mid + 1;
    else
      v_high := v_mid - 1;
    end if;
  end loop;
  if v_best_response is null then
    raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
  end if;
  return v_best_response;
end;
$$;

revoke all on function public.read_airfare_history_page(
  text,text,text,text[],text,text,text,text,jsonb,integer
) from public, anon, authenticated, service_role;
grant execute on function public.read_airfare_history_page(
  text,text,text,text[],text,text,text,text,jsonb,integer
) to service_role;
