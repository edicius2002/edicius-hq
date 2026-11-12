-- Browser access to its own bounded request queue. Worker-only state changes
-- continue through SECURITY DEFINER RPCs or the server's direct connection.
GRANT SELECT, INSERT ON public.collector_requests TO authenticated;

CREATE POLICY collector_requests_select_owner ON public.collector_requests
  FOR SELECT TO authenticated
  USING (owner_id::text = (select auth.user_id()));

CREATE POLICY collector_requests_insert_owner ON public.collector_requests
  FOR INSERT TO authenticated
  WITH CHECK (owner_id::text = (select auth.user_id()));
