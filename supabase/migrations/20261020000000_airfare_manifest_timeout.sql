-- The full archive manifest has exceeded the authenticator's 8s deadline.
-- Keep the longer deadline scoped to this service-role-only RPC. The Python
-- finalizer uses 35s so the database can return its own bounded result first.
alter function public.airfare_dataset_manifest() set statement_timeout = '30s';

-- PostgREST reads per-function settings from its schema cache.
notify pgrst, 'reload schema';
