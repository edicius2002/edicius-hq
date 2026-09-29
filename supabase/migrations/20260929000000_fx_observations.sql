-- Owner-only USD/PEN captures; references retain publication revisions.
create table public.fx_observations (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  source text not null check(source in ('kambista','tu-cambista','securex','cambio-seguro','dollarhouse','rextie','tkambio','bcrp','sbs')),
  observed_at timestamptz not null,
  effective_at timestamptz not null,
  buy numeric not null check(buy > 0 and buy < 'Infinity'::numeric),
  sell numeric not null check(sell > 0 and sell < 'Infinity'::numeric and buy <= sell),
  context jsonb not null default '{}'::jsonb check(jsonb_typeof(context)='object' and octet_length(context::text)<=2048 and context - array['variant','method','amount_usd','direction','via','series'] = '{}'::jsonb),
  primary key(owner_id,source,effective_at,observed_at)
);
create index fx_observations_owner_source_time on public.fx_observations(owner_id,source,effective_at desc,observed_at desc);
alter table public.fx_observations enable row level security;
create policy fx_observations_select_own on public.fx_observations for select to authenticated using(owner_id=auth.uid());
revoke all on public.fx_observations from public,anon,authenticated,service_role;
grant select on public.fx_observations to authenticated;
grant select,insert,update on public.fx_observations to service_role;
alter table public.collector_runs drop constraint collector_runs_collector_check;
alter table public.collector_runs add constraint collector_runs_collector_check check(collector in ('airfare','airfare-requests','x-posts','sentiment','market','fx'));

-- Definer functions explicitly gate the allowlist and scope every read to auth.uid().
create function public.read_fx_latest() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_result jsonb;
begin
  if v_owner is null or not exists(select 1 from public.edicius_owners where owner_id=v_owner) then
    raise exception 'owner access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by source),'[]'::jsonb) into v_result
  from (select distinct on (source) owner_id,source,observed_at,effective_at,buy,sell,context
        from public.fx_observations where owner_id=v_owner
        order by source,effective_at desc,observed_at desc) t;
  return v_result;
end $$;

create function public.read_fx_history(p_source text,p_range text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid := auth.uid(); v_since timestamptz; v_daily boolean; v_points jsonb;
begin
  if v_owner is null or not exists(select 1 from public.edicius_owners where owner_id=v_owner) then
    raise exception 'owner access required' using errcode='42501';
  end if;
  if p_source is null or p_source not in ('kambista','tu-cambista','securex','cambio-seguro','dollarhouse','rextie','tkambio','bcrp','sbs') or p_range is null or p_range not in ('1D','7D','1M','1Y','ALL') then
    raise exception 'invalid FX source or range' using errcode='22023';
  end if;
  v_since := case p_range when '1D' then now()-interval '1 day' when '7D' then now()-interval '7 days' when '1M' then now()-interval '1 month' when '1Y' then now()-interval '1 year' else '-infinity'::timestamptz end;
  v_daily := p_range in ('1M','1Y','ALL') or p_source in ('bcrp','sbs');
  with revisions as (
    select distinct on (effective_at) owner_id,source,observed_at,effective_at,buy,sell,context
    from public.fx_observations
    where owner_id=v_owner and source=p_source and effective_at>=v_since and effective_at<=now()
    order by effective_at,observed_at desc
  ), ranked as (
    select *,row_number() over(partition by (effective_at at time zone 'America/Lima')::date order by effective_at desc,observed_at desc) as day_rank from revisions
  )
  select coalesce(jsonb_agg(to_jsonb(r)-'day_rank' order by effective_at),'[]'::jsonb) into v_points
  from ranked r where not v_daily or day_rank=1;
  return jsonb_build_object('points',v_points,'aggregation',case when v_daily then 'daily' else 'observations' end);
end $$;
revoke all on function public.read_fx_latest(), public.read_fx_history(text,text) from public,anon,authenticated,service_role;
grant execute on function public.read_fx_latest(), public.read_fx_history(text,text) to authenticated;
