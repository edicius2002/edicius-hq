create or replace function public.write_finance_document(
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
    -- PT409 is PostgREST's explicit HTTP-conflict code. Unlike 40001, it is
    -- not a PostgreSQL serialization failure and must not be retried by the
    -- hosted transaction boundary: this conflict requires a user choice.
    raise exception using errcode = 'PT409', message = 'finance_revision_conflict';
  end if;
  return v_saved;
end;
$$;
