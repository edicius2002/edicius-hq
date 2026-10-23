begin;
select plan(1);

select is(
  (
    select setting
    from pg_proc function_info,
         unnest(function_info.proconfig) as setting
    where function_info.oid = 'public.refresh_fare_route_projection(text,text)'::regprocedure
      and setting like 'statement_timeout=%'
  ),
  'statement_timeout=60s',
  'route projection can use the maximum REST function timeout'
);

select * from finish();
rollback;
