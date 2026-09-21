create policy market_quote_broadcast_select_own
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'market-quotes:' || (select auth.uid())::text
);

alter publication supabase_realtime drop table public.market_quotes;
