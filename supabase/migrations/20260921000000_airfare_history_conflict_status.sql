-- SQLSTATE 40001 is reserved for serialization failures. PostgREST 14 retries
-- it inside the request transaction, so a stale history revision can loop
-- indefinitely without returning control to the bounded browser retry policy.
-- Preserve both function bodies and replace only that transport error code.
do $$
declare
  v_function regprocedure;
  v_definition text;
  v_patched text;
  v_old constant text :=
    'raise exception using errcode = ''40001'', message = ''airfare_history_revision_changed'';';
  v_new constant text :=
    'raise sqlstate ''PT409'' using message = ''airfare_history_revision_changed'';';
begin
  foreach v_function in array array[
    'public.read_airfare_history_meta(text,text,text,text[],text,text,text)'::regprocedure,
    'public.read_airfare_history_page(text,text,text,text[],text,text,text,text,jsonb,integer)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_function);
    v_patched := replace(v_definition, v_old, v_new);
    if v_patched = v_definition then
      raise exception 'expected revision conflict clause missing from %', v_function;
    end if;
    execute v_patched;
  end loop;
end;
$$;
