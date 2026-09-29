begin;
select plan(24);
select has_table('public'::name,'fx_observations'::name);
select col_is_pk('public','fx_observations',array['owner_id','source','effective_at','observed_at']);
select ok(not has_table_privilege('anon','public.fx_observations','select'),'anon cannot read');
select ok(not has_table_privilege('authenticated','public.fx_observations','insert,update,delete'),'browser cannot write');
select ok(has_table_privilege('service_role','public.fx_observations','insert,update'),'service writes');
select ok(not has_function_privilege('anon','public.read_fx_latest()','execute'),'anonymous RPC blocked');
insert into auth.users(id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),('cccccccc-cccc-cccc-cccc-cccccccccccc');
insert into public.edicius_owners(owner_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
insert into public.fx_observations(owner_id,source,observed_at,effective_at,buy,sell) values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','kambista',now()-interval '1 hour',now()-interval '1 hour',3.4,3.5),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','kambista',now()-interval '2 hour',now()-interval '2 hour',3.3,3.5),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','kambista',now(),now()-interval '1 year',2.9,3.0),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bcrp',now()-interval '1 hour',date_trunc('day',now()),3.1,3.2),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bcrp',now(),date_trunc('day',now()),3.2,3.3),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','kambista',now(),now(),8,9);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}',true);
select is((select count(*) from public.fx_observations),5::bigint,'RLS isolates other owner');
select is(jsonb_array_length(public.read_fx_latest()),2,'latest only own sources');
select is((select (x->>'buy')::numeric from jsonb_array_elements(public.read_fx_latest()) x where x->>'source'='kambista'),3.4::numeric,'old backfill does not replace latest');
select is((select (x->>'buy')::numeric from jsonb_array_elements(public.read_fx_latest()) x where x->>'source'='bcrp'),3.2::numeric,'latest revision wins');
select is(jsonb_array_length(public.read_fx_history('kambista','1D')->'points'),2,'intraday captures retained');
select is(public.read_fx_history('kambista','1D')->>'aggregation','observations','intraday label');
select is(public.read_fx_history('kambista','1M')->>'aggregation','daily','daily label');
select is(jsonb_array_length(public.read_fx_history('bcrp','1D')->'points'),1,'reference revisions collapsed');
select is(public.read_fx_history('bcrp','1D')->>'aggregation','daily','references daily');
select throws_ok($$select public.read_fx_history('unknown','ALL')$$,'22023','invalid FX source or range','invalid source');
select throws_ok($$select public.read_fx_history('bcrp','unknown')$$,'22023','invalid FX source or range','invalid range');
select is(jsonb_array_length(public.read_fx_history('kambista','1M')->'points'),
  (select count(distinct (effective_at at time zone 'America/Lima')::date)::integer from public.fx_observations where source='kambista' and effective_at >= now()-interval '1 month'), 'daily aggregation collapses Lima days');
select is((select max((x->>'buy')::numeric) from jsonb_array_elements(public.read_fx_history('kambista','1M')->'points') x),3.4::numeric,'daily retains last capture');
select throws_ok($$insert into public.fx_observations(owner_id,source,observed_at,effective_at,buy,sell) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','kambista',now(),now(),3,4)$$,'42501',null,'actual browser insert denied');
select throws_ok($$update public.fx_observations set buy=3$$,'42501',null,'actual browser update denied');
select set_config('request.jwt.claims','{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}',true);
select is((select count(*) from public.fx_observations),0::bigint,'non-owner reads no rows');
select throws_ok($$select public.read_fx_latest()$$,'42501','owner access required','non-owner RPC denied');
select throws_ok($$select public.read_fx_history('bcrp','ALL')$$,'42501','owner access required','non-owner history denied');
select * from finish();
rollback;
