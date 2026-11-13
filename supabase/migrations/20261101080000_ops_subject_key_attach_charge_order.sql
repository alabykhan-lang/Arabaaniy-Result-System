-- Subject key on every staged row, a pupil picker for C rows, and documents
-- readiness before any credit is taken.
--
-- 1. finish_job stamps a single-subject job's subject key on every row, so
--    staged rows carry it end to end and OPS_SUBJECT_EMPTY cannot fire on a
--    job whose marks were read. Existing rows are backfilled the same way.
--    document_readiness records the row/subject counts on the job whenever it
--    refuses, so a false refusal is provable from the job itself.
-- 2. ops.attach_row attaches one frozen-roster pupil to one staged row, one
--    pupil per job, without leaving the job.
-- 3. confirm_job runs every readiness check before approving or charging. A
--    job that would refuse documents is never charged.
--
-- No matcher change, no new adapter, no school table write, live_write false.

begin;

alter table ops.jobs
  add column if not exists last_readiness jsonb;

-- ---------------------------------------------------------------------------
-- 1a. finish_job stamps the job's only subject on every staged row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.finish_job(p_job_id uuid, p_worker text, p_attempt integer, p_rows jsonb, p_adapter text DEFAULT 'openbot_agent'::text, p_model text DEFAULT NULL::text, p_contract_version text DEFAULT '1.0.0'::text, p_response_hash text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public', 'pg_temp'
AS $function$
declare
  v_job        ops.jobs;
  v_row        jsonb;
  v_count      integer := 0;
  v_pending    integer := 0;
  v_accepted   integer := 0;
  v_matched    integer := 0;
  v_distinct   integer := 0;
  v_status     text;
  v_sid        uuid;
  v_admno      text;
  v_candidate  text;
  v_raw        text;
  v_flag       text;
  v_conf       numeric;
  v_component  text;
  v_value      numeric;
  v_method     text;
  v_status_row text;
  v_subject_key text;
  v_subject_label text;
  v_with_subject integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROWS_INVALID');
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROWS_EMPTY');
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROWS_TOO_MANY');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status <> 'processing'
     or v_job.claimed_by is distinct from p_worker
     or v_job.attempts <> p_attempt then
    return jsonb_build_object('ok', false, 'code', 'OPS_CLAIM_LOST');
  end if;

  -- A single-subject job stamps that subject on every row here, so the key
  -- survives staging even when a reader does not send it per row.
  if jsonb_array_length(coalesce(v_job.subject_set, '[]'::jsonb)) = 1 then
    v_subject_key   := v_job.subject_set -> 0 ->> 'key';
    v_subject_label := v_job.subject_set -> 0 ->> 'label';
  end if;

  -- A retry replaces the previous partial attempt, never adds to it.
  delete from ops.staged_rows where job_id = p_job_id;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_count     := v_count + 1;
    v_raw       := left(coalesce(v_row->>'name_raw', ''), 300);
    v_admno     := nullif(btrim(coalesce(v_row->>'admno', '')), '');
    v_candidate := nullif(btrim(coalesce(v_row->>'candidate_admno', '')), '');
    v_flag      := nullif(btrim(coalesce(v_row->>'flag', '')), '');
    v_conf      := nullif(btrim(coalesce(v_row->>'confidence', '')), '')::numeric;
    v_component := coalesce(nullif(btrim(v_row->>'component'), ''), 'ca1');
    if v_component not in ('ca1', 'ca2', 'ca3', 'exam') then
      v_component := 'ca1';
    end if;
    v_value := nullif(btrim(coalesce(v_row->>'value', '')), '')::numeric;

    v_sid := null;
    v_method := 'none';
    v_status_row := 'pending';

    if v_admno is not null then
      select (p->>'id')::uuid into v_sid
        from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
       where rs.job_id = p_job_id
         and upper(p->>'admno') = upper(v_admno)
       limit 1;
      if v_sid is not null then
        v_method := 'admno';
        if v_flag is null then
          v_status_row := 'accepted';
        else
          v_flag := coalesce(v_flag, 'low_confidence');
        end if;
      else
        v_flag := coalesce(v_flag, 'admno_not_in_snapshot');
      end if;
    elsif v_candidate is not null then
      select (p->>'id')::uuid into v_sid
        from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
       where rs.job_id = p_job_id
         and upper(p->>'admno') = upper(v_candidate)
       limit 1;
      if v_sid is not null then
        v_method := 'name';
        v_flag := coalesce(v_flag, 'near_match');
      end if;
    end if;

    if v_status_row = 'accepted' then
      v_accepted := v_accepted + 1;
      v_conf := coalesce(v_conf, 1.0);
    else
      v_pending := v_pending + 1;
    end if;
    if v_sid is not null then
      v_matched := v_matched + 1;
    end if;

    insert into ops.staged_rows (
      job_id, row_no, student_id, admno, candidate_admno, student_name_raw,
      match_method, match_confidence, subject_key, subject_label,
      component, value, confidence, status, flag
    ) values (
      p_job_id,
      case when (v_row->>'row_no') ~ '^[0-9]+$' then (v_row->>'row_no')::integer else v_count end,
      v_sid, v_admno, v_candidate, v_raw,
      v_method, v_conf,
      coalesce(nullif(btrim(coalesce(v_row->>'subject_key', '')), ''), v_subject_key),
      coalesce(nullif(btrim(coalesce(v_row->>'subject_label', '')), ''), v_subject_label),
      v_component, v_value, v_conf, v_status_row, v_flag
    );
  end loop;

  select count(distinct student_id) into v_distinct
    from ops.staged_rows
   where job_id = p_job_id and student_id is not null;

  select count(*) into v_with_subject
    from ops.staged_rows
   where job_id = p_job_id and subject_key is not null;

  v_status := case when v_pending > 0 then 'needs_input' else 'needs_review' end;

  update ops.jobs
     set status           = v_status,
         claimed_by       = null,
         claimed_at       = null,
         lease_until      = null,
         last_error       = left(coalesce(nullif(btrim(p_reason), ''),
                                  case when v_pending > 0
                                       then v_pending || ' lines need a human'
                                       else null end), 2000),
         adapter          = coalesce(nullif(btrim(p_adapter), ''), adapter),
         model            = coalesce(p_model, model),
         contract_version = coalesce(p_contract_version, contract_version),
         response_hash    = coalesce(p_response_hash, response_hash),
         updated_at       = now()
   where id = p_job_id
   returning * into v_job;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, p_worker,
          'worker.rows_staged', 'ops.staged_rows', v_job.id,
          jsonb_build_object('attempt', p_attempt, 'adapter', v_job.adapter,
                             'contract_version', v_job.contract_version,
                             'read', v_count, 'accepted', v_accepted,
                             'need_eye', v_pending, 'matched', v_matched,
                             'distinct', v_distinct, 'rows_with_subject_key', v_with_subject));

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, p_worker,
          'job.finished', 'ops.jobs', v_job.id,
          jsonb_build_object('status', v_job.status, 'read', v_count,
                             'accepted', v_accepted, 'need_eye', v_pending,
                             'matched', v_matched, 'distinct', v_distinct));

  return jsonb_build_object(
    'ok', true,
    'status', v_job.status,
    'counts', jsonb_build_object(
      'read', v_count, 'accepted', v_accepted, 'need_eye', v_pending,
      'matched', v_matched, 'distinct', v_distinct,
      'rows_with_subject_key', v_with_subject,
      'snapshot', v_job.roster_snapshot_count
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1b. Backfill the jobs that were staged before the reader sent the key.
-- ---------------------------------------------------------------------------

update ops.staged_rows r
   set subject_key = j.subject_set -> 0 ->> 'key',
       subject_label = j.subject_set -> 0 ->> 'label',
       updated_at = now()
  from ops.jobs j
 where r.job_id = j.id
   and r.subject_key is null
   and jsonb_array_length(coalesce(j.subject_set, '[]'::jsonb)) = 1
   and nullif(btrim(coalesce(j.subject_set -> 0 ->> 'key', '')), '') is not null;

-- ---------------------------------------------------------------------------
-- 1c. readiness records what it saw whenever it refuses.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.document_readiness(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public', 'pg_temp'
AS $function$
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
  v_rows_total     integer := 0;
  v_rows_with_subject integer := 0;
  v_row_subject_keys jsonb := '[]'::jsonb;
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

  -- How many staged rows actually carry a subject key. This is recorded with
  -- any refusal so a false OPS_SUBJECT_EMPTY can be proved from the job.
  select count(*),
         count(*) filter (where r.subject_key is not null),
         coalesce(jsonb_agg(distinct r.subject_key) filter (where r.subject_key is not null), '[]'::jsonb)
    into v_rows_total, v_rows_with_subject, v_row_subject_keys
    from ops.staged_rows r
   where r.job_id = p_job_id;

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
        'subject_label', v_subject.value ->> 'label',
        'rows_total', v_rows_total,
        'rows_with_subject_key', v_rows_with_subject,
        'row_subject_keys', v_row_subject_keys,
        'job_subject_key', v_job.subject_set -> 0 ->> 'key'
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
    -- The job keeps the last refusal and the row/subject counts it saw. The
    -- evidence is on the job, not only in the response.
    update ops.jobs
       set last_readiness = jsonb_build_object(
             'ok', false,
             'checked_at', now(),
             'code', v_refusals -> 0 ->> 'code',
             'rows_total', v_rows_total,
             'rows_with_subject_key', v_rows_with_subject,
             'row_subject_keys', v_row_subject_keys,
             'refusals', v_refusals),
           updated_at = now()
     where id = p_job_id;

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
$function$;

-- ---------------------------------------------------------------------------
-- 2. Attach one frozen-roster pupil to one staged row.
-- ---------------------------------------------------------------------------

create or replace function ops.attach_row(
  p_job_id uuid,
  p_staged_row_id uuid,
  p_student_id uuid,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job        ops.jobs;
  v_row        ops.staged_rows;
  v_name       text;
  v_admno      text;
  v_other_no   integer;
  v_pending    integer;
  v_counts     jsonb;
  v_portal     integer;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  select * into v_row from ops.staged_rows
   where id = p_staged_row_id and job_id = p_job_id
   for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROW_NOT_FOUND');
  end if;

  select p ->> 'name', p ->> 'admno'
    into v_name, v_admno
    from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
   where rs.job_id = p_job_id
     and (p ->> 'id')::uuid = p_student_id
   limit 1;
  if nullif(btrim(coalesce(v_name, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_PUPIL_NOT_IN_CLASS',
                              'message', 'That pupil is not in this class list.');
  end if;

  select row_no into v_other_no
    from ops.staged_rows
   where job_id = p_job_id
     and id <> p_staged_row_id
     and student_id = p_student_id
     and status <> 'rejected'
   order by row_no
   limit 1;
  if v_other_no is not null then
    return jsonb_build_object('ok', false, 'code', 'OPS_PUPIL_ALREADY_ATTACHED',
                              'message', 'That pupil is already attached to line ' || v_other_no || '.',
                              'row_no', v_other_no);
  end if;

  update ops.staged_rows
     set student_id = p_student_id,
         admno = v_admno,
         candidate_admno = null,
         candidate_names = jsonb_build_array(v_name),
         match_method = 'manual',
         match_confidence = 1,
         surname_score = null,
         first_score = null,
         confidence = coalesce(confidence, 1),
         flag = null,
         match_list = 'B',
         status = 'accepted',
         updated_at = now()
   where id = p_staged_row_id
   returning * into v_row;

  select count(*) into v_pending
    from ops.staged_rows
   where job_id = p_job_id and status = 'pending';

  v_portal := case
    when jsonb_typeof(v_job.alignment -> 'portal_only') = 'array'
      then jsonb_array_length(v_job.alignment -> 'portal_only')
    else coalesce((v_job.alignment -> 'counts' ->> 'D')::integer, 0)
  end;

  v_counts := jsonb_build_object(
    'A', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'A'),
    'B', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'B'),
    'C', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'C'),
    'D', v_portal,
    'pending', v_pending
  );

  update ops.jobs
     set status = case when v_pending > 0 then 'needs_input' else 'needs_review' end,
         last_error = case when v_pending > 0 then v_pending || ' lines need a human' else null end,
         alignment = jsonb_set(coalesce(alignment, '{}'::jsonb), '{counts}', v_counts, true),
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'staged_row.attach', 'ops.staged_rows', p_staged_row_id,
          jsonb_build_object('row_no', v_row.row_no, 'page', v_row.student_name_raw,
                             'pupil', v_name, 'admno', v_admno,
                             'from_list', 'C', 'to_list', 'B', 'live_write', false));

  return jsonb_build_object('ok', true, 'staged_row', to_jsonb(v_row), 'counts', v_counts);
end;
$$;

revoke all on function ops.attach_row(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.attach_row(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public.ops_attach_row(
  p_job_id uuid,
  p_staged_row_id uuid,
  p_student_id uuid,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.attach_row(p_job_id, p_staged_row_id, p_student_id, p_actor, p_actor_email);
$$;

revoke all on function public.ops_attach_row(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_attach_row(uuid, uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Approval refuses before it charges when the documents would refuse.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.confirm_job(p_job_id uuid, p_actor uuid, p_actor_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public', 'pg_temp'
AS $function$
declare
  v_job      ops.jobs;
  v_total    integer;
  v_pending  integer;
  v_accepted integer;
  v_marks    integer;
  v_decision ops.decisions;
  v_charge   jsonb;
  v_ready    jsonb;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  select count(*),
         count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'accepted')
    into v_total, v_pending, v_accepted
    from ops.staged_rows
   where job_id = p_job_id;

  select count(*) into v_marks
    from ops.staged_marks
   where job_id = p_job_id and status in ('ambiguous', 'rejected');

  if v_total = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_NOTHING_TO_APPROVE');
  end if;
  if v_pending > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROWS_PENDING',
                              'pending', v_pending, 'total', v_total);
  end if;
  if v_marks > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARKS_PENDING', 'marks', v_marks);
  end if;
  if v_accepted = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_NO_ACCEPTED_ROWS');
  end if;

  -- Every readiness check runs here, before the job is approved and before
  -- any credit is taken. A job that cannot make its documents is never
  -- charged; the whole function is one transaction.
  v_ready := ops.document_readiness(p_job_id);
  if coalesce((v_ready ->> 'ok')::boolean, false) is not true then
    return jsonb_build_object(
      'ok', false,
      'code', coalesce(v_ready ->> 'code', 'OPS_DOCUMENTS_REFUSED'),
      'message', coalesce(v_ready -> 'refusals' -> 0 ->> 'message',
                          'This job is not ready for documents.'),
      'refusals', coalesce(v_ready -> 'refusals', '[]'::jsonb),
      'live_write', false);
  end if;

  update ops.jobs
     set status = 'approved', updated_at = now()
   where id = p_job_id
   returning * into v_job;

  insert into ops.decisions (job_id, staged_row_id, decision, decided_by, decided_by_email, note, payload)
  values (p_job_id, null, 'approve', p_actor, p_actor_email,
          'Job approved inside ops. Live publication is disabled in this pilot.',
          jsonb_build_object('accepted_rows', v_accepted, 'total_rows', v_total))
  returning * into v_decision;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'job.approved', 'ops.jobs', p_job_id,
          jsonb_build_object('accepted_rows', v_accepted, 'total_rows', v_total,
                             'public_write', false));

  v_charge := ops.charge_job(p_job_id, p_actor, p_actor_email);

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'decision', to_jsonb(v_decision),
                            'charge', v_charge, 'live_write', false);
end;
$function$;

commit;
