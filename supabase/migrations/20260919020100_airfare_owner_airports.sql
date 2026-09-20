-- Owner-gated coordinate list used to draw the Airfare globe without the
-- retired home API. Requested waypoints missing from the archive retain the
-- prior reference-coordinate fallback. Both tables remain browser-inaccessible.
create or replace function public.read_owner_fare_airports(p_codes text[])
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.edicius_owners where owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_codes is null or exists (
    select 1 from unnest(p_codes) code where code is null or code !~ '^[A-Z0-9]{3}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_airport_codes';
  end if;
  return jsonb_build_object(
    'airports', coalesce((
      with requested as (
        select distinct code from unnest(p_codes) code
      ), resolved as (
        select a.code, a.payload from public.fare_airports a
        union all
        select r.code, jsonb_build_object(
          'code', r.code,
          'name', null,
          'city', null,
          'country', null,
          'latitude', r.latitude,
          'longitude', r.longitude
        )
        from requested q
        join public.airport_coordinate_reference r on r.code = q.code
        where not exists (select 1 from public.fare_airports a where a.code = r.code)
      )
      select jsonb_agg(payload order by code) from resolved
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.read_owner_fare_airports(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.read_owner_fare_airports(text[])
  to authenticated, service_role;
