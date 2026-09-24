-- Existing flight projections receive an empty seen_days array when the column
-- is added. Rebuild only route/month pairs with affected flights so a fresh
-- deployment cannot show an empty Flights seen table until the next import.
do $$
declare
  v_month record;
begin
  for v_month in
    select distinct origin,destination,month
    from public.fare_flight_projections
    where seen_days = '{}'::date[]
  loop
    perform public.refresh_fare_month_projection(
      v_month.origin,v_month.destination,v_month.month
    );
  end loop;
end;
$$;
