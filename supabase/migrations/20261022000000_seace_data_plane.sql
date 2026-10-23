-- SEACE is an owner-scoped dataset in the existing Edicius project.
-- Raw source fields stay in payload so the UI can display them without translation.
create table public.seace_records (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  kind text not null check (kind in ('notices', 'processes', 'contracts')),
  record_key text not null,
  region text not null,
  year integer not null check (year between 2024 and 2100),
  published_at timestamptz,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  last_seen_at timestamptz not null default now(),
  primary key (owner_id, kind, record_key)
);

create index seace_records_region_kind_published_idx
  on public.seace_records (owner_id, region, kind, published_at desc nulls last);

create table public.seace_sync_state (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  region text not null,
  year integer not null check (year between 2024 and 2100),
  kind text not null check (kind in ('notices', 'processes', 'contracts')),
  fetched_at timestamptz not null,
  record_count integer not null check (record_count >= 0),
  primary key (owner_id, region, year, kind)
);

create table public.seace_exclusions (
  owner_id uuid not null default auth.uid() references public.edicius_owners(owner_id) on delete cascade,
  record_key text not null check (length(record_key) between 1 and 500),
  excluded_at timestamptz not null default now(),
  primary key (owner_id, record_key)
);

alter table public.seace_records enable row level security;
alter table public.seace_sync_state enable row level security;
alter table public.seace_exclusions enable row level security;

create policy seace_records_select_own on public.seace_records
  for select to authenticated using (owner_id = auth.uid());
create policy seace_sync_state_select_own on public.seace_sync_state
  for select to authenticated using (owner_id = auth.uid());
create policy seace_exclusions_select_own on public.seace_exclusions
  for select to authenticated using (owner_id = auth.uid());
create policy seace_exclusions_insert_own on public.seace_exclusions
  for insert to authenticated with check (owner_id = auth.uid());
create policy seace_exclusions_delete_own on public.seace_exclusions
  for delete to authenticated using (owner_id = auth.uid());

revoke all on public.seace_records, public.seace_sync_state, public.seace_exclusions
  from public, anon, authenticated, service_role;
grant select on public.seace_records, public.seace_sync_state to authenticated;
grant select, insert, delete on public.seace_exclusions to authenticated;
grant select, insert, update on public.seace_records, public.seace_sync_state to service_role;
grant select, insert, update, delete on public.seace_exclusions to service_role;

alter table public.collector_requests drop constraint collector_requests_operation_check;
alter table public.collector_requests add constraint collector_requests_operation_check
  check (operation in ('market-bars', 'market-search', 'airfare-route', 'seace-refresh'));
alter table public.collector_runs drop constraint collector_runs_collector_check;
alter table public.collector_runs add constraint collector_runs_collector_check
  check (collector in ('airfare', 'airfare-requests', 'x-posts', 'sentiment', 'market', 'fx', 'seace'));

create unique index collector_requests_active_seace_refresh_idx
  on public.collector_requests(owner_id, (payload->>'region'), (payload->>'year'))
  where operation = 'seace-refresh' and status in ('queued', 'running');

create function public.enqueue_seace_refresh(p_region text, p_year integer)
returns public.collector_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_region text := upper(trim(p_region));
  v_request public.collector_requests;
begin
  if v_owner is null or not exists (
    select 1 from public.edicius_owners where owner_id = v_owner
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if v_region is null or v_region not in (
    'AMAZONAS','ÁNCASH','APURÍMAC','AREQUIPA','AYACUCHO','CAJAMARCA',
    'CALLAO','CUSCO','HUANCAVELICA','HUÁNUCO','ICA','JUNÍN',
    'LA LIBERTAD','LAMBAYEQUE','LIMA','LORETO','MADRE DE DIOS',
    'MOQUEGUA','PASCO','PIURA','PUNO','SAN MARTÍN','TACNA','TUMBES','UCAYALI'
  ) or p_year is null or p_year < 2024
    or p_year > extract(year from current_timestamp at time zone 'America/Lima')::integer then
    raise exception using errcode = '22023', message = 'invalid_seace_refresh';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = v_owner and operation = 'seace-refresh'
     and status in ('queued', 'running') and expires_at <= now();

  insert into public.collector_requests(owner_id, operation, payload, expires_at)
  values (v_owner, 'seace-refresh', jsonb_build_object('region', v_region, 'year', p_year),
          now() + interval '2 hours')
  on conflict do nothing returning * into v_request;
  if v_request.request_id is null then
    select * into v_request from public.collector_requests
     where owner_id = v_owner and operation = 'seace-refresh'
       and payload = jsonb_build_object('region', v_region, 'year', p_year)
       and status in ('queued', 'running') and expires_at > now()
     order by created_at, request_id limit 1;
  end if;
  if v_request.request_id is null then
    raise exception using errcode = '40001', message = 'seace_refresh_enqueue_conflict';
  end if;
  return v_request;
end;
$$;

-- Separate claim RPC leaves the existing market/airfare claim allowlist intact.
create function public.claim_seace_refresh_request(p_owner_id uuid)
returns public.collector_requests
language plpgsql security definer set search_path = '' as $$
declare v_claimed public.collector_requests;
begin
  if p_owner_id is null or not exists (
    select 1 from public.edicius_owners where owner_id = p_owner_id
  ) then
    raise exception using errcode = '22023', message = 'invalid_seace_owner';
  end if;
  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id and operation = 'seace-refresh'
     and status in ('queued', 'running') and expires_at <= now();
  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id from public.collector_requests
      where owner_id = p_owner_id and operation = 'seace-refresh'
        and status = 'queued' and expires_at > now()
      order by created_at, request_id for update skip locked limit 1
   ) returning * into v_claimed;
  return v_claimed;
end;
$$;

revoke all on function public.enqueue_seace_refresh(text, integer),
  public.claim_seace_refresh_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_seace_refresh(text, integer) to authenticated;
grant execute on function public.claim_seace_refresh_request(uuid) to service_role;
