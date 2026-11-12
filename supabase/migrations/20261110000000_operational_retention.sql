-- Operational records only. The Airfare archive and read projections are untouched.
create function public.prune_operational_history(
  p_apply boolean default false,
  p_batch_size integer default 500
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - interval '7 days';
  v_imports integer;
  v_requests integer;
begin
  if p_apply is null or p_batch_size is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception using errcode = '22023', message = 'invalid_retention_batch_size';
  end if;

  if not p_apply then
    select count(*) into v_imports
      from public.airfare_import_runs
     where status in ('complete', 'failed') and started_at < v_cutoff;
    select count(*) into v_requests
      from public.collector_requests
     where status in ('complete', 'failed', 'expired')
       and created_at < v_cutoff and expires_at < now();
  else
    with candidates as (
      select run_id from public.airfare_import_runs
       where status in ('complete', 'failed') and started_at < v_cutoff
       order by started_at, run_id limit p_batch_size for update skip locked
    ), deleted as (
      delete from public.airfare_import_runs old using candidates c
       where old.run_id = c.run_id returning 1
    ) select count(*) into v_imports from deleted;

    with candidates as (
      select request_id from public.collector_requests
       where status in ('complete', 'failed', 'expired')
         and created_at < v_cutoff and expires_at < now()
       order by created_at, request_id limit p_batch_size for update skip locked
    ), deleted as (
      delete from public.collector_requests old using candidates c
       where old.request_id = c.request_id returning 1
    ) select count(*) into v_requests from deleted;
  end if;

  return jsonb_build_object(
    'applied', p_apply,
    'airfare_import_runs', v_imports,
    'collector_requests', v_requests
  );
end;
$$;

revoke all on function public.prune_operational_history(boolean, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_operational_history(boolean, integer) to service_role;
