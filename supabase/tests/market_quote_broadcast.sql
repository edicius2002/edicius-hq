begin;
select plan(6);

select is(
  (select cmd from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'),
  'SELECT',
  'market quote Broadcast policy is read-only'
);
select is(
  (select roles::text from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'),
  '{authenticated}',
  'only authenticated clients receive market quote Broadcasts'
);
select ok(
  coalesce((select qual like '%extension%broadcast%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'), false),
  'policy is limited to Broadcast messages'
);
select ok(
  coalesce((select qual like '%market-quotes:%uid%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'), false),
  'policy binds the topic to the authenticated owner'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and cmd = 'INSERT' and 'authenticated' = any(roles)
      and coalesce(with_check, '') like '%market-quotes:%'),
  0::bigint,
  'authenticated clients cannot publish market quote Broadcasts'
);
select is(
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'market_quotes'),
  0::bigint,
  'market quote snapshots are not duplicated through Postgres Changes'
);

select * from finish();
rollback;
