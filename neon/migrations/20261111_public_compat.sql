-- Generated from the public-only Supabase schema dump. No rows or secrets.

-- The six omitted history/operational tables start empty.

SET check_function_bodies = false;

CREATE OR REPLACE FUNCTION public.neon_owner_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$ SELECT NULLIF(auth.user_id(), '')::uuid $$;

CREATE TABLE IF NOT EXISTS "public"."airfare_import_runs" (
    "run_id" "uuid" NOT NULL,
    "mode" "text" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" NOT NULL,
    "source_manifest" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "destination_manifest" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "text",
    CONSTRAINT "airfare_import_runs_mode_check" CHECK (("mode" = ANY (ARRAY['full'::"text", 'incremental'::"text"]))),
    CONSTRAINT "airfare_import_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'complete'::"text", 'failed'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."collector_requests" (
    "request_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "operation" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "result" "jsonb",
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "claimed_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:05:00'::interval) NOT NULL,
    "error_code" "text",
    "progress" "jsonb" DEFAULT '{"stage": "queued", "total": null, "completed": 0}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "collector_requests_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "collector_requests_check1" CHECK ((("claimed_at" IS NULL) OR ("claimed_at" >= "created_at"))),
    CONSTRAINT "collector_requests_check2" CHECK ((("completed_at" IS NULL) OR ("completed_at" >= "created_at"))),
    CONSTRAINT "collector_requests_error_code_check" CHECK ((("error_code" IS NULL) OR ("error_code" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::"text"))),
    CONSTRAINT "collector_requests_operation_check" CHECK (("operation" = ANY (ARRAY['market-bars'::"text", 'market-search'::"text", 'airfare-route'::"text", 'seace-refresh'::"text"]))),
    CONSTRAINT "collector_requests_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "collector_requests_progress_check" CHECK (("jsonb_typeof"("progress") = 'object'::"text")),
    CONSTRAINT "collector_requests_result_check" CHECK ((("result" IS NULL) OR ("jsonb_typeof"("result") = 'object'::"text"))),
    CONSTRAINT "collector_requests_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'complete'::"text", 'failed'::"text", 'expired'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."collector_runs" (
    "run_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "collector" "text" NOT NULL,
    "status" "text" NOT NULL,
    "records_seen" integer DEFAULT 0 NOT NULL,
    "records_written" integer DEFAULT 0 NOT NULL,
    "records_failed" integer DEFAULT 0 NOT NULL,
    "error_code" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "heartbeat_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "collector_runs_check" CHECK (("heartbeat_at" >= "started_at")),
    CONSTRAINT "collector_runs_check1" CHECK ((("completed_at" IS NULL) OR ("completed_at" >= "started_at"))),
    CONSTRAINT "collector_runs_collector_check" CHECK (("collector" = ANY (ARRAY['airfare'::"text", 'airfare-requests'::"text", 'x-posts'::"text", 'sentiment'::"text", 'market'::"text", 'fx'::"text", 'seace'::"text"]))),
    CONSTRAINT "collector_runs_error_code_check" CHECK ((("error_code" IS NULL) OR ("error_code" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::"text"))),
    CONSTRAINT "collector_runs_records_failed_check" CHECK (("records_failed" >= 0)),
    CONSTRAINT "collector_runs_records_seen_check" CHECK (("records_seen" >= 0)),
    CONSTRAINT "collector_runs_records_written_check" CHECK (("records_written" >= 0)),
    CONSTRAINT "collector_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'complete'::"text", 'failed'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."fare_baseline_points" (
    "record_id" "text" NOT NULL,
    "origin" "text" NOT NULL,
    "destination" "text" NOT NULL,
    "flight_date" "date" NOT NULL,
    "price_date" "date" NOT NULL,
    "price" numeric NOT NULL,
    "currency" "text" NOT NULL,
    "source" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fare_baseline_points_destination_check" CHECK (("destination" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_baseline_points_origin_check" CHECK (("origin" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_baseline_points_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "fare_baseline_points_record_id_check" CHECK (("record_id" ~ '^[0-9a-f]{64}$'::"text"))
);

CREATE TABLE IF NOT EXISTS "public"."fare_checks" (
    "record_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "origin" "text" NOT NULL,
    "destination" "text" NOT NULL,
    "flight_date" "date",
    "checked_at" timestamp with time zone NOT NULL,
    "outcome" "text" NOT NULL,
    "offers" integer DEFAULT 0 NOT NULL,
    "cheapest" numeric,
    "error_code" "text",
    "payload" "jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fare_checks_check" CHECK (((("kind" = 'board'::"text") AND ("flight_date" IS NOT NULL)) OR ("kind" = 'calendar'::"text"))),
    CONSTRAINT "fare_checks_destination_check" CHECK (("destination" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_checks_kind_check" CHECK (("kind" = ANY (ARRAY['board'::"text", 'calendar'::"text"]))),
    CONSTRAINT "fare_checks_offers_check" CHECK (("offers" >= 0)),
    CONSTRAINT "fare_checks_origin_check" CHECK (("origin" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_checks_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "fare_checks_record_id_check" CHECK (("record_id" ~ '^[0-9a-f]{64}$'::"text"))
);

CREATE TABLE IF NOT EXISTS "public"."fare_snapshots" (
    "record_id" "text" NOT NULL,
    "origin" "text" NOT NULL,
    "destination" "text" NOT NULL,
    "flight_date" "date" NOT NULL,
    "captured_at" timestamp with time zone NOT NULL,
    "captured_at_text" "text" NOT NULL,
    "source_line" bigint NOT NULL,
    "source" "text" NOT NULL,
    "currency" "text" NOT NULL,
    "cheapest_price" numeric,
    "payload" "jsonb" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fare_snapshots_destination_check" CHECK (("destination" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_snapshots_origin_check" CHECK (("origin" ~ '^[A-Z0-9]{3}$'::"text")),
    CONSTRAINT "fare_snapshots_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "fare_snapshots_record_id_check" CHECK (("record_id" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "fare_snapshots_source_line_check" CHECK (("source_line" > 0))
);

ALTER TABLE ONLY "public"."airfare_import_runs"
    ADD CONSTRAINT "airfare_import_runs_pkey" PRIMARY KEY ("run_id");

ALTER TABLE ONLY "public"."collector_requests"
    ADD CONSTRAINT "collector_requests_pkey" PRIMARY KEY ("request_id");

ALTER TABLE ONLY "public"."collector_runs"
    ADD CONSTRAINT "collector_runs_pkey" PRIMARY KEY ("run_id");

ALTER TABLE ONLY "public"."fare_baseline_points"
    ADD CONSTRAINT "fare_baseline_points_pkey" PRIMARY KEY ("record_id");

ALTER TABLE ONLY "public"."fare_checks"
    ADD CONSTRAINT "fare_checks_pkey" PRIMARY KEY ("record_id");

ALTER TABLE ONLY "public"."fare_snapshots"
    ADD CONSTRAINT "fare_snapshots_pkey" PRIMARY KEY ("record_id");

ALTER TABLE public.airfare_import_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.collector_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.collector_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fare_baseline_points ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fare_checks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fare_snapshots ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION "public"."advance_airfare_history_revision"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  update public.airfare_history_revision set revision = revision + 1 where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."airfare_dataset_manifest"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    SET "statement_timeout" TO '30s'
    AS $$
  with records as (
    select 'snapshots' as dataset, origin, destination, record_id from public.fare_snapshots
    union all
    select 'baseline', origin, destination, record_id from public.fare_baseline_points
    union all
    select 'calendar', origin, destination, record_id from public.fare_calendar_captures
    union all
    select kind || '_checks', origin, destination, record_id from public.fare_checks
  ),
  groups as (
    select dataset, origin || '-' || destination as route, count(*) as count,
           encode(sha256(convert_to(string_agg(record_id, chr(10) order by record_id), 'UTF8')), 'hex') as digest
    from records
    group by dataset, origin, destination
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'dataset', dataset, 'route', route, 'count', count, 'digest', digest
  ) order by dataset, route), '[]'::jsonb)
  from groups;
$$;

CREATE OR REPLACE FUNCTION "public"."airfare_history_query_key"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
declare v_months text[];
begin
  if exists (select 1 from unnest(p_snapshot_months) m
    where m is null or m !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(m,4) = '0000') then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_snapshot_months is not null then
    v_months := array(select distinct m from unnest(p_snapshot_months) m order by m);
  end if;
  return md5(jsonb_build_array(1, p_origin, p_destination, nullif(p_departure,''),
    v_months, nullif(p_since,''), nullif(p_until,''))::text);
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."cancel_market_request"("p_request_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_cancelled uuid;
begin
  if public.neon_owner_id() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  update public.collector_requests
     set status = 'failed', error_code = 'aborted',
         completed_at = now(), updated_at = now()
   where request_id = p_request_id
     and owner_id = public.neon_owner_id()
     and operation in ('market-bars', 'market-search')
     and status = 'queued'
  returning request_id into v_cancelled;
  return v_cancelled is not null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."claim_collector_request"("p_owner_id" "uuid", "p_operations" "text"[]) RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_claimed public.collector_requests;
begin
  if p_owner_id is null
     or coalesce(cardinality(p_operations), 0) = 0
     or exists (select 1 from unnest(p_operations) operation where operation is null)
     or not p_operations <@ array['market-bars', 'market-search', 'airfare-route']::text[]
     or cardinality(p_operations) <> (select count(distinct operation) from unnest(p_operations) operation) then
    raise exception using errcode = '22023', message = 'invalid_collector_operations';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id
     and status in ('queued', 'running')
     and expires_at <= now();

  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id
       from public.collector_requests
      where owner_id = p_owner_id
        and operation = any(p_operations)
        and status = 'queued'
        and expires_at > now()
      order by created_at, request_id
      for update skip locked
      limit 1
  )
  returning * into v_claimed;

  return v_claimed;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."claim_collector_request"("p_owner_id" "uuid", "p_operations" "text"[], "p_excluded_pairs" "text"[]) RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_claimed public.collector_requests;
begin
  if p_owner_id is null
     or coalesce(cardinality(p_operations), 0) = 0
     or exists (select 1 from unnest(p_operations) operation where operation is null)
     or not p_operations <@ array['market-bars', 'market-search', 'airfare-route']::text[]
     or cardinality(p_operations) <> (select count(distinct operation) from unnest(p_operations) operation)
     or p_excluded_pairs is null
     or exists (
       select 1 from unnest(p_excluded_pairs) as excluded(pair)
       where pair is null or pair !~ '^[A-Z0-9]{3}-[A-Z0-9]{3}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_collector_operations';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id
     and status in ('queued', 'running')
     and expires_at <= now();

  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id
       from public.collector_requests
      where owner_id = p_owner_id
        and operation = any(p_operations)
        and status = 'queued'
        and expires_at > now()
        and (
          operation <> 'airfare-route'
          or coalesce(payload->>'origin', '') || '-' || coalesce(payload->>'destination', '')
             <> all(p_excluded_pairs)
        )
      order by created_at, request_id
      for update skip locked
      limit 1
  )
  returning * into v_claimed;

  return v_claimed;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."claim_seace_refresh_request"("p_owner_id" "uuid") RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_claimed public.collector_requests;
begin
  if p_owner_id is null or not exists (
    select 1 from public.edicius_owners where owner_id = p_owner_id
  ) then
    raise exception using errcode = '22023', message = 'invalid_seace_owner';
  end if;
  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = p_owner_id and operation = 'seace-refresh'
     and status in ('queued', 'running') and expires_at <= now();
  update public.collector_requests
     set status = 'running', claimed_at = now(), updated_at = now()
   where request_id = (
     select request_id from public.collector_requests
      where owner_id = p_owner_id and operation = 'seace-refresh'
        and status = 'queued' and expires_at > now()
      order by created_at, request_id for update skip locked limit 1
   ) returning * into v_claimed;
  return v_claimed;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."complete_collector_request"("p_request_id" "uuid", "p_result" "jsonb") RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_completed public.collector_requests;
begin
  if jsonb_typeof(p_result) <> 'object' then
    raise exception using errcode = '22023', message = 'collector_result_must_be_object';
  end if;
  update public.collector_requests
     set status = 'complete', result = p_result, completed_at = now(),
         error_code = null, updated_at = now()
   where request_id = p_request_id and status = 'running' and expires_at > now()
  returning * into v_completed;
  if v_completed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_completed;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."delete_app_document"("p_document_key" "text", "p_expected_revision" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_owner uuid := public.neon_owner_id();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_document_key not in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  ) then
    raise exception using errcode = '22023', message = 'invalid_app_document_key';
  end if;
  if p_expected_revision <= 0 then
    raise exception using errcode = '22023', message = 'invalid_app_document_revision';
  end if;

  delete from public.app_documents
   where owner_id = v_owner and document_key = p_document_key and revision = p_expected_revision;
  if not found then
    raise exception using errcode = 'PT409', message = 'app_revision_conflict';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."enqueue_airfare_route_request"("p_origin" "text", "p_destination" "text", "p_month" "text", "p_currency" "text") RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_owner uuid := public.neon_owner_id();
  v_origin text := upper(trim(p_origin));
  v_destination text := upper(trim(p_destination));
  v_month text := trim(p_month);
  v_currency text := upper(trim(p_currency));
  v_month_date date;
  v_payload jsonb;
  v_request public.collector_requests;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if v_origin !~ '^[A-Z]{3}$'
     or v_destination !~ '^[A-Z]{3}$'
     or v_origin = v_destination
     or v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or v_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'invalid_airfare_request';
  end if;

  v_month_date := make_date(substring(v_month, 1, 4)::integer,
                            substring(v_month, 6, 2)::integer, 1);
  if v_month_date < date_trunc('month', current_date)::date
     or v_month_date > date_trunc('month', current_date + 330)::date then
    raise exception using errcode = '22023', message = 'invalid_airfare_request';
  end if;

  v_payload := jsonb_build_object(
    'origin', v_origin,
    'destination', v_destination,
    'month', v_month,
    'currency', v_currency
  );

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = v_owner
     and operation = 'airfare-route'
     and status in ('queued', 'running')
     and expires_at <= now();

  select * into v_request
    from public.collector_requests
   where owner_id = v_owner
     and operation = 'airfare-route'
     and payload = v_payload
     and status in ('queued', 'running')
     and expires_at > now()
   order by created_at, request_id
   limit 1;

  if v_request.request_id is null then
    insert into public.collector_requests (owner_id, operation, payload, expires_at)
    values (v_owner, 'airfare-route', v_payload, now() + interval '30 minutes')
    on conflict do nothing
    returning * into v_request;
  end if;

  if v_request.request_id is null then
    select * into v_request
      from public.collector_requests
     where owner_id = v_owner
       and operation = 'airfare-route'
       and payload = v_payload
       and status in ('queued', 'running')
       and expires_at > now()
     order by created_at, request_id
     limit 1;
  end if;

  if v_request.request_id is null then
    raise exception using errcode = '40001', message = 'airfare_request_enqueue_conflict';
  end if;
  return v_request;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."enqueue_seace_refresh"("p_region" "text", "p_year" integer) RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_owner uuid := public.neon_owner_id();
  v_region text := upper(trim(p_region));
  v_request public.collector_requests;
begin
  if v_owner is null or not exists (
    select 1 from public.edicius_owners where owner_id = v_owner
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if v_region is null or v_region not in (
    'AMAZONAS','ÁNCASH','APURÍMAC','AREQUIPA','AYACUCHO','CAJAMARCA',
    'CALLAO','CUSCO','HUANCAVELICA','HUÁNUCO','ICA','JUNÍN',
    'LA LIBERTAD','LAMBAYEQUE','LIMA','LORETO','MADRE DE DIOS',
    'MOQUEGUA','PASCO','PIURA','PUNO','SAN MARTÍN','TACNA','TUMBES','UCAYALI'
  ) or p_year is null or p_year < 2024
    or p_year > extract(year from current_timestamp at time zone 'America/Lima')::integer then
    raise exception using errcode = '22023', message = 'invalid_seace_refresh';
  end if;

  update public.collector_requests
     set status = 'expired', completed_at = now(), updated_at = now()
   where owner_id = v_owner and operation = 'seace-refresh'
     and status in ('queued', 'running') and expires_at <= now();

  insert into public.collector_requests(owner_id, operation, payload, expires_at)
  values (v_owner, 'seace-refresh', jsonb_build_object('region', v_region, 'year', p_year),
          now() + interval '2 hours')
  on conflict do nothing returning * into v_request;
  if v_request.request_id is null then
    select * into v_request from public.collector_requests
     where owner_id = v_owner and operation = 'seace-refresh'
       and payload = jsonb_build_object('region', v_region, 'year', p_year)
       and status in ('queued', 'running') and expires_at > now()
     order by created_at, request_id limit 1;
  end if;
  if v_request.request_id is null then
    raise exception using errcode = '40001', message = 'seace_refresh_enqueue_conflict';
  end if;
  return v_request;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."fail_collector_request"("p_request_id" "uuid", "p_error_code" "text") RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare v_failed public.collector_requests;
begin
  if p_error_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid_collector_error_code';
  end if;
  update public.collector_requests
     set status = 'failed', error_code = p_error_code, completed_at = now(), updated_at = now()
   where request_id = p_request_id and status = 'running' and expires_at > now()
  returning * into v_failed;
  if v_failed.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;
  return v_failed;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."list_fare_projection_dirty_routes"() RETURNS TABLE("origin" "text", "destination" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select d.origin,d.destination from public.fare_projection_dirty_routes d
  order by d.origin,d.destination;
$$;

CREATE OR REPLACE FUNCTION "public"."mark_fare_projection_dirty"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_old_origin text;
  v_old_destination text;
  v_old_month text;
  v_new_month text;
  v_old_relevant boolean := false;
  v_new_relevant boolean := false;
begin
  if TG_OP <> 'INSERT' then
    v_old_relevant := TG_TABLE_NAME <> 'fare_checks';
    if TG_TABLE_NAME = 'fare_checks' then v_old_relevant := OLD.kind = 'board'; end if;
    if v_old_relevant then
      v_old_origin := OLD.origin;
      v_old_destination := OLD.destination;
      v_old_month := to_char(OLD.flight_date,'YYYY-MM');
      perform public.mark_fare_projection_month(v_old_origin,v_old_destination,v_old_month);
    end if;
  end if;
  if TG_OP <> 'DELETE' then
    v_new_relevant := TG_TABLE_NAME <> 'fare_checks';
    if TG_TABLE_NAME = 'fare_checks' then v_new_relevant := NEW.kind = 'board'; end if;
    if v_new_relevant then
      v_new_month := to_char(NEW.flight_date,'YYYY-MM');
      if (v_old_origin,v_old_destination,v_old_month)
         is distinct from (NEW.origin,NEW.destination,v_new_month) then
        perform public.mark_fare_projection_month(NEW.origin,NEW.destination,v_new_month);
      end if;
    end if;
  end if;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."mark_fare_projection_month"("p_origin" "text", "p_destination" "text", "p_month" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.fare_projection_dirty_routes(origin,destination,changed_at)
  values(p_origin,p_destination,now())
  on conflict (origin,destination) do update set changed_at=excluded.changed_at;
  insert into public.fare_projection_dirty_months(origin,destination,month,changed_at)
  values(p_origin,p_destination,p_month,now())
  on conflict (origin,destination,month) do update set changed_at=excluded.changed_at;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."merge_market_quote_ticks"("p_owner_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_updated integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'quote_ticks_must_be_array';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_rows) item
     where jsonb_typeof(item) <> 'object'
        or nullif(item ->> 'symbol', '') is null
        or nullif(item ->> 'provider', '') is null
        or nullif(item ->> 'fetched_at', '') is null
        or jsonb_typeof(item -> 'payload') <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'invalid_quote_tick';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'symbol')
      from jsonb_array_elements(p_rows) item
  ) then
    raise exception using errcode = '22023', message = 'duplicate_quote_tick_symbol';
  end if;

  update public.market_quotes quote
     set provider = tick.provider,
         market_time = tick.market_time,
         fetched_at = tick.fetched_at,
         payload = quote.payload || tick.payload
    from jsonb_to_recordset(p_rows) as tick(
      symbol text,
      provider text,
      market_time bigint,
      fetched_at timestamptz,
      payload jsonb
    )
   where quote.owner_id = p_owner_id
     and quote.symbol = tick.symbol
     and (
       quote.market_time is null
       or tick.market_time is null
       or tick.market_time >= quote.market_time
     );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."prune_operational_history"("p_apply" boolean DEFAULT false, "p_batch_size" integer DEFAULT 500) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cutoff timestamptz := now() - interval '7 days';
  v_imports integer;
  v_requests integer;
begin
  if p_apply is null or p_batch_size is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception using errcode = '22023', message = 'invalid_retention_batch_size';
  end if;

  if not p_apply then
    select count(*) into v_imports
      from public.airfare_import_runs
     where status in ('complete', 'failed') and started_at < v_cutoff;
    select count(*) into v_requests
      from public.collector_requests
     where status in ('complete', 'failed', 'expired')
       and created_at < v_cutoff and expires_at < now();
  else
    with candidates as (
      select run_id from public.airfare_import_runs
       where status in ('complete', 'failed') and started_at < v_cutoff
       order by started_at, run_id limit p_batch_size for update skip locked
    ), deleted as (
      delete from public.airfare_import_runs old using candidates c
       where old.run_id = c.run_id returning 1
    ) select count(*) into v_imports from deleted;

    with candidates as (
      select request_id from public.collector_requests
       where status in ('complete', 'failed', 'expired')
         and created_at < v_cutoff and expires_at < now()
       order by created_at, request_id limit p_batch_size for update skip locked
    ), deleted as (
      delete from public.collector_requests old using candidates c
       where old.request_id = c.request_id returning 1
    ) select count(*) into v_requests from deleted;
  end if;

  return jsonb_build_object(
    'applied', p_apply,
    'airfare_import_runs', v_imports,
    'collector_requests', v_requests
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_airfare_calendar"("p_origin" "text", "p_destination" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  with curves as (
    select record_id, source_line, from_date, to_date, source, currency, payload,
           payload->>'capturedAt' as captured_at_text
    from public.fare_calendar_captures
    where origin = p_origin and destination = p_destination
  ),
  newest as (
    select * from curves order by captured_at_text desc, source_line desc, record_id desc limit 1
  ),
  bounds as (
    select newest.from_date, (select max(to_date) from curves) as to_date
    from newest
  ),
  -- Original JSONL uses a date-to-price object. Accept the list form used by
  -- wire fixtures too, without changing either stored document.
  expanded as (
    select c.record_id, c.source_line, c.captured_at_text, p.departure_date, p.price, p.ordinality
    from curves c
    cross join lateral (
      select key as departure_date, value as price, 0::bigint as ordinality
      from jsonb_each(case when jsonb_typeof(c.payload->'prices') = 'object'
                          then c.payload->'prices' else '{}'::jsonb end)
      union all
      select point->>'departureDate', point->'price', ordinality
      from jsonb_array_elements(
        case when jsonb_typeof(c.payload->'prices') = 'array'
             then c.payload->'prices' else '[]'::jsonb end
      ) with ordinality as points(point, ordinality)
    ) p
    cross join bounds b
    where p.departure_date >= b.from_date::text and p.departure_date <= b.to_date::text
  ),
  answered as (
    -- Presence wins, including an explicit null. A gap falls through to an
    -- older curve; dates behind the newest near boundary never return.
    select distinct on (departure_date) departure_date, price, captured_at_text
    from expanded
    order by departure_date, captured_at_text desc, source_line desc, record_id desc, ordinality
  ),
  horizon as (
    select jsonb_build_object(
      'capturedAt', coalesce((select max(captured_at_text) from answered), n.captured_at_text),
      'source', n.source,
      'currency', n.currency,
      'fromDate', b.from_date,
      'toDate', b.to_date,
      'prices', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'departureDate', departure_date,
          'price', price,
          'observedAt', captured_at_text
        ) order by departure_date), '[]'::jsonb)
        from answered
      )
    ) as body
    from newest n cross join bounds b
  ),
  health as (
    select jsonb_build_object(
      'lastCheckedAt', max(payload->>'at'),
      'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')
    ) as body
    from public.fare_checks
    where kind = 'calendar' and origin = p_origin and destination = p_destination
  )
  select jsonb_build_object(
    'origin', p_origin,
    'destination', p_destination,
    'horizon', (select body from horizon),
    'health', (select body from health)
  );
$$;

CREATE OR REPLACE FUNCTION "public"."read_airfare_history"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  with selected_snapshots as (
    select s.payload, s.captured_at_text, s.source_line, s.record_id
    from public.fare_snapshots s
    where p_snapshot_months is null
      and s.origin = p_origin and s.destination = p_destination
      and (coalesce(p_since, '') = '' or s.captured_at_text >= p_since)
      and (coalesce(p_until, '') = '' or s.captured_at_text <= p_until)
    union all
    select s.payload, s.captured_at_text, s.source_line, s.record_id
    from (
      select distinct (month || '-01')::date as from_date
      from unnest(p_snapshot_months) as requested(month)
    ) months
    cross join lateral (
      select s.payload, s.captured_at_text, s.source_line, s.record_id
      from public.fare_snapshots s
      where s.origin = p_origin and s.destination = p_destination
        and s.flight_date >= months.from_date
        and s.flight_date < months.from_date + interval '1 month'
        and (coalesce(p_since, '') = '' or s.captured_at_text >= p_since)
        and (coalesce(p_until, '') = '' or s.captured_at_text <= p_until)
      -- Preserve the correlated, indexed month-range scan boundary.
      offset 0
    ) s
  ),
  per_departure as (
    select flight_date, min(cheapest_price) as price
    from public.fare_snapshots
    where origin = p_origin and destination = p_destination
      and cheapest_price is not null
    group by flight_date
  ),
  pair_reference as (
    select case when count(*) = 0 then null else jsonb_build_object(
      'value', percentile_cont(0.5) within group (order by price),
      'dates', count(*)
    ) end as body
    from per_departure
  ),
  health as (
    select jsonb_build_object(
      'lastCheckedAt', max(payload->>'at'),
      'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')
    ) as body
    from public.fare_checks
    where kind = 'board' and origin = p_origin and destination = p_destination
      and (coalesce(p_departure, '') = '' or starts_with(flight_date::text, p_departure))
  )
  select jsonb_build_object(
    'origin', p_origin,
    'destination', p_destination,
    'snapshots', array(
      select s.payload
      from selected_snapshots s
      order by s.captured_at_text, s.source_line, s.record_id
    ),
    'baseline', array(
      select b.payload
      from public.fare_baseline_points b
      where b.origin = p_origin and b.destination = p_destination
        and (coalesce(p_departure, '') = '' or starts_with(b.flight_date::text, p_departure))
      order by b.flight_date, b.price_date, b.record_id
    ),
    'health', (select body from health),
    'airports', array(
      select a.payload
      from public.fare_airports a
      where a.code in (p_origin, p_destination)
      order by array_position(array[p_origin, p_destination], a.code)
    ),
    'pairReference', (select body from pair_reference)
  );
$$;

CREATE OR REPLACE FUNCTION "public"."read_airfare_history_meta"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_expected_revision" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
declare
  v_revision bigint;
  v_key text;
  v_body jsonb;
begin
  v_key := public.airfare_history_query_key(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until);
  if p_expected_revision is not null then
    if p_expected_revision !~ '^[1-9][0-9]{0,18}$' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
    end if;
    if p_expected_revision::numeric > 9223372036854775807 then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
    end if;
  end if;
  select revision into v_revision from public.airfare_history_revision where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  if p_expected_revision is not null and p_expected_revision <> v_revision::text then
    raise sqlstate 'PT409' using message = 'airfare_history_revision_changed';
  end if;
  with selected_snapshots as (
    select s.record_id from public.fare_snapshots s
    where p_snapshot_months is null and s.origin = p_origin and s.destination = p_destination
      and (coalesce(p_since,'') = '' or s.captured_at_text >= p_since)
      and (coalesce(p_until,'') = '' or s.captured_at_text <= p_until)
    union all
    select s.record_id from (
      select distinct (m || '-01')::date as from_date from unnest(p_snapshot_months) m
    ) months cross join lateral (
      select s.record_id from public.fare_snapshots s
      where s.origin = p_origin and s.destination = p_destination
        and s.flight_date >= months.from_date and s.flight_date < months.from_date + interval '1 month'
        and (coalesce(p_since,'') = '' or s.captured_at_text >= p_since)
        and (coalesce(p_until,'') = '' or s.captured_at_text <= p_until)
      offset 0
    ) s
  ), per_departure as (
    select flight_date, min(cheapest_price) as price from public.fare_snapshots
    where origin = p_origin and destination = p_destination and cheapest_price is not null
    group by flight_date
  ), pair_reference as (
    select case when count(*) = 0 then null else jsonb_build_object(
      'value', percentile_cont(0.5) within group (order by price), 'dates', count(*)
    ) end as body from per_departure
  ), health as (
    select jsonb_build_object('lastCheckedAt', max(payload->>'at'), 'checks', count(*),
      'changes', count(*) filter (where outcome = 'changed'),
      'errors', count(*) filter (where outcome = 'error')) as body
    from public.fare_checks where kind = 'board' and origin = p_origin and destination = p_destination
      and (coalesce(p_departure,'') = '' or starts_with(flight_date::text,p_departure))
  )
  select jsonb_build_object(
    'protocolVersion',1,'queryKey',v_key,'revision',v_revision::text,
    'origin',p_origin,'destination',p_destination,
    'counts',jsonb_build_object('snapshots',(select count(*)::text from selected_snapshots),
      'baseline',(select count(*)::text from public.fare_baseline_points b
        where b.origin = p_origin and b.destination = p_destination
          and (coalesce(p_departure,'') = '' or starts_with(b.flight_date::text,p_departure)))),
    'health',(select body from health),
    'airports',array(select a.payload from public.fare_airports a
      where a.code in (p_origin,p_destination) order by array_position(array[p_origin,p_destination],a.code)),
    'pairReference',(select body from pair_reference)
  ) into v_body;
  if octet_length(convert_to(v_body::text,'UTF8')) > 1048576 then
    raise exception using errcode = '22023', message = 'airfare_history_metadata_too_large';
  end if;
  return v_body;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."read_airfare_history_page"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_revision" "text", "p_dataset" "text", "p_cursor" "jsonb" DEFAULT NULL::"jsonb", "p_page_size" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
declare
  v_revision bigint;
  v_key text;
  v_after1 text;
  v_after2 text;
  v_after_id text;
  v_after_line bigint;
  v_items jsonb[] := array[]::jsonb[];
  v_orders jsonb[] := array[]::jsonb[];
  v_item jsonb;
  v_order jsonb;
  v_cursor jsonb;
  v_envelope jsonb;
  v_response jsonb;
  v_best_response jsonb;
  v_row record;
  v_item_bytes integer;
  v_items_bytes bigint := 0;
  v_total integer := 0;
  v_count integer;
  v_low integer;
  v_high integer;
  v_mid integer;
begin
  v_key := public.airfare_history_query_key(
    p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until
  );
  if p_page_size is null or p_page_size not between 1 and 250
    or p_dataset is null or p_dataset not in ('snapshots','baseline')
    or p_revision is null or p_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_revision::numeric > 9223372036854775807 then
    raise exception using errcode = '22023', message = 'airfare_history_invalid_request';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(p_cursor) k)
        is distinct from array['after','dataset','protocolVersion','queryKey','revision']
      or p_cursor->'protocolVersion' is distinct from '1'::jsonb
      or p_cursor->'queryKey' is distinct from to_jsonb(v_key)
      or p_cursor->'revision' is distinct from to_jsonb(p_revision)
      or p_cursor->'dataset' is distinct from to_jsonb(p_dataset)
      or jsonb_typeof(p_cursor->'after') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if jsonb_array_length(p_cursor->'after') <> 3
      or exists (
        select 1 from jsonb_array_elements(p_cursor->'after') e
        where jsonb_typeof(e) <> 'string'
      ) then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    v_after1 := p_cursor#>>'{after,0}';
    v_after2 := p_cursor#>>'{after,1}';
    v_after_id := p_cursor#>>'{after,2}';
    if v_after_id !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
    end if;
    if p_dataset = 'snapshots' then
      if v_after2 !~ '^[1-9][0-9]{0,18}$' then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
      if v_after2::numeric > 9223372036854775807 then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
      v_after_line := v_after2::bigint;
    else
      if v_after1 !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or v_after2 !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or not pg_input_is_valid(v_after1,'date')
        or not pg_input_is_valid(v_after2,'date') then
        raise exception using errcode = '22023', message = 'airfare_history_invalid_cursor';
      end if;
    end if;
  end if;
  select revision into v_revision from public.airfare_history_revision where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  if p_revision <> v_revision::text then
    raise sqlstate 'PT409' using message = 'airfare_history_revision_changed';
  end if;
  v_envelope := jsonb_build_object(
    'protocolVersion',1,'queryKey',v_key,'revision',p_revision,'dataset',p_dataset
  );

  -- Fetch payloads once. The extra key establishes whether the final included
  -- item needs a continuation cursor, including exact page-size boundaries.
  for v_row in
    with candidates as materialized (
      (select s.record_id, s.captured_at_text as order1, ''::text as order2,
          s.source_line as line
       from public.fare_snapshots s
       where p_dataset = 'snapshots' and s.origin=p_origin and s.destination=p_destination
         and (coalesce(p_since,'')='' or s.captured_at_text >= p_since)
         and (coalesce(p_until,'')='' or s.captured_at_text <= p_until)
         and (p_snapshot_months is null or exists (
           select 1 from unnest(p_snapshot_months) m
           where s.flight_date >= (m || '-01')::date
             and s.flight_date < (m || '-01')::date + interval '1 month'))
         and (p_cursor is null or
           (s.captured_at_text,s.source_line,s.record_id) > (v_after1,v_after_line,v_after_id))
       order by s.captured_at_text,s.source_line,s.record_id limit p_page_size + 1)
      union all
      (select b.record_id, b.flight_date::text as order1, b.price_date::text as order2,
          0::bigint as line
       from public.fare_baseline_points b
       where p_dataset = 'baseline' and b.origin=p_origin and b.destination=p_destination
         and (coalesce(p_departure,'')='' or starts_with(b.flight_date::text,p_departure))
         and (p_cursor is null or
           (b.flight_date,b.price_date,b.record_id) > (v_after1::date,v_after2::date,v_after_id))
       order by b.flight_date,b.price_date,b.record_id limit p_page_size + 1)
    ), numbered as materialized (
      select c.*, row_number() over(order by order1,line,order2,record_id) as position,
        count(*) over() as total from candidates c
    )
    select n.*, case when p_dataset='snapshots' then s.payload else b.payload end as payload
    from numbered n
    left join public.fare_snapshots s
      on p_dataset='snapshots' and s.record_id=n.record_id
    left join public.fare_baseline_points b
      on p_dataset='baseline' and b.record_id=n.record_id
    where n.position <= p_page_size
    order by n.position
  loop
    v_order := jsonb_build_array(
      v_row.order1,
      case when p_dataset='snapshots' then v_row.line::text else v_row.order2 end,
      v_row.record_id
    );
    v_item := jsonb_build_object(
      'recordId',v_row.record_id,'order',v_order,'payload',v_row.payload
    );
    v_total := v_row.total;
    v_item_bytes := octet_length(convert_to(v_item::text,'UTF8'));
    if v_item_bytes > 1048576 and cardinality(v_items) = 0 then
      raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
    end if;
    -- The final envelope can only add bytes, so stop before retaining more than
    -- one response budget of item bodies. Exact trimming happens below.
    if v_items_bytes + v_item_bytes > 1048576 then
      exit;
    end if;
    v_items := array_append(v_items,v_item);
    v_orders := array_append(v_orders,v_order);
    v_items_bytes := v_items_bytes + v_item_bytes;
  end loop;

  v_count := cardinality(v_items);
  if v_count = 0 then
    return v_envelope || jsonb_build_object('items',v_items,'nextCursor',null);
  end if;
  v_cursor := case when v_count < v_total then
    v_envelope || jsonb_build_object('after',v_orders[v_count]) else null end;
  v_response := v_envelope || jsonb_build_object('items',v_items,'nextCursor',v_cursor);
  if octet_length(convert_to(v_response::text,'UTF8')) <= 1048576 then
    return v_response;
  end if;

  -- The full page exceeded the wire budget. Find the longest exact prefix in
  -- O(log page-size) whole-response serializations instead of one per row.
  v_low := 1;
  v_high := v_count - 1;
  while v_low <= v_high loop
    v_mid := (v_low + v_high) / 2;
    v_cursor := v_envelope || jsonb_build_object('after',v_orders[v_mid]);
    v_response := v_envelope || jsonb_build_object(
      'items',v_items[1:v_mid],'nextCursor',v_cursor
    );
    if octet_length(convert_to(v_response::text,'UTF8')) <= 1048576 then
      v_best_response := v_response;
      v_low := v_mid + 1;
    else
      v_high := v_mid - 1;
    end if;
  end loop;
  if v_best_response is null then
    raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
  end if;
  return v_best_response;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."read_fx_history"("p_source" "text", "p_range" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_owner uuid := public.neon_owner_id(); v_since timestamptz; v_daily boolean; v_points jsonb;
begin
  if v_owner is null or not exists(select 1 from public.edicius_owners where owner_id=v_owner) then
    raise exception 'owner access required' using errcode='42501';
  end if;
  if p_source is null or p_source not in ('kambista','tu-cambista','securex','cambio-seguro','dollarhouse','rextie','tkambio','bcrp','sbs') or p_range is null or p_range not in ('1D','7D','1M','1Y','ALL') then
    raise exception 'invalid FX source or range' using errcode='22023';
  end if;
  v_since := case p_range when '1D' then now()-interval '1 day' when '7D' then now()-interval '7 days' when '1M' then now()-interval '1 month' when '1Y' then now()-interval '1 year' else '-infinity'::timestamptz end;
  v_daily := p_range in ('1M','1Y','ALL') or p_source in ('bcrp','sbs');
  with revisions as (
    select distinct on (effective_at) owner_id,source,observed_at,effective_at,buy,sell,context
    from public.fx_observations
    where owner_id=v_owner and source=p_source and effective_at>=v_since and effective_at<=now()
    order by effective_at,observed_at desc
  ), ranked as (
    select *,row_number() over(partition by (effective_at at time zone 'America/Lima')::date order by effective_at desc,observed_at desc) as day_rank from revisions
  )
  select coalesce(jsonb_agg(to_jsonb(r)-'day_rank' order by effective_at),'[]'::jsonb) into v_points
  from ranked r where not v_daily or day_rank=1;
  return jsonb_build_object('points',v_points,'aggregation',case when v_daily then 'daily' else 'observations' end);
end $$;

CREATE OR REPLACE FUNCTION "public"."read_fx_latest"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_owner uuid := public.neon_owner_id(); v_result jsonb;
begin
  if v_owner is null or not exists(select 1 from public.edicius_owners where owner_id=v_owner) then
    raise exception 'owner access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by source),'[]'::jsonb) into v_result
  from (select distinct on (source) owner_id,source,observed_at,effective_at,buy,sell,context
        from public.fx_observations where owner_id=v_owner
        order by source,effective_at desc,observed_at desc) t;
  return v_result;
end $$;

CREATE OR REPLACE FUNCTION "public"."read_owner_airfare_calendar"("p_origin" "text", "p_destination" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id = public.neon_owner_id()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_calendar(p_origin, p_destination);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_airfare_history"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id = public.neon_owner_id()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_history(p_origin, p_destination, p_departure, p_snapshot_months, p_since, p_until);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_airfare_history_meta"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_expected_revision" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id = public.neon_owner_id()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  return public.read_airfare_history_meta(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until,p_expected_revision);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_airfare_history_page"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_revision" "text", "p_dataset" "text", "p_cursor" "jsonb" DEFAULT NULL::"jsonb", "p_page_size" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id=public.neon_owner_id()
  ) then
    raise exception using errcode='42501', message='not_edicius_owner';
  end if;
  return public.read_airfare_history_page(p_origin,p_destination,p_departure,p_snapshot_months,p_since,p_until,p_revision,p_dataset,p_cursor,p_page_size);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_fare_airports"("p_codes" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id = public.neon_owner_id()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_codes is null or exists (
    select 1 from unnest(p_codes) code where code is null or code !~ '^[A-Z0-9]{3}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_airport_codes';
  end if;
  return jsonb_build_object(
    'airports', coalesce((
      with requested as (
        select distinct code from unnest(p_codes) code
      ), resolved as (
        select a.code, a.payload from public.fare_airports a
        union all
        select r.code, jsonb_build_object(
          'code', r.code,
          'name', null,
          'city', null,
          'country', null,
          'latitude', r.latitude,
          'longitude', r.longitude
        )
        from requested q
        join public.airport_coordinate_reference r on r.code = q.code
        where not exists (select 1 from public.fare_airports a where a.code = r.code)
      )
      select jsonb_agg(payload order by code) from resolved
    ), '[]'::jsonb)
  );
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."read_owner_fare_flights"("p_origin" "text", "p_destination" "text", "p_month" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_body jsonb;
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id=public.neon_owner_id()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  select jsonb_build_object(
    'revision',m.revision::text,
    'latestCapture',m.payload->'latestCapture',
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'key',f.flight_key,'offer',f.offer,'price',f.price,
      'previousPrice',f.previous_price,'firstPrice',f.first_price,
      'sightings',f.sightings,'lastSeenAt',f.last_seen_at,
      'present',f.present,'category',f.category,'change',f.change_percent
    ) order by f.flight_key)
    from public.fare_flight_projections f
    where f.origin=m.origin and f.destination=m.destination and f.month=m.month),'[]'::jsonb)
  ) into v_body
  from public.fare_month_projections m
  where m.origin=p_origin and m.destination=p_destination and m.month=p_month;
  return v_body;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_fare_flights_page"("p_origin" "text", "p_destination" "text", "p_month" "text", "p_from" "date", "p_to" "date", "p_filters" "jsonb" DEFAULT '{}'::"jsonb", "p_sort" "text" DEFAULT 'departs'::"text", "p_direction" "text" DEFAULT 'asc'::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 10) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_revision bigint;
  v_latest jsonb;
  v_tracked integer;
  v_in_period integer;
  v_shown integer;
  v_page integer;
  v_page_count integer;
  v_rows jsonb;
  v_facets jsonb;
  v_period_days date[];
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id=public.neon_owner_id()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  if p_origin !~ '^[A-Z0-9]{3}$' or p_destination !~ '^[A-Z0-9]{3}$'
    or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    or p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366
    or p_filters is null or jsonb_typeof(p_filters) <> 'object'
    or p_sort not in ('departs','airline','flight','stops','duration','price','change')
    or p_direction not in ('asc','desc')
    or p_page is null or p_page < 1 or p_page > 100000
    or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode='22023',message='invalid_fare_flight_page_request';
  end if;

  select m.revision,m.payload->'latestCapture' into v_revision,v_latest
  from public.fare_month_projections m
  where m.origin=p_origin and m.destination=p_destination and m.month=p_month;
  if not found then return null; end if;
  select array_agg(day::date) into v_period_days
  from pg_catalog.generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') as days(day);

  select count(*) into v_tracked from public.fare_flight_projections f
  where f.origin=p_origin and f.destination=p_destination and f.month=p_month;

  with period_rows as materialized (
    select f.*,
      case when f.offer->>'departureAt' ~ 'T[0-9]{2}:'
        then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer
        else null end as departure_hour,
      greatest(0,coalesce((f.offer->>'transfers')::integer,0)) as stop_count,
      coalesce(f.offer->>'airlineName',f.offer->>'airline') as airline_label
    from public.fare_flight_projections f
    where f.origin=p_origin and f.destination=p_destination and f.month=p_month
      and f.seen_days && v_period_days
      and not f.current_unconfirmed
  ), filtered as materialized (
    select * from period_rows r where
      ((p_filters->>'minPrice') is null or r.price >= (p_filters->>'minPrice')::numeric)
      and ((p_filters->>'maxPrice') is null or r.price <= (p_filters->>'maxPrice')::numeric)
      and ((p_filters->>'airline') is null or r.offer->>'airline'=p_filters->>'airline')
      and ((p_filters->>'stops') is null or r.stop_count=(p_filters->>'stops')::integer)
      and ((p_filters->>'maxDuration') is null or
        (r.offer->>'durationMinutes')::integer <= (p_filters->>'maxDuration')::integer)
      and ((p_filters->>'change') is null or r.category=p_filters->>'change')
      and ((p_filters->>'band') is null or
        case p_filters->>'band'
          when 'night' then r.departure_hour between 0 and 5
          when 'morning' then r.departure_hour between 6 and 11
          when 'afternoon' then r.departure_hour between 12 and 17
          when 'evening' then r.departure_hour between 18 and 23
          else false end)
  )
  select
    (select count(*) from period_rows),
    (select count(*) from filtered),
    jsonb_build_object(
      'airlines',coalesce((select jsonb_agg(jsonb_build_object('value',airline,'label',label) order by lower(label),airline)
        from (select distinct offer->>'airline' as airline,airline_label as label from period_rows) a),'[]'::jsonb),
      'price',(select jsonb_build_object('low',min(price),'high',max(price)) from period_rows having count(*) > 0),
      'bands',coalesce((select jsonb_agg(band order by rank) from (
        select distinct case when departure_hour between 0 and 5 then 'night'
          when departure_hour between 6 and 11 then 'morning'
          when departure_hour between 12 and 17 then 'afternoon'
          when departure_hour between 18 and 23 then 'evening' end as band,
          case when departure_hour between 0 and 5 then 1
          when departure_hour between 6 and 11 then 2
          when departure_hour between 12 and 17 then 3
          when departure_hour between 18 and 23 then 4 end as rank
        from period_rows where departure_hour is not null) b),'[]'::jsonb),
      'stops',coalesce((select jsonb_agg(stop_count order by stop_count)
        from (select distinct stop_count from period_rows) s),'[]'::jsonb),
      'durations',coalesce((select jsonb_agg(duration order by duration)
        from (select distinct (offer->>'durationMinutes')::integer as duration
          from period_rows where offer->>'durationMinutes' is not null) d),'[]'::jsonb),
      'categories',coalesce((select jsonb_agg(category order by category)
        from (select distinct category from period_rows) c),'[]'::jsonb)
    )
  into v_in_period,v_shown,v_facets;

  v_page_count := greatest(1,ceil(v_shown::numeric / p_page_size)::integer);
  v_page := least(p_page,v_page_count);

  with rows as (
    select f.*,
      greatest(0,coalesce((f.offer->>'transfers')::integer,0)) as stop_count,
      lower(coalesce(f.offer->>'airlineName',f.offer->>'airline')) as airline_sort,
      lower((f.offer->>'airline') || ' ' || coalesce(f.offer->>'flightNumber','')) as flight_sort
    from public.fare_flight_projections f
    where f.origin=p_origin and f.destination=p_destination and f.month=p_month
      and f.seen_days && v_period_days
      and not f.current_unconfirmed
      and ((p_filters->>'minPrice') is null or f.price >= (p_filters->>'minPrice')::numeric)
      and ((p_filters->>'maxPrice') is null or f.price <= (p_filters->>'maxPrice')::numeric)
      and ((p_filters->>'airline') is null or f.offer->>'airline'=p_filters->>'airline')
      and ((p_filters->>'stops') is null or greatest(0,coalesce((f.offer->>'transfers')::integer,0))=(p_filters->>'stops')::integer)
      and ((p_filters->>'maxDuration') is null or (f.offer->>'durationMinutes')::integer <= (p_filters->>'maxDuration')::integer)
      and ((p_filters->>'change') is null or f.category=p_filters->>'change')
      and ((p_filters->>'band') is null or
        case p_filters->>'band'
          when 'night' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 0 and 5
          when 'morning' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 6 and 11
          when 'afternoon' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 12 and 17
          when 'evening' then substring(f.offer->>'departureAt' from 'T([0-9]{2}):')::integer between 18 and 23
          else false end)
  ), selected as (
    select r.*,row_number() over (order by
      case when p_sort='departs' and p_direction='asc' then r.offer->>'departureAt' end asc nulls last,
      case when p_sort='departs' and p_direction='desc' then r.offer->>'departureAt' end desc nulls last,
      case when p_sort='airline' and p_direction='asc' then r.airline_sort end asc nulls last,
      case when p_sort='airline' and p_direction='desc' then r.airline_sort end desc nulls last,
      case when p_sort='flight' and p_direction='asc' then r.flight_sort end asc nulls last,
      case when p_sort='flight' and p_direction='desc' then r.flight_sort end desc nulls last,
      case when p_sort='stops' and p_direction='asc' then r.stop_count end asc nulls last,
      case when p_sort='stops' and p_direction='desc' then r.stop_count end desc nulls last,
      case when p_sort='duration' and p_direction='asc' then (r.offer->>'durationMinutes')::integer end asc nulls last,
      case when p_sort='duration' and p_direction='desc' then (r.offer->>'durationMinutes')::integer end desc nulls last,
      case when p_sort='price' and p_direction='asc' then r.price end asc nulls last,
      case when p_sort='price' and p_direction='desc' then r.price end desc nulls last,
      case when p_sort='change' and p_direction='asc' then r.change_percent end asc nulls last,
      case when p_sort='change' and p_direction='desc' then r.change_percent end desc nulls last,
      r.offer->>'departureAt',r.flight_key) as position
    from rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key',flight_key,'offer',offer,'price',price,'previousPrice',previous_price,
    'firstPrice',first_price,'sightings',sightings,'lastSeenAt',last_seen_at,
    'present',present,'category',category,'change',change_percent
  ) order by position),'[]'::jsonb) into v_rows from selected
  where position between (v_page-1)*p_page_size+1 and v_page*p_page_size;

  return jsonb_build_object(
    'revision',v_revision::text,'latestCapture',v_latest,
    'tracked',v_tracked,'inPeriod',v_in_period,'shown',v_shown,
    'page',v_page,'pageCount',v_page_count,'rows',v_rows,'facets',v_facets
  );
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."read_owner_fare_month_projection"("p_origin" "text", "p_destination" "text", "p_month" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_payload jsonb;
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id=public.neon_owner_id()
  ) then
    raise exception using errcode='42501',message='not_edicius_owner';
  end if;
  select payload into v_payload from public.fare_month_projections
  where origin=p_origin and destination=p_destination and month=p_month;
  return v_payload;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."read_owner_seace_page"("p_region" "text", "p_year" integer, "p_view" "text", "p_minor_only" boolean, "p_object_filter" "text", "p_excluded" boolean, "p_search" "text", "p_sort_field" "text", "p_ascending" boolean, "p_page" integer, "p_page_size" integer, "p_now" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
declare
  result jsonb;
begin
  if p_region is null or p_year is null or p_year not between 2024 and 2100
    or p_view is null or p_view not in ('recent','open','closed','published')
    or p_minor_only is null or p_object_filter is null
    or p_object_filter not in ('Todos','Bien','Servicio','Obra','Consultoría de Obra')
    or p_excluded is null or p_search is null
    or p_sort_field is null or p_sort_field not in
      ('code','entity','description','object','published','start','end','amount','links','signed','termStart','termEnd')
    or p_ascending is null or p_page is null or p_page not between 1 and 1000000
    or p_page_size is null or p_page_size not between 1 and 100 or p_now is null then
    raise exception using errcode = '22023', message = 'invalid_seace_page_request';
  end if;

  with filtered as materialized (
    select r.owner_id, r.kind, r.record_key,
      case when p_sort_field in ('published','signed','start','end','termStart','termEnd') then
        coalesce(case when p_sort_field = 'published' and r.kind <> 'contracts'
          then r.published_at
          else public.seace_peru_date(r.payload->>
            (case when p_sort_field = 'published' then 'signed' else p_sort_field end))
          end, '1970-01-01 00:00+00'::timestamptz)
      end as sort_date,
      case when p_sort_field not in ('published','signed','start','end','termStart','termEnd')
        then case when p_sort_field = 'links' then ''
          else lower(coalesce(r.payload->>p_sort_field,'')) end
      end as sort_text
    from public.seace_records r
    where r.owner_id = public.neon_owner_id() and r.region = p_region and r.year = p_year
      and (case when p_view = 'published' then r.kind = 'contracts'
        else r.kind in ('notices','processes') end)
      and (not p_minor_only or r.is_minor is true)
      and (p_object_filter = 'Todos' or r.object_key like
        (case when p_object_filter = 'Consultoría de Obra' then 'CONSULTORIA'
          else upper(p_object_filter) end) || '%')
      and (case p_view
        when 'recent' then r.open_until > p_now and r.published_at between p_now - interval '24 hours' and p_now
        when 'open' then r.open_until > p_now and (r.published_at is null
          or r.published_at < p_now - interval '24 hours' or r.published_at > p_now)
        when 'closed' then r.open_until is null or r.open_until <= p_now
        else true end)
      and (p_search = '' or position(lower(p_search) in lower(coalesce(r.payload->>'code',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'entity',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'description',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'contractor',''))) > 0
        or position(lower(p_search) in lower(coalesce(r.payload->>'object',''))) > 0)
      and (exists (select 1 from public.seace_exclusions e
        where e.owner_id = r.owner_id and e.record_key = case
          when r.kind = 'processes' then 'process:' || array_to_json(array[
            coalesce(r.payload->>'region',''), coalesce(r.payload->>'code',''),
            coalesce(r.payload->>'published',''), coalesce(r.payload->>'entity','')])::text
          else 'minor:' || array_to_json(array[
            coalesce(r.payload->>'region',''), upper(public.seace_js_trim(r.payload->>'code'))])::text
          end) = p_excluded)
  ), ordered as (
    select f.*, row_number() over (order by
      case when p_ascending then f.sort_date end asc,
      case when not p_ascending then f.sort_date end desc,
      case when p_ascending then f.sort_text end asc,
      case when not p_ascending then f.sort_text end desc,
      case f.kind when 'notices' then 0 when 'processes' then 1 else 2 end,
      f.record_key) as position
    from filtered f
  ), page_rows as (
    select o.position, jsonb_build_object('kind',r.kind,'recordKey',r.record_key,'payload',r.payload) as item
    from ordered o join public.seace_records r
      on r.owner_id=o.owner_id and r.kind=o.kind and r.record_key=o.record_key
    where o.position > (p_page::bigint - 1) * p_page_size
      and o.position <= p_page::bigint * p_page_size
  )
  select jsonb_build_object('total',(select count(*) from filtered),
    'rows',coalesce((select jsonb_agg(item order by position) from page_rows),'[]'::jsonb))
    into result;
  return result;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."refresh_fare_month_projection"("p_origin" "text", "p_destination" "text", "p_month" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_from date;
  v_to date;
  v_revision bigint;
  v_metadata jsonb;
  v_payload jsonb;
begin
  if p_origin !~ '^[A-Z0-9]{3}$' or p_destination !~ '^[A-Z0-9]{3}$'
     or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = 'invalid_airfare_month_projection_request';
  end if;
  v_from := (p_month || '-01')::date;
  v_to := (v_from + interval '1 month')::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_origin || p_destination || p_month));
  select revision into v_revision from public.airfare_history_revision where singleton;
  v_metadata := public.read_airfare_history_meta(
    p_origin,p_destination,p_month,array[p_month],null,null,null
  );

  with month_snapshots as (
    select s.record_id,s.flight_date,s.captured_at,s.captured_at_text,
      s.source_line,s.cheapest_price from public.fare_snapshots s
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), price_days as (
    select left(captured_at_text,10) as day,
      min(cheapest_price) as low, max(cheapest_price) as high,
      percentile_cont(0.5) within group (order by cheapest_price) as middle,
      count(*) as observations
    from month_snapshots where cheapest_price is not null
    group by left(captured_at_text,10)
  ), unsold_days as (
    select left(captured_at_text,10) as day, count(*) as observations
    from month_snapshots where cheapest_price is null
    group by left(captured_at_text,10)
  ), provider_days as (
    select b.price_date::text as day,
      min(b.price) as low, max(b.price) as high,
      percentile_cont(0.5) within group (order by b.price) as middle,
      count(*) as observations
    from public.fare_baseline_points b
    where b.origin=p_origin and b.destination=p_destination
      and b.flight_date>=v_from and b.flight_date<v_to
    group by b.price_date
  ), latest_boards as (
    select latest.flight_date,s.payload
    from (
      select distinct on (flight_date) flight_date,record_id
      from month_snapshots
      order by flight_date,captured_at desc,source_line,record_id
    ) latest join public.fare_snapshots s using(record_id)
  ), latest_attempts as (
    select distinct on (flight_date) flight_date, checked_at, outcome, error_code
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
    order by flight_date, checked_at desc, record_id desc
  ), latest_confirmed as (
    select distinct on (flight_date) flight_date, checked_at, outcome
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
      and outcome in ('changed','unchanged','rebaselined','no-offers')
    order by flight_date, checked_at desc, record_id desc
  ), departure_checks as (
    select coalesce(c.flight_date,a.flight_date) as flight_date,
      c.checked_at,c.outcome,a.checked_at as last_attempt_at,
      case when a.outcome='error' then a.error_code else null end as last_error_code
    from latest_confirmed c full join latest_attempts a using(flight_date)
  ), via_sequences as (
    select distinct o.offer->'viaPoints' as points
    from public.fare_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers') o(offer)
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
      and jsonb_typeof(o.offer->'viaPoints')='array'
      and jsonb_array_length(o.offer->'viaPoints') > 0
  )
  select jsonb_build_object(
    'origin',p_origin,'destination',p_destination,'month',p_month,
    'revision',v_revision::text,
    'latestCapture',(select max(captured_at_text) from month_snapshots),
    'priceDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'low',low,'high',high,'middle',middle,'count',observations)
      order by day) from price_days),'[]'::jsonb),
    'unsoldDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'count',observations) order by day) from unsold_days),'[]'::jsonb),
    'providerDays',coalesce((select jsonb_agg(jsonb_build_object(
      'key',day,'low',low,'high',high,'middle',middle,'count',observations)
      order by day) from provider_days),'[]'::jsonb),
    'latestBoards',coalesce((select jsonb_agg(payload order by flight_date)
      from latest_boards),'[]'::jsonb),
    'currentBoards',coalesce((select jsonb_agg(b.payload order by b.flight_date)
      from latest_boards b join latest_confirmed c using(flight_date)
      where c.outcome <> 'no-offers'),'[]'::jsonb),
    'departureChecks',coalesce((select jsonb_agg(jsonb_build_object(
      'flightDate',flight_date::text,'checkedAt',checked_at,
      'outcome',outcome,'lastAttemptAt',last_attempt_at,
      'lastErrorCode',last_error_code) order by flight_date)
      from departure_checks),'[]'::jsonb),
    'viaSequences',coalesce((select jsonb_agg(points order by points)
      from via_sequences),'[]'::jsonb),
    'health',v_metadata->'health',
    'pairReference',v_metadata->'pairReference'
  ) into v_payload;

  insert into public.fare_month_projections(origin,destination,month,revision,payload,built_at)
  values(p_origin,p_destination,p_month,v_revision,v_payload,now())
  on conflict (origin,destination,month) do update set
    revision=excluded.revision,payload=excluded.payload,built_at=excluded.built_at;

  with month_snapshots as (
    select s.record_id,s.flight_date,s.captured_at,s.captured_at_text,
      s.source_line,s.cheapest_price from public.fare_snapshots s
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), latest_boards as (
    select latest.flight_date,s.payload
    from (
      select distinct on (flight_date) flight_date,record_id
      from month_snapshots
      order by flight_date,captured_at desc,source_line,record_id
    ) latest join public.fare_snapshots s using(record_id)
  ), latest_confirmed as (
    select distinct on (flight_date) flight_date, outcome
    from public.fare_checks
    where kind='board' and origin=p_origin and destination=p_destination
      and flight_date>=v_from and flight_date<v_to
      and outcome in ('changed','unchanged','rebaselined','no-offers')
    order by flight_date, checked_at desc, record_id desc
  ), latest_keys as (
    select distinct (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
      || '|' || (o.offer->>'departureAt') || '|'
      || coalesce(o.offer->>'arrivalAt','') as flight_key
    from latest_boards b cross join lateral jsonb_array_elements(b.payload->'offers') o(offer)
      left join latest_confirmed c on c.flight_date=b.flight_date
    where c.outcome in ('changed','unchanged','rebaselined')
  ), all_offers as (
    select s.record_id,s.captured_at_text,s.source_line,o.ordinality,
      (o.offer->>'price')::numeric as price,
      (o.offer->>'airline') || '|' || coalesce(o.offer->>'flightNumber','')
        || '|' || (o.offer->>'departureAt') || '|'
        || coalesce(o.offer->>'arrivalAt','') as flight_key
    from public.fare_snapshots s
      cross join lateral jsonb_array_elements(s.payload->'offers')
        with ordinality o(offer,ordinality)
    where s.origin=p_origin and s.destination=p_destination
      and s.flight_date>=v_from and s.flight_date<v_to
  ), offered as (
    select * from all_offers where price is not null
  ), ordered as (
    select o.*,lag(price) over (
      partition by flight_key order by captured_at_text,source_line,record_id,ordinality
    ) as prior_event_price
    from offered o
  ), changed as (
    select flight_key,price,
      row_number() over (partition by flight_key
        order by captured_at_text desc,source_line desc,record_id desc,ordinality desc) as reverse_rank
    from ordered where prior_event_price is distinct from price
  ), tracks as (
    select distinct on (flight_key) flight_key,record_id,ordinality
    from offered
    order by flight_key,captured_at_text,source_line,record_id,ordinality
  ), sightings as (
    select flight_key,count(distinct record_id)::integer as sightings,
      max(captured_at_text) as last_seen_at,
      array_agg(distinct left(captured_at_text,10)::date order by left(captured_at_text,10)::date) as seen_days
    from all_offers group by flight_key
  ), prices as (
    select flight_key,
      max(price) filter (where reverse_rank=1) as price,
      max(price) filter (where reverse_rank=2) as previous_price,
      max(reverse_rank) as distinct_prices
    from changed group by flight_key
  ), first_prices as (
    select distinct on (flight_key) flight_key,price as first_price
    from changed order by flight_key,reverse_rank desc
  ), projected as materialized (
    select t.flight_key,first_offer.offer,f.first_price,p.price,p.previous_price,
      si.sightings,si.last_seen_at,si.seen_days,
      (k.flight_key is not null) as present,
      coalesce(c.outcome not in ('changed','unchanged','rebaselined'),true) as current_unconfirmed,
      case when k.flight_key is null then 'gone'
        when p.previous_price > 0 and p.previous_price <> p.price
          then case when p.price > p.previous_price then 'rose' else 'fell' end
        when si.sightings > 1 then 'unchanged' else 'first' end as category,
      case when k.flight_key is null then null
        when p.previous_price > 0 then 100 * (p.price-p.previous_price)/p.previous_price
        when si.sightings > 1 then 0 else null end as change_percent
    from tracks t join prices p using(flight_key)
      join first_prices f using(flight_key)
      join sightings si using(flight_key)
      join public.fare_snapshots source on source.record_id=t.record_id
      cross join lateral (
        select source.payload->'offers'->(t.ordinality-1)::integer as offer
      ) first_offer
      left join latest_keys k using(flight_key)
      left join latest_confirmed c on c.flight_date::text=left(first_offer.offer->>'departureAt',10)
  ), upserted as (
    insert into public.fare_flight_projections as existing (
      origin,destination,month,flight_key,offer,first_price,price,previous_price,
      sightings,last_seen_at,seen_days,present,current_unconfirmed,category,change_percent
    )
    select p_origin,p_destination,p_month,flight_key,offer,first_price,price,previous_price,
      sightings,last_seen_at,seen_days,present,current_unconfirmed,category,change_percent
    from projected
    on conflict (origin,destination,month,flight_key) do update set
      offer=excluded.offer,first_price=excluded.first_price,price=excluded.price,
      previous_price=excluded.previous_price,sightings=excluded.sightings,
      last_seen_at=excluded.last_seen_at,seen_days=excluded.seen_days,
      present=excluded.present,current_unconfirmed=excluded.current_unconfirmed,
      category=excluded.category,change_percent=excluded.change_percent
    where (existing.offer,existing.first_price,existing.price,existing.previous_price,
      existing.sightings,existing.last_seen_at,existing.seen_days,existing.present,
      existing.current_unconfirmed,existing.category,existing.change_percent)
    is distinct from (excluded.offer,excluded.first_price,excluded.price,excluded.previous_price,
      excluded.sightings,excluded.last_seen_at,excluded.seen_days,excluded.present,
      excluded.current_unconfirmed,excluded.category,excluded.change_percent)
    returning flight_key
  )
  -- The upsert and delete have disjoint key sets; neither rewrites the other's rows.
  delete from public.fare_flight_projections existing
  where existing.origin=p_origin and existing.destination=p_destination
    and existing.month=p_month
    and not exists (select 1 from projected p where p.flight_key=existing.flight_key);
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."refresh_fare_route_projection"("p_origin" "text", "p_destination" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    SET "statement_timeout" TO '60s'
    AS $$
declare
  v_full boolean;
  v_months text[];
  v_month text;
  v_from date;
  v_to date;
  v_count integer := 0;
  v_metadata jsonb;
begin
  -- The trigger first updates this row. Its lock keeps a concurrent dirty
  -- mark waiting until this refresh either commits or rolls back.
  select needs_full_refresh into v_full from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination for update;
  if not found then return 0; end if;

  if v_full then
    select coalesce(array_agg(month order by month),array[]::text[]) into v_months
    from (
      select to_char(flight_date,'YYYY-MM') as month from public.fare_snapshots
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_baseline_points
        where origin=p_origin and destination=p_destination
      union
      select to_char(flight_date,'YYYY-MM') as month from public.fare_checks
        where kind='board' and origin=p_origin and destination=p_destination
      union
      select month from public.fare_month_projections
        where origin=p_origin and destination=p_destination
    ) months;
  else
    select coalesce(array_agg(month order by month),array[]::text[]) into v_months
    from public.fare_projection_dirty_months
    where origin=p_origin and destination=p_destination;
  end if;

  foreach v_month in array v_months loop
    v_from := (v_month || '-01')::date;
    v_to := (v_from + interval '1 month')::date;
    if exists (
      select 1 from public.fare_snapshots s where s.origin=p_origin
        and s.destination=p_destination and s.flight_date>=v_from and s.flight_date<v_to
    ) or exists (
      select 1 from public.fare_baseline_points b where b.origin=p_origin
        and b.destination=p_destination and b.flight_date>=v_from and b.flight_date<v_to
    ) or exists (
      select 1 from public.fare_checks c where c.kind='board' and c.origin=p_origin
        and c.destination=p_destination and c.flight_date>=v_from and c.flight_date<v_to
    ) then
      perform public.refresh_fare_month_projection(p_origin,p_destination,v_month);
      v_count := v_count + 1;
    else
      delete from public.fare_month_projections
        where origin=p_origin and destination=p_destination and month=v_month;
    end if;
  end loop;

  -- Pair reference spans the whole route; health is month-specific. Keep
  -- only the shared reference current in otherwise unchanged months.
  if exists (select 1 from public.fare_month_projections
             where origin=p_origin and destination=p_destination) then
    v_metadata := public.read_airfare_history_meta(
      p_origin,p_destination,'',array[]::text[],null,null,null
    );
    update public.fare_month_projections p set
      payload = p.payload || jsonb_build_object(
        'pairReference',v_metadata->'pairReference',
        'revision',v_metadata->'revision'
      ),
      revision = (v_metadata->>'revision')::bigint
    where p.origin=p_origin and p.destination=p_destination
      and p.payload->'pairReference' is distinct from v_metadata->'pairReference';
  end if;

  delete from public.fare_projection_dirty_months
    where origin=p_origin and destination=p_destination;
  delete from public.fare_projection_dirty_routes
    where origin=p_origin and destination=p_destination;
  return v_count;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."seace_js_trim"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select btrim(coalesce(p_value,''), E' \t\n\r\f\v' || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
    || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
    || chr(12288) || chr(65279));
$$;

CREATE OR REPLACE FUNCTION "public"."seace_peru_date"("p_value" "text", "p_end_of_day" boolean DEFAULT false) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
declare
  parts text[];
begin
  if p_value is null then return null; end if;
  parts := regexp_match(p_value,
    '^([0-9]{2})/([0-9]{2})/([0-9]{4})([[:space:]]+([0-9]{2}):([0-9]{2})(:([0-9]{2}))?)?');
  if parts is null then return null; end if;
  return make_timestamptz(parts[3]::integer, parts[2]::integer, parts[1]::integer,
    coalesce(parts[5]::integer, case when p_end_of_day then 23 else 0 end),
    coalesce(parts[6]::integer, case when p_end_of_day then 59 else 0 end),
    coalesce(parts[8]::integer, case when p_end_of_day then 59 else 0 end),
    'America/Lima');
exception when datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."search_owner_airports"("p_query" "text", "p_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  -- The same fold the catalog keys were built with, for the accents a keyboard
  -- is likely to produce; codes are ASCII already.
  v_needle text := lower(translate(
    trim(coalesce(p_query, '')),
    'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
  ));
begin
  if public.neon_owner_id() is null or not exists (
    select 1 from public.edicius_owners where owner_id = public.neon_owner_id()
  ) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'invalid_airport_search_limit';
  end if;
  return jsonb_build_object(
    'query', p_query,
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'city', city, 'country', country)
                       order by rank, code)
      from (
      select code, name, city, country, rank
      from (
        select code, name, city, country,
               case
                 when lower(code) = v_needle then 0
                 when left(lower(code), length(v_needle)) = v_needle then 1
                 when left(city_key, length(v_needle)) = v_needle then 2
                 when position(v_needle in city_key) > 0 then 3
                 when position(v_needle in name_key) > 0 then 4
                 when position(v_needle in lower(country)) > 0 then 5
               end as rank
          from (
            select code, name, city, country, city_key, name_key
              from public.airport_catalog
            union all
            -- An archived airport the catalog lacks is still findable, as before.
            select a.code, coalesce(a.name, a.code), coalesce(a.city, ''), coalesce(a.country, ''),
                   lower(coalesce(a.city, '')), lower(coalesce(a.name, ''))
              from public.fare_airports a
             where not exists (select 1 from public.airport_catalog c where c.code = a.code)
          ) airports
         where v_needle <> ''
      ) ranked
      where rank is not null
      order by rank, code
      limit p_limit
      ) best
    ), '[]'::jsonb)
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."set_seace_read_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.is_minor := new.payload->>'minor' = 'true';
  new.object_key := upper(regexp_replace(
    normalize(coalesce(new.payload->>'object',''), NFD), U&'[\0300-\036F]', '', 'g'));
  new.open_until := null;
  if new.kind = 'notices' and new.payload->>'state' = 'Vigente' then
    new.open_until := public.seace_peru_date(new.payload->>'end', false);
  elsif new.kind = 'processes' and coalesce(new.payload->>'state','') !~* 'adjudicad|desiert|cancelad|anulad|contratad|finalizad' then
    new.open_until := least(
      public.seace_peru_date(new.payload->>'end', true),
      public.seace_peru_date(new.payload->>'registrationEnd', true));
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."update_collector_request_progress"("p_request_id" "uuid", "p_progress" "jsonb") RETURNS "public"."collector_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_current public.collector_requests;
  v_updated public.collector_requests;
  v_stage text;
  v_completed integer;
  v_total integer;
  v_current_stage text;
  v_current_completed integer;
  v_current_total integer;
  v_stage_order integer;
  v_current_stage_order integer;
begin
  if jsonb_typeof(p_progress) <> 'object'
     or (select count(*) from jsonb_object_keys(p_progress)) <> 3
     or not (p_progress ?& array['stage', 'completed', 'total'])
     or jsonb_typeof(p_progress->'stage') <> 'string'
     or jsonb_typeof(p_progress->'completed') <> 'number'
     or jsonb_typeof(p_progress->'total') not in ('number', 'null') then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  begin
    v_stage := p_progress->>'stage';
    v_completed := (p_progress->>'completed')::integer;
    v_total := case when jsonb_typeof(p_progress->'total') = 'null'
                    then null else (p_progress->>'total')::integer end;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end;

  v_stage_order := case v_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;
  if v_stage_order < 0 or v_completed < 0 or (v_total is not null and v_total < v_completed) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  select * into v_current
    from public.collector_requests
   where request_id = p_request_id
     and operation = 'airfare-route'
     and status = 'running'
     and expires_at > now()
   for update;
  if v_current.request_id is null then
    raise exception using errcode = 'P0002', message = 'collector_request_not_running';
  end if;

  v_current_stage := v_current.progress->>'stage';
  v_current_completed := coalesce((v_current.progress->>'completed')::integer, 0);
  v_current_total := case when jsonb_typeof(v_current.progress->'total') = 'number'
                          then (v_current.progress->>'total')::integer else null end;
  v_current_stage_order := case v_current_stage
    when 'queued' then 0 when 'collecting' then 1 when 'syncing' then 2 else -1 end;

  if v_current_stage_order < 0
     or v_stage_order < v_current_stage_order
     or (v_stage_order = v_current_stage_order and (
       v_completed < v_current_completed
       or (v_current_total is not null and (v_total is null or v_total < v_current_total))
     )) then
    raise exception using errcode = '22023', message = 'invalid_collector_progress';
  end if;

  update public.collector_requests
     set progress = p_progress, updated_at = now()
   where request_id = p_request_id
  returning * into v_updated;
  return v_updated;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."write_app_document"("p_document_key" "text", "p_payload" "jsonb", "p_expected_revision" bigint) RETURNS "public"."app_documents"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_owner uuid := public.neon_owner_id();
  v_saved public.app_documents;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if not exists (select 1 from public.edicius_owners where owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'not_edicius_owner';
  end if;
  if p_document_key not in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  ) then
    raise exception using errcode = '22023', message = 'invalid_app_document_key';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'app_payload_must_be_object';
  end if;

  if p_expected_revision = 0 then
    insert into public.app_documents (owner_id, document_key, payload)
    values (v_owner, p_document_key, p_payload)
    on conflict do nothing
    returning * into v_saved;
  elsif p_expected_revision > 0 then
    update public.app_documents
       set payload = p_payload, revision = revision + 1, updated_at = now()
     where owner_id = v_owner and document_key = p_document_key and revision = p_expected_revision
    returning * into v_saved;
  end if;

  if v_saved.owner_id is null then
    raise exception using errcode = 'PT409', message = 'app_revision_conflict';
  end if;
  return v_saved;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."write_finance_document"("p_document_key" "text", "p_payload" "jsonb", "p_expected_revision" bigint) RETURNS "public"."finance_documents"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_owner uuid := public.neon_owner_id();
  v_saved public.finance_documents;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if p_document_key not in ('finance', 'finance-camera-views') then
    raise exception using errcode = '22023', message = 'invalid_finance_document_key';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'finance_payload_must_be_object';
  end if;

  if p_expected_revision = 0 then
    insert into public.finance_documents (owner_id, document_key, payload)
    values (v_owner, p_document_key, p_payload)
    on conflict do nothing
    returning * into v_saved;
  elsif p_expected_revision > 0 then
    update public.finance_documents
       set payload = p_payload, revision = revision + 1, updated_at = now()
     where owner_id = v_owner
       and document_key = p_document_key
       and revision = p_expected_revision
    returning * into v_saved;
  end if;

  if v_saved.owner_id is null then
    -- PT409 is PostgREST's explicit HTTP-conflict code. Unlike 40001, it is
    -- not a PostgreSQL serialization failure and must not be retried by the
    -- hosted transaction boundary: this conflict requires a user choice.
    raise exception using errcode = 'PT409', message = 'finance_revision_conflict';
  end if;
  return v_saved;
end;
$$;

CREATE UNIQUE INDEX "collector_requests_active_airfare_route_idx" ON "public"."collector_requests" USING "btree" ("owner_id", (("payload" ->> 'origin'::"text")), (("payload" ->> 'destination'::"text")), (("payload" ->> 'month'::"text")), (("payload" ->> 'currency'::"text"))) WHERE (("operation" = 'airfare-route'::"text") AND ("status" = ANY (ARRAY['queued'::"text", 'running'::"text"])));

CREATE UNIQUE INDEX "collector_requests_active_seace_refresh_idx" ON "public"."collector_requests" USING "btree" ("owner_id", (("payload" ->> 'region'::"text")), (("payload" ->> 'year'::"text"))) WHERE (("operation" = 'seace-refresh'::"text") AND ("status" = ANY (ARRAY['queued'::"text", 'running'::"text"])));

CREATE INDEX "collector_requests_claim_idx" ON "public"."collector_requests" USING "btree" ("owner_id", "created_at") WHERE ("status" = 'queued'::"text");

CREATE INDEX "collector_runs_owner_collector_started_idx" ON "public"."collector_runs" USING "btree" ("owner_id", "collector", "started_at" DESC);

CREATE UNIQUE INDEX "fare_baseline_natural_key_idx" ON "public"."fare_baseline_points" USING "btree" ("origin", "destination", "flight_date", "price_date");

CREATE INDEX "fare_baseline_route_flight_price_date_idx" ON "public"."fare_baseline_points" USING "btree" ("origin", "destination", "flight_date", "price_date");

CREATE INDEX "fare_calendar_route_capture_idx" ON "public"."fare_calendar_captures" USING "btree" ("origin", "destination", "captured_at" DESC);

CREATE INDEX "fare_checks_board_health_idx" ON "public"."fare_checks" USING "btree" ("kind", "origin", "destination", "flight_date", "checked_at");

CREATE INDEX "fare_checks_calendar_health_idx" ON "public"."fare_checks" USING "btree" ("kind", "origin", "destination", "checked_at");

CREATE INDEX "fare_flight_projections_price_idx" ON "public"."fare_flight_projections" USING "btree" ("origin", "destination", "month", "price", "flight_key");

CREATE INDEX "fare_flight_projections_seen_days_idx" ON "public"."fare_flight_projections" USING "gin" ("seen_days");

CREATE INDEX "fare_snapshots_history_cursor_idx" ON "public"."fare_snapshots" USING "btree" ("origin", "destination", "captured_at_text", "source_line", "record_id");

CREATE INDEX "fare_snapshots_route_capture_idx" ON "public"."fare_snapshots" USING "btree" ("origin", "destination", "captured_at");

CREATE INDEX "fare_snapshots_route_flight_capture_idx" ON "public"."fare_snapshots" USING "btree" ("origin", "destination", "flight_date", "captured_at");

CREATE INDEX "fx_observations_owner_source_time" ON "public"."fx_observations" USING "btree" ("owner_id", "source", "effective_at" DESC, "observed_at" DESC);

CREATE INDEX "seace_records_page_open_idx" ON "public"."seace_records" USING "btree" ("owner_id", "region", "year", "kind", "open_until");

CREATE INDEX "seace_records_page_published_idx" ON "public"."seace_records" USING "btree" ("owner_id", "region", "year", "kind", "published_at" DESC NULLS LAST);

CREATE INDEX "seace_records_region_kind_published_idx" ON "public"."seace_records" USING "btree" ("owner_id", "region", "kind", "published_at" DESC NULLS LAST);

ALTER TABLE ONLY "public"."app_documents"
    ADD CONSTRAINT "app_documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."collector_requests"
    ADD CONSTRAINT "collector_requests_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."collector_runs"
    ADD CONSTRAINT "collector_runs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."fare_flight_projections"
    ADD CONSTRAINT "fare_flight_projections_origin_destination_month_fkey" FOREIGN KEY ("origin", "destination", "month") REFERENCES "public"."fare_month_projections"("origin", "destination", "month") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."fare_projection_dirty_months"
    ADD CONSTRAINT "fare_projection_dirty_months_origin_destination_fkey" FOREIGN KEY ("origin", "destination") REFERENCES "public"."fare_projection_dirty_routes"("origin", "destination") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."fx_observations"
    ADD CONSTRAINT "fx_observations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."market_bars"
    ADD CONSTRAINT "market_bars_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."market_quotes"
    ADD CONSTRAINT "market_quotes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."seace_exclusions"
    ADD CONSTRAINT "seace_exclusions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."seace_records"
    ADD CONSTRAINT "seace_records_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."seace_sync_state"
    ADD CONSTRAINT "seace_sync_state_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sentiment_snapshots"
    ADD CONSTRAINT "sentiment_snapshots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."tweet_posts"
    ADD CONSTRAINT "tweet_posts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."edicius_owners"("owner_id") ON DELETE CASCADE;

CREATE OR REPLACE TRIGGER "airfare_history_revision_change" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."fare_airports" FOR EACH STATEMENT EXECUTE FUNCTION "public"."advance_airfare_history_revision"();

CREATE OR REPLACE TRIGGER "airfare_history_revision_change" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."fare_baseline_points" FOR EACH STATEMENT EXECUTE FUNCTION "public"."advance_airfare_history_revision"();

CREATE OR REPLACE TRIGGER "airfare_history_revision_change" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."fare_checks" FOR EACH STATEMENT EXECUTE FUNCTION "public"."advance_airfare_history_revision"();

CREATE OR REPLACE TRIGGER "airfare_history_revision_change" AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."fare_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "public"."advance_airfare_history_revision"();

CREATE OR REPLACE TRIGGER "fare_projection_dirty" AFTER INSERT OR DELETE OR UPDATE ON "public"."fare_baseline_points" FOR EACH ROW EXECUTE FUNCTION "public"."mark_fare_projection_dirty"();

CREATE OR REPLACE TRIGGER "fare_projection_dirty" AFTER INSERT OR DELETE OR UPDATE ON "public"."fare_checks" FOR EACH ROW EXECUTE FUNCTION "public"."mark_fare_projection_dirty"();

CREATE OR REPLACE TRIGGER "fare_projection_dirty" AFTER INSERT OR DELETE OR UPDATE ON "public"."fare_snapshots" FOR EACH ROW EXECUTE FUNCTION "public"."mark_fare_projection_dirty"();

CREATE OR REPLACE TRIGGER "seace_records_read_fields" BEFORE INSERT OR UPDATE OF "kind", "payload" ON "public"."seace_records" FOR EACH ROW EXECUTE FUNCTION "public"."set_seace_read_fields"();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neon_owner_id() TO authenticated;

GRANT EXECUTE ON FUNCTION "public"."cancel_market_request"("p_request_id" "uuid") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."delete_app_document"("p_document_key" "text", "p_expected_revision" bigint) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."enqueue_airfare_route_request"("p_origin" "text", "p_destination" "text", "p_month" "text", "p_currency" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."enqueue_seace_refresh"("p_region" "text", "p_year" integer) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_fx_history"("p_source" "text", "p_range" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_fx_latest"() TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_airfare_calendar"("p_origin" "text", "p_destination" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_airfare_history"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_airfare_history_meta"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_expected_revision" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_airfare_history_page"("p_origin" "text", "p_destination" "text", "p_departure" "text", "p_snapshot_months" "text"[], "p_since" "text", "p_until" "text", "p_revision" "text", "p_dataset" "text", "p_cursor" "jsonb", "p_page_size" integer) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_fare_airports"("p_codes" "text"[]) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_fare_flights"("p_origin" "text", "p_destination" "text", "p_month" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_fare_flights_page"("p_origin" "text", "p_destination" "text", "p_month" "text", "p_from" "date", "p_to" "date", "p_filters" "jsonb", "p_sort" "text", "p_direction" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_fare_month_projection"("p_origin" "text", "p_destination" "text", "p_month" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."read_owner_seace_page"("p_region" "text", "p_year" integer, "p_view" "text", "p_minor_only" boolean, "p_object_filter" "text", "p_excluded" boolean, "p_search" "text", "p_sort_field" "text", "p_ascending" boolean, "p_page" integer, "p_page_size" integer, "p_now" timestamp with time zone) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."seace_js_trim"("p_value" "text") TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."seace_peru_date"("p_value" "text", "p_end_of_day" boolean) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."search_owner_airports"("p_query" "text", "p_limit" integer) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."write_app_document"("p_document_key" "text", "p_payload" "jsonb", "p_expected_revision" bigint) TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."write_finance_document"("p_document_key" "text", "p_payload" "jsonb", "p_expected_revision" bigint) TO "authenticated";
