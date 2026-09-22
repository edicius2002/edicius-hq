begin;
select plan(6);
select is(
  (select cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and policyname = 'market_chart_focus_broadcast_insert_own'),
  'INSERT', 'focus policy permits publication');
select is(
  (select roles::text from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and policyname = 'market_chart_focus_broadcast_insert_own'),
  '{authenticated}', 'only authenticated clients publish focus');
select ok(
  coalesce((select with_check like '%extension%broadcast%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_chart_focus_broadcast_insert_own'), false),
  'only Broadcast messages');
select ok(
  coalesce((select with_check like '%market-focus:%uid%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_chart_focus_broadcast_insert_own'), false),
  'topic is bound to auth.uid');
select is(
  (select count(*) from pg_policies where schemaname = 'realtime'
    and tablename = 'messages' and policyname = 'market_quote_broadcast_select_own'
    and cmd = 'SELECT'),
  1::bigint, 'quote receive policy remains');
select is(
  (select count(*) from pg_policies where schemaname = 'realtime'
    and tablename = 'messages' and cmd = 'INSERT'
    and coalesce(with_check, '') like '%market-quotes:%'),
  0::bigint, 'clients cannot publish quote events');
select * from finish();
rollback;
