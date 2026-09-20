begin;
select plan(20);

select has_table('public'::name, 'airport_coordinate_reference'::name);
select is((select count(*) from public.airport_coordinate_reference), 9054::bigint,
          'the complete checked-in coordinate reference is installed');
select has_function('public', 'read_owner_fare_airports', array['text[]']);
select function_returns('public', 'read_owner_fare_airports', array['text[]'], 'jsonb');
select function_lang_is('public', 'read_owner_fare_airports', array['text[]'], 'plpgsql');
select volatility_is('public', 'read_owner_fare_airports', array['text[]'], 'stable');
select is_definer('public', 'read_owner_fare_airports', array['text[]']);
select ok(
  has_function_privilege('authenticated', 'public.read_owner_fare_airports(text[])', 'execute')
  and has_function_privilege('service_role', 'public.read_owner_fare_airports(text[])', 'execute')
  and not has_function_privilege('anon', 'public.read_owner_fare_airports(text[])', 'execute'),
  'only authenticated and service callers can execute the owner airport reader'
);
select is(
  (select proconfig from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'read_owner_fare_airports' and oidvectortypes(proargtypes) = 'text[]'),
  array['search_path=""'],
  'owner airport reader has an empty search path'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated',
   'airport-owner@example.invalid', now(), now(), now()),
  ('55555555-5555-5555-5555-555555555555', 'authenticated', 'authenticated',
   'airport-outsider@example.invalid', now(), now(), now());
insert into public.edicius_owners(owner_id)
values ('44444444-4444-4444-4444-444444444444');
insert into public.fare_airports(code, name, city, country, latitude, longitude, payload)
values
  ('AAA', 'Alpha Airport', 'Alpha', 'Peru', -10, -70,
   '{"code":"AAA","name":"Alpha Airport","city":"Alpha","country":"Peru","latitude":-10,"longitude":-70}'),
  ('BBB', 'Beta Airport', 'Beta', 'Chile', -20, -71,
   '{"code":"BBB","name":"Beta Airport","city":"Beta","country":"Chile","latitude":-20,"longitude":-71}');

set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(
  $$select public.read_owner_fare_airports(array[]::text[])$$,
  '42501', 'not_edicius_owner', 'non-owner cannot read map coordinates'
);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select is(
  jsonb_array_length(public.read_owner_fare_airports(array[]::text[])->'airports'),
  2,
  'an empty code list returns every archived airport for the map'
);
select is(
  jsonb_array_length(public.read_owner_fare_airports(array['BBB'])->'airports'),
  2,
  'requested waypoints do not narrow the complete map coordinate list'
);
select is(
  public.read_owner_fare_airports(array['BBB'])->'airports'->1->>'code',
  'BBB',
  'requested archived waypoints remain present in the complete list'
);
select is(
  (select jsonb_path_query_first(
    public.read_owner_fare_airports(array['BOG'])->'airports',
    '$[*] ? (@.code == "BOG")'
  )->>'name'),
  null,
  'a requested unarchived waypoint uses a coordinate-only fallback'
);
select is(
  (select (jsonb_path_query_first(
    public.read_owner_fare_airports(array['BOG'])->'airports',
    '$[*] ? (@.code == "BOG")'
  )->>'latitude')::double precision),
  4.70159::double precision,
  'the requested fallback carries its reference latitude'
);
select is(
  (select jsonb_path_query_first(
    public.read_owner_fare_airports(array_fill('BOG'::text, array[101]))->'airports',
    '$[*] ? (@.code == "BOG")'
  )->>'code'),
  'BOG',
  'the prior coordinate endpoint has no artificial 100-waypoint limit'
);
select throws_ok(
  $$select public.read_owner_fare_airports(array['bad'])$$,
  '22023', 'invalid_airport_codes', 'malformed airport codes fail closed'
);
select throws_ok(
  $$select public.read_owner_fare_airports(array[null]::text[])$$,
  '22023', 'invalid_airport_codes', 'null airport codes fail closed'
);

reset role;
select ok(not has_table_privilege('authenticated', 'public.fare_airports', 'select'),
          'authenticated callers still cannot read the airport table directly');
select ok(not has_table_privilege('authenticated', 'public.airport_coordinate_reference', 'select'),
          'authenticated callers cannot read the fallback table directly');

select * from finish();
rollback;
