-- Pilot step 8: give the page the class size before work starts, without
-- creating anything. The confirmation screen shows how many pupils are in
-- the chosen class; this adds that count to the existing context call.
--
-- Only a read-only key is added to the context. No rows, files, jobs or
-- settings change.

create or replace function ops.active_context()
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'public', 'pg_temp'
as $function$
declare
  v_class   text;
  v_session text;
  v_term    text;
  v_depts   jsonb;
  v_subject jsonb;
begin
  select class_key, academic_session, term
    into v_class, v_session, v_term
    from public.academic_context where id = 1;

  select config -> 'depts' into v_depts from public.app_config where id = 1;
  v_depts := coalesce(v_depts, '{}'::jsonb);

  select to_jsonb(s) into v_subject
    from ops.subjects s
   where s.class_key = v_class
   order by s.subject_key
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'class_key', v_class,
    'class_label', coalesce(v_depts -> v_class ->> 'label', v_class),
    'academic_session', v_session,
    'term', v_term,
    'section', ops.class_section(v_class),
    'subject_key', v_subject ->> 'subject_key',
    'subject_label', coalesce(v_subject ->> 'subject_label', v_subject ->> 'label'),
    'pupil_count', (
      select count(*)
        from public.students s
       where s.class_key = v_class
         and s.academic_session = v_session
         and coalesce(s.archived, false) = false
    ),
    'classes', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'key', d.key,
          'label', d.value ->> 'label',
          'section', ops.class_section(d.key),
          'subjects', coalesce(d.value -> 'subjects', '[]'::jsonb),
          'pupils', (
            select count(*)
              from public.students s
             where s.class_key = d.key
               and s.academic_session = v_session
               and coalesce(s.archived, false) = false
          )
        ) order by d.value ->> 'label')
       from jsonb_each(v_depts) d),
      '[]'::jsonb
    )
  );
end;
$function$;
