-- Pilot step 5: broadsheet and report cards, the third verb.
--
-- ADDITIVE. Everything lives in schema ops, plus replacements for the pilot's
-- own public wrappers (same names, service-role grants only). No school-loaded
-- file and no school table is touched. No live writes: public.students and
-- public.scores are never written here.
--
-- Generation itself is server-side in api/_ops-documents.js; this migration
-- freezes the inputs at job creation, refuses before rendering, and stores the
-- finished PDF's template version and sha256 on the job.
--
-- Reversal is still one statement:  drop schema if exists ops cascade;

begin;

-- ---------------------------------------------------------------------------
-- 1. Inputs frozen at job creation: subject set, school config, column, and
--    the parsed sentence that started the job.
-- ---------------------------------------------------------------------------
alter table ops.jobs add column if not exists subject_set       jsonb not null default '[]'::jsonb;
alter table ops.jobs add column if not exists config_snapshot   jsonb;
alter table ops.jobs add column if not exists column_group      text;
alter table ops.jobs add column if not exists column_label      text;
alter table ops.jobs add column if not exists template_version  text;
alter table ops.jobs add column if not exists instruction_frozen jsonb;
alter table ops.jobs add column if not exists document_set      jsonb;
alter table ops.jobs add column if not exists documents_generated_at timestamptz;
alter table ops.jobs add column if not exists published_at      timestamptz;
alter table ops.jobs add column if not exists is_proof_copy     boolean not null default false;

comment on column ops.jobs.subject_set is
  'Frozen at job creation: one column per subject, with the school range for this assessment column.';
comment on column ops.jobs.config_snapshot is
  'School name, grade bands, remarks and assessment range copied from app_config when the job was created. A later config edit cannot change this job.';
comment on column ops.jobs.instruction_frozen is
  'The sentence that fixed class, subject, term and column. Later sentences may add notes, never switch it.';
comment on column ops.jobs.is_proof_copy is
  'A throwaway copy made from accepted rows only. It may be deleted; a real job may not.';

alter table ops.job_files add column if not exists kind text not null default 'intake';
alter table ops.job_files add column if not exists document_type text;
alter table ops.job_files add column if not exists page_count integer;

alter table ops.job_files drop constraint if exists job_files_kind_check;
alter table ops.job_files
  add constraint job_files_kind_check check (kind in ('intake', 'document'));

comment on column ops.job_files.kind is
  'intake = the school photo; document = a generated broadsheet or report-card set.';

-- ---------------------------------------------------------------------------
-- 2. Freeze school config and the subject/column that this job is about.
--    Called inside job creation and, before any row exists, by a later
--    sentence. Once rows exist the caller never changes it.
-- ---------------------------------------------------------------------------
create or replace function ops.freeze_job_config(p_job_id uuid, p_parsed jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job            ops.jobs;
  v_cfg            jsonb;
  v_class_label    text;
  v_subject_label  text;
  v_subject_key    text;
  v_column_label   text;
  v_column_group   text;
  v_ca_max         numeric;
  v_exam_max       numeric;
  v_range_max      numeric;
  v_subject_set    jsonb := '[]'::jsonb;
  v_config         jsonb;
  v_found_key      text;
  v_found_label    text;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  select config into v_cfg from public.app_config where id = 1;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);

  v_class_label := coalesce(
    nullif(btrim(coalesce(p_parsed ->> 'class_label', '')), ''),
    v_cfg -> 'depts' -> v_job.class_key ->> 'label',
    v_job.class_key
  );

  v_subject_label := nullif(btrim(coalesce(p_parsed ->> 'subject', p_parsed ->> 'subject_label', '')), '');
  -- Never guess a subject. A photo job has no subject in its sentence; the
  -- reader's staged rows supply it and readiness derives the column from them.
  -- Only a sentence that names a subject fixes the subject set here.

  if v_subject_label is not null then
    select s.subject_key, s.label into v_found_key, v_found_label
      from ops.subjects s
     where s.class_key = v_job.class_key
       and lower(s.label) = lower(v_subject_label)
     limit 1;

    if v_found_key is not null then
      v_subject_key := v_found_key;
      v_subject_label := v_found_label;
    else
      v_subject_key := v_job.class_key || ':' || rtrim(regexp_replace(
        lower(v_subject_label), '[^a-z0-9]+', '-', 'g'), '-');
    end if;
  end if;

  v_column_label := coalesce(
    nullif(btrim(coalesce(p_parsed ->> 'column_label', '')), ''),
    nullif(btrim(v_job.column_label), ''),
    'CLASS EXERCISE'
  );
  v_column_group := coalesce(
    nullif(btrim(coalesce(p_parsed ->> 'column_group', '')), ''),
    nullif(btrim(v_job.column_group), ''),
    upper(coalesce(v_job.term, '1ST TERM'))
  );

  v_ca_max := coalesce((v_cfg -> 'assessment' -> 'caMarks' ->> 0)::numeric, 100);
  v_exam_max := coalesce((v_cfg -> 'assessment' ->> 'examMark')::numeric, 100);
  v_range_max := case
    when v_column_label = 'EXAM' then v_exam_max
    when v_column_label = 'CLASS EXERCISE' then v_ca_max
    else 100
  end;

  if v_subject_label is not null then
    v_subject_set := jsonb_build_array(jsonb_build_object(
      'key', v_subject_key,
      'label', v_subject_label,
      'range_min', 0,
      'range_max', v_range_max
    ));
  end if;

  v_config := jsonb_build_object(
    'school', coalesce(v_cfg -> 'school', '{}'::jsonb),
    'class_key', v_job.class_key,
    'class_label', v_class_label,
    'section', ops.class_section(v_job.class_key),
    'academic_session', v_job.academic_session,
    'term', v_job.term,
    'column_group', v_column_group,
    'column_label', v_column_label,
    'subject_set', v_subject_set,
    'grade_scale', coalesce(v_cfg -> 'gradeScale', '[]'::jsonb),
    'remarks', coalesce(v_cfg -> 'remarks', '[]'::jsonb),
    'assessment', coalesce(v_cfg -> 'assessment', '{}'::jsonb),
    'ranges', jsonb_build_object(
      'class_exercise', jsonb_build_object('min', 0, 'max', v_ca_max),
      'exam', jsonb_build_object('min', 0, 'max', v_exam_max),
      'term', jsonb_build_object('min', 0, 'max', 100)
    ),
    'captured_at', now()
  );

  update ops.jobs
     set subject_set      = v_subject_set,
         config_snapshot  = v_config,
         column_label     = v_column_label,
         column_group     = v_column_group,
         template_version = coalesce(template_version, '2026-10-31.1'),
         instruction_frozen = coalesce(instruction_frozen, p_parsed),
         updated_at       = now()
   where id = p_job_id
   returning * into v_job;

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

revoke all on function ops.freeze_job_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function ops.freeze_job_config(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Creation now stores the parse itself and freezes the inputs in the same
--    transaction. The API parses before it calls this, so a later message can
--    never half-switch the job.
-- ---------------------------------------------------------------------------
drop function if exists public.ops_jobs_create(uuid, text, text, text, text, uuid, text, text, jsonb);

create or replace function public.ops_jobs_create(
  p_school_id uuid,
  p_class_key text,
  p_academic_session text,
  p_term text,
  p_service text,
  p_submitted_by uuid,
  p_submitted_by_email text,
  p_instruction text,
  p_file_refs jsonb default '[]'::jsonb,
  p_instruction_parsed jsonb default null
)
returns jsonb
language plpgsql
set search_path = ops, public, pg_temp
as $$
declare
  v_job   ops.jobs;
  v_count integer := null;
begin
  insert into ops.jobs (
    school_id, class_key, academic_session, term, service, status,
    submitted_by, submitted_by_email, instruction, file_refs,
    instruction_parsed, instruction_frozen
  )
  values (
    p_school_id, p_class_key, p_academic_session, p_term, p_service, 'draft',
    p_submitted_by, p_submitted_by_email, p_instruction,
    coalesce(p_file_refs, '[]'::jsonb),
    p_instruction_parsed, p_instruction_parsed
  )
  returning * into v_job;

  if v_job.class_key is not null then
    v_count := ops.snapshot_roster(v_job.id, v_job.class_key);
    perform ops.freeze_job_config(v_job.id, p_instruction_parsed);
    select * into v_job from ops.jobs where id = v_job.id;
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, p_submitted_by, p_submitted_by_email, 'job.created', 'ops.jobs', v_job.id,
          jsonb_build_object('service', v_job.service, 'class_key', v_job.class_key,
                             'roster_snapshot', v_count,
                             'instruction_frozen', p_instruction_parsed));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

revoke all on function public.ops_jobs_create(uuid, text, text, text, text, uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ops_jobs_create(uuid, text, text, text, text, uuid, text, text, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. A later sentence: before any row exists it may still fix the inputs;
--    after a row exists it is a note only. A disagreement is returned, not
--    applied, with the fields that are in force and an offer of a new job.
-- ---------------------------------------------------------------------------
create or replace function ops.save_instruction(p_job_id uuid, p_raw text, p_parsed jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job        ops.jobs;
  v_old_class  text;
  v_rows       integer;
  v_frozen     jsonb;
  v_class      text;
  v_subject    text;
  v_term       text;
  v_column     text;
  v_conflict   boolean := false;
  v_in_force   jsonb;
  v_asked      jsonb;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  select count(*) into v_rows from ops.staged_rows where job_id = p_job_id;
  v_frozen := coalesce(v_job.instruction_frozen, v_job.instruction_parsed, '{}'::jsonb);
  v_old_class := v_job.class_key;

  -- A job is frozen when it was created from a parsed sentence. Only a legacy
  -- job with no parse and no rows may still take its first real sentence.
  if v_rows = 0 and v_job.instruction_frozen is null then
    update ops.jobs
       set instruction = case when instruction is null or btrim(instruction) = ''
                              then left(coalesce(p_raw, ''), 4000) else instruction end,
           instruction_parsed = coalesce(p_parsed, '{}'::jsonb)
                                || jsonb_build_object('raw', left(coalesce(p_raw, ''), 4000)),
           instruction_frozen = coalesce(p_parsed, '{}'::jsonb)
                                || jsonb_build_object('raw', left(coalesce(p_raw, ''), 4000)),
           class_key = coalesce(nullif(p_parsed ->> 'class_key', ''), class_key),
           term = coalesce(nullif(p_parsed ->> 'term', ''), term),
           academic_session = coalesce(nullif(p_parsed ->> 'academic_session', ''), academic_session),
           updated_at = now()
     where id = p_job_id
     returning * into v_job;

    perform ops.freeze_job_config(p_job_id, p_parsed);
    select * into v_job from ops.jobs where id = p_job_id;

    if v_job.class_key is distinct from v_old_class then
      perform ops.snapshot_roster(p_job_id, v_job.class_key);
      select * into v_job from ops.jobs where id = p_job_id;
    end if;
  else
    -- The job is already fixed. Compare only what the sentence actually says.
    v_class := nullif(p_parsed ->> 'class_key', '');
    v_subject := nullif(p_parsed ->> 'subject', '');
    v_term := nullif(p_parsed ->> 'term', '');
    v_column := nullif(p_parsed ->> 'column_label', '');

    if v_class is not null and lower(v_class) <> lower(v_job.class_key) then v_conflict := true; end if;
    if v_subject is not null and lower(v_subject) <> lower(coalesce(v_job.subject_set -> 0 ->> 'label', '')) then v_conflict := true; end if;
    if v_term is not null and lower(v_term) <> lower(coalesce(v_job.term, '')) then v_conflict := true; end if;
    if v_column is not null and lower(v_column) <> lower(coalesce(v_job.column_label, '')) then v_conflict := true; end if;

    v_in_force := jsonb_build_object(
      'class_key', v_job.class_key,
      'class_label', coalesce(v_job.config_snapshot -> 'class_label', to_jsonb(v_job.class_key)),
      'subject', v_job.subject_set -> 0 ->> 'label',
      'term', v_job.term,
      'column_label', v_job.column_label
    );
    v_asked := jsonb_build_object(
      'class_key', v_class,
      'subject', v_subject,
      'term', v_term,
      'column_label', v_column
    );

    if v_conflict then
      insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
      values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
              'instruction.conflict', 'ops.jobs', p_job_id,
              jsonb_build_object('raw', left(coalesce(p_raw, ''), 4000),
                                 'asked', v_asked, 'in_force', v_in_force));

      return jsonb_build_object(
        'ok', false,
        'conflict', true,
        'code', 'OPS_INSTRUCTION_CONFLICT',
        'in_force', v_in_force,
        'asked', v_asked,
        'rows', v_rows,
        'raw', left(coalesce(p_raw, ''), 4000)
      );
    end if;

    update ops.jobs
       set instruction_parsed = coalesce(instruction_parsed, '{}'::jsonb)
                                || jsonb_build_object('raw', left(coalesce(p_raw, ''), 4000)),
           updated_at = now()
     where id = p_job_id
     returning * into v_job;
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'instruction.parsed', 'ops.jobs', p_job_id,
          jsonb_build_object('parsed', p_parsed, 'raw', left(coalesce(p_raw, ''), 4000),
                             'rows_at_parse', v_rows));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job),
                            'in_force', v_in_force);
end;
$$;

revoke all on function ops.save_instruction(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function ops.save_instruction(uuid, text, jsonb) to service_role;

-- Public wrapper keeps its name and signature.
create or replace function public.ops_save_instruction(p_job_id uuid, p_raw text, p_parsed jsonb)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.save_instruction(p_job_id, p_raw, p_parsed);
$$;

revoke all on function public.ops_save_instruction(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_save_instruction(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Readiness. Every refusal is collected before a single page is rendered.
-- ---------------------------------------------------------------------------
create or replace function ops.document_readiness(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job            ops.jobs;
  v_cfg            jsonb;
  v_subjects       jsonb;
  v_pending        jsonb := '[]'::jsonb;
  v_bad_range      jsonb := '[]'::jsonb;
  v_bad_total      jsonb := '[]'::jsonb;
  v_missing        jsonb := '[]'::jsonb;
  v_refusals       jsonb := '[]'::jsonb;
  v_pupils         jsonb := '[]'::jsonb;
  v_subject_stats  jsonb := '[]'::jsonb;
  v_pupil          jsonb;
  v_marks          jsonb;
  v_grades         jsonb;
  v_grade_remarks  jsonb;
  v_grade_remark   text;
  v_percent        numeric;
  v_sub_percent    numeric;
  v_max_total      numeric;
  v_missing_sub    jsonb;
  v_total          numeric;
  v_average        numeric;
  v_den            integer;
  v_grade          text;
  v_remark         text;
  v_name           text;
  v_admno          text;
  v_student        uuid;
  v_subject        record;
  v_snapshot_count integer;
  v_accepted_count integer;
  v_count          integer;
  v_stats          jsonb;
  v_data           jsonb;
  v_class_size     integer;
  v_class_average  numeric;
  v_highest        numeric;
  v_lowest         numeric;
begin
  select * into v_job from ops.jobs where id = p_job_id;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND',
      'refusals', jsonb_build_array(jsonb_build_object('code', 'OPS_JOB_NOT_FOUND',
        'message', 'That job is not here.')));
  end if;

  v_cfg := coalesce(v_job.config_snapshot, '{}'::jsonb);
  if v_cfg = '{}'::jsonb then
    perform ops.freeze_job_config(p_job_id, null);
    select * into v_job from ops.jobs where id = p_job_id;
    v_cfg := coalesce(v_job.config_snapshot, '{}'::jsonb);
  end if;

  v_subjects := coalesce(v_job.subject_set, '[]'::jsonb);
  if jsonb_array_length(v_subjects) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'key', s.subject_key, 'label', s.subject_label,
             'range_min', 0,
             'range_max', case when v_job.column_label = 'EXAM'
                               then coalesce((v_cfg -> 'assessment' ->> 'examMark')::numeric, 100)
                               when v_job.column_label = 'CLASS EXERCISE'
                               then coalesce((v_cfg -> 'assessment' -> 'caMarks' ->> 0)::numeric, 100)
                               else 100 end) order by s.subject_label), '[]'::jsonb)
      into v_subjects
      from (select distinct subject_key, subject_label
              from ops.staged_rows
             where job_id = p_job_id and subject_key is not null) s;
  end if;

  -- 5a. Any row not accepted or applied. Name every one of them.
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_no', r.row_no, 'name', r.student_name_raw, 'status', r.status
         ) order by r.row_no), '[]'::jsonb)
    into v_pending
    from ops.staged_rows r
   where r.job_id = p_job_id and r.status not in ('accepted', 'applied');

  if jsonb_array_length(v_pending) > 0 then
    v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
      'code', 'OPS_ROWS_PENDING',
      'message', jsonb_array_length(v_pending) || ' rows still need a decision before a page is made.',
      'count', jsonb_array_length(v_pending),
      'rows', v_pending
    ));
  end if;

  -- 5b. A subject column with no mark for the whole class.
  for v_subject in select value from jsonb_array_elements(v_subjects) loop
    select count(*) into v_count
      from ops.staged_rows r
      join ops.staged_marks m on m.staged_row_id = r.id
     where r.job_id = p_job_id
       and r.status in ('accepted', 'applied')
       and r.subject_key = v_subject.value ->> 'key'
       and m.column_label = v_job.column_label
       and m.status = 'read'
       and m.value is not null;

    if v_count = 0 then
      v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
        'code', 'OPS_SUBJECT_EMPTY',
        'message', 'The subject column "' || (v_subject.value ->> 'label') || '" has no mark for the whole class.',
        'subject_key', v_subject.value ->> 'key',
        'subject_label', v_subject.value ->> 'label'
      ));
    end if;
  end loop;

  -- 5c. Pupil count must equal the frozen roster snapshot.
  select count(distinct r.student_id) into v_accepted_count
    from ops.staged_rows r
   where r.job_id = p_job_id and r.status in ('accepted', 'applied') and r.student_id is not null;

  v_snapshot_count := coalesce(v_job.roster_snapshot_count,
    (select pupil_count from ops.roster_snapshots where job_id = p_job_id), 0);

  if v_accepted_count <> v_snapshot_count then
    select coalesce(jsonb_agg(jsonb_build_object('name', p ->> 'name', 'admno', p ->> 'admno')
                              order by p ->> 'admno'), '[]'::jsonb)
      into v_missing
      from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
     where rs.job_id = p_job_id
       and not exists (
         select 1 from ops.staged_rows r
          where r.job_id = p_job_id
            and r.status in ('accepted', 'applied')
            and r.student_id = (p ->> 'id')::uuid
       );

    v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
      'code', 'OPS_PUPIL_COUNT_MISMATCH',
      'message', 'The class list has ' || v_snapshot_count || ' pupils but ' || v_accepted_count || ' are approved on this job.',
      'expected', v_snapshot_count,
      'actual', v_accepted_count,
      'missing', v_missing
    ));
  end if;

  -- 5d. A mark outside the school's declared range for that subject/column.
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_no', r.row_no, 'name', r.student_name_raw, 'subject', r.subject_label,
           'value', m.value, 'min', (s.value ->> 'range_min')::numeric,
           'max', (s.value ->> 'range_max')::numeric
         ) order by r.row_no), '[]'::jsonb)
    into v_bad_range
    from ops.staged_rows r
    join ops.staged_marks m on m.staged_row_id = r.id
    join jsonb_array_elements(v_subjects) s on s.value ->> 'key' = r.subject_key
   where r.job_id = p_job_id
     and r.status in ('accepted', 'applied')
     and m.column_label = v_job.column_label
     and m.status = 'read'
     and m.value is not null
     and (m.value < (s.value ->> 'range_min')::numeric
          or m.value > (s.value ->> 'range_max')::numeric);

  if jsonb_array_length(v_bad_range) > 0 then
    v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
      'code', 'OPS_MARK_RANGE',
      'message', jsonb_array_length(v_bad_range) || ' marks fall outside the school range for this column.',
      'count', jsonb_array_length(v_bad_range),
      'rows', v_bad_range
    ));
  end if;

  -- 5e. A mark that cannot be recomputed: the row value and its cell differ.
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_no', r.row_no, 'name', r.student_name_raw,
           'row_value', r.value, 'cell_value', m.value
         ) order by r.row_no), '[]'::jsonb)
    into v_bad_total
    from ops.staged_rows r
    join ops.staged_marks m on m.staged_row_id = r.id
   where r.job_id = p_job_id
     and r.status in ('accepted', 'applied')
     and m.column_label = v_job.column_label
     and m.status = 'read'
     and r.value is not null
     and m.value is distinct from r.value;

  if jsonb_array_length(v_bad_total) > 0 then
    v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
      'code', 'OPS_TOTAL_MISMATCH',
      'message', 'A total cannot be recomputed from its parts.',
      'count', jsonb_array_length(v_bad_total),
      'rows', v_bad_total
    ));
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    return jsonb_build_object(
      'ok', false,
      'code', v_refusals -> 0 ->> 'code',
      'refusals', v_refusals,
      'job', jsonb_build_object(
        'id', v_job.id, 'class_key', v_job.class_key, 'status', v_job.status,
        'roster_snapshot_count', v_job.roster_snapshot_count,
        'column_label', v_job.column_label
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- Everything passed. Build one row per pupil from the accepted marks.
  -- -------------------------------------------------------------------------
  for v_student in
    select distinct r.student_id
      from ops.staged_rows r
     where r.job_id = p_job_id
       and r.status in ('accepted', 'applied')
       and r.student_id is not null
  loop
    select p ->> 'name', p ->> 'admno'
      into v_name, v_admno
      from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
     where rs.job_id = p_job_id and (p ->> 'id')::uuid = v_student
     limit 1;

    select coalesce(v_name, r.student_name_raw), coalesce(v_admno, r.admno)
      into v_name, v_admno
      from ops.staged_rows r
     where r.job_id = p_job_id and r.student_id = v_student
     order by r.row_no
     limit 1;

    select coalesce(jsonb_object_agg(r.subject_key, m.value), '{}'::jsonb)
      into v_marks
      from ops.staged_rows r
      join ops.staged_marks m on m.staged_row_id = r.id
     where r.job_id = p_job_id
       and r.student_id = v_student
       and r.status in ('accepted', 'applied')
       and r.subject_key is not null
       and m.column_label = v_job.column_label
       and m.status = 'read'
       and m.value is not null;

    v_den := (select count(*) from jsonb_object_keys(v_marks));
    v_total := (select coalesce(sum(value::numeric), 0) from jsonb_each_text(v_marks));
    v_average := case when v_den > 0 then round(v_total / v_den, 2) else null end;

    -- The school's bands are written for a mark out of 100. This column may be
    -- out of 30 or 70, so the same band is applied to the mark as a percentage
    -- of what the column is worth. The printed mark itself is never rescaled.
    select coalesce(sum((s.value ->> 'range_max')::numeric), 0)
      into v_max_total
      from jsonb_array_elements(v_subjects) s
     where v_marks ? (s.value ->> 'key');

    v_percent := case when v_max_total > 0 then round(v_total / v_max_total * 100, 2) else null end;

    v_grades := '{}'::jsonb;
    v_grade_remarks := '{}'::jsonb;
    for v_subject in select value from jsonb_array_elements(v_subjects) loop
      if v_marks ? (v_subject.value ->> 'key') then
        v_sub_percent := round(
          ((v_marks ->> (v_subject.value ->> 'key'))::numeric
            / nullif((v_subject.value ->> 'range_max')::numeric, 0)) * 100, 2);
        select e ->> 'g', e ->> 'r' into v_grade, v_grade_remark
          from jsonb_array_elements(coalesce(v_cfg -> 'grade_scale', '[]'::jsonb)) e
         where floor(coalesce(v_sub_percent, 0)) >= (e ->> 'min')::numeric
           and floor(coalesce(v_sub_percent, 0)) <= (e ->> 'max')::numeric
         order by (e ->> 'min')::numeric desc
         limit 1;
        v_grades := v_grades || jsonb_build_object(v_subject.value ->> 'key', v_grade);
        v_grade_remarks := v_grade_remarks
          || jsonb_build_object(v_subject.value ->> 'key', v_grade_remark);
      end if;
    end loop;

    select e ->> 'g' into v_grade
      from jsonb_array_elements(coalesce(v_cfg -> 'grade_scale', '[]'::jsonb)) e
     where v_percent is not null
       and floor(v_percent) >= (e ->> 'min')::numeric
       and floor(v_percent) <= (e ->> 'max')::numeric
     order by (e ->> 'min')::numeric desc
     limit 1;

    select coalesce(jsonb_agg(s.value ->> 'key' order by s.value ->> 'label'), '[]'::jsonb)
      into v_missing_sub
      from jsonb_array_elements(v_subjects) s
     where not v_marks ? (s.value ->> 'key');

    select e ->> 'text' into v_remark
      from jsonb_array_elements(coalesce(v_cfg -> 'remarks', '[]'::jsonb)) e
     where v_percent is not null
       and floor(v_percent) >= (e ->> 'min')::numeric
       and floor(v_percent) <= (e ->> 'max')::numeric
     order by (e ->> 'min')::numeric desc
     limit 1;

    v_pupil := jsonb_build_object(
      'student_id', v_student,
      'name', v_name,
      'admno', v_admno,
      'marks', v_marks,
      'grades', v_grades,
      'grade_remarks', v_grade_remarks,
      'total', v_total,
      'average', v_average,
      'max_total', v_max_total,
      'percent', v_percent,
      'grade', v_grade,
      'counted_subjects', v_den,
      'missing_subjects', v_missing_sub,
      'asterisk', v_den < jsonb_array_length(v_subjects),
      'remark', v_remark
    );
    v_pupils := v_pupils || jsonb_build_array(v_pupil);
  end loop;

  -- Ties share a position; the next position skips the tied places.
  with ranked as (
    select p,
           (p ->> 'average')::numeric as avg
      from jsonb_array_elements(v_pupils) p
  ), positioned as (
    select p,
           (select count(*) + 1 from ranked r2 where r2.avg > r.avg) as pos
      from ranked r
  )
  select coalesce(jsonb_agg(p || jsonb_build_object('position', pos)
                            order by p ->> 'admno', p ->> 'name'), '[]'::jsonb)
    into v_pupils
    from positioned;

  select count(*),
         round(avg((p ->> 'average')::numeric), 2),
         max((p ->> 'average')::numeric),
         min((p ->> 'average')::numeric)
    into v_class_size, v_class_average, v_highest, v_lowest
    from jsonb_array_elements(v_pupils) p;

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', s.value ->> 'key',
           'label', s.value ->> 'label',
           'range_min', (s.value ->> 'range_min')::numeric,
           'range_max', (s.value ->> 'range_max')::numeric,
           'count', (select count(*) from jsonb_array_elements(v_pupils) p
                      where p -> 'marks' ? (s.value ->> 'key')),
           'average', (select round(avg((p -> 'marks' ->> (s.value ->> 'key'))::numeric), 2)
                         from jsonb_array_elements(v_pupils) p
                        where p -> 'marks' ? (s.value ->> 'key')),
           'highest', (select max((p -> 'marks' ->> (s.value ->> 'key'))::numeric)
                        from jsonb_array_elements(v_pupils) p
                       where p -> 'marks' ? (s.value ->> 'key')),
           'lowest', (select min((p -> 'marks' ->> (s.value ->> 'key'))::numeric)
                       from jsonb_array_elements(v_pupils) p
                      where p -> 'marks' ? (s.value ->> 'key'))
         ) order by s.value ->> 'label'), '[]'::jsonb)
    into v_subject_stats
    from jsonb_array_elements(v_subjects) s;

  v_stats := jsonb_build_object(
    'class_size', v_class_size,
    'average', v_class_average,
    'highest', v_highest,
    'lowest', v_lowest,
    'subjects', v_subject_stats,
    'order_rule', 'Ordered by admission number.',
    'position_rule', 'Equal averages share a position; the next position skips the tied places.',
    'asterisk_rule', 'A pupil with a missing subject is ranked only on the subjects they have and marked with an asterisk. No mark is filled with zero.'
  );

  v_data := jsonb_build_object(
    'job_id', v_job.id,
    'school_name', coalesce(v_cfg -> 'school' ->> 'name', 'FIRST CHOICE STANDARD SCHOOLS'),
    'school_address', coalesce(v_cfg -> 'school' ->> 'addr', ''),
    'school_motto', coalesce(v_cfg -> 'school' ->> 'motto', ''),
    'class_key', v_job.class_key,
    'class_label', coalesce(v_cfg ->> 'class_label', v_job.class_key),
    'section', coalesce(v_cfg ->> 'section', ''),
    'academic_session', v_job.academic_session,
    'term', v_job.term,
    'column_group', v_job.column_group,
    'column_label', v_job.column_label,
    'template_version', coalesce(v_job.template_version, '2026-10-31.1'),
    'subject_set', v_subjects,
    'pupils', v_pupils,
    'stats', v_stats
  );

  return jsonb_build_object('ok', true, 'code', null, 'refusals', '[]'::jsonb, 'data', v_data);
end;
$$;

revoke all on function ops.document_readiness(uuid) from public, anon, authenticated;
grant execute on function ops.document_readiness(uuid) to service_role;

create or replace function public.ops_document_readiness(p_job_id uuid)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.document_readiness(p_job_id);
$$;

revoke all on function public.ops_document_readiness(uuid) from public, anon, authenticated;
grant execute on function public.ops_document_readiness(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. A throwaway proof copy: accepted rows only, its own frozen roster of
--    exactly those pupils, flagged so only this kind of job can be deleted.
-- ---------------------------------------------------------------------------
create or replace function ops.copy_accepted_job(p_source uuid, p_actor uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_src      ops.jobs;
  v_job      ops.jobs;
  v_row      record;
  v_new_id   uuid;
  v_no       integer := 0;
  v_count    integer;
  v_pupils   jsonb;
  v_summary  jsonb;
begin
  select * into v_src from ops.jobs where id = p_source;
  if v_src.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  select count(*) into v_count
    from ops.staged_rows where job_id = p_source and status = 'accepted';
  if v_count = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_NO_ACCEPTED_ROWS',
      'message', 'This job has no accepted rows to copy.');
  end if;

  insert into ops.jobs (
    school_id, class_key, academic_session, term, service, status,
    submitted_by, submitted_by_email, instruction, file_refs,
    subject_set, config_snapshot, column_group, column_label, template_version,
    instruction_frozen, is_proof_copy, roster_snapshot_count, roster_snapshot_at
  ) values (
    v_src.school_id, v_src.class_key, v_src.academic_session, v_src.term,
    'documents', 'needs_review',
    p_actor, p_actor_email,
    'Throwaway proof copy of ' || v_src.id || ' accepted rows only. Delete after the render check.',
    '[]'::jsonb,
    v_src.subject_set, v_src.config_snapshot, v_src.column_group, v_src.column_label,
    coalesce(v_src.template_version, '2026-10-31.1'),
    v_src.instruction_frozen, true, 0, now()
  ) returning * into v_job;

  for v_row in
    select * from ops.staged_rows
     where job_id = p_source and status = 'accepted'
     order by admno nulls last, row_no, student_name_raw
  loop
    v_no := v_no + 1;
    insert into ops.staged_rows (
      job_id, row_no, student_id, admno, student_name_raw, match_method,
      match_confidence, subject_id, subject_key, subject_label, component, value,
      confidence, status, flag, match_list, surname_score, first_score, candidate_names
    ) values (
      v_job.id, v_no, v_row.student_id, v_row.admno, v_row.student_name_raw, v_row.match_method,
      v_row.match_confidence, v_row.subject_id, v_row.subject_key, v_row.subject_label,
      v_row.component, v_row.value, v_row.confidence, 'accepted', null, 'A',
      v_row.surname_score, v_row.first_score, v_row.candidate_names
    ) returning id into v_new_id;

    insert into ops.staged_marks (
      job_id, staged_row_id, column_group, column_label, value, status,
      candidates, confidence, note
    )
    select v_job.id, v_new_id, m.column_group, m.column_label, m.value, m.status,
           m.candidates, m.confidence, m.note
      from ops.staged_marks m
     where m.staged_row_id = v_row.id
       and m.column_label = v_src.column_label;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('id', x.student_id, 'admno', x.admno, 'name', x.name)
                            order by x.admno), '[]'::jsonb)
    into v_pupils
    from (
      select distinct on (r.student_id)
             r.student_id, r.admno,
             coalesce((select p ->> 'name'
                         from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
                        where rs.job_id = p_source and (p ->> 'id')::uuid = r.student_id
                        limit 1), r.student_name_raw) as name
        from ops.staged_rows r
       where r.job_id = v_job.id and r.student_id is not null
       order by r.student_id, r.row_no
    ) x;

  insert into ops.roster_snapshots (job_id, class_key, pupil_count, pupils)
  values (v_job.id, v_job.class_key, jsonb_array_length(v_pupils), v_pupils);

  update ops.jobs
     set roster_snapshot_count = jsonb_array_length(v_pupils),
         roster_snapshot_at = now(),
         updated_at = now()
   where id = v_job.id
   returning * into v_job;

  v_summary := ops.refresh_marks_summary(v_job.id);
  select * into v_job from ops.jobs where id = v_job.id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, p_actor, p_actor_email, 'job.proof_copy', 'ops.jobs', v_job.id,
          jsonb_build_object('source_job', p_source, 'rows', v_no,
                             'pupils', jsonb_array_length(v_pupils), 'public_write', false));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'source_job', p_source,
                            'rows', v_no, 'pupils', jsonb_array_length(v_pupils),
                            'summary', v_summary, 'live_write', false);
end;
$$;

revoke all on function ops.copy_accepted_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.copy_accepted_job(uuid, uuid, text) to service_role;

create or replace function public.ops_copy_accepted_job(p_source uuid, p_actor uuid, p_actor_email text)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.copy_accepted_job(p_source, p_actor, p_actor_email);
$$;

revoke all on function public.ops_copy_accepted_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_copy_accepted_job(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Store generated PDFs and their manifest on the job. Generation is key
--    one; publishing is a separate second confirmation and is not built here.
-- ---------------------------------------------------------------------------
create or replace function ops.clear_documents(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from ops.job_files where job_id = p_job_id and kind = 'document';
  get diagnostics v_count = row_count;

  update ops.jobs
     set document_set = null,
         documents_generated_at = null,
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'documents.cleared', 'ops.job_files', p_job_id,
          jsonb_build_object('files_removed', v_count));

  return jsonb_build_object('ok', true, 'files_removed', v_count);
end;
$$;

revoke all on function ops.clear_documents(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.clear_documents(uuid, uuid, text) to service_role;

create or replace function public.ops_clear_documents(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.clear_documents(p_job_id, p_actor, p_actor_email);
$$;

revoke all on function public.ops_clear_documents(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_clear_documents(uuid, uuid, text) to service_role;

create or replace function ops.attach_document(
  p_job_id uuid,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_page_count integer,
  p_document_type text,
  p_uploaded_by uuid,
  p_uploaded_by_email text,
  p_max_bytes integer default 12000000
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_bytes bytea := decode(coalesce(p_content_b64, ''), 'base64');
  v_size  integer := coalesce(length(decode(coalesce(p_content_b64, ''), 'base64')), 0);
  v_file  ops.job_files;
  v_job   ops.jobs;
begin
  if v_size = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_FILE_EMPTY');
  end if;
  if v_size > p_max_bytes then
    return jsonb_build_object('ok', false, 'code', 'OPS_FILE_TOO_LARGE', 'limit', p_max_bytes);
  end if;
  if coalesce(p_mime, '') <> 'application/pdf' then
    return jsonb_build_object('ok', false, 'code', 'OPS_DOCUMENT_TYPE_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  insert into ops.job_files (
    job_id, filename, mime, byte_size, sha256, content,
    uploaded_by, uploaded_by_email, kind, document_type, page_count
  ) values (
    p_job_id, left(coalesce(p_filename, 'document.pdf'), 200),
    'application/pdf', v_size, coalesce(p_sha256, ''), v_bytes,
    p_uploaded_by, p_uploaded_by_email, 'document',
    left(coalesce(p_document_type, 'document'), 40), greatest(0, coalesce(p_page_count, 0))
  ) returning * into v_file;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_uploaded_by, p_uploaded_by_email, 'documents.file', 'ops.job_files', v_file.id,
          jsonb_build_object('filename', v_file.filename, 'type', v_file.document_type,
                             'pages', v_file.page_count, 'bytes', v_size, 'sha256', v_file.sha256));

  return jsonb_build_object('ok', true, 'file', jsonb_build_object(
    'id', v_file.id, 'job_id', v_file.job_id, 'filename', v_file.filename,
    'mime', v_file.mime, 'byte_size', v_file.byte_size, 'sha256', v_file.sha256,
    'page_count', v_file.page_count, 'document_type', v_file.document_type,
    'kind', v_file.kind, 'created_at', v_file.created_at
  ));
end;
$$;

revoke all on function ops.attach_document(uuid, text, text, text, text, integer, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function ops.attach_document(uuid, text, text, text, text, integer, text, uuid, text, integer)
  to service_role;

create or replace function public.ops_attach_document(
  p_job_id uuid,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_page_count integer,
  p_document_type text,
  p_uploaded_by uuid,
  p_uploaded_by_email text,
  p_max_bytes integer default 12000000
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.attach_document(p_job_id, p_filename, p_mime, p_content_b64, p_sha256,
                             p_page_count, p_document_type, p_uploaded_by,
                             p_uploaded_by_email, p_max_bytes);
$$;

revoke all on function public.ops_attach_document(uuid, text, text, text, text, integer, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.ops_attach_document(uuid, text, text, text, text, integer, text, uuid, text, integer)
  to service_role;

create or replace function ops.record_documents(p_job_id uuid, p_document_set jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
begin
  if p_document_set is null or jsonb_typeof(p_document_set) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'OPS_DOCUMENT_SET_INVALID');
  end if;

  update ops.jobs
     set document_set = p_document_set,
         template_version = coalesce(p_document_set ->> 'template_version', template_version),
         documents_generated_at = now(),
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'documents.generated', 'ops.jobs', p_job_id,
          jsonb_build_object('template_version', v_job.template_version,
                             'pages', p_document_set -> 'pages_total',
                             'bytes', p_document_set -> 'bytes_total',
                             'class_size', p_document_set -> 'numbers' -> 'class_size',
                             'published', false));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'live_write', false);
end;
$$;

revoke all on function ops.record_documents(uuid, jsonb) from public, anon, authenticated;
grant execute on function ops.record_documents(uuid, jsonb) to service_role;

create or replace function public.ops_record_documents(p_job_id uuid, p_document_set jsonb)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.record_documents(p_job_id, p_document_set);
$$;

revoke all on function public.ops_record_documents(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ops_record_documents(uuid, jsonb) to service_role;

-- Only a proof copy may be deleted; a real job may not.
create or replace function ops.delete_proof_copy(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
begin
  select * into v_job from ops.jobs where id = p_job_id;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.is_proof_copy is not true then
    return jsonb_build_object('ok', false, 'code', 'OPS_NOT_PROOF_COPY',
      'message', 'Only a throwaway proof copy may be deleted.');
  end if;

  delete from ops.jobs where id = p_job_id;
  return jsonb_build_object('ok', true, 'deleted', p_job_id, 'files_deleted', true);
end;
$$;

revoke all on function ops.delete_proof_copy(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.delete_proof_copy(uuid, uuid, text) to service_role;

create or replace function public.ops_delete_proof_copy(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.delete_proof_copy(p_job_id, p_actor, p_actor_email);
$$;

revoke all on function public.ops_delete_proof_copy(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_delete_proof_copy(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Job list/detail carry the generated set and file kind, so the card and
--    the thread can show the same numbers and the download.
-- ---------------------------------------------------------------------------
create or replace function public.ops_jobs_list()
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object('ok', true, 'jobs', coalesce(
    (select jsonb_agg(to_jsonb(j) || jsonb_build_object(
      'counts', jsonb_build_object(
        'read', (select count(*) from ops.staged_rows s where s.job_id = j.id),
        'matched', (select count(*) from ops.staged_rows s where s.job_id = j.id and s.student_id is not null),
        'distinct', (select count(distinct s.student_id) from ops.staged_rows s where s.job_id = j.id and s.student_id is not null),
        'accepted', (select count(*) from ops.staged_rows s where s.job_id = j.id and s.status = 'accepted'),
        'need_eye', (select count(*) from ops.staged_rows s where s.job_id = j.id and s.status = 'pending'),
        'marks_pending', (select count(*) from ops.staged_marks m where m.job_id = j.id and m.status in ('ambiguous','rejected')),
        'proposals', (select count(*) from ops.pupil_proposals p where p.job_id = j.id)
      ),
      'files', coalesce((select jsonb_agg(jsonb_build_object(
          'id', f.id, 'filename', f.filename, 'byte_size', f.byte_size,
          'kind', f.kind, 'document_type', f.document_type, 'page_count', f.page_count,
          'sha256', f.sha256) order by f.created_at)
        from ops.job_files f where f.job_id = j.id), '[]'::jsonb)
    ) order by j.created_at desc) from ops.jobs j), '[]'::jsonb));
end;

revoke all on function public.ops_jobs_list() from public, anon, authenticated;
grant execute on function public.ops_jobs_list() to service_role;

create or replace function public.ops_jobs_get(p_id uuid)
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'job', to_jsonb(j),
    'roster', coalesce(
      (select rs.pupils from ops.roster_snapshots rs where rs.job_id = j.id),
      '[]'::jsonb
    ),
    'files', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'id', f.id, 'filename', f.filename, 'mime', f.mime,
          'byte_size', f.byte_size, 'sha256', f.sha256, 'created_at', f.created_at,
          'kind', f.kind, 'document_type', f.document_type, 'page_count', f.page_count
        ) order by f.created_at asc)
       from ops.job_files f where f.job_id = j.id),
      '[]'::jsonb
    ),
    'staged_rows', coalesce(
      (select jsonb_agg(to_jsonb(s) order by s.row_no) from ops.staged_rows s where s.job_id = j.id),
      '[]'::jsonb
    ),
    'marks', coalesce(
      (select jsonb_agg(to_jsonb(m) order by m.column_group, m.column_label, m.created_at)
         from ops.staged_marks m where m.job_id = j.id),
      '[]'::jsonb
    ),
    'pupil_proposals', coalesce(
      (select jsonb_agg(to_jsonb(p) order by p.created_at)
         from ops.pupil_proposals p where p.job_id = j.id),
      '[]'::jsonb
    ),
    'decisions', coalesce(
      (select jsonb_agg(to_jsonb(d) order by d.created_at desc) from ops.decisions d where d.job_id = j.id),
      '[]'::jsonb
    ),
    'audit', coalesce(
      (select jsonb_agg(to_jsonb(a) order by a.created_at desc) from ops.audit a where a.job_id = j.id),
      '[]'::jsonb
    )
  )
  from ops.jobs j
  where j.id = p_id;
end;

revoke all on function public.ops_jobs_get(uuid) from public, anon, authenticated;
grant execute on function public.ops_jobs_get(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Backfill the two real jobs. Use what the reader actually staged: the
--    subject on the rows and the printed column that carries the read marks.
-- ---------------------------------------------------------------------------
do $$
declare
  r              record;
  v_subject_key  text;
  v_subject_lab  text;
  v_column_label text;
  v_column_group text;
begin
  -- Leave the manual job exactly as it was: it has no reader rows to derive
  -- a subject or column from, and the pilot must not touch it.
  -- Only legacy jobs that predate this step. A job created after it already
  -- carries its frozen snapshot, and must not be re-derived here.
  for r in select * from ops.jobs
            where coalesce(adapter, '') <> 'manual'
              and config_snapshot is null
  loop
    select subject_key, subject_label into v_subject_key, v_subject_lab
      from ops.staged_rows
     where job_id = r.id and subject_key is not null
     group by subject_key, subject_label
     order by count(*) desc
     limit 1;

    select column_label, column_group into v_column_label, v_column_group
      from ops.staged_marks
     where job_id = r.id and status = 'read' and value is not null
     group by column_label, column_group
     order by count(*) desc
     limit 1;

    perform ops.freeze_job_config(r.id, jsonb_build_object(
      'class_key', r.class_key,
      'class_label', (select config -> 'depts' -> r.class_key ->> 'label' from public.app_config where id = 1),
      'subject', v_subject_lab,
      'subject_label', v_subject_lab,
      'subject_key', v_subject_key,
      'column_label', coalesce(v_column_label, 'CLASS EXERCISE'),
      'column_group', coalesce(v_column_group, upper(coalesce(r.term, '1ST TERM'))),
      'term', r.term,
      'academic_session', r.academic_session
    ));
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
