begin;
select plan(10);

select has_function('public', 'cancel_market_request', array['uuid']);
select ok(
  has_function_privilege('authenticated', 'public.cancel_market_request(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cancel_market_request(uuid)', 'execute'),
  'only authenticated users can request cancellation'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'market-owner-a@example.invalid', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'market-owner-b@example.invalid', now(), now(), now());
insert into public.edicius_owners(owner_id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.collector_requests (request_id, owner_id, operation, payload, status)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111',
   'market-search', '{}'::jsonb, 'queued'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111',
   'market-bars', '{}'::jsonb, 'running'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '11111111-1111-1111-1111-111111111111',
   'airfare-route', '{}'::jsonb, 'queued'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', '22222222-2222-2222-2222-222222222222',
   'market-search', '{}'::jsonb, 'queued');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), true,
          'owner can cancel their queued market request');
select is((select status from public.collector_requests
           where request_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 'failed',
          'cancelled request becomes terminal');
select is((select error_code from public.collector_requests
           where request_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 'aborted',
          'cancelled request carries a safe error code');
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), false,
          'terminal request cannot be cancelled twice');
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'), false,
          'claimed work is left for the worker');
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'), false,
          'market cancellation cannot affect Airfare');
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'), false,
          'one owner cannot cancel another owner request');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is(public.cancel_market_request('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'), true,
          'second owner can cancel their own queued request');

select * from finish();
rollback;
