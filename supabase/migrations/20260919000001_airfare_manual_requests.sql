alter table public.collector_runs
  drop constraint collector_runs_collector_check;
alter table public.collector_runs
  add constraint collector_runs_collector_check
  check (collector in ('airfare', 'airfare-requests', 'x-posts', 'sentiment', 'market'));

alter table public.collector_requests
  drop constraint collector_requests_operation_check;
alter table public.collector_requests
  add constraint collector_requests_operation_check
  check (operation in ('market-bars', 'market-search', 'airfare-route'));

alter table public.collector_requests
  add column progress jsonb not null
    default '{"stage":"queued","completed":0,"total":null}'::jsonb
    check (jsonb_typeof(progress) = 'object'),
  add column updated_at timestamptz not null default now();

create unique index collector_requests_active_airfare_route_idx
  on public.collector_requests (
    owner_id,
    (payload->>'origin'),
    (payload->>'destination'),
    (payload->>'month'),
    (payload->>'currency')
  )
  where operation = 'airfare-route' and status in ('queued', 'running');

drop policy collector_requests_insert_own on public.collector_requests;
create policy collector_requests_insert_own on public.collector_requests
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and operation in ('market-bars', 'market-search')
  );

create function public.enqueue_airfare_route_request(
  p_origin text,
  p_destination text,
  p_month text,
  p_currency text
) returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_origin text := upper(trim(p_origin));
  v_destination text := upper(trim(p_destination));
  v_month text := trim(p_month);
  v_currency text := upper(trim(p_currency));
  v_month_date date;
  v_payload jsonb;
  v_request public.collector_requests;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if v_origin !~ '^[A-Z]{3}$'
     or v_destination !~ '^[A-Z]{3}$'
     or v_origin = v_destination
     or v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or v_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'invalid_airfare_request';
  end if;

  v_month_date := make_date(substring(v_month, 1, 4)::integer,
                            substring(v_month, 6, 2)::integer, 1);
  if v_month_date < date_trunc('month', current_date)::date
     or v_month_date > date_trunc('month', current_date + 330)::date then
    raise exception using errcode = '22023', message = 'invalid_airfare_request';
  end if;

  v_payload := jsonb_build_object(
    'origin', v_origin,
    'destination', v_destination,
    'month', v_month,
    'currency', v_currency
  );

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = v_owner
     and operation = 'airfare-route'
     and status in ('queued', 'running')
     and expires_at <= now();

  select * into v_request
    from public.collector_requests
   where owner_id = v_owner
     and operation = 'airfare-route'
     and payload = v_payload
     and status in ('queued', 'running')
     and expires_at > now()
   order by created_at, request_id
   limit 1;

  if v_request.request_id is null then
    insert into public.collector_requests (owner_id, operation, payload, expires_at)
    values (v_owner, 'airfare-route', v_payload, now() + interval '30 minutes')
    on conflict do nothing
    returning * into v_request;
  end if;

  if v_request.request_id is null then
    select * into v_request
      from public.collector_requests
     where owner_id = v_owner
       and operation = 'airfare-route'
       and payload = v_payload
       and status in ('queued', 'running')
       and expires_at > now()
     order by created_at, request_id
     limit 1;
  end if;

  if v_request.request_id is null then
    raise exception using errcode = '40001', message = 'airfare_request_enqueue_conflict';
  end if;
  return v_request;
end;
$$;

drop function public.claim_collector_request(uuid);

create function public.claim_collector_request(
  p_owner_id uuid,
  p_operations text[]
) returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_claimed public.collector_requests;
begin
  if p_owner_id is null
     or coalesce(cardinality(p_operations), 0) = 0
     or exists (select 1 from unnest(p_operations) operation where operation is null)
     or not p_operations <@ array['market-bars', 'market-search', 'airfare-route']::text[]
     or cardinality(p_operations) <> (select count(distinct operation) from unnest(p_operations) operation) then
    raise exception using errcode = '22023', message = 'invalid_collector_operations';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id
     and status in ('queued', 'running')
     and expires_at <= now();

  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id
       from public.collector_requests
      where owner_id = p_owner_id
        and operation = any(p_operations)
        and status = 'queued'
        and expires_at > now()
      order by created_at, request_id
      for update skip locked
      limit 1
  )
  returning * into v_claimed;

  return v_claimed;
end;
$$;

create function public.update_collector_request_progress(
  p_request_id uuid,
  p_progress jsonb
) returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_current public.collector_requests;
  v_updated public.collector_requests;
  v_stage text;
  v_completed integer;
  v_total integer;
  v_current_stage text;
  v_current_completed integer;
  v_current_total integer;
  v_stage_order integer;
  v_current_stage_order integer;
begin
  if jsonb_typeof(p_progress) <> 'object'
     or (select count(*) from jsonb_object_keys(p_progress)) <> 3
     or not (p_progress ?& array['stage', 'completed', 'total'])
     or jsonb_typeof(p_progress->'stage') <> 'string'
     or jsonb_typeof(p_progress->'completed') <> 'number'
     or jsonb_typeof(p_progress->'total') not in ('number', 'null') then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  begin
    v_stage := p_progress->>'stage';
    v_completed := (p_progress->>'completed')::integer;
    v_total := case when jsonb_typeof(p_progress->'total') = 'null'
                    then null else (p_progress->>'total')::integer end;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end;

  v_stage_order := case v_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;
  if v_stage_order < 0 or v_completed < 0 or (v_total is not null and v_total < v_completed) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  select * into v_current
    from public.collector_requests
   where request_id = p_request_id
     and operation = 'airfare-route'
     and status = 'running'
     and expires_at > now()
   for update;
  if v_current.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;

  v_current_stage := v_current.progress->>'stage';
  v_current_completed := coalesce((v_current.progress->>'completed')::integer, 0);
  v_current_total := case when jsonb_typeof(v_current.progress->'total') = 'number'
                          then (v_current.progress->>'total')::integer else null end;
  v_current_stage_order := case v_current_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;

  if v_current_stage_order < 0
     or v_stage_order < v_current_stage_order
     or v_completed < v_current_completed
     or (v_current_total is not null and (v_total is null or v_total < v_current_total)) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  update public.collector_requests
     set progress = p_progress, updated_at = now()
   where request_id = p_request_id
  returning * into v_updated;
  return v_updated;
end;
$$;

create or replace function public.complete_collector_request(p_request_id uuid, p_result jsonb)
returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare v_completed public.collector_requests;
begin
  if jsonb_typeof(p_result) <> 'object' then
    raise exception using errcode = '22023', message = 'collector_result_must_be_object';
  end if;
  update public.collector_requests
     set status = 'complete', result = p_result, completed_at = now(),
         error_code = null, updated_at = now()
   where request_id = p_request_id and status = 'running' and expires_at > now()
  returning * into v_completed;
  if v_completed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_completed;
end;
$$;

create or replace function public.fail_collector_request(p_request_id uuid, p_error_code text)
returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare v_failed public.collector_requests;
begin
  if p_error_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid_collector_error_code';
  end if;
  update public.collector_requests
     set status = 'failed', error_code = p_error_code, completed_at = now(), updated_at = now()
   where request_id = p_request_id and status = 'running' and expires_at > now()
  returning * into v_failed;
  if v_failed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_failed;
end;
$$;

revoke all on function public.enqueue_airfare_route_request(text, text, text, text),
  public.claim_collector_request(uuid, text[]),
  public.update_collector_request_progress(uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.enqueue_airfare_route_request(text, text, text, text)
  to authenticated;
grant execute on function public.claim_collector_request(uuid, text[]),
  public.update_collector_request_progress(uuid, jsonb)
  to service_role;
