-- Older sync rows cannot distinguish newly added records from updates.
alter table public.seace_sync_state
  add column new_count integer check (new_count >= 0);
