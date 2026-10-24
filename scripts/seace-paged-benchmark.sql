-- Run only in the isolated database created for seace-paged-local-test.sql.
begin;
insert into public.edicius_owners(owner_id) values ('94111111-1111-1111-1111-111111111111');
insert into public.seace_records(owner_id,kind,record_key,region,year,published_at,payload)
select '94111111-1111-1111-1111-111111111111','notices',g::text,'Arequipa',2026,
  '2026-01-01 05:00+00'::timestamptz,
  jsonb_build_object('region','Arequipa','code','CM-' || g,'minor',true,
    'object','Bien','state','Vigente','published','01/01/2026','end','01/01/2026')
from generate_series(1,7000) g;
insert into public.seace_records(owner_id,kind,record_key,region,year,published_at,payload)
select '94111111-1111-1111-1111-111111111111','notices','recent-' || g,'Arequipa',2026,
  '2026-10-24 11:00+00'::timestamptz,
  jsonb_build_object('region','Arequipa','code','CM-R-' || g,'minor',true,
    'object','Bien','state','Vigente','published','24/10/2026 06:00','end','25/10/2026')
from generate_series(1,31) g;
set local role authenticated;
select set_config('request.jwt.claim.sub','94111111-1111-1111-1111-111111111111',true);
explain (analyze,buffers) select public.read_owner_seace_page(
  'Arequipa',2026,'recent',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00');
explain (analyze,buffers) select public.read_owner_seace_page(
  'Arequipa',2026,'closed',true,'Todos',false,'','published',false,1,50,'2026-10-24 12:00+00');
rollback;
