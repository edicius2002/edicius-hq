-- Minimal local PostgreSQL fixture for running supabase/tests/seace_paged_read.sql
-- when the full Supabase stack is unavailable. Create a fresh isolated database,
-- apply this file, then apply the SEACE paged-read migration and test file.
do $$
begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin;
  end if;
end;
$$;
create schema auth;
create schema extensions;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
$$;
create table public.edicius_owners(owner_id uuid primary key);
create table public.seace_records (
  owner_id uuid not null references public.edicius_owners(owner_id),
  kind text not null,
  record_key text not null,
  region text not null,
  year integer not null,
  published_at timestamptz,
  payload jsonb not null,
  last_seen_at timestamptz not null default now(),
  primary key(owner_id,kind,record_key)
);
create table public.seace_exclusions (
  owner_id uuid not null references public.edicius_owners(owner_id),
  record_key text not null,
  excluded_at timestamptz not null default now(),
  primary key(owner_id,record_key)
);
create table auth.users (
  id uuid primary key,
  aud text,
  role text,
  email text,
  email_confirmed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
);
alter table public.seace_records enable row level security;
alter table public.seace_exclusions enable row level security;
create policy seace_records_select_own on public.seace_records
  for select to authenticated using (owner_id=auth.uid());
create policy seace_exclusions_select_own on public.seace_exclusions
  for select to authenticated using (owner_id=auth.uid());
grant usage on schema public,auth to authenticated;
grant select on public.seace_records,public.seace_exclusions to authenticated;
grant execute on function auth.uid() to authenticated;

-- The following shims fail fast and mimic only the pgTAP assertions used by this test.
create function public.plan(integer) returns text language sql as $$ select '1..' || $1 $$;
create function public.is(anyelement,anyelement,text) returns text language plpgsql as $$
begin
  if $1 is distinct from $2 then
    raise exception 'assertion failed: % (got %, expected %)', $3,$1,$2;
  end if;
  return 'ok - ' || $3;
end $$;
create function public.throws_ok(text,text,text,text) returns text language plpgsql as $$
declare got_state text; got_message text;
begin
  begin
    execute $1;
  exception when others then
    get stacked diagnostics got_state=returned_sqlstate, got_message=message_text;
    if got_state is distinct from $2 or got_message is distinct from $3 then
      raise exception 'assertion failed: % (got % %, expected % %)', $4,got_state,got_message,$2,$3;
    end if;
    return 'ok - ' || $4;
  end;
  raise exception 'assertion failed: % (no error)', $4;
end $$;
create function public.finish() returns setof text language sql as $$ select 'finished'::text $$;
