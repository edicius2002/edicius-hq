create table public.finance_documents (
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_key text not null check (document_key in ('finance', 'finance-camera-views')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, document_key)
);

alter table public.finance_documents enable row level security;
revoke all on table public.finance_documents from public, anon, authenticated, service_role;
grant select on table public.finance_documents to authenticated;
grant select, insert on table public.finance_documents to service_role;

create policy finance_documents_select_own
on public.finance_documents for select to authenticated
using (owner_id = auth.uid());

create function public.write_finance_document(
  p_document_key text,
  p_payload jsonb,
  p_expected_revision bigint
) returns public.finance_documents
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_saved public.finance_documents;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_document_key not in ('finance', 'finance-camera-views') then
    raise exception using errcode = '22023', message = 'invalid_finance_document_key';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'finance_payload_must_be_object';
  end if;

  if p_expected_revision = 0 then
    insert into public.finance_documents (owner_id, document_key, payload)
    values (v_owner, p_document_key, p_payload)
    on conflict do nothing
    returning * into v_saved;
  elsif p_expected_revision > 0 then
    update public.finance_documents
       set payload = p_payload, revision = revision + 1, updated_at = now()
     where owner_id = v_owner
       and document_key = p_document_key
       and revision = p_expected_revision
    returning * into v_saved;
  end if;

  if v_saved.owner_id is null then
    raise exception using errcode = '40001', message = 'finance_revision_conflict';
  end if;
  return v_saved;
end;
$$;

revoke all on function public.write_finance_document(text, jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.write_finance_document(text, jsonb, bigint)
  to authenticated;
