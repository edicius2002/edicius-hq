create policy market_chart_focus_broadcast_insert_own
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'market-focus:' || (select auth.uid())::text
);
