create table public.edicius_owners (
  owner_id uuid primary key references auth.users(id) on delete cascade
);

insert into public.edicius_owners(owner_id)
select distinct owner_id from public.finance_documents on conflict do nothing;

create table public.app_documents (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  document_key text not null check (document_key in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  )),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, document_key)
);

create table public.collector_runs (
  run_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  collector text not null check (collector in ('airfare', 'x-posts', 'sentiment', 'market')),
  status text not null check (status in ('running', 'complete', 'failed')),
  records_seen integer not null default 0 check (records_seen >= 0),
  records_written integer not null default 0 check (records_written >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (completed_at is null or completed_at >= started_at)
);

create table public.tweet_posts (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  handle text not null,
  post_id text not null,
  posted_at timestamptz not null,
  captured_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, handle, post_id)
);

create table public.sentiment_snapshots (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  source text not null,
  as_of timestamptz not null,
  score numeric,
  classification text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  fetched_at timestamptz not null default now(),
  primary key (owner_id, source, as_of)
);

create table public.market_quotes (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  symbol text not null,
  provider text not null,
  market_time bigint,
  fetched_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, symbol)
);

create table public.market_bars (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  extended boolean not null,
  provider text not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, symbol, timeframe, extended)
);

create table public.collector_requests (
  request_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.edicius_owners(owner_id) on delete cascade,
  operation text not null check (operation in ('market-bars', 'market-search')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  check (expires_at > created_at),
  check (claimed_at is null or claimed_at >= created_at),
  check (completed_at is null or completed_at >= created_at)
);

create index collector_runs_owner_collector_started_idx
  on public.collector_runs (owner_id, collector, started_at desc);
create index collector_requests_claim_idx
  on public.collector_requests (owner_id, created_at) where status = 'queued';

create function public.write_app_document(
  p_document_key text,
  p_payload jsonb,
  p_expected_revision bigint
) returns public.app_documents
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_saved public.app_documents;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_document_key not in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  ) then
    raise exception using errcode = '22023', message = 'invalid_app_document_key';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'app_payload_must_be_object';
  end if;

  if p_expected_revision = 0 then
    insert into public.app_documents (owner_id, document_key, payload)
    values (v_owner, p_document_key, p_payload)
    on conflict do nothing
    returning * into v_saved;
  elsif p_expected_revision > 0 then
    update public.app_documents
       set payload = p_payload, revision = revision + 1, updated_at = now()
     where owner_id = v_owner and document_key = p_document_key and revision = p_expected_revision
    returning * into v_saved;
  end if;

  if v_saved.owner_id is null then
    raise exception using errcode = 'PT409', message = 'app_revision_conflict';
  end if;
  return v_saved;
end;
$$;

create function public.delete_app_document(
  p_document_key text,
  p_expected_revision bigint
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_document_key not in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  ) then
    raise exception using errcode = '22023', message = 'invalid_app_document_key';
  end if;
  if p_expected_revision <= 0 then
    raise exception using errcode = '22023', message = 'invalid_app_document_revision';
  end if;

  delete from public.app_documents
   where owner_id = v_owner and document_key = p_document_key and revision = p_expected_revision;
  if not found then
    raise exception using errcode = 'PT409', message = 'app_revision_conflict';
  end if;
end;
$$;

create function public.claim_collector_request(p_owner_id uuid)
returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare v_claimed public.collector_requests;
begin
  update public.collector_requests
     set status = 'running', claimed_at = now()
   where request_id = (
     select request_id
       from public.collector_requests
      where owner_id = p_owner_id and status = 'queued' and expires_at > now()
      order by created_at, request_id
      for update skip locked
      limit 1
   )
  returning * into v_claimed;

  update public.collector_requests
     set status = 'expired', completed_at = now()
   where owner_id = p_owner_id and status = 'queued' and expires_at <= now();

  return v_claimed;
end;
$$;

create function public.complete_collector_request(p_request_id uuid, p_result jsonb)
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
     set status = 'complete', result = p_result, completed_at = now(), error_code = null
   where request_id = p_request_id and status = 'running' and expires_at > now()
  returning * into v_completed;
  if v_completed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_completed;
end;
$$;

create function public.fail_collector_request(p_request_id uuid, p_error_code text)
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
     set status = 'failed', error_code = p_error_code, completed_at = now()
   where request_id = p_request_id and status = 'running'
  returning * into v_failed;
  if v_failed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_failed;
end;
$$;

create function public.read_owner_airfare_history(
  p_origin text, p_destination text, p_departure text, p_snapshot_months text[], p_since text, p_until text
) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_history(p_origin, p_destination, p_departure, p_snapshot_months, p_since, p_until);
end;
$$;

create function public.read_owner_airfare_calendar(p_origin text, p_destination text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_calendar(p_origin, p_destination);
end;
$$;

create function public.search_owner_airports(p_query text, p_limit integer)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'invalid_airport_search_limit';
  end if;
  return jsonb_build_object(
    'query', p_query,
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'city', city, 'country', country)
                       order by code)
      from (
        select code, name, city, country
          from public.fare_airports
         where p_query <> '' and concat_ws(' ', code, name, city, country) ilike '%' || p_query || '%'
         order by code
         limit p_limit
      ) matches
    ), '[]'::jsonb)
  );
end;
$$;

alter table public.edicius_owners enable row level security;
alter table public.app_documents enable row level security;
alter table public.collector_runs enable row level security;
alter table public.tweet_posts enable row level security;
alter table public.sentiment_snapshots enable row level security;
alter table public.market_quotes enable row level security;
alter table public.market_bars enable row level security;
alter table public.collector_requests enable row level security;

create policy app_documents_select_own on public.app_documents for select to authenticated using (owner_id = auth.uid());
create policy collector_runs_select_own on public.collector_runs for select to authenticated using (owner_id = auth.uid());
create policy tweet_posts_select_own on public.tweet_posts for select to authenticated using (owner_id = auth.uid());
create policy sentiment_snapshots_select_own on public.sentiment_snapshots for select to authenticated using (owner_id = auth.uid());
create policy market_quotes_select_own on public.market_quotes for select to authenticated using (owner_id = auth.uid());
create policy market_bars_select_own on public.market_bars for select to authenticated using (owner_id = auth.uid());
create policy collector_requests_insert_own on public.collector_requests for insert to authenticated with check (owner_id = auth.uid());
create policy collector_requests_select_own on public.collector_requests for select to authenticated using (owner_id = auth.uid());

revoke all on table public.edicius_owners, public.app_documents, public.collector_runs,
  public.tweet_posts, public.sentiment_snapshots, public.market_quotes, public.market_bars,
  public.collector_requests from public, anon, authenticated, service_role;
grant select on public.app_documents, public.collector_runs, public.tweet_posts,
  public.sentiment_snapshots, public.market_quotes, public.market_bars to authenticated;
grant select, insert on public.collector_requests to authenticated;
grant select, insert on public.app_documents to service_role;
grant select, insert, update on public.collector_runs, public.tweet_posts, public.sentiment_snapshots,
  public.market_quotes, public.market_bars, public.collector_requests to service_role;

revoke all on function public.write_app_document(text, jsonb, bigint), public.delete_app_document(text, bigint),
  public.claim_collector_request(uuid), public.complete_collector_request(uuid, jsonb),
  public.fail_collector_request(uuid, text), public.read_owner_airfare_history(text, text, text, text[], text, text),
  public.read_owner_airfare_calendar(text, text), public.search_owner_airports(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.write_app_document(text, jsonb, bigint), public.delete_app_document(text, bigint),
  public.read_owner_airfare_history(text, text, text, text[], text, text),
  public.read_owner_airfare_calendar(text, text), public.search_owner_airports(text, integer)
  to authenticated;
grant execute on function public.claim_collector_request(uuid),
  public.complete_collector_request(uuid, jsonb), public.fail_collector_request(uuid, text)
  to service_role;

alter publication supabase_realtime add table public.market_quotes;
alter publication supabase_realtime add table public.tweet_posts;
alter publication supabase_realtime add table public.collector_runs;
alter publication supabase_realtime add table public.collector_requests;
