begin;
select plan(10);

select has_function(
  'public'::name,
  'merge_market_quote_ticks'::name,
  array['uuid', 'jsonb']::name[]
);
select ok(
  has_function_privilege(
    'service_role', 'public.merge_market_quote_ticks(uuid,jsonb)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.merge_market_quote_ticks(uuid,jsonb)', 'execute'
  ),
  'only the service role can merge live quote ticks'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (
  '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
  'quote-owner@example.invalid', now(), now(), now()
);
insert into public.edicius_owners(owner_id)
values ('11111111-1111-1111-1111-111111111111');
insert into public.market_quotes (
  owner_id, symbol, provider, market_time, fetched_at, payload
) values (
  '11111111-1111-1111-1111-111111111111', 'AAPL', 'yahoo', 100,
  '2026-09-21T10:00:00Z',
  '{"symbol":"AAPL","price":100,"currency":"USD","previousClose":99,"name":"Apple Inc.","change":1,"changePercent":1,"time":100}'
);

set local role service_role;
select lives_ok(
  $$select public.merge_market_quote_ticks(
    '11111111-1111-1111-1111-111111111111',
    '[{"symbol":"AAPL","provider":"yahoo","market_time":101,"fetched_at":"2026-09-21T10:00:05Z","payload":{"symbol":"AAPL","price":101,"marketState":"REGULAR","extended":false,"changePercent":2,"time":101}}]'::jsonb
  )$$,
  'the collector can atomically merge a live tick'
);
reset role;

select is(
  (select payload ->> 'currency' from public.market_quotes where symbol = 'AAPL'),
  'USD',
  'a live tick preserves currency required by the web decoder'
);
select is(
  (select payload ->> 'name' from public.market_quotes where symbol = 'AAPL'),
  'Apple Inc.',
  'a live tick preserves the display name'
);
select is(
  (select payload ->> 'previousClose' from public.market_quotes where symbol = 'AAPL'),
  '99',
  'a live tick preserves the previous close used for price changes'
);
select is(
  (select payload ->> 'price' from public.market_quotes where symbol = 'AAPL'),
  '101',
  'a live tick replaces the current price'
);
select is(
  (select market_time from public.market_quotes where symbol = 'AAPL'),
  101::bigint,
  'a live tick advances the market timestamp'
);
select is(
  (select fetched_at from public.market_quotes where symbol = 'AAPL'),
  '2026-09-21T10:00:05Z'::timestamptz,
  'a live tick advances the fetch timestamp'
);

set local role authenticated;
select throws_ok(
  $$select public.merge_market_quote_ticks(
    '11111111-1111-1111-1111-111111111111', '[]'::jsonb
  )$$,
  '42501',
  'permission denied for function merge_market_quote_ticks',
  'authenticated callers cannot merge quote ticks'
);

select * from finish();
rollback;
