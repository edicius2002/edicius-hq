-- Claim an Airfare route without occupying a worker slot with another month
-- of a city pair that is already being collected. Keep the two-argument RPC
-- for market workers and deployed Airfare workers during the rollout.
create function public.claim_collector_request(
  p_owner_id uuid,
  p_operations text[],
  p_excluded_pairs text[]
) returns public.collector_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_claimed public.collector_requests;
begin
  if p_owner_id is null
     or coalesce(cardinality(p_operations), 0) = 0
     or exists (select 1 from unnest(p_operations) operation where operation is null)
     or not p_operations <@ array['market-bars', 'market-search', 'airfare-route']::text[]
     or cardinality(p_operations) <> (select count(distinct operation) from unnest(p_operations) operation)
     or p_excluded_pairs is null
     or exists (
       select 1 from unnest(p_excluded_pairs) as excluded(pair)
       where pair is null or pair !~ '^[A-Z0-9]{3}-[A-Z0-9]{3}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_collector_operations';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id
     and status in ('queued', 'running')
     and expires_at <= now();

  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id
       from public.collector_requests
      where owner_id = p_owner_id
        and operation = any(p_operations)
        and status = 'queued'
        and expires_at > now()
        and (
          operation <> 'airfare-route'
          or coalesce(payload->>'origin', '') || '-' || coalesce(payload->>'destination', '')
             <> all(p_excluded_pairs)
        )
      order by created_at, request_id
      for update skip locked
      limit 1
  )
  returning * into v_claimed;

  return v_claimed;
end;
$$;

revoke all on function public.claim_collector_request(uuid, text[], text[])
  from public, anon, authenticated, service_role;
grant execute on function public.claim_collector_request(uuid, text[], text[])
  to service_role;
notify pgrst, 'reload schema';
