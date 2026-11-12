-- Departure summaries are immutable archive partitions, not replacement observations.
create table public.airfare_retention_state (
 singleton boolean primary key default true check(singleton),
 cutoff date, target_cutoff date, phase text not null default 'verified', run_id uuid
);
insert into public.airfare_retention_state(singleton) values(true);
create table public.airfare_retention_runs (
 run_id uuid primary key, target_cutoff date not null,
 phase text not null default 'summarized', progress jsonb not null default '{}',
 manifest jsonb, started_at timestamptz not null default now()
);
create table public.fare_departure_summaries (
 origin text not null check(origin ~ '^[A-Z0-9]{3}$'),
 destination text not null check(destination ~ '^[A-Z0-9]{3}$'),
 flight_date date not null, payload jsonb not null,
 digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 primary key(origin,destination,flight_date)
);
alter table public.airfare_retention_state enable row level security;
alter table public.airfare_retention_runs enable row level security;
alter table public.fare_departure_summaries enable row level security;
revoke all on public.airfare_retention_state,public.airfare_retention_runs,public.fare_departure_summaries from public,authenticated;

-- Matches sorted-key, compact UTF-8 JSON used by DepartureSummary.canonical_json.
create function public.airfare_canonical_json(p jsonb) returns text
language sql immutable set search_path='' as $$
 select case jsonb_typeof(p)
 when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||public.airfare_canonical_json(value),',' order by key collate "C") from jsonb_each(p)),'')||'}'
 when 'array' then '['||coalesce((select string_agg(public.airfare_canonical_json(value),',' order by ordinality) from jsonb_array_elements(p) with ordinality),'')||']'
 else p::text end;
$$;

create function public.begin_airfare_retention(p_run_id uuid,p_cutoff date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.airfare_retention_state; r public.airfare_retention_runs;
begin
 select * into s from public.airfare_retention_state where singleton for update;
 if p_run_id is null or p_cutoff is null or p_cutoff>(now() at time zone 'UTC')::date-1
 or p_cutoff<greatest(s.cutoff,s.target_cutoff) then
 raise exception using errcode='22023',message='invalid_airfare_retention_cutoff'; end if;
 select * into r from public.airfare_retention_runs where run_id=p_run_id;
 if found then
 if r.target_cutoff<>p_cutoff then raise exception 'airfare_retention_run_conflict'; end if;
 return to_jsonb(s);
 end if;
 if s.phase<>'verified' then raise exception 'airfare_retention_in_progress'; end if;
 insert into public.airfare_retention_runs(run_id,target_cutoff) values(p_run_id,p_cutoff);
 update public.airfare_retention_state set target_cutoff=p_cutoff,phase='summarized',run_id=p_run_id where singleton returning * into s;
 update public.airfare_history_revision set revision=revision+1 where singleton;
 return to_jsonb(s);
end; $$;

create function public.fence_airfare_departure() returns trigger
language plpgsql security definer set search_path='' as $$
declare c date;
begin
 -- Share lock serializes pre-existing inserts with the begin transaction.
 select greatest(cutoff,target_cutoff) into c from public.airfare_retention_state where singleton for share;
 if c is null then return new; end if;
 if TG_TABLE_NAME='fare_calendar_captures' then
 if exists(select 1 from jsonb_each(case when jsonb_typeof(new.payload->'prices')='object' then new.payload->'prices' else '{}' end) e where e.key::date<c)
 or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(new.payload->'prices')='array' then new.payload->'prices' else '[]' end) e where (e->>'departureDate')::date<c)
 then raise exception using errcode='22023',message='airfare_departure_expired'; end if;
 elsif TG_TABLE_NAME='fare_checks' then
 if new.kind='board' and new.flight_date<c then raise exception using errcode='22023',message='airfare_departure_expired'; end if;
 elsif new.flight_date<c then raise exception using errcode='22023',message='airfare_departure_expired'; end if;
 return new;
end; $$;
create trigger airfare_retention_fence before insert or update on public.fare_snapshots for each row execute function public.fence_airfare_departure();
create trigger airfare_retention_fence before insert or update on public.fare_baseline_points for each row execute function public.fence_airfare_departure();
create trigger airfare_retention_fence before insert or update on public.fare_checks for each row execute function public.fence_airfare_departure();
create trigger airfare_retention_fence before insert or update on public.fare_calendar_captures for each row execute function public.fence_airfare_departure();

create function public.publish_airfare_departure_summary(p_run_id uuid,p_payload jsonb,p_digest text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.airfare_retention_state; old public.fare_departure_summaries; d date;
begin
 select * into s from public.airfare_retention_state where singleton for update;
 d:=(p_payload->>'flight_date')::date;
 if s.run_id is distinct from p_run_id or s.phase='verified' or d is null or d>=s.target_cutoff then raise exception 'invalid_airfare_retention_partition'; end if;
 if p_payload->>'version' is distinct from '1' or p_digest is distinct from encode(sha256(convert_to(public.airfare_canonical_json(p_payload),'UTF8')),'hex')
 or (select array_agg(key order by key) from jsonb_object_keys(p_payload) key) is distinct from array['destination','flight_date','health','latest_capture','minimum_price','origin','price_days','provider_days','unsold_days','version']
 then raise exception 'invalid_airfare_summary'; end if;
 select * into old from public.fare_departure_summaries where origin=p_payload->>'origin' and destination=p_payload->>'destination' and flight_date=d;
 if found then
 if old.digest<>p_digest or old.payload<>p_payload then raise exception 'airfare_summary_conflict'; end if;
 return;
 end if;
 insert into public.fare_departure_summaries values(p_payload->>'origin',p_payload->>'destination',d,p_payload,p_digest);
 perform public.mark_fare_projection_month(p_payload->>'origin',p_payload->>'destination',to_char(d,'YYYY-MM'));
 update public.airfare_history_revision set revision=revision+1 where singleton;
end; $$;

create function public.prune_airfare_departure(p_run_id uuid,p_origin text,p_destination text,p_flight_date date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.airfare_retention_state; k text;
begin
 select * into s from public.airfare_retention_state where singleton for update;
 if s.run_id is distinct from p_run_id or s.phase='verified' or p_flight_date>=s.target_cutoff then raise exception 'invalid_airfare_retention_partition'; end if;
 if not exists(select 1 from public.fare_departure_summaries where origin=p_origin and destination=p_destination and flight_date=p_flight_date) then
 raise exception using errcode='55000',message='airfare_summary_required'; end if;
 delete from public.fare_snapshots where origin=p_origin and destination=p_destination and flight_date=p_flight_date;
 delete from public.fare_baseline_points where origin=p_origin and destination=p_destination and flight_date=p_flight_date;
 delete from public.fare_checks where kind='board' and origin=p_origin and destination=p_destination and flight_date=p_flight_date;
 perform public.mark_fare_projection_month(p_origin,p_destination,to_char(p_flight_date,'YYYY-MM'));
 perform public.refresh_fare_month_projection(p_origin,p_destination,to_char(p_flight_date,'YYYY-MM'));
 k:=p_origin||'-'||p_destination||'/'||p_flight_date::text;
 update public.airfare_retention_runs set phase='pruned',progress=progress||jsonb_build_object(k,'pruned') where run_id=p_run_id;
 update public.airfare_retention_state set phase='pruned' where singleton;
 return jsonb_build_object('departure',k,'phase','pruned');
end; $$;
create function public.airfare_summary_days(p_origin text,p_destination text,p_month text,p_kind text) returns jsonb
language sql stable security definer set search_path='' as $$
 with frequencies as (
 select left(s.captured_at_text,10) as observation_day,s.cheapest_price price,1::bigint n from public.fare_snapshots s
 where p_kind='price_days' and s.origin=p_origin and s.destination=p_destination and to_char(s.flight_date,'YYYY-MM')=p_month and s.cheapest_price is not null
 and not exists(select 1 from public.fare_departure_summaries a where (a.origin,a.destination,a.flight_date)=(s.origin,s.destination,s.flight_date))
 union all
 select b.price_date::text,b.price,1 from public.fare_baseline_points b
 where p_kind='provider_days' and b.origin=p_origin and b.destination=p_destination and to_char(b.flight_date,'YYYY-MM')=p_month
 and not exists(select 1 from public.fare_departure_summaries a where (a.origin,a.destination,a.flight_date)=(b.origin,b.destination,b.flight_date))
 union all
 select d.key,(f->>0)::numeric,(f->>1)::bigint from public.fare_departure_summaries a
 cross join lateral jsonb_each(a.payload->p_kind) d cross join lateral jsonb_array_elements(d.value) f
 where a.origin=p_origin and a.destination=p_destination and to_char(a.flight_date,'YYYY-MM')=p_month
 ), grouped as(select observation_day,price,sum(n) n from frequencies group by observation_day,price),
 ranked as(select *,sum(n) over(partition by observation_day order by price) cumulative,sum(n) over(partition by observation_day) total from grouped),
 days as(select observation_day,min(price) low,max(price) high,max(total) observations,
 trim_scale((min(price) filter(where cumulative>=floor((total+1)/2))+min(price) filter(where cumulative>=floor((total+2)/2)))/2) middle from ranked group by observation_day)
 select coalesce(jsonb_agg(jsonb_build_object('key',observation_day,'low',low,'high',high,'middle',middle,'count',observations) order by observation_day),'[]') from days;
$$;
create function public.airfare_summary_unsold(p_origin text,p_destination text,p_month text) returns jsonb
language sql stable security definer set search_path='' as $$
 with counts as (
 select left(s.captured_at_text,10) as observation_day,count(*) n from public.fare_snapshots s where s.origin=p_origin and s.destination=p_destination and to_char(s.flight_date,'YYYY-MM')=p_month and cheapest_price is null
 and not exists(select 1 from public.fare_departure_summaries a where (a.origin,a.destination,a.flight_date)=(s.origin,s.destination,s.flight_date)) group by 1
 union all select d.key,(d.value#>>'{}')::bigint from public.fare_departure_summaries a cross join lateral jsonb_each(a.payload->'unsold_days') d
 where a.origin=p_origin and a.destination=p_destination and to_char(a.flight_date,'YYYY-MM')=p_month
 ), days as(select observation_day,sum(n) n from counts group by observation_day)
 select coalesce(jsonb_agg(jsonb_build_object('key',observation_day,'count',n) order by observation_day),'[]') from days;
$$;

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
    from month_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers') o(offer)
    where jsonb_typeof(o.offer->'viaPoints')='array'
      and jsonb_array_length(o.offer->'viaPoints') > 0
  )
  select jsonb_build_object(
    'origin',p_origin,'destination',p_destination,'month',p_month,
    'revision',v_revision::text,
    'latestCapture',greatest((select max(captured_at_text) from month_snapshots),(select max(payload->>'latest_capture') from public.fare_departure_summaries where origin=p_origin and destination=p_destination and to_char(flight_date,'YYYY-MM')=p_month)),
    'retention',jsonb_build_object('cutoff',(select cutoff from public.airfare_retention_state where singleton),'detailExpired',exists(select 1 from public.fare_departure_summaries where origin=p_origin and destination=p_destination and to_char(flight_date,'YYYY-MM')=p_month) and not exists(select 1 from month_snapshots)),
    'priceDays',public.airfare_summary_days(p_origin,p_destination,p_month,'price_days'),
    'providerDays',public.airfare_summary_days(p_origin,p_destination,p_month,'provider_days'),
    'unsoldDays',public.airfare_summary_unsold(p_origin,p_destination,p_month),
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
    sightings,last_seen_at,seen_days,present,current_unconfirmed,category,change_percent
  )
  select p_origin,p_destination,p_month,t.flight_key,t.offer,f.first_price,p.price,
    p.previous_price,si.sightings,si.last_seen_at,si.seen_days,
    (k.flight_key is not null),coalesce(c.outcome not in ('changed','unchanged','rebaselined'),true),
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
    left join latest_keys k using(flight_key)
    left join latest_confirmed c on c.flight_date::text=left(t.offer->>'departureAt',10);
end;
$$;



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
    raise exception using errcode = 'PT409', message = 'airfare_history_revision_changed';
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
    and not exists(select 1 from public.fare_departure_summaries a where (a.origin,a.destination,a.flight_date)=(fare_snapshots.origin,fare_snapshots.destination,fare_snapshots.flight_date))
    group by flight_date
    union all select flight_date,(payload->>'minimum_price')::numeric from public.fare_departure_summaries where origin=p_origin and destination=p_destination and payload->>'minimum_price' is not null
  ), pair_reference as (
    select case when count(*) = 0 then null else jsonb_build_object(
      'value', percentile_cont(0.5) within group (order by price), 'dates', count(*)
    ) end as body from per_departure
  ), health_rows as (
    select payload->>'at' latest,1::bigint checks,(outcome='changed')::int changes,(outcome='error')::int errors from public.fare_checks c
    where kind='board' and origin=p_origin and destination=p_destination
      and (coalesce(p_departure,'')='' or starts_with(flight_date::text,p_departure))
      and not exists(select 1 from public.fare_departure_summaries a where (a.origin,a.destination,a.flight_date)=(c.origin,c.destination,c.flight_date))
    union all select payload#>>'{health,last_checked_at}',(payload#>>'{health,checks}')::bigint,(payload#>>'{health,changes}')::int,(payload#>>'{health,errors}')::int
    from public.fare_departure_summaries where origin=p_origin and destination=p_destination and (coalesce(p_departure,'')='' or starts_with(flight_date::text,p_departure))
  ), health as (
    select jsonb_build_object('lastCheckedAt',max(latest),'checks',coalesce(sum(checks),0),'changes',coalesce(sum(changes),0),'errors',coalesce(sum(errors),0)) body from health_rows
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
  if p_departure ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     and coalesce(p_since,'')='' and coalesce(p_until,'')='' then
    v_body := v_body || jsonb_build_object(
      'priceDays',public.airfare_summary_days(p_origin,p_destination,p_departure,'price_days'),
      'providerDays',public.airfare_summary_days(p_origin,p_destination,p_departure,'provider_days'),
      'unsoldDays',public.airfare_summary_unsold(p_origin,p_destination,p_departure));
  end if;
  if (select cutoff from public.airfare_retention_state where singleton) is not null then
    v_body := v_body || jsonb_build_object('retention',jsonb_build_object(
      'cutoff',(select cutoff from public.airfare_retention_state where singleton),
      'detailExpired',p_departure ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
        and exists(select 1 from public.fare_departure_summaries where origin=p_origin and destination=p_destination and to_char(flight_date,'YYYY-MM')=p_departure)
        and not exists(select 1 from public.fare_snapshots where origin=p_origin and destination=p_destination and to_char(flight_date,'YYYY-MM')=p_departure)));
  end if;
  if octet_length(convert_to(v_body::text,'UTF8')) > 1048576 then
    raise exception using errcode = '22023', message = 'airfare_history_metadata_too_large';
  end if;
  return v_body;
end;
$$;
revoke all on function public.read_airfare_history_meta(text,text,text,text[],text,text,text) from public, authenticated;


create or replace function public.refresh_fare_route_projection(
  p_origin text,p_destination text
) returns integer language plpgsql security definer
  set search_path = '' set statement_timeout = '60s' as $$
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
      select to_char(flight_date,'YYYY-MM') from public.fare_departure_summaries where origin=p_origin and destination=p_destination
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
    ) or exists(select 1 from public.fare_departure_summaries where origin=p_origin and destination=p_destination and flight_date>=v_from and flight_date<v_to) then
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

create or replace function public.read_airfare_calendar(p_origin text, p_destination text)
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
    select greatest(newest.from_date,(select cutoff from public.airfare_retention_state where singleton)) as from_date, (select max(to_date) from curves) as to_date
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
create or replace function public.airfare_dataset_manifest()
returns jsonb
language sql stable security invoker
set search_path = '' set statement_timeout = '30s'
as $$
  with records as (
    select 'snapshots' as dataset, origin, destination, record_id from public.fare_snapshots
    union all
    select 'baseline', origin, destination, record_id from public.fare_baseline_points
    union all
    select 'calendar', origin, destination, record_id from public.fare_calendar_captures
    union all
    select kind || '_checks', origin, destination, record_id from public.fare_checks
    union all select 'summaries',origin,destination,digest from public.fare_departure_summaries
  ),
  groups as (
    select dataset, origin || '-' || destination as route, count(*) as count,
           encode(sha256(convert_to(string_agg(record_id, chr(10) order by record_id), 'UTF8')), 'hex') as digest
    from records
    group by dataset, origin, destination
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'dataset', dataset, 'route', route, 'count', count, 'digest', digest
  ) order by dataset, route), '[]'::jsonb) || jsonb_build_array((select to_jsonb(s)||jsonb_build_object('dataset','retention','route','*') from public.airfare_retention_state s where singleton))
  from groups;
$$;

-- Replace only a fenced curve, validating the surviving points against its source.
-- The caller supplies the canonical record identity and metadata used by normal sync.
create function public.replace_airfare_retention_calendar(p_run_id uuid,p_record_id text,p_replacement jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.airfare_retention_state; old public.fare_calendar_captures; expected jsonb;
begin
 select * into s from public.airfare_retention_state where singleton for update;
 if s.run_id is distinct from p_run_id or s.phase='verified' then raise exception 'invalid_airfare_retention_run'; end if;
 select * into old from public.fare_calendar_captures where record_id=p_record_id for update;
 if not found then
 if p_replacement is null or exists(select 1 from public.fare_calendar_captures where record_id=p_replacement->>'record_id' and payload=p_replacement->'payload') then return; end if;
 raise exception 'airfare_calendar_source_missing'; end if;
 if jsonb_typeof(old.payload->'prices')='object' then
 select coalesce(jsonb_object_agg(key,value),'{}') into expected from jsonb_each(old.payload->'prices') where key::date>=s.target_cutoff;
 else
 select coalesce(jsonb_agg(value order by ordinality),'[]') into expected from jsonb_array_elements(old.payload->'prices') with ordinality where (value->>'departureDate')::date>=s.target_cutoff;
 end if;
 if expected=old.payload->'prices' and old.from_date>=s.target_cutoff then raise exception 'airfare_calendar_not_expired'; end if;
 if p_replacement is null then
 if expected not in ('{}'::jsonb,'[]'::jsonb) then raise exception 'airfare_calendar_future_points_required'; end if;
 else
 if p_replacement->'payload'->'prices' is distinct from expected
 or (p_replacement->'payload')-array['prices','from','to','fromDate','toDate'] is distinct from old.payload-array['prices','from','to','fromDate','toDate']
 or (p_replacement->>'from_date')::date<s.target_cutoff
 or (p_replacement->>'to_date')::date is distinct from old.to_date
 or (p_replacement->'payload'->>'from')::date is distinct from (p_replacement->>'from_date')::date
 or (p_replacement->'payload'->>'to')::date is distinct from old.to_date
 then raise exception 'airfare_calendar_replacement_mismatch'; end if;
 insert into public.fare_calendar_captures(record_id,origin,destination,captured_at,source_line,from_date,to_date,source,currency,payload)
 values(p_replacement->>'record_id',old.origin,old.destination,old.captured_at,(p_replacement->>'source_line')::bigint,(p_replacement->>'from_date')::date,(p_replacement->>'to_date')::date,old.source,old.currency,p_replacement->'payload');
 end if;
 delete from public.fare_calendar_captures where record_id=p_record_id;
end; $$;

create function public.finish_airfare_retention(p_run_id uuid,p_manifest jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.airfare_retention_state; actual jsonb; supplied jsonb;
begin
 select * into s from public.airfare_retention_state where singleton for update;
 if s.run_id is distinct from p_run_id then raise exception 'invalid_airfare_retention_run'; end if;
 if exists(select 1 from public.fare_snapshots where flight_date<s.target_cutoff)
 or exists(select 1 from public.fare_baseline_points where flight_date<s.target_cutoff)
 or exists(select 1 from public.fare_checks where kind='board' and flight_date<s.target_cutoff)
 or exists(select 1 from public.fare_calendar_captures c cross join lateral jsonb_each(case when jsonb_typeof(c.payload->'prices')='object' then c.payload->'prices' else '{}' end) e where e.key::date<s.target_cutoff)
 or exists(select 1 from public.fare_calendar_captures c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.payload->'prices')='array' then c.payload->'prices' else '[]' end) e where (e->>'departureDate')::date<s.target_cutoff)
 then raise exception 'airfare_retention_detail_remaining'; end if;
 select coalesce(jsonb_agg(e order by e->>'dataset',e->>'route'),'[]') into actual from jsonb_array_elements(public.airfare_dataset_manifest()) e where e->>'dataset'<>'retention';
 select coalesce(jsonb_agg(e order by e->>'dataset',e->>'route'),'[]') into supplied from jsonb_array_elements(p_manifest) e where e->>'dataset'<>'retention';
 if p_manifest is null or actual is distinct from supplied then raise exception 'airfare_retention_manifest_mismatch'; end if;
 update public.airfare_retention_state set cutoff=target_cutoff,phase='verified' where singleton returning * into s;
 update public.airfare_retention_runs set phase='verified',manifest=p_manifest where run_id=p_run_id;
 update public.airfare_history_revision set revision=revision+1 where singleton;
 insert into public.fare_projection_dirty_routes(origin,destination,needs_full_refresh)
 select distinct origin,destination,true from public.fare_departure_summaries
 on conflict(origin,destination) do update set needs_full_refresh=true,changed_at=now();
 return to_jsonb(s);
end; $$;

revoke all on function public.airfare_canonical_json(jsonb),public.fence_airfare_departure(),public.airfare_summary_days(text,text,text,text),public.airfare_summary_unsold(text,text,text) from public,authenticated;
revoke all on function public.begin_airfare_retention(uuid,date),public.publish_airfare_departure_summary(uuid,jsonb,text),public.prune_airfare_departure(uuid,text,text,date),public.finish_airfare_retention(uuid,jsonb),public.replace_airfare_retention_calendar(uuid,text,jsonb) from public,authenticated;
notify pgrst, 'reload schema';
