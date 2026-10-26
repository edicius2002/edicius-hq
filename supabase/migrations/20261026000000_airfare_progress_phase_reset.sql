-- Collection and synchronization have separate denominators. A transition to
-- syncing resets completed/total; monotonicity applies within each stage.
create or replace function public.update_collector_request_progress(
  p_request_id uuid,
  p_progress jsonb
) returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_current public.collector_requests;
  v_updated public.collector_requests;
  v_stage text;
  v_completed integer;
  v_total integer;
  v_current_stage text;
  v_current_completed integer;
  v_current_total integer;
  v_stage_order integer;
  v_current_stage_order integer;
begin
  if jsonb_typeof(p_progress) <> 'object'
     or (select count(*) from jsonb_object_keys(p_progress)) <> 3
     or not (p_progress ?& array['stage', 'completed', 'total'])
     or jsonb_typeof(p_progress->'stage') <> 'string'
     or jsonb_typeof(p_progress->'completed') <> 'number'
     or jsonb_typeof(p_progress->'total') not in ('number', 'null') then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  begin
    v_stage := p_progress->>'stage';
    v_completed := (p_progress->>'completed')::integer;
    v_total := case when jsonb_typeof(p_progress->'total') = 'null'
                    then null else (p_progress->>'total')::integer end;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end;

  v_stage_order := case v_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;
  if v_stage_order < 0 or v_completed < 0 or (v_total is not null and v_total < v_completed) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  select * into v_current
    from public.collector_requests
   where request_id = p_request_id
     and operation = 'airfare-route'
     and status = 'running'
     and expires_at > now()
   for update;
  if v_current.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;

  v_current_stage := v_current.progress->>'stage';
  v_current_completed := coalesce((v_current.progress->>'completed')::integer, 0);
  v_current_total := case when jsonb_typeof(v_current.progress->'total') = 'number'
                          then (v_current.progress->>'total')::integer else null end;
  v_current_stage_order := case v_current_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;

  if v_current_stage_order < 0
     or v_stage_order < v_current_stage_order
     or (v_stage_order = v_current_stage_order and (
       v_completed < v_current_completed
       or (v_current_total is not null and (v_total is null or v_total < v_current_total))
     )) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  update public.collector_requests
     set progress = p_progress, updated_at = now()
   where request_id = p_request_id
  returning * into v_updated;
  return v_updated;
end;
$$;
