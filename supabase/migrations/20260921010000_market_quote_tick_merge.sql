create function public.merge_market_quote_ticks(p_owner_id uuid, p_rows jsonb)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'quote_ticks_must_be_array';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_rows) item
     where jsonb_typeof(item) <> 'object'
        or nullif(item ->> 'symbol', '') is null
        or nullif(item ->> 'provider', '') is null
        or nullif(item ->> 'fetched_at', '') is null
        or jsonb_typeof(item -> 'payload') <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'invalid_quote_tick';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'symbol')
      from jsonb_array_elements(p_rows) item
  ) then
    raise exception using errcode = '22023', message = 'duplicate_quote_tick_symbol';
  end if;

  update public.market_quotes quote
     set provider = tick.provider,
         market_time = tick.market_time,
         fetched_at = tick.fetched_at,
         payload = quote.payload || tick.payload
    from jsonb_to_recordset(p_rows) as tick(
      symbol text,
      provider text,
      market_time bigint,
      fetched_at timestamptz,
      payload jsonb
    )
   where quote.owner_id = p_owner_id
     and quote.symbol = tick.symbol
     and (
       quote.market_time is null
       or tick.market_time is null
       or tick.market_time >= quote.market_time
     );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.merge_market_quote_ticks(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.merge_market_quote_ticks(uuid, jsonb)
  to service_role;
