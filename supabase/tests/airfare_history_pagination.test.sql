begin;
select no_plan();
select has_function('public','read_airfare_history_page',array['text','text','text','text[]','text','text','text','text','jsonb','integer']);
select throws_ok($$select public.read_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots',null,0)$$,
  '22023','airfare_history_invalid_request','zero page size rejects');
select throws_ok($$select public.read_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots','{"after":[]}',1)$$,
  '22023','airfare_history_invalid_cursor','invalid cursor rejects before revision comparison');

set local role service_role;
insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,cheapest_price,payload)
values
  (repeat('1',64),'JSN','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',9007199254740992,'test','USD',0,'{"zero":0,"nil":null}'),
  (repeat('2',64),'JSN','DST','2026-12-01','2026-09-19','2026-09-19T00:00:00Z',9007199254740992,'test','USD',300,'{"exact":9007199254740993.123456789}'),
  (repeat('3',64),'JSN','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',9007199254740993,'test','USD',null,'{"nested":{"empty":[],"nil":null}}'),
  (repeat('4',64),'JSN','DST','2026-12-01','2026-09-20','2026-09-20T00:00:00Z',1,'test','USD',300,'{"text":"Perú — quote: \" slash: \\"}');
insert into public.fare_baseline_points
  (record_id,origin,destination,flight_date,price_date,price,currency,source,payload)
values
  (repeat('5',64),'JSN','DST','2026-11-01','2026-09-01',0,'USD','test','{"price":0,"date":"2026-09-01"}'),
  (repeat('6',64),'JSN','DST','2026-11-01','2026-09-02',1,'USD','test','{"price":1,"date":"2026-09-02"}');
reset role;

-- Compare complete SQL JSONB, not a floating-point reconstruction of precision.
create function pg_temp.assembled(months text[], dep text, lo text, hi text, size integer)
returns jsonb language plpgsql as $$
declare meta jsonb; page jsonb; cursor jsonb; dataset text; items jsonb; result jsonb; loops int;
begin
  meta := public.read_airfare_history_meta('JSN','DST',dep,months,lo,hi);
  result := meta - array['protocolVersion','revision','queryKey','counts'];
  foreach dataset in array array['snapshots','baseline'] loop
    cursor := null; items := '[]'; loops := 0;
    loop
      page := public.read_airfare_history_page('JSN','DST',dep,months,lo,hi,meta->>'revision',dataset,cursor,size);
      select items || coalesce(jsonb_agg(i->'payload'),'[]') into items from jsonb_array_elements(page->'items') i;
      cursor := nullif(page->'nextCursor','null'); loops := loops + 1;
      if loops > 10 then raise exception 'nonterminating pagination'; end if;
      exit when cursor is null;
    end loop;
    result := result || jsonb_build_object(dataset,items);
  end loop;
  return result;
end;
$$;
select is(pg_temp.assembled(months,dep,lo,hi,size),
  public.read_airfare_history('JSN','DST',dep,months,lo,hi), 'complete parity: ' || label || ' size ' || size)
from (values
  ('whole',null::text[],null::text,null::text,null::text),
  ('empty',array[]::text[],'2026-11',null,null),
  ('dedupe',array['2026-12','2026-11','2026-11'],'2026',null,null),
  ('prefix',array['2026-12'],'2026-11-0',null,null),
  ('inclusive',null,null,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z'),
  ('excluded',null,null,'2026-10',null)
) v(label,months,dep,lo,hi) cross join unnest(array[1,2,100,250]) size;

create temporary table first_page as select public.read_airfare_history_page('JSN','DST',null,null,null,null,
  (select revision::text from public.airfare_history_revision),'snapshots',null,2) body;
select is(body#>>'{items,0,order,1}','9007199254740992','bigint order is exact decimal string') from first_page;
select is(body#>>'{nextCursor,after,2}',repeat('2',64),'ID resolves source-line ties') from first_page;
select is(jsonb_array_length(body->'items'),2,'row bound') from first_page;
select is(jsonb_array_length(public.read_airfare_history_page('JSN','DST',null,null,null,null,
  body->>'revision','snapshots',body->'nextCursor',2)->'items'),2,'second exact-multiple page has two rows') from first_page;
select is(public.read_airfare_history_page('JSN','DST',null,null,null,null,
  body->>'revision','snapshots',body->'nextCursor',2)->'nextCursor','null'::jsonb,'exact-multiple terminal cursor') from first_page;

select throws_ok(format('select public.read_airfare_history_page(''JSN'',''DST'',null,null,null,null,%L,''snapshots'',null,%s)',
  body->>'revision',coalesce(size::text,'null')),'22023','airfare_history_invalid_request','invalid page size')
from first_page cross join unnest(array[0,251,null]) size;
select throws_ok(format('select public.read_airfare_history_page(''JSN'',''DST'',null,null,null,null,%L,''snapshots'',%L::jsonb,2)',
  body->>'revision',bad),'22023','airfare_history_invalid_cursor','untrusted cursor rejected')
from first_page cross join lateral (values
  ('[]'::jsonb), ('{}'::jsonb),
  (jsonb_set(body->'nextCursor','{revision}','"1"')),
  (jsonb_set(body->'nextCursor','{queryKey}','"other"')),
  (jsonb_set(body->'nextCursor','{dataset}','"baseline"')),
  (jsonb_set(body->'nextCursor','{after,1}','9007199254740992')),
  (jsonb_set(body->'nextCursor','{after,1}','"9223372036854775808"')),
  (jsonb_set(body->'nextCursor','{after,1}','"0"')),
  (jsonb_set(body->'nextCursor','{after,2}','"bad"')),
  ((body->'nextCursor') || '{"extra":true}')
) c(bad);
select throws_ok(format('select public.read_airfare_history_page(''JSN'',''DST'',null,null,null,null,%L,''baseline'',%L::jsonb,2)',
  body->>'revision',body->'nextCursor'),'22023','airfare_history_invalid_cursor','cross-dataset cursor rejects') from first_page;

savepoint bytes;
update public.fare_snapshots set payload = jsonb_build_object('text',repeat('é',350 * 1024)) where record_id=repeat('1',64);
update public.fare_snapshots set payload = jsonb_build_object('text',repeat('é',200 * 1024)) where record_id=repeat('2',64);
create temporary table byte_page as select public.read_airfare_history_page('JSN','DST',null,null,null,null,
  (select revision::text from public.airfare_history_revision),'snapshots',null,2) body;
select is(jsonb_array_length(body->'items'),1,'byte trimming returns a strict prefix') from byte_page;
select ok(body->'nextCursor' <> 'null','byte-trimmed page advances') from byte_page;
select ok(octet_length(convert_to(body::text,'UTF8')) <= 1048576,'complete page stays within UTF8 byte bound') from byte_page;
select is(pg_temp.assembled(null,null,null,null,2),public.read_airfare_history('JSN','DST',null,null,null,null),'byte trimming is lossless');
update public.fare_snapshots set payload=jsonb_build_object('text',repeat('é',524288)) where record_id=repeat('1',64);
select throws_ok(format('select public.read_airfare_history_page(''JSN'',''DST'',null,null,null,null,%L,''snapshots'',null,2)',
  revision::text),'22023','airfare_history_item_too_large','oversized first item rejects instead of empty loop') from public.airfare_history_revision;
rollback to bytes;

update public.fare_snapshots set source_line=source_line+1 where record_id=repeat('1',64);
select throws_ok(format('select public.read_airfare_history_page(''JSN'',''DST'',null,null,null,null,%L,''snapshots'',%L::jsonb,2)',
  body->>'revision',body->'nextCursor'),'40001','airfare_history_revision_changed','replay position move invalidates cursor') from first_page;

select ok(provolatile='s' and proconfig=array['search_path=""']
  and prosecdef=(proname='read_owner_airfare_history_page'),proname || ' security and snapshot')
from pg_proc where oid in (
  'public.read_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer)'::regprocedure,
  'public.read_owner_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer)'::regprocedure);
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000101');
insert into public.edicius_owners(owner_id) values ('00000000-0000-0000-0000-000000000101');
select set_config('test.history_revision',(select revision::text from public.airfare_history_revision),true);
set local role service_role;
select is(jsonb_array_length(public.read_airfare_history_page('JSN','DST',null,null,null,null,
  current_setting('test.history_revision'),'snapshots')->'items'),4,'service role core succeeds');
set local role anon;
select throws_ok($$select public.read_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots')$$,
  '42501',null,'anon core denied');
select throws_ok($$select public.read_owner_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots')$$,
  '42501',null,'anon wrapper denied');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000102',true);
select throws_ok($$select public.read_owner_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots')$$,
  '42501','not_edicius_owner','non-owner wrapper denied before cursor/revision checks');
select throws_ok($$select public.read_airfare_history_page('JSN','DST',null,null,null,null,'1','snapshots')$$,
  '42501',null,'browser core denied');
select throws_ok($$select * from public.fare_snapshots$$,'42501',null,'browser direct payload access denied');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000101',true);
select is(jsonb_array_length(public.read_owner_airfare_history_page('JSN','DST',null,null,null,null,
  current_setting('test.history_revision'),'snapshots')->'items'),4,'authorized owner page succeeds');
reset role;

insert into public.fare_snapshots
  (record_id,origin,destination,flight_date,captured_at,captured_at_text,source_line,source,currency,payload)
select lpad(to_hex(n),64,'0'),'CAP','DST','2026-11-01','2026-09-19','2026-09-19T00:00:00Z',n,'test','USD','{}'
from generate_series(1,251) n;
select set_config('test.history_revision',(select revision::text from public.airfare_history_revision),true);
select is(jsonb_array_length(public.read_airfare_history_page('CAP','DST',null,null,null,null,
  current_setting('test.history_revision'),'snapshots')->'items'),100,'default size limits a growing dataset');
select is(jsonb_array_length(public.read_airfare_history_page('CAP','DST',null,null,null,null,
  current_setting('test.history_revision'),'snapshots',null,250)->'items'),250,'maximum accepted size has lookahead');
select is(public.read_airfare_history_page('NON','DST',null,null,null,null,
  current_setting('test.history_revision'),'snapshots')->'items','[]'::jsonb,'empty route page is terminal');
select is(public.read_airfare_history_page('CAP','DST',null,array[]::text[],null,null,
  current_setting('test.history_revision'),'snapshots')->'nextCursor','null'::jsonb,'empty month set has no continuation');
select throws_ok(format('select public.read_airfare_history_page(''CAP'',''DST'',null,null,null,null,%L,%L)',revision,dataset),
  '22023','airfare_history_invalid_request','invalid revision or dataset')
from (values (null::text,'snapshots'),('0','snapshots'),('01','snapshots'),('9223372036854775808','snapshots'),
  ('1',null::text),('1','other')) cases(revision,dataset);
select * from finish();
rollback;
