-- Stream owner-visible FX captures to the Dashboard as the collector writes them.
alter publication supabase_realtime add table public.fx_observations;
