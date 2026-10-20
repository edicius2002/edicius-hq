-- Read-only catalog regression; safe to run before and after the migration.
begin;
do $$
declare
  v_settings text[];
begin
  select proconfig into v_settings from pg_proc
    where oid = 'public.airfare_dataset_manifest()'::regprocedure;
  if not coalesce(v_settings @> array['statement_timeout=30s'], false) then
    raise exception 'Airfare manifest must have its own 30s statement deadline';
  end if;
  if not has_function_privilege('service_role',
      'public.airfare_dataset_manifest()', 'EXECUTE') then
    raise exception 'Collector must retain access to the manifest';
  end if;
  if has_function_privilege('anon', 'public.airfare_dataset_manifest()', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.airfare_dataset_manifest()', 'EXECUTE') then
    raise exception 'Browser roles must not gain manifest access';
  end if;
end;
$$;
rollback;
