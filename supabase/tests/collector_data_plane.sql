begin;
select plan(77);

select has_table('public'::name, 'edicius_owners'::name);
select has_table('public'::name, 'app_documents'::name);
select has_table('public'::name, 'collector_runs'::name);
select has_table('public'::name, 'tweet_posts'::name);
select has_table('public'::name, 'sentiment_snapshots'::name);
select has_table('public'::name, 'market_quotes'::name);
select has_table('public'::name, 'market_bars'::name);
select has_table('public'::name, 'collector_requests'::name);
select col_is_pk('public', 'app_documents', array['owner_id', 'document_key']);
select col_is_pk('public', 'tweet_posts', array['owner_id', 'handle', 'post_id']);
select col_is_pk('public', 'sentiment_snapshots', array['owner_id', 'source', 'as_of']);
select col_is_pk('public', 'market_quotes', array['owner_id', 'symbol']);
select col_is_pk('public', 'market_bars', array['owner_id', 'symbol', 'timeframe', 'extended']);
select col_is_pk('public', 'collector_requests', array['request_id']);

select has_function('public', 'write_app_document', array['text','jsonb','bigint']);
select has_function('public', 'delete_app_document', array['text','bigint']);
select has_function('public', 'claim_collector_request', array['uuid']);
select has_function('public', 'complete_collector_request', array['uuid','jsonb']);
select has_function('public', 'fail_collector_request', array['uuid','text']);
select has_function('public', 'read_owner_airfare_history', array['text','text','text','text[]','text','text']);
select has_function('public', 'read_owner_airfare_calendar', array['text','text']);
select has_function('public', 'search_owner_airports', array['text','integer']);

select policies_are('public', 'app_documents', array['app_documents_select_own']);
select policies_are('public', 'tweet_posts', array['tweet_posts_select_own']);
select policies_are('public', 'sentiment_snapshots', array['sentiment_snapshots_select_own']);
select policies_are('public', 'market_quotes', array['market_quotes_select_own']);
select policies_are('public', 'market_bars', array['market_bars_select_own']);
select policies_are('public', 'collector_runs', array['collector_runs_select_own']);
select policies_are('public', 'collector_requests', array[
  'collector_requests_insert_own', 'collector_requests_select_own'
]);

select ok(not has_table_privilege('anon', 'public.app_documents', 'select'),
          'anon cannot read owner documents');
select ok(has_table_privilege('authenticated', 'public.app_documents', 'select'),
          'authenticated reads owner documents only through RLS');
select ok(not has_table_privilege('authenticated', 'public.app_documents', 'insert,update,delete'),
          'authenticated cannot write owner documents directly');
select ok(has_function_privilege('authenticated', 'public.delete_app_document(text,bigint)', 'execute')
          and not has_function_privilege('anon', 'public.delete_app_document(text,bigint)', 'execute'),
          'only authenticated callers can delete owner documents through the revision RPC');
select ok(has_table_privilege('authenticated', 'public.collector_requests', 'insert,select'),
          'authenticated can queue and read requests through RLS');
select ok(not has_table_privilege('authenticated', 'public.collector_requests', 'update,delete'),
          'authenticated cannot claim or complete requests directly');
select ok(has_table_privilege('service_role', 'public.market_quotes', 'insert,update'),
          'service role can write quote cache');
select ok(has_table_privilege('service_role', 'public.app_documents', 'select,insert'),
          'service role can import and refresh owner documents');
select ok(not has_table_privilege('authenticated', 'public.fare_snapshots', 'select'),
          'underlying Airfare archive remains service-role-only');
select ok(not has_function_privilege('authenticated', 'public.read_airfare_history(text,text,text,text[],text,text)', 'execute'),
          'authenticated cannot call the underlying Airfare history RPC');
select ok(has_function_privilege('authenticated', 'public.read_owner_airfare_history(text,text,text,text[],text,text)', 'execute'),
          'authenticated can call the owner-gated Airfare history RPC');
select ok(has_function_privilege('authenticated', 'public.read_owner_airfare_calendar(text,text)', 'execute'),
          'authenticated can call the owner-gated Airfare calendar RPC');
select ok(has_function_privilege('authenticated', 'public.search_owner_airports(text,integer)', 'execute'),
          'authenticated can call the owner-gated airport-search RPC');
select ok(has_function_privilege('service_role', 'public.claim_collector_request(uuid)', 'execute'),
          'only the service role can claim collector requests');
select ok(has_function_privilege('service_role', 'public.complete_collector_request(uuid,jsonb)', 'execute'),
          'service role can complete collector requests');
select ok(has_function_privilege('service_role', 'public.fail_collector_request(uuid,text)', 'execute'),
          'service role can fail collector requests');
select ok(not has_function_privilege('authenticated', 'public.complete_collector_request(uuid,jsonb)', 'execute'),
          'authenticated cannot complete collector requests');
select ok(not has_function_privilege('authenticated', 'public.fail_collector_request(uuid,text)', 'execute'),
          'authenticated cannot fail collector requests');
select ok(not has_function_privilege('authenticated', 'public.read_airfare_calendar(text,text)', 'execute')
          and has_function_privilege('service_role', 'public.read_airfare_calendar(text,text)', 'execute'),
          'original Airfare calendar RPC remains service-role-only');
select ok(not has_function_privilege('authenticated', 'public.airfare_dataset_manifest()', 'execute')
          and has_function_privilege('service_role', 'public.airfare_dataset_manifest()', 'execute'),
          'original Airfare manifest RPC remains service-role-only');
select ok(has_function_privilege('service_role', 'public.read_airfare_history(text,text,text,text[],text,text)', 'execute'),
          'service role retains original Airfare history RPC execution');

select results_eq(
  $$select document_key from public.app_documents where false$$,
  $$select null::text where false$$,
  'app document keys are text'
);
select ok(exists (select 1 from pg_constraint where conrelid = 'public.app_documents'::regclass
                  and pg_get_constraintdef(oid) like '%document_key%'), 'app document key is constrained');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.app_documents'::regclass
                  and pg_get_constraintdef(oid) like '%jsonb_typeof(payload)%'), 'app document payload must be an object');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.collector_requests'::regclass
                  and pg_get_constraintdef(oid) like '%market-bars%'), 'request operation is constrained');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.collector_requests'::regclass
                  and pg_get_constraintdef(oid) like '%queued%'), 'request status is constrained');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.collector_runs'::regclass
                  and pg_get_constraintdef(oid) like '%error_code%'), 'run errors must be sanitized');

select isnt_empty(
  $$select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'market_quotes'$$
);
select isnt_empty($$select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename = 'tweet_posts'$$);
select isnt_empty($$select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename = 'collector_runs'$$);
select isnt_empty($$select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename = 'collector_requests'$$);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'owner-one@example.invalid', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'owner-two@example.invalid', now(), now(), now());
insert into public.edicius_owners(owner_id) values ('11111111-1111-1111-1111-111111111111');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((public.write_app_document('watchlist', '{"symbols":[]}'::jsonb, 0)).revision,
          1::bigint, 'owner can create an allowed app document through the revision RPC');
select throws_ok($$ select public.write_app_document('unknown', '{}', 0) $$,
                 '22023', 'invalid_app_document_key', 'unknown app document keys are rejected');
select throws_ok($$ select public.write_app_document('watchlist', '[]', 1) $$,
                 '22023', 'app_payload_must_be_object', 'non-object app document payloads are rejected');
select lives_ok($$ select public.delete_app_document('watchlist', 1) $$,
               'owner deletes an exact revision through the RPC');
select is((select count(*) from public.app_documents), 0::bigint,
          'exact revision delete removes the owner document');
select throws_ok($$ select public.delete_app_document('watchlist', 1) $$,
                 'PT409', 'app_revision_conflict', 'missing document delete is a safe revision conflict');
select is((public.write_app_document('watchlist', '{"symbols":[]}'::jsonb, 0)).revision,
          1::bigint, 'owner can recreate a deleted document at revision one');
insert into public.collector_requests (operation, payload) values ('market-search', '{"query":"AAPL"}');
select is((select count(*) from public.collector_requests), 1::bigint,
          'owner can queue a request for itself');

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is((select count(*) from public.app_documents), 0::bigint,
          'RLS hides documents from a non-owner');
select is((select count(*) from public.collector_requests), 0::bigint,
          'RLS hides requests from a non-owner');
select throws_ok(
  $$ insert into public.collector_requests (owner_id, operation, payload)
       values ('11111111-1111-1111-1111-111111111111', 'market-search', '{}') $$,
  '42501', NULL, 'request insert policy forbids selecting another owner');
select throws_ok($$ select public.read_owner_airfare_calendar('AQP', 'LIM') $$,
                 '42501', 'not_edicius_owner', 'non-owner cannot call Airfare wrapper');

reset role;
set local role service_role;
select is(
  (public.claim_collector_request('11111111-1111-1111-1111-111111111111')).status,
  'running', 'service role atomically claims an unexpired queued request'
);
select is(
  (public.complete_collector_request(
    (select request_id from public.collector_requests where status = 'running'), '{"matches":[]}'::jsonb
  )).status,
  'complete', 'service role completes a claimed request exactly once'
);
insert into public.collector_requests (owner_id, operation, payload)
values ('11111111-1111-1111-1111-111111111111', 'market-bars', '{}');
select is(
  (public.fail_collector_request(
    (public.claim_collector_request('11111111-1111-1111-1111-111111111111')).request_id, 'provider_unavailable'
  )).status,
  'failed', 'service role records a sanitized failure for a claimed request'
);
insert into public.collector_requests (owner_id, operation, payload, created_at, expires_at)
values ('11111111-1111-1111-1111-111111111111', 'market-bars', '{}', now() - interval '10 minutes', now() - interval '5 minutes');
select is((public.claim_collector_request('11111111-1111-1111-1111-111111111111')).request_id, null::uuid,
          'claim returns no row after consuming the queue');
select is((select status from public.collector_requests order by created_at limit 1), 'expired',
          'claiming expires stale queued requests after five minutes');

select * from finish();
rollback;
