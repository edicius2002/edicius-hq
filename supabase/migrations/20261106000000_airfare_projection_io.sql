-- Keep the archive, dirty-month protocol, and read contracts unchanged.
-- Sort scalar offer references, then fetch only the first priced offer's JSON.
-- Reconcile projections without rewriting flights whose values did not change.
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
    select s.record_id,s.flight_date,s.captured_at,s.captured_at_text,
      s.source_line,s.cheapest_price from public.fare_snapshots s
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
    select latest.flight_date,s.payload
    from (
      select distinct on (flight_date) flight_date,record_id
      from month_snapshots
      order by flight_date,captured_at desc,source_line,record_id
    ) latest join public.fare_snapshots s using(record_id)
  ), latest_attempts as (
    select distinct on (flight_date) flight_date, checked_at, outcome, error_code
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
    order by flight_date, checked_at desc, record_id desc
  ), latest_confirmed as (
    select distinct on (flight_date) flight_date, checked_at, outcome
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
      and outcome in ('changed','unchanged','rebaselined','no-offers')
    order by flight_date, checked_at desc, record_id desc
  ), departure_checks as (
    select coalesce(c.flight_date,a.flight_date) as flight_date,
      c.checked_at,c.outcome,a.checked_at as last_attempt_at,
      case when a.outcome='error' then a.error_code else null end as last_error_code
    from latest_confirmed c full join latest_attempts a using(flight_date)
  ), via_sequences as (
    select distinct o.offer->'viaPoints' as points
    from public.fare_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers') o(offer)
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
      and jsonb_typeof(o.offer->'viaPoints')='array'
      and jsonb_array_length(o.offer->'viaPoints') > 0
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
    'currentBoards',coalesce((select jsonb_agg(b.payload order by b.flight_date)
      from latest_boards b join latest_confirmed c using(flight_date)
      where c.outcome <> 'no-offers'),'[]'::jsonb),
    'departureChecks',coalesce((select jsonb_agg(jsonb_build_object(
      'flightDate',flight_date::text,'checkedAt',checked_at,
      'outcome',outcome,'lastAttemptAt',last_attempt_at,
      'lastErrorCode',last_error_code) order by flight_date)
      from departure_checks),'[]'::jsonb),
    'viaSequences',coalesce((select jsonb_agg(points order by points)
      from via_sequences),'[]'::jsonb),
    'health',v_metadata->'health',
    'pairReference',v_metadata->'pairReference'
  ) into v_payload;

  insert into public.fare_month_projections(origin,destination,month,revision,payload,built_at)
  values(p_origin,p_destination,p_month,v_revision,v_payload,now())
  on conflict (origin,destination,month) do update set
    revision=excluded.revision,payload=excluded.payload,built_at=excluded.built_at;

  with month_snapshots as (
    select s.record_id,s.flight_date,s.captured_at,s.captured_at_text,
      s.source_line,s.cheapest_price from public.fare_snapshots s
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), latest_boards as (
    select latest.flight_date,s.payload
    from (
      select distinct on (flight_date) flight_date,record_id
      from month_snapshots
      order by flight_date,captured_at desc,source_line,record_id
    ) latest join public.fare_snapshots s using(record_id)
  ), latest_confirmed as (
    select distinct on (flight_date) flight_date, outcome
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
      and outcome in ('changed','unchanged','rebaselined','no-offers')
    order by flight_date, checked_at desc, record_id desc
  ), latest_keys as (
    select distinct (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
      || '|' || (o.offer->>'departureAt') || '|'
      || coalesce(o.offer->>'arrivalAt','') as flight_key
    from latest_boards b cross join lateral jsonb_array_elements(b.payload->'offers') o(offer)
      left join latest_confirmed c on c.flight_date=b.flight_date
    where c.outcome in ('changed','unchanged','rebaselined')
  ), all_offers as (
    select s.record_id,s.captured_at_text,s.source_line,o.ordinality,
      (o.offer->>'price')::numeric as price,
      (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
        || '|' || (o.offer->>'departureAt') || '|'
        || coalesce(o.offer->>'arrivalAt','') as flight_key
    from public.fare_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers')
        with ordinality o(offer,ordinality)
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
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
    select distinct on (flight_key) flight_key,record_id,ordinality
    from offered
    order by flight_key,captured_at_text,source_line,record_id,ordinality
  ), sightings as (
    select flight_key,count(distinct record_id)::integer as sightings,
      max(captured_at_text) as last_seen_at,
      array_agg(distinct left(captured_at_text,10)::date order by left(captured_at_text,10)::date) as seen_days
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
  ), projected as materialized (
    select t.flight_key,first_offer.offer,f.first_price,p.price,p.previous_price,
      si.sightings,si.last_seen_at,si.seen_days,
      (k.flight_key is not null) as present,
      coalesce(c.outcome not in ('changed','unchanged','rebaselined'),true) as current_unconfirmed,
      case when k.flight_key is null then 'gone'
        when p.previous_price > 0 and p.previous_price <> p.price
          then case when p.price > p.previous_price then 'rose' else 'fell' end
        when si.sightings > 1 then 'unchanged' else 'first' end as category,
      case when k.flight_key is null then null
        when p.previous_price > 0 then 100 * (p.price-p.previous_price)/p.previous_price
        when si.sightings > 1 then 0 else null end as change_percent
    from tracks t join prices p using(flight_key)
      join first_prices f using(flight_key)
      join sightings si using(flight_key)
      join public.fare_snapshots source on source.record_id=t.record_id
      cross join lateral (
        select source.payload->'offers'->(t.ordinality-1)::integer as offer
      ) first_offer
      left join latest_keys k using(flight_key)
      left join latest_confirmed c on c.flight_date::text=left(first_offer.offer->>'departureAt',10)
  ), upserted as (
    insert into public.fare_flight_projections as existing (
      origin,destination,month,flight_key,offer,first_price,price,previous_price,
      sightings,last_seen_at,seen_days,present,current_unconfirmed,category,change_percent
    )
    select p_origin,p_destination,p_month,flight_key,offer,first_price,price,previous_price,
      sightings,last_seen_at,seen_days,present,current_unconfirmed,category,change_percent
    from projected
    on conflict (origin,destination,month,flight_key) do update set
      offer=excluded.offer,first_price=excluded.first_price,price=excluded.price,
      previous_price=excluded.previous_price,sightings=excluded.sightings,
      last_seen_at=excluded.last_seen_at,seen_days=excluded.seen_days,
      present=excluded.present,current_unconfirmed=excluded.current_unconfirmed,
      category=excluded.category,change_percent=excluded.change_percent
    where (existing.offer,existing.first_price,existing.price,existing.previous_price,
      existing.sightings,existing.last_seen_at,existing.seen_days,existing.present,
      existing.current_unconfirmed,existing.category,existing.change_percent)
    is distinct from (excluded.offer,excluded.first_price,excluded.price,excluded.previous_price,
      excluded.sightings,excluded.last_seen_at,excluded.seen_days,excluded.present,
      excluded.current_unconfirmed,excluded.category,excluded.change_percent)
    returning flight_key
  )
  -- The upsert and delete have disjoint key sets; neither rewrites the other's rows.
  delete from public.fare_flight_projections existing
  where existing.origin=p_origin and existing.destination=p_destination
    and existing.month=p_month
    and not exists (select 1 from projected p where p.flight_key=existing.flight_key);
end;
$$;
