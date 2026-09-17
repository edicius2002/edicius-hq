begin;
select plan(18);

select has_table('public'::name, 'finance_documents'::name);
select col_is_pk('public'::name, 'finance_documents'::name,
                 array['owner_id', 'document_key']::name[]);
select has_function('public'::name, 'write_finance_document'::name,
                    array['text', 'jsonb', 'bigint']::name[]);
select ok(not has_table_privilege('anon', 'public.finance_documents', 'select'),
          'anon cannot read Finance');
select ok(has_table_privilege('authenticated', 'public.finance_documents', 'select'),
          'authenticated can read through RLS');
select ok(not has_table_privilege(
            'authenticated', 'public.finance_documents', 'insert,update,delete'),
          'authenticated cannot bypass the RPC');

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'owner-one@example.invalid', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'owner-two@example.invalid', now(), now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  (public.write_finance_document('finance', '{"diagrams":[]}'::jsonb, 0)).revision,
  1::bigint,
  'revision zero inserts the first document'
);
select is(
  (public.write_finance_document('finance', '{"diagrams":[{"id":"a"}]}'::jsonb, 1)).revision,
  2::bigint,
  'matching revision updates exactly once'
);
select throws_ok(
  $$ select public.write_finance_document('finance', '{}', 1) $$,
  'PT409', 'finance_revision_conflict', 'stale revisions are rejected without a retryable SQLSTATE'
);
select throws_ok(
  $$ select public.write_finance_document('unknown', '{}', 0) $$,
  '22023', 'invalid_finance_document_key', 'unknown keys are rejected'
);
select throws_ok(
  $$ select public.write_finance_document('finance', '[]'::jsonb, 2) $$,
  '22023', 'finance_payload_must_be_object', 'array payloads are rejected'
);

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is((select count(*) from public.finance_documents), 0::bigint,
          'RLS hides the first owner from the second');

select is(
  (public.write_finance_document('finance-camera-views', '{"views":{}}'::jsonb, 0)).revision,
  1::bigint,
  'the second owner can create a camera document'
);

reset role;
select ok(
  (select relrowsecurity from pg_class where oid = 'public.finance_documents'::regclass),
  'Finance has RLS enabled'
);
select ok(not has_function_privilege(
            'anon', 'public.write_finance_document(text,jsonb,bigint)', 'execute'),
          'anon cannot call the writer');
select ok(has_function_privilege(
            'authenticated', 'public.write_finance_document(text,jsonb,bigint)', 'execute'),
          'authenticated can call the writer');
select ok(
  has_table_privilege('service_role', 'public.finance_documents', 'select,insert')
  and not has_table_privilege(
    'service_role', 'public.finance_documents', 'update,delete,truncate,references,trigger'),
  'service role has only insert-once importer privileges'
);

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$ select public.write_finance_document('finance', '{}', 0) $$,
  '42501', 'permission denied for function write_finance_document',
  'anonymous callers cannot execute the writer'
);

select * from finish();
rollback;
