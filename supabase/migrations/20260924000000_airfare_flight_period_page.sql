alter table public.fare_flight_projections add column seen_days date[] not null default '{}';
create index fare_flight_projections_seen_days_idx on public.fare_flight_projections using gin (seen_days);

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
  ), via_sequences as (
    select distinct o.offer->'viaPoints' as points
    from month_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers') o(offer)
    where jsonb_typeof(o.offer->'viaPoints')='array'
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
    'viaSequences',coalesce((select jsonb_agg(points order by points)
      from via_sequences),'[]'::jsonb),
    'health',v_metadata->'health',
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
  )
  insert into public.fare_flight_projections(
    origin,destination,month,flight_key,offer,first_price,price,previous_price,
    sightings,last_seen_at,seen_days,present,category,change_percent
  )
  select p_origin,p_destination,p_month,t.flight_key,t.offer,f.first_price,p.price,
    p.previous_price,si.sightings,si.last_seen_at,si.seen_days,
    (k.flight_key is not null),
    case when k.flight_key is null then 'gone'
      when p.previous_price > 0 and p.previous_price <> p.price
        then case when p.price > p.previous_price then 'rose' else 'fell' end
      when si.sightings > 1 then 'unchanged' else 'first' end,
    case when k.flight_key is null then null
      when p.previous_price > 0 then 100 * (p.price-p.previous_price)/p.previous_price
      when si.sightings > 1 then 0 else null end
  from tracks t join prices p using(flight_key)
    join first_prices f using(flight_key)
    join sightings si using(flight_key)
    left join latest_keys k using(flight_key);
end;
$$;

-- The table reads only its visible observation period and one 10-row page.
create or replace function public.read_owner_fare_flights_page(
  p_origin text, p_destination text, p_month text, p_from date, p_to date,
  p_filters jsonb default '{}'::jsonb, p_sort text default 'departs',
  p_direction text default 'asc', p_page integer default 1, p_page_size integer default 10
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_revision bigint;
  v_latest jsonb;
  v_tracked integer;
  v_in_period integer;
  v_shown integer;
  v_page integer;
  v_page_count integer;
  v_rows jsonb;
  v_facets jsonb;
  v_period_days date[];
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id=auth.uid()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  if p_origin !~ '^[A-Z0-9]{3}$' or p_destination !~ '^[A-Z0-9]{3}$'
    or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    or p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366
    or p_filters is null or jsonb_typeof(p_filters) <> 'object'
    or p_sort not in ('departs','airline','flight','stops','duration','price','change')
    or p_direction not in ('asc','desc')
    or p_page is null or p_page < 1 or p_page > 100000
    or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode='22023',message='invalid_fare_flight_page_request';
  end if;

  select m.revision,m.payload->'latestCapture' into v_revision,v_latest
  from public.fare_month_projections m
  where m.origin=p_origin and m.destination=p_destination and m.month=p_month;
  if not found then return null; end if;
  select array_agg(day::date) into v_period_days
  from pg_catalog.generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') as days(day);

  select count(*) into v_tracked from public.fare_flight_projections f
  where f.origin=p_origin and f.destination=p_destination and f.month=p_month;

  with period_rows as materialized (
    select f.*,
      case when f.offer->>'departureAt' ~ 'T[0-9]{2}:'
        then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer
        else null end as departure_hour,
      greatest(0,coalesce((f.offer->>'transfers')::integer,0)) as stop_count,
      coalesce(f.offer->>'airlineName',f.offer->>'airline') as airline_label
    from public.fare_flight_projections f
    where f.origin=p_origin and f.destination=p_destination and f.month=p_month
      and f.seen_days && v_period_days
  ), filtered as materialized (
    select * from period_rows r where
      ((p_filters->>'minPrice') is null or r.price >= (p_filters->>'minPrice')::numeric)
      and ((p_filters->>'maxPrice') is null or r.price <= (p_filters->>'maxPrice')::numeric)
      and ((p_filters->>'airline') is null or r.offer->>'airline'=p_filters->>'airline')
      and ((p_filters->>'stops') is null or r.stop_count=(p_filters->>'stops')::integer)
      and ((p_filters->>'maxDuration') is null or
        (r.offer->>'durationMinutes')::integer <= (p_filters->>'maxDuration')::integer)
      and ((p_filters->>'change') is null or r.category=p_filters->>'change')
      and ((p_filters->>'band') is null or
        case p_filters->>'band'
          when 'night' then r.departure_hour between 0 and 5
          when 'morning' then r.departure_hour between 6 and 11
          when 'afternoon' then r.departure_hour between 12 and 17
          when 'evening' then r.departure_hour between 18 and 23
          else false end)
  )
  select
    (select count(*) from period_rows),
    (select count(*) from filtered),
    jsonb_build_object(
      'airlines',coalesce((select jsonb_agg(jsonb_build_object('value',airline,'label',label) order by lower(label),airline)
        from (select distinct offer->>'airline' as airline,airline_label as label from period_rows) a),'[]'::jsonb),
      'price',(select jsonb_build_object('low',min(price),'high',max(price)) from period_rows having count(*) > 0),
      'bands',coalesce((select jsonb_agg(band order by rank) from (
        select distinct case when departure_hour between 0 and 5 then 'night'
          when departure_hour between 6 and 11 then 'morning'
          when departure_hour between 12 and 17 then 'afternoon'
          when departure_hour between 18 and 23 then 'evening' end as band,
          case when departure_hour between 0 and 5 then 1
          when departure_hour between 6 and 11 then 2
          when departure_hour between 12 and 17 then 3
          when departure_hour between 18 and 23 then 4 end as rank
        from period_rows where departure_hour is not null) b),'[]'::jsonb),
      'stops',coalesce((select jsonb_agg(stop_count order by stop_count)
        from (select distinct stop_count from period_rows) s),'[]'::jsonb),
      'durations',coalesce((select jsonb_agg(duration order by duration)
        from (select distinct (offer->>'durationMinutes')::integer as duration
          from period_rows where offer->>'durationMinutes' is not null) d),'[]'::jsonb),
      'categories',coalesce((select jsonb_agg(category order by category)
        from (select distinct category from period_rows) c),'[]'::jsonb)
    )
  into v_in_period,v_shown,v_facets;

  v_page_count := greatest(1,ceil(v_shown::numeric / p_page_size)::integer);
  v_page := least(p_page,v_page_count);

  with rows as (
    select f.*,
      greatest(0,coalesce((f.offer->>'transfers')::integer,0)) as stop_count,
      lower(coalesce(f.offer->>'airlineName',f.offer->>'airline')) as airline_sort,
      lower((f.offer->>'airline') || ' ' || coalesce(f.offer->>'flightNumber','')) as flight_sort
    from public.fare_flight_projections f
    where f.origin=p_origin and f.destination=p_destination and f.month=p_month
      and f.seen_days && v_period_days
      and ((p_filters->>'minPrice') is null or f.price >= (p_filters->>'minPrice')::numeric)
      and ((p_filters->>'maxPrice') is null or f.price <= (p_filters->>'maxPrice')::numeric)
      and ((p_filters->>'airline') is null or f.offer->>'airline'=p_filters->>'airline')
      and ((p_filters->>'stops') is null or greatest(0,coalesce((f.offer->>'transfers')::integer,0))=(p_filters->>'stops')::integer)
      and ((p_filters->>'maxDuration') is null or (f.offer->>'durationMinutes')::integer <= (p_filters->>'maxDuration')::integer)
      and ((p_filters->>'change') is null or f.category=p_filters->>'change')
      and ((p_filters->>'band') is null or
        case p_filters->>'band'
          when 'night' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 0 and 5
          when 'morning' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 6 and 11
          when 'afternoon' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 12 and 17
          when 'evening' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 18 and 23
          else false end)
  ), selected as (
    select r.*,row_number() over (order by
      case when p_sort='departs' and p_direction='asc' then r.offer->>'departureAt' end asc nulls last,
      case when p_sort='departs' and p_direction='desc' then r.offer->>'departureAt' end desc nulls last,
      case when p_sort='airline' and p_direction='asc' then r.airline_sort end asc nulls last,
      case when p_sort='airline' and p_direction='desc' then r.airline_sort end desc nulls last,
      case when p_sort='flight' and p_direction='asc' then r.flight_sort end asc nulls last,
      case when p_sort='flight' and p_direction='desc' then r.flight_sort end desc nulls last,
      case when p_sort='stops' and p_direction='asc' then r.stop_count end asc nulls last,
      case when p_sort='stops' and p_direction='desc' then r.stop_count end desc nulls last,
      case when p_sort='duration' and p_direction='asc' then (r.offer->>'durationMinutes')::integer end asc nulls last,
      case when p_sort='duration' and p_direction='desc' then (r.offer->>'durationMinutes')::integer end desc nulls last,
      case when p_sort='price' and p_direction='asc' then r.price end asc nulls last,
      case when p_sort='price' and p_direction='desc' then r.price end desc nulls last,
      case when p_sort='change' and p_direction='asc' then r.change_percent end asc nulls last,
      case when p_sort='change' and p_direction='desc' then r.change_percent end desc nulls last,
      r.offer->>'departureAt',r.flight_key) as position
    from rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key',flight_key,'offer',offer,'price',price,'previousPrice',previous_price,
    'firstPrice',first_price,'sightings',sightings,'lastSeenAt',last_seen_at,
    'present',present,'category',category,'change',change_percent
  ) order by position),'[]'::jsonb) into v_rows from selected
  where position between (v_page-1)*p_page_size+1 and v_page*p_page_size;

  return jsonb_build_object(
    'revision',v_revision::text,'latestCapture',v_latest,
    'tracked',v_tracked,'inPeriod',v_in_period,'shown',v_shown,
    'page',v_page,'pageCount',v_page_count,'rows',v_rows,'facets',v_facets
  );
end;
$$;
revoke all on function public.read_owner_fare_flights_page(text,text,text,date,date,jsonb,text,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_owner_fare_flights_page(text,text,text,date,date,jsonb,text,text,integer,integer)
  to authenticated, service_role;
