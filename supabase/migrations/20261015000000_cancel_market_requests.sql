-- Browsers may withdraw their own unclaimed market work after a search changes
-- or its total wait budget expires. Running work is left to settle normally.
create function public.cancel_market_request(p_request_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_cancelled uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  update public.collector_requests
     set status = 'failed', error_code = 'aborted',
         completed_at = now(), updated_at = now()
   where request_id = p_request_id
     and owner_id = auth.uid()
     and operation in ('market-bars', 'market-search')
     and status = 'queued'
  returning request_id into v_cancelled;
  return v_cancelled is not null;
end;
$$;

revoke all on function public.cancel_market_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_market_request(uuid) to authenticated;
