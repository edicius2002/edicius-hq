begin;
select plan(12);

-- The search once looked only at the airports the archive had collected, so a
-- code nobody had watched (JFK, BOG, CDG) offered nothing at all.
select has_table('public'::name, 'airport_catalog'::name);
select is((select count(*) from public.airport_catalog), 4162::bigint,
          'the complete checked-in airport catalog is installed');
select ok(
  not has_table_privilege('authenticated', 'public.airport_catalog', 'select')
  and not has_table_privilege('anon', 'public.airport_catalog', 'select'),
  'the catalog is read only through the owner-gated search'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('66666666-6666-6666-6666-666666666666', 'authenticated', 'authenticated',
   'catalog-owner@example.invalid', now(), now(), now()),
  ('77777777-7777-7777-7777-777777777777', 'authenticated', 'authenticated',
   'catalog-outsider@example.invalid', now(), now(), now());
insert into public.edicius_owners(owner_id) values ('66666666-6666-6666-6666-666666666666');
insert into public.fare_airports(code, name, city, country, latitude, longitude, payload)
values ('ZZQ', 'Archive Only Field', 'Nowhere', 'Peru', 0, 0,
        '{"code":"ZZQ","name":"Archive Only Field","city":"Nowhere","country":"Peru","latitude":0,"longitude":0}');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select throws_ok(
  $$select public.search_owner_airports('JFK', 8)$$,
  '42501', 'not_edicius_owner', 'a non-owner still cannot search'
);

select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
select is(public.search_owner_airports('JFK', 8)->'matches'->0->>'code', 'JFK',
          'an exact code nobody watched is found, first');
select is(public.search_owner_airports('cdg', 8)->'matches'->0->>'code', 'CDG',
          'a lower-case code is the same search');
select is(public.search_owner_airports('jf', 8)->'matches'->0->>'code', 'JFK',
          'two letters already offer the code they begin');
select is(public.search_owner_airports('Málaga', 8)->'matches'->0->>'code', 'AGP',
          'an accented city is found');
select is(public.search_owner_airports('cusco', 8)->'matches'->0->>'code', 'CUZ',
          'an unaccented city is found');
select is(public.search_owner_airports('heathrow', 8)->'matches'->0->>'code', 'LHR',
          'an airport name is the last resort, and still found');
select is(public.search_owner_airports('ZZQ', 8)->'matches'->0->>'code', 'ZZQ',
          'an archived airport the catalog lacks stays findable');
select is(jsonb_array_length(public.search_owner_airports('   ', 8)->'matches'), 0,
          'a blank query offers nothing');

select * from finish();
rollback;
