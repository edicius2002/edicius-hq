begin;
set local role postgres;
grant usage on schema extensions to authenticated;
set local search_path = public, extensions;
select plan(27);

insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) values
  ('93111111-1111-1111-1111-111111111111','authenticated','authenticated','seace-page-owner@example.invalid',now(),now(),now()),
  ('93222222-2222-2222-2222-222222222222','authenticated','authenticated','seace-page-other@example.invalid',now(),now(),now()),
  ('93333333-3333-3333-3333-333333333333','authenticated','authenticated','seace-page-outsider@example.invalid',now(),now(),now());
insert into public.edicius_owners(owner_id) values
  ('93111111-1111-1111-1111-111111111111'),
  ('93222222-2222-2222-2222-222222222222');

insert into public.seace_records(owner_id,kind,record_key,region,year,published_at,payload) values
  ('93111111-1111-1111-1111-111111111111','notices','A','Arequipa',2026,'2026-10-24 11:30+00',
   '{"region":"Arequipa","code":"CM-A","minor":true,"object":"Bien","state":"Vigente","published":"24/10/2026 06:30","end":"25/10/2026","entity":"Entidad A"}'),
  ('93111111-1111-1111-1111-111111111111','notices','B','Arequipa',2026,'2026-10-22 11:00+00',
   '{"region":"Arequipa","code":"CM-B","minor":true,"object":"Servicio","state":"Vigente","published":"22/10/2026 06:00","end":"25/10/2026","entity":"Entidad B"}'),
  ('93111111-1111-1111-1111-111111111111','notices','C','Arequipa',2026,'2026-10-24 11:00+00',
   '{"region":"Arequipa","code":"CM-C","minor":true,"object":"Bien","state":"Vigente","published":"24/10/2026 06:00","end":"24/10/2026","entity":"Entidad C"}'),
  ('93111111-1111-1111-1111-111111111111','processes','D','Arequipa',2026,'2026-10-24 11:00+00',
   '{"region":"Arequipa","code":"P-D","minor":true,"object":"Servicio","state":"Convocado","published":"24/10/2026 06:00","end":"24/10/2026","registrationEnd":"24/10/2026","entity":"Entidad D"}'),
  ('93111111-1111-1111-1111-111111111111','processes','E','Arequipa',2026,'2026-10-22 11:00+00',
   '{"region":"Arequipa","code":"P-E","minor":true,"object":"Servicio","state":"Adjudicado","published":"22/10/2026 06:00","end":"26/10/2026","entity":"Entidad E"}'),
  ('93111111-1111-1111-1111-111111111111','contracts','F','Arequipa',2026,null,
   '{"region":"Arequipa","code":"CT-F","minor":true,"object":"Bien","signed":"23/10/2026","entity":"Entidad F"}'),
  ('93111111-1111-1111-1111-111111111111','notices','G','Arequipa',2026,'2026-10-22 11:00+00',
   '{"region":"Arequipa","code":"CM-G","minor":false,"object":"Bien","state":"Vigente","published":"22/10/2026 06:00","end":"23/10/2026","entity":"Entidad G"}'),
  ('93222222-2222-2222-2222-222222222222','notices','X','Arequipa',2026,'2026-10-24 11:00+00',
   '{"region":"Arequipa","code":"CM-X","minor":true,"object":"Bien","state":"Vigente","published":"24/10/2026 06:00","end":"25/10/2026","entity":"Entidad X"}');

set local role authenticated;
select set_config('request.jwt.claim.sub','93111111-1111-1111-1111-111111111111',true);

select is((select count(*) from public.seace_records where open_until > '2026-10-24 12:00+00'::timestamptz),3::bigint,
  'derived open boundary includes date-only process and excludes date-only notice');
select is((select count(*) from public.seace_records where record_key='E' and open_until is null),1::bigint,
  'terminal process has no open end');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','2','recent includes two open records');
select is(public.read_owner_seace_page('Arequipa',2026,'open',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','open excludes recent records');
select is(public.read_owner_seace_page('Arequipa',2026,'closed',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','2','closed includes elapsed and terminal records');
select is(public.read_owner_seace_page('Arequipa',2026,'closed',false,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','3','turning off Minor includes nonminor rows');
select is(public.read_owner_seace_page('Arequipa',2026,'published',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','published includes contracts');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,1,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','A','first page sorted before limiting');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,2,1,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','D','second page contains next record');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',true,1,1,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','D','ascending sort applies before pagination');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Servicio',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','object filter applies on server');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'entidad a','published',false,1,50,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','A','search matches entity case insensitively');

set local role postgres;
insert into public.seace_exclusions(owner_id,record_key) values
  ('93111111-1111-1111-1111-111111111111','minor:["Arequipa","CM-A"]');
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','excluded row is absent from included count');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',true,'','published',false,1,50,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','A','excluded view returns excluded row');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,2,1,'2026-10-24 12:00+00') ->> 'total','1','empty later page still reports exact total');
set local role postgres;
insert into public.seace_exclusions(owner_id,record_key) values
  ('93111111-1111-1111-1111-111111111111','process:["Arequipa","P-D","24/10/2026 06:00","Entidad D"]');
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',true,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','2','process exclusion key matches the saved browser key');
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,repeat('x',201),'published',false,1,50,'2026-10-24 12:00+00') ->> 'total','0','long pasted search remains a valid empty result');
set local role postgres;
update public.seace_records
  set payload = jsonb_set(payload,'{code}',to_jsonb(E' \tCM-A\t '::text))
  where owner_id='93111111-1111-1111-1111-111111111111' and kind='notices' and record_key='A';
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',true,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','2','exclusion code trims whitespace as the browser does');
set local role postgres;
update public.seace_records
  set payload = jsonb_set(payload,'{code}',to_jsonb((chr(160) || 'CM-A' || chr(65279))::text))
  where owner_id='93111111-1111-1111-1111-111111111111' and kind='notices' and record_key='A';
update public.seace_records
  set payload = jsonb_set(payload,'{object}',to_jsonb((U&'Consultori\0301a de Obra')::text))
  where owner_id='93111111-1111-1111-1111-111111111111' and kind='contracts' and record_key='F';
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',true,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','2','exclusion code trims Unicode whitespace');
select is(public.read_owner_seace_page('Arequipa',2026,'published',true,'Consultoría de Obra',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','object filter normalizes decomposed accents');
set local role postgres;
insert into public.seace_records(owner_id,kind,record_key,region,year,published_at,payload) values
  ('93111111-1111-1111-1111-111111111111','notices','H','Arequipa',2026,'2026-10-23 12:00+00',
   '{"region":"Arequipa","code":"CM-H","minor":true,"object":"Bien","state":"Vigente","published":"23/10/2026 07:00","end":"25/10/2026"}');
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'CM-H','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','exact 24-hour boundary is recent');
select is(public.read_owner_seace_page('Arequipa',2026,'open',true,'Todos',false,'CM-H','published',false,1,50,'2026-10-24 12:00:01+00') ->> 'total','1','record moves to Open one second after 24-hour boundary');
set local role postgres;
update public.seace_records set payload=jsonb_set(payload,'{state}','"Cancelado"'::jsonb)
  where owner_id='93111111-1111-1111-1111-111111111111' and kind='notices' and record_key='H';
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'closed',true,'Todos',false,'CM-H','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','collector payload update refreshes derived open field');
set local role postgres;
insert into public.seace_records(owner_id,kind,record_key,region,year,published_at,payload) values
  ('93111111-1111-1111-1111-111111111111','notices','H','Arequipa',2026,'2026-10-23 12:00+00',
   '{"region":"Arequipa","code":"CM-H","minor":true,"object":"Bien","state":"Vigente","published":"23/10/2026 07:00","end":"25/10/2026"}')
  on conflict (owner_id,kind,record_key) do update set payload=excluded.payload;
set local role authenticated;
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'CM-H','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','1','collector upsert restores derived open field');

select set_config('request.jwt.claim.sub','93222222-2222-2222-2222-222222222222',true);
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') #>> '{rows,0,recordKey}','X','second owner receives own record');
select set_config('request.jwt.claim.sub','93333333-3333-3333-3333-333333333333',true);
select is(public.read_owner_seace_page('Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00') ->> 'total','0','non-owner sees no rows');
select throws_ok($$select public.read_owner_seace_page('Arequipa',2026,'bad',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00')$$,'22023','invalid_seace_page_request','invalid view rejected');

select * from finish();
rollback;
