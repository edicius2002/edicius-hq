begin;
select no_plan();
select has_function('public', 'read_airfare_history_meta',
  array['text','text','text','text[]','text','text','text']);
set local role service_role;
select is(public.read_airfare_history_meta('NON','DST',null,null,null,null)
  -> 'counts', '{"snapshots":"0","baseline":"0"}'::jsonb,
  'empty route has exact string counts');
select ok(not has_table_privilege('service_role',
  'public.airfare_history_revision','UPDATE'), 'writer cannot directly alter revision');
reset role;

-- Omitting any mutation trigger permits a mixed-revision result after replay.
create function pg_temp.check_mutations() returns setof text language plpgsql as $$
declare t text; command text; before_revision bigint; after_revision bigint;
begin
  foreach t in array array['fare_snapshots','fare_baseline_points','fare_checks','fare_airports'] loop
    foreach command in array array[
      format('insert into public.%I select * from public.%I where false', t,t),
      format('update public.%I set payload = payload where false',t),
      format('delete from public.%I where false',t),
      format('truncate public.%I',t)
    ] loop
      select revision into before_revision from public.airfare_history_revision;
      execute command;
      select revision into after_revision from public.airfare_history_revision;
      return next ok(after_revision > before_revision, command || ' advances revision');
    end loop;
  end loop;
end;
$$;
select * from pg_temp.check_mutations();
select ok(relrowsecurity, 'revision table uses RLS') from pg_class
where oid = 'public.airfare_history_revision'::regclass;
select ok(not has_table_privilege(r, 'public.airfare_history_revision', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  r || ' cannot directly access revision') from unnest(array['anon','authenticated']) r;
select ok(not has_function_privilege(r, 'public.advance_airfare_history_revision()', 'EXECUTE'),
  r || ' cannot invoke trigger function') from unnest(array['anon','authenticated','service_role']) r;
select ok(not has_table_privilege('service_role', 'public.' || t, 'DELETE,TRUNCATE'),
  'no delete/truncate grant added for ' || t)
from unnest(array['fare_snapshots','fare_baseline_points','fare_checks','fare_airports']) t;
select ok(provolatile = 's' and proconfig = array['search_path=""']
  and prosecdef = (proname = 'read_owner_airfare_history_meta'), proname || ' security and snapshot')
from pg_proc where oid in (
  'public.read_airfare_history_meta(text,text,text,text[],text,text,text)'::regprocedure,
  'public.read_owner_airfare_history_meta(text,text,text,text[],text,text,text)'::regprocedure);

set local role service_role;
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
values
  (repeat('1',64),'MET','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',1,'test','USD',0,'{"zero":0,"nil":null}'),
  (repeat('2',64),'MET','DST','2026-12-01','2026-09-19','2026-09-19T00:00:00Z',2,'test','USD',300,'{"exact":9007199254740993.123456789}');
insert into public.fare_baseline_points
  (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
values (repeat('3',64),'MET','DST','2026-11-01','2026-09-01',0,'USD','test','{"price":0}');
insert into public.fare_checks
  (record_id,kind,origin,destination,flight_date,checked_at,outcome,payload)
values (repeat('4',64),'board','MET','DST','2026-11-01','2026-09-19','changed','{"at":"2026-09-19T00:00:00Z"}');
insert into public.fare_airports(code,latitude,longitude,payload) values
  ('MET',0,0,'{"code":"MET","name":"Perú"}'),('DST',0,0,'{"code":"DST","nil":null}');
reset role;

create temporary table before_upsert as select revision from public.airfare_history_revision;
set local role service_role;
insert into public.fare_airports(code,latitude,longitude,payload)
values ('MET',0,0,'{"code":"MET","name":"Perú"}')
on conflict(code) do update set payload = excluded.payload;
reset role;
select ok(r.revision > b.revision, 'real service-role replay can advance protected counter')
from public.airfare_history_revision r cross join before_upsert b;

create temporary table meta_reference as
select public.read_airfare_history_meta('MET','DST','2026-11',array['2026-11'],null,null) body;
select is(body->'counts','{"snapshots":"1","baseline":"1"}'::jsonb, 'selected counts') from meta_reference;
select is(body - array['protocolVersion','revision','queryKey','counts'],
  public.read_airfare_history('MET','DST','2026-11',array['2026-11'],null,null) - array['snapshots','baseline'],
  'all legacy summaries unchanged') from meta_reference;
select is(body->'pairReference','{"value":150,"dates":2}'::jsonb,'reference sees outside-month departure') from meta_reference;
select is(body->'airports'->0->>'code','MET','airports are origin-first') from meta_reference;
select is(public.read_airfare_history_meta('MET','DST','2026',null,null,null)->'counts',
  '{"snapshots":"2","baseline":"1"}'::jsonb,'arbitrary departure prefix and null months');
select is(public.read_airfare_history_meta('MET','DST','2026-11-0',array[]::text[],null,null)->'counts',
  '{"snapshots":"0","baseline":"1"}'::jsonb,'empty months preserve independent baseline prefix');
select is(public.read_airfare_history_meta('MET','DST','2026-11',array['2026-11','2026-11'],'',''),
  body,'equivalent empty filters and duplicate months share key') from meta_reference;
select isnt(public.airfare_history_query_key('MET','DST',null,null,null,null),
  public.airfare_history_query_key('MET','DST',null,array[]::text[],null,null),'null/empty months keys differ');
select is(public.read_airfare_history_meta('MET','DST',null,null,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z')#>>'{counts,snapshots}',
  '2','lexical observation bounds inclusive');
select is(public.read_airfare_history_meta('MET','DST',null,null,'2026-09-20',null)#>>'{counts,snapshots}',
  '0','lexical observation lower bound filters rows');
select is(public.read_airfare_history_meta('MET','DST','2026-11',array['2026-11'],null,null,body->>'revision'),
  body,'final expected revision preserves metadata') from meta_reference;
select throws_ok($$select public.read_airfare_history_meta('MET','DST',null,null,null,null,'1')$$,
  'PT409','airfare_history_revision_changed','old expected revision returns a bounded HTTP conflict');
select throws_ok(format('select public.read_airfare_history_meta(''MET'',''DST'',null,array[%L],null,null)',m),
  '22023','airfare_history_invalid_request','invalid month rejects: ' || coalesce(m,'null'))
from unnest(array['2026-13','2026-00','2026-1','0000-01','2026-01-01',null]) m;
select throws_ok(format('select public.read_airfare_history_meta(''MET'',''DST'',null,null,null,null,%L)',r),
  '22023','airfare_history_invalid_request','invalid expected revision rejects: ' || r)
from unnest(array['0','-1','01','1.0','9223372036854775808']) r;

create temporary table before_rollback as select * from public.airfare_history_revision;
savepoint rolled_write;
update public.fare_snapshots set source_line = 99;
rollback to rolled_write;
select is(r.revision,b.revision,'rollback restores counter') from public.airfare_history_revision r cross join before_rollback b;
select is((select max(source_line) from public.fare_snapshots),2::bigint,'rollback restores data');
insert into public.fare_calendar_captures select * from public.fare_calendar_captures where false;
insert into public.airfare_import_runs select * from public.airfare_import_runs where false;
insert into public.app_documents select * from public.app_documents where false;
insert into public.airfare_documents select * from public.airfare_documents where false;
select is(r.revision,b.revision,'unrelated calendar/import/watch mutations do not invalidate')
from public.airfare_history_revision r cross join before_rollback b;

savepoint oversized;
update public.fare_airports set payload = jsonb_build_object('large',repeat('é',524288)) where code = 'MET';
select throws_ok($$select public.read_airfare_history_meta('MET','DST',null,null,null,null)$$,
  '22023','airfare_history_metadata_too_large','summary is bounded in UTF8 bytes');
rollback to oversized;
savepoint missing_counter;
delete from public.airfare_history_revision;
select throws_ok($$select public.read_airfare_history_meta('MET','DST',null,null,null,null)$$,
  '55000','airfare_history_revision_missing','missing singleton is not revision zero');
select throws_ok($$update public.fare_airports set payload=payload$$,
  '55000','airfare_history_revision_missing','write cannot bypass missing revision guard');
rollback to missing_counter;

insert into auth.users(id) values ('00000000-0000-0000-0000-000000000101');
insert into public.edicius_owners(owner_id) values ('00000000-0000-0000-0000-000000000101');
set local role anon;
select throws_ok($$select public.read_airfare_history_meta('MET','DST',null,null,null,null)$$,'42501',null,'anon core denied');
select throws_ok($$select public.read_owner_airfare_history_meta('MET','DST',null,null,null,null)$$,'42501',null,'anon wrapper denied');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000102',true);
select throws_ok($$select public.read_owner_airfare_history_meta('MET','DST',null,null,null,null)$$,
  '42501','not_edicius_owner','non-owner wrapper denied');
select throws_ok($$select public.read_airfare_history_meta('MET','DST',null,null,null,null)$$,'42501',null,'browser core denied');
select throws_ok($$select * from public.airfare_history_revision$$,'42501',null,'browser direct revision denied');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000101',true);
select is(public.read_owner_airfare_history_meta('MET','DST',null,null,null,null)#>>'{counts,snapshots}',
  '2','authorized owner wrapper succeeds');
reset role;
select * from finish();
rollback;
