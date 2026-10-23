begin;
select plan(26);

select has_table('public'::name, 'seace_records'::name);
select has_table('public'::name, 'seace_sync_state'::name);
select has_table('public'::name, 'seace_exclusions'::name);
select col_is_pk('public', 'seace_records', array['owner_id', 'kind', 'record_key']);
select col_is_pk('public', 'seace_sync_state', array['owner_id', 'region', 'year', 'kind']);
select col_is_pk('public', 'seace_exclusions', array['owner_id', 'record_key']);
select has_function('public', 'enqueue_seace_refresh', array['text', 'integer']);
select has_function('public', 'claim_seace_refresh_request', array['uuid']);
select policies_are('public', 'seace_records', array['seace_records_select_own']);
select policies_are('public', 'seace_sync_state', array['seace_sync_state_select_own']);
select policies_are('public', 'seace_exclusions', array[
  'seace_exclusions_select_own', 'seace_exclusions_insert_own', 'seace_exclusions_delete_own'
]);
select ok(not has_table_privilege('anon', 'public.seace_records', 'select'), 'anonymous cannot read records');
select ok(not has_table_privilege('authenticated', 'public.seace_records', 'insert,update,delete'),
          'browser cannot mutate source records');
select ok(has_table_privilege('authenticated', 'public.seace_exclusions', 'select,insert,delete'),
          'owner may reverse exclusions');
select ok(not has_function_privilege('anon', 'public.enqueue_seace_refresh(text,integer)', 'execute'),
          'anonymous cannot enqueue');
select ok(not has_function_privilege('authenticated', 'public.claim_seace_refresh_request(uuid)', 'execute'),
          'browser cannot claim');
select ok(has_function_privilege('service_role', 'public.claim_seace_refresh_request(uuid)', 'execute'),
          'Pi service can claim');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.collector_requests'::regclass
                  and pg_get_constraintdef(oid) like '%seace-refresh%'), 'queue recognizes SEACE');

insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) values
  ('91111111-1111-1111-1111-111111111111','authenticated','authenticated','seace-owner@example.invalid',now(),now(),now()),
  ('92222222-2222-2222-2222-222222222222','authenticated','authenticated','seace-other@example.invalid',now(),now(),now());
insert into public.edicius_owners(owner_id) values ('91111111-1111-1111-1111-111111111111');
insert into public.seace_records(owner_id,kind,record_key,region,year,payload) values
  ('91111111-1111-1111-1111-111111111111','notices','42','Arequipa',2026,'{"code":"CM-42"}');

set local role authenticated;
select set_config('request.jwt.claim.sub','92222222-2222-2222-2222-222222222222',true);
select is((select count(*) from public.seace_records), 0::bigint, 'non-owner sees no rows');
select throws_ok($$select public.enqueue_seace_refresh('Arequipa',2026)$$, '42501',
                 'not_edicius_owner', 'non-owner cannot enqueue');

select set_config('request.jwt.claim.sub','91111111-1111-1111-1111-111111111111',true);
select is((select count(*) from public.seace_records), 1::bigint, 'owner sees own row');
select lives_ok($$select public.enqueue_seace_refresh('Arequipa',extract(year from now())::integer)$$,
                'owner may queue valid region');
select throws_ok($$select public.enqueue_seace_refresh('Invented',2026)$$, '22023',
                 'invalid_seace_refresh', 'invalid region is rejected');

insert into public.seace_exclusions(record_key) values ('minor:["Arequipa","CM-42"]');
select is((select count(*) from public.seace_exclusions), 1::bigint,
          'owner can exclude a record');
reset role;
update public.seace_records set payload = '{"code":"CM-42","state":"Vigente"}'
 where record_key = '42';
set local role authenticated;
select is((select count(*) from public.seace_exclusions), 1::bigint,
          'source update does not remove exclusion');
delete from public.seace_exclusions where record_key = 'minor:["Arequipa","CM-42"]';
select is((select count(*) from public.seace_exclusions), 0::bigint,
          'owner can restore a record');

select * from finish();
rollback;
