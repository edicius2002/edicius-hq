begin;
select no_plan();

select has_table('public', 'fare_month_projections', 'month projections are persisted');
select has_table('public', 'fare_flight_projections', 'flight projections are persisted');
select has_table('public', 'fare_projection_dirty_routes', 'dirty routes survive failed syncs');
select has_function('public', 'refresh_fare_month_projection', array['text','text','text'], 'service refresh exists');
select has_function('public', 'refresh_fare_route_projection', array['text','text'], 'route refresh exists');
select has_function('public', 'list_fare_projection_dirty_routes', array[]::text[], 'dirty route list exists');
select has_function('public', 'read_owner_fare_month_projection', array['text','text','text'], 'owner month read exists');
select has_function('public', 'read_owner_fare_flights', array['text','text','text'], 'owner flight read exists');
select has_column('public', 'fare_flight_projections', 'seen_days', 'flight projection stores observation-day membership');
select has_function('public', 'read_owner_fare_flights_page', array['text','text','text','date','date','jsonb','text','text','integer','integer'], 'paged owner flight read exists');

set local role service_role;
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
values
  (repeat('a',64),'TST','DST','2027-03-09','2026-09-20T10:00:00Z','2026-09-20T10:00:00Z',1,'test','USD',100,
   '{"capturedAt":"2026-09-20T10:00:00Z","source":"test","origin":"TST","destination":"DST","flightDate":"2027-03-09","returnDate":null,"currency":"USD","insights":null,"offers":[{"airline":"AA","airlineName":"Alpha","flightNumber":"1","departureAt":"2027-03-09T10:00","arrivalAt":"2027-03-09T12:00","transfers":0,"durationMinutes":120,"price":100,"currency":"USD"},{"airline":"BB","airlineName":"Beta","flightNumber":"2","departureAt":"2027-03-09T15:00","arrivalAt":"2027-03-09T17:00","transfers":0,"durationMinutes":120,"price":200,"currency":"USD"}]}'),
  (repeat('b',64),'TST','DST','2027-03-09','2026-09-20T11:00:00Z','2026-09-20T11:00:00Z',2,'test','USD',100,
   '{"capturedAt":"2026-09-20T11:00:00Z","source":"test","origin":"TST","destination":"DST","flightDate":"2027-03-09","returnDate":null,"currency":"USD","insights":null,"offers":[{"airline":"AA","airlineName":"Alpha","flightNumber":"1","departureAt":"2027-03-09T10:00","arrivalAt":"2027-03-09T12:00","transfers":0,"durationMinutes":120,"price":100,"currency":"USD"}]}'),
  (repeat('c',64),'TST','DST','2027-03-09','2026-09-20T12:00:00Z','2026-09-20T12:00:00Z',3,'test','USD',90,
   '{"capturedAt":"2026-09-20T12:00:00Z","source":"test","origin":"TST","destination":"DST","flightDate":"2027-03-09","returnDate":null,"currency":"USD","insights":null,"offers":[{"airline":"AA","airlineName":"Alpha","flightNumber":"1","departureAt":"2027-03-09T10:00","arrivalAt":"2027-03-09T12:00","transfers":0,"durationMinutes":120,"price":90,"currency":"USD"}]}'),
  (repeat('d',64),'TST','DST','2027-03-10','2026-09-20T13:00:00Z','2026-09-20T13:00:00Z',4,'test','USD',null,
   '{"capturedAt":"2026-09-20T13:00:00Z","source":"test","origin":"TST","destination":"DST","flightDate":"2027-03-10","returnDate":null,"currency":"USD","insights":null,"offers":[]}'),
  (repeat('e',64),'TST','DST','2027-03-09','2026-09-20T14:00:00Z','2026-09-20T14:00:00Z',5,'test','USD',null,
   '{"capturedAt":"2026-09-20T14:00:00Z","source":"test","origin":"TST","destination":"DST","flightDate":"2027-03-09","returnDate":null,"currency":"USD","insights":null,"offers":[{"airline":"AA","airlineName":"Alpha","flightNumber":"1","departureAt":"2027-03-09T10:00","arrivalAt":"2027-03-09T12:00","transfers":0,"durationMinutes":120,"price":null,"currency":"USD"}]}');
insert into public.fare_baseline_points
  (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
values
  (repeat('f',64),'TST','DST','2027-03-09','2026-09-20',50,'USD','test','{"flightDate":"2027-03-09","date":"2026-09-20","price":50}'),
  (repeat('0',64),'TST','DST','2027-03-10','2026-09-20',70,'USD','test','{"flightDate":"2027-03-10","date":"2026-09-20","price":70}');

select is((select count(*)::text from public.list_fare_projection_dirty_routes() where origin='TST' and destination='DST'),'1','snapshot insert marks one route dirty');
select lives_ok($$select public.refresh_fare_month_projection('TST','DST','2027-03')$$, 'refresh succeeds');
select is((select payload #>> '{priceDays,0,count}' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),'3','three priced observations in day');
select is((select payload #>> '{priceDays,0,middle}' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),'100','median of snapshot minima');
select is((select payload #>> '{providerDays,0,middle}' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),'60','provider median across departure dates');
select is((select payload #>> '{unsoldDays,0,count}' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),'2','empty and unpriced boards retained');
select is((select jsonb_array_length(payload->'latestBoards') from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),2,'one last board per departure');
select is((select price::text from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),'90','latest price');
select is((select previous_price::text from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),'100','previous distinct price');
select is((select sightings::text from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),'4','unpriced sighting still counts');
select is((select present from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),true,'present on latest board for departure');
select is((select category from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='BB|2|2027-03-09T15:00|2027-03-09T17:00'),'gone','missing from latest board of own departure');
select is((select category from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),'fell','last distinct price determines category');
select is((select payload->>'latestCapture' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),'2026-09-20T14:00:00Z','latest capture spans all departures');
select is((select last_seen_at from public.fare_flight_projections where origin='TST' and destination='DST' and month='2027-03' and flight_key='AA|1|2027-03-09T10:00|2027-03-09T12:00'),'2026-09-20T14:00:00Z','unpriced sighting sets period membership');
select is((select payload ? 'airports' from public.fare_month_projections where origin='TST' and destination='DST' and month='2027-03'),false,'airport directory is read separately rather than copied into month projection');
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
select repeat('7',64),'STB','DST','2027-04-09'::date,'2026-09-20T10:00:00Z'::timestamptz,'2026-09-20T10:00:00Z',1,'test','USD',100,
  jsonb_build_object('offers',jsonb_build_array(jsonb_build_object('airline','AA','flightNumber','1','departureAt','2027-04-09T10:00','arrivalAt','2027-04-09T12:00','price',100)))
union all
select repeat('8',64),'STB','DST','2027-04-09'::date,'2026-09-21T11:00:00Z'::timestamptz,'2026-09-21T11:00:00Z',2,'test','USD',100,
  jsonb_build_object('offers',jsonb_build_array(jsonb_build_object('airline','AA','flightNumber','1','departureAt','2027-04-09T10:00','arrivalAt','2027-04-09T12:00','price',100)));
select lives_ok($$select public.refresh_fare_month_projection('STB','DST','2027-04')$$,'stable flight projection refresh succeeds');
select is((select change_percent::text from public.fare_flight_projections where origin='STB' and destination='DST' and month='2027-04'),'0','repeated stable price reports zero change');
select is((select category from public.fare_flight_projections where origin='STB' and destination='DST' and month='2027-04'),'unchanged','repeated stable flight remains unchanged');
select is((select seen_days::text from public.fare_flight_projections where origin='STB' and destination='DST' and month='2027-04'),'{2026-09-20,2026-09-21}','every observation day is retained');
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
values
  (repeat('1',64),'VIA','DST','2027-06-09','2026-09-20T10:00:00Z','2026-09-20T10:00:00Z',1,'test','USD',100,
   '{"offers":[{"airline":"AA","flightNumber":"1","departureAt":"2027-06-09T10:00","arrivalAt":"2027-06-09T12:00","price":100,"viaPoints":["LIM"]}]}'),
  (repeat('2',64),'VIA','DST','2027-06-09','2026-09-21T10:00:00Z','2026-09-21T10:00:00Z',2,'test','USD',null,'{"offers":[]}');
select lives_ok($$select public.refresh_fare_month_projection('VIA','DST','2027-06')$$,'historic stop route projection refresh succeeds');
select is((select payload->'viaSequences' from public.fare_month_projections where origin='VIA' and destination='DST' and month='2027-06'),'[["LIM"]]'::jsonb,'historic intermediate airports remain available without old boards');
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
values (repeat('9',64),'DEL','DST','2027-05-09','2026-09-20T10:00:00Z','2026-09-20T10:00:00Z',1,'test','USD',100,'{"offers":[]}');
select is(public.refresh_fare_route_projection('DEL','DST'),1,'route builds its only month');
reset role;
delete from public.fare_snapshots where origin='DEL' and destination='DST';
set local role service_role;
select is(public.refresh_fare_route_projection('DEL','DST'),0,'route has no source months after deletion');
select is((select count(*)::text from public.fare_month_projections where origin='DEL' and destination='DST'),'0','removed source month also removes its projection');
select throws_ok($$select public.read_owner_fare_month_projection('TST','DST','2027-03')$$,'42501','not_edicius_owner','month read denies a non-owner');
select throws_ok($$select public.read_owner_fare_flights('TST','DST','2027-03')$$,'42501','not_edicius_owner','flight read denies a non-owner');
select throws_ok($$select public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20')$$,'42501','not_edicius_owner','paged flight read denies a non-owner');
select is(public.refresh_fare_route_projection('TST','DST'),1,'route refresh covers its month');
select is((select count(*)::text from public.list_fare_projection_dirty_routes() where origin='TST' and destination='DST'),'0','successful route refresh clears dirty mark');

reset role;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000777');
insert into public.edicius_owners(owner_id) values ('00000000-0000-0000-0000-000000000777');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000777',true);
select is(public.read_owner_fare_month_projection('TST','DST','2027-03')#>>'{priceDays,0,count}','3','owner reads compact month projection');
select is(jsonb_array_length(public.read_owner_fare_flights('TST','DST','2027-03')->'rows'),2,'owner reads flight projection');
select is(public.read_owner_fare_flights_page('STB','DST','2027-04','2026-09-20','2026-09-20','{}','departs','asc',1,10)->>'inPeriod','1','flight seen on first day remains in first day');
select is(public.read_owner_fare_flights_page('STB','DST','2027-04','2026-09-21','2026-09-21','{}','departs','asc',1,10)->>'inPeriod','1','flight seen on next day remains in next day');
select is(public.read_owner_fare_flights_page('STB','DST','2027-04','2026-09-22','2026-09-22','{}','departs','asc',1,10)->>'inPeriod','0','unseen day has no flight rows');
select is(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{"change":"gone"}','price','desc',1,10)->>'shown','1','category filter keeps gone flight');
select is(jsonb_array_length(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{}','departs','asc',2,1)->'rows'),1,'server paginates flight rows');
select is(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{}','price','asc',1,1)#>>'{rows,0,key}','AA|1|2027-03-09T10:00|2027-03-09T12:00','ascending price sorts before limiting');
select is(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{}','price','desc',1,1)#>>'{rows,0,key}','BB|2|2027-03-09T15:00|2027-03-09T17:00','descending price sorts before limiting');
select is(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{"maxPrice":100}','price','asc',1,10)->>'shown','1','price filter runs before pagination');
select is(public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{}','departs','asc',1,1)->>'pageCount','2','page count includes all period rows');
select throws_ok($$select public.read_owner_fare_flights_page('TST','DST','2027-03','2026-09-20','2026-09-20','{}','invalid','asc',1,10)$$,'22023','invalid_fare_flight_page_request','sort whitelist rejects invalid values');
select throws_ok($$select * from public.fare_month_projections$$,'42501',null,'browser cannot select projection table');
select throws_ok($$select public.refresh_fare_route_projection('TST','DST')$$,'42501',null,'browser cannot rebuild projections');
reset role;

select * from finish();
rollback;
