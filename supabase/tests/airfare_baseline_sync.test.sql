begin;
select plan(4);

select has_index('public'::name, 'fare_baseline_points'::name,
  'fare_baseline_natural_key_idx'::name,
  array['origin','destination','flight_date','price_date']::name[]);

set local role service_role;
insert into public.fare_baseline_points
  (record_id, origin, destination, flight_date, price_date, price, currency, source, payload)
values (repeat('a',64), 'AQP', 'LIM', '2027-03-01', '2026-09-01', 150, 'USD', 'test',
        '{"flightDate":"2027-03-01","date":"2026-09-01","price":150}');

insert into public.fare_baseline_points
  (record_id, origin, destination, flight_date, price_date, price, currency, source, payload)
values (repeat('b',64), 'AQP', 'LIM', '2027-03-01', '2026-09-01', 160, 'USD', 'test',
        '{"flightDate":"2027-03-01","date":"2026-09-01","price":160}')
on conflict (origin, destination, flight_date, price_date) do update
set record_id = excluded.record_id, price = excluded.price, payload = excluded.payload;

select is((select count(*) from public.fare_baseline_points), 1::bigint,
          'a rewritten baseline point updates its existing natural key');
select is((select payload->>'price' from public.fare_baseline_points), '160',
          'the baseline keeps only the latest provider answer');
select is((select entry->>'digest' from jsonb_array_elements(public.airfare_dataset_manifest()) entry
           where entry->>'dataset' = 'baseline'),
          encode(sha256(convert_to(repeat('b',64), 'UTF8')), 'hex'),
          'manifest reflects the replacement content identity');

select * from finish();
rollback;
