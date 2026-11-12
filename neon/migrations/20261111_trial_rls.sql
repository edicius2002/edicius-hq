-- Trial branch: expose only owner-scoped reads through Neon's Data API.
-- Auth is self-managed Better Auth; auth.user_id() reads the verified JWT sub.
GRANT USAGE ON SCHEMA public TO authenticated;

DO $migration$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'airfare_documents', 'airfare_history_revision', 'airport_catalog',
    'airport_coordinate_reference', 'app_documents', 'edicius_owners',
    'fare_airports', 'fare_calendar_captures', 'fare_flight_projections',
    'fare_month_projections', 'fare_projection_dirty_months',
    'fare_projection_dirty_routes', 'finance_documents', 'fx_observations',
    'market_bars', 'market_quotes', 'seace_exclusions', 'seace_records',
    'seace_sync_state', 'sentiment_snapshots', 'tweet_posts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'app_documents', 'edicius_owners', 'finance_documents',
    'fx_observations', 'market_bars', 'market_quotes', 'seace_exclusions',
    'seace_records', 'seace_sync_state', 'sentiment_snapshots', 'tweet_posts'
  ] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
      || 'USING (owner_id::text = (select auth.user_id()))',
      table_name || '_select_owner', table_name
    );
  END LOOP;
END
$migration$;

-- The browser writes only exclusions directly. Its owner_id is derived from
-- the verified JWT, and both insert and delete remain scoped to that owner.
ALTER TABLE public.seace_exclusions
  ALTER COLUMN owner_id SET DEFAULT (auth.user_id())::uuid;
GRANT INSERT, DELETE ON public.seace_exclusions TO authenticated;
CREATE POLICY seace_exclusions_insert_owner ON public.seace_exclusions
  FOR INSERT TO authenticated
  WITH CHECK (owner_id::text = (select auth.user_id()));
CREATE POLICY seace_exclusions_delete_owner ON public.seace_exclusions
  FOR DELETE TO authenticated
  USING (owner_id::text = (select auth.user_id()));
