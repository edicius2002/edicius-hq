begin;
select plan(13);

select has_function('public', 'prune_operational_history', array['boolean','integer']);
select ok(has_function_privilege('service_role', 'public.prune_operational_history(boolean,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.prune_operational_history(boolean,integer)', 'execute')
  and not has_function_privilege('anon', 'public.prune_operational_history(boolean,integer)', 'execute'),
  'only the service role may run retention');
select ok(not has_table_privilege('service_role', 'public.airfare_import_runs', 'delete')
  and not has_table_privilege('service_role', 'public.collector_requests', 'delete'),
  'retention does not grant unrestricted table deletion');

insert into auth.users(id) values ('99999999-9999-9999-9999-999999999999');
insert into public.edicius_owners(owner_id) values ('99999999-9999-9999-9999-999999999999');

insert into public.airfare_import_runs(run_id,mode,started_at,status) values
  ('99999999-9999-9999-9999-000000000001','incremental',now()-interval '10 days','complete'),
  ('99999999-9999-9999-9999-000000000002','incremental',now()-interval '9 days','failed'),
  ('99999999-9999-9999-9999-000000000003','incremental',now()-interval '8 days','running'),
  ('99999999-9999-9999-9999-000000000004','incremental',now()-interval '1 day','complete');
insert into public.collector_requests
  (request_id,owner_id,operation,payload,status,created_at,expires_at,completed_at)
values
  ('99999999-9999-9999-9999-000000000011','99999999-9999-9999-9999-999999999999',
   'market-bars','{}','complete',now()-interval '10 days',now()-interval '10 days'+interval '5 minutes',now()-interval '10 days'+interval '1 minute'),
  ('99999999-9999-9999-9999-000000000012','99999999-9999-9999-9999-999999999999',
   'airfare-route','{}','failed',now()-interval '9 days',now()-interval '9 days'+interval '30 minutes',now()-interval '9 days'+interval '1 minute'),
  ('99999999-9999-9999-9999-000000000013','99999999-9999-9999-9999-999999999999',
   'market-bars','{}','running',now()-interval '8 days',now()-interval '8 days'+interval '5 minutes',null),
  ('99999999-9999-9999-9999-000000000014','99999999-9999-9999-9999-999999999999',
   'market-bars','{}','complete',now()-interval '1 day',now()-interval '1 day'+interval '5 minutes',now()-interval '1 day'+interval '1 minute');

set local role service_role;
select is(public.prune_operational_history(false, 1)->>'airfare_import_runs', '2', 'dry run counts all old terminal imports');
select is(public.prune_operational_history(false, 1)->>'collector_requests', '2', 'dry run counts all old terminal requests');
reset role;
select is((select count(*) from public.airfare_import_runs where run_id::text like '99999999-9999-9999-9999-00000000000%'),4::bigint,'dry run did not delete imports');
set local role service_role;
select is(public.prune_operational_history(true, 1)->>'airfare_import_runs', '1','first batch deletes one import');
select is(public.prune_operational_history(true, 1)->>'collector_requests', '1','second batch deletes one request');
select is(public.prune_operational_history(true, 1)->>'airfare_import_runs', '0','old imports are exhausted');
select is(public.prune_operational_history(true, 1)->>'collector_requests', '0','terminal requests are exhausted');
reset role;
select is((select count(*) from public.airfare_import_runs where run_id in
  ('99999999-9999-9999-9999-000000000003','99999999-9999-9999-9999-000000000004')),2::bigint,
  'running and recent imports survive');
select is((select count(*) from public.collector_requests where request_id in
  ('99999999-9999-9999-9999-000000000013','99999999-9999-9999-9999-000000000014')),2::bigint,
  'running and recent requests survive');
select throws_ok($$select public.prune_operational_history(true, 501)$$,'22023','invalid_retention_batch_size',
  'oversized batch is rejected');

select * from finish();
rollback;
