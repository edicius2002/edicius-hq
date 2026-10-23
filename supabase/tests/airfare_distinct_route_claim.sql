begin;
select plan(7);

select has_function('public', 'claim_collector_request', array['uuid','text[]','text[]']);
select ok(
  has_function_privilege(
    'service_role', 'public.claim_collector_request(uuid,text[],text[])', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.claim_collector_request(uuid,text[],text[])', 'execute'
  ),
  'only the collector service can claim with a route exclusion'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (
  '88888888-8888-8888-8888-888888888888', 'authenticated', 'authenticated',
  'airfare-route-claim@example.invalid', now(), now(), now()
);
insert into public.edicius_owners(owner_id)
values ('88888888-8888-8888-8888-888888888888');

insert into public.collector_requests
  (request_id, owner_id, operation, payload, created_at, expires_at)
values
  (
    '88888888-8888-8888-8888-000000000001',
    '88888888-8888-8888-8888-888888888888', 'airfare-route',
    '{"origin":"LIM","destination":"CUZ","month":"2027-01","currency":"USD"}',
    now() - interval '3 seconds', now() + interval '30 minutes'
  ),
  (
    '88888888-8888-8888-8888-000000000002',
    '88888888-8888-8888-8888-888888888888', 'airfare-route',
    '{"origin":"LIM","destination":"CUZ","month":"2027-02","currency":"USD"}',
    now() - interval '2 seconds', now() + interval '30 minutes'
  ),
  (
    '88888888-8888-8888-8888-000000000003',
    '88888888-8888-8888-8888-888888888888', 'airfare-route',
    '{"origin":"LIM","destination":"AQP","month":"2027-01","currency":"USD"}',
    now() - interval '1 second', now() + interval '30 minutes'
  );

select is(
  (public.claim_collector_request(
    '88888888-8888-8888-8888-888888888888',
    array['airfare-route'], array['LIM-CUZ']
  )).request_id,
  '88888888-8888-8888-8888-000000000003'::uuid,
  'an unrelated pair can bypass two queued months of an active pair'
);
select is(
  (select status from public.collector_requests
   where request_id='88888888-8888-8888-8888-000000000001'),
  'queued', 'first month of excluded pair remains queued'
);
select is(
  (select status from public.collector_requests
   where request_id='88888888-8888-8888-8888-000000000002'),
  'queued', 'second month of excluded pair remains queued'
);
select is(
  (public.claim_collector_request(
    '88888888-8888-8888-8888-888888888888',
    array['airfare-route'], array['LIM-CUZ']
  )).request_id,
  null::uuid, 'an excluded pair does not occupy the second worker slot'
);
select is(
  (public.claim_collector_request(
    '88888888-8888-8888-8888-888888888888',
    array['airfare-route'], array[]::text[]
  )).request_id,
  '88888888-8888-8888-8888-000000000001'::uuid,
  'oldest month can be claimed after its pair becomes available'
);

select * from finish();
rollback;
