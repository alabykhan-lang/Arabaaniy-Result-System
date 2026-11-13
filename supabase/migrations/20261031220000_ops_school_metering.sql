-- Pilot step 6b: bind every new job to its school, and make the money path
-- refuse instead of guessing.
--
-- ADDITIVE. No school table is altered. The public wrappers keep their names
-- and service-role grants. Reversal is still: drop schema if exists ops cascade;
--
-- Rules enforced here:
--   * a new job must carry an explicit, active school id; no null, no lookup
--   * a plan is found by exact school id only; a missing school id or a school
--     with no active plan returns no plan, never the earliest plan
--   * a job with no school cannot be charged
--   * a refused charge writes no ledger row
--   * balance_after is clamped at zero and the table refuses negative values

begin;

-- ---------------------------------------------------------------------------
-- 1. No fallback. A plan is the plan of this school, or there is no plan.
-- ---------------------------------------------------------------------------
create or replace function ops.current_plan(p_school_id uuid default null)
returns ops.school_plans
language sql
stable
security definer
set search_path = ops, public, pg_temp
as $$
  select p.*
    from ops.school_plans p
   where p_school_id is not null
     and p.school_id = p_school_id
     and p.status in ('pilot', 'active')
   order by p.created_at asc
   limit 1;
$$;

revoke all on function ops.current_plan(uuid) from public, anon, authenticated;
grant execute on function ops.current_plan(uuid) to service_role;

-- The balance now names the school it belongs to, so a caller can see that no
-- other school's plan was used.
create or replace function ops.credit_balance(p_school_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_plan ops.school_plans;
  v_used integer := 0;
begin
  select * into v_plan from ops.current_plan(p_school_id);

  if v_plan.id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_NO_PLAN',
      'school_id', p_school_id,
      'used', 0,
      'remaining', 0,
      'plan', null
    );
  end if;

  select coalesce(sum(l.credits), 0)
    into v_used
    from ops.credit_ledger l
   where l.plan_id = v_plan.id
     and l.charged_at >= v_plan.period_start;

  return jsonb_build_object(
    'ok', true,
    'school_id', v_plan.school_id,
    'used', v_used,
    'remaining', greatest(0, v_plan.credits_per_period - v_used),
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'school_id', v_plan.school_id,
      'name', v_plan.name,
      'credits_per_period', v_plan.credits_per_period,
      'period_start', v_plan.period_start,
      'status', v_plan.status,
      'is_placeholder', v_plan.is_placeholder,
      'note', v_plan.note
    )
  );
end;
$$;

revoke all on function ops.credit_balance(uuid) from public, anon, authenticated;
grant execute on function ops.credit_balance(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. A job is created under one explicit school. A missing or inactive school
--    is refused before any row exists.
-- ---------------------------------------------------------------------------
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
  v_job    ops.jobs;
  v_count  integer := null;
  v_school integer := 0;
begin
  if p_school_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_SCHOOL_REQUIRED',
      'message', 'This job needs a school before it can be saved, so nothing was created.'
    );
  end if;

  select count(*) into v_school
    from public.school_accounts s
   where s.id = p_school_id and s.active;

  if v_school = 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_SCHOOL_NOT_ACTIVE',
      'message', 'That school is not active, so nothing was created.'
    );
  end if;

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
                             'school_id', v_job.school_id,
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
-- 3. A charge needs the job's own school. No school means no charge, and no
--    plan for that school means no charge. Both return before the insert.
-- ---------------------------------------------------------------------------
create or replace function ops.charge_job(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job        ops.jobs;
  v_plan       ops.school_plans;
  v_work_type  text;
  v_price      ops.work_types;
  v_marks      integer := 0;
  v_existing   ops.credit_ledger;
  v_charge     ops.credit_ledger;
  v_used       integer := 0;
  v_balance    integer := 0;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  if v_job.school_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_JOB_NO_SCHOOL',
      'message', 'This job has no school, so I cannot charge it. No credits were taken.'
    );
  end if;

  if v_job.status not in ('approved', 'applied') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FINISHED',
      'message', 'A job is charged only when it reaches a finished state.');
  end if;

  select * into v_existing from ops.credit_ledger where job_id = p_job_id;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'charged', false, 'already_charged', true,
      'charge', to_jsonb(v_existing),
      'balance', ops.credit_balance(v_job.school_id));
  end if;

  select count(*) into v_marks
    from ops.staged_marks
   where job_id = p_job_id and status = 'read' and value is not null;

  v_work_type := case
    when v_job.document_set is not null then 'names_marks_documents'
    when v_marks > 0 then 'names_marks'
    else 'names'
  end;

  select * into v_price from ops.work_types where key = v_work_type and active;
  if v_price.key is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_WORK_TYPE_MISSING',
      'message', 'No active price row for this work type. No credits were taken.');
  end if;

  select * into v_plan from ops.current_plan(v_job.school_id);
  if v_plan.id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_NO_PLAN',
      'message', 'This school has no active plan, so I cannot charge this job. No credits were taken and the finished work is not lost.'
    );
  end if;

  if v_plan.school_id <> v_job.school_id then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_PLAN_SCHOOL_MISMATCH',
      'message', 'The plan does not belong to this job''s school, so I cannot charge it. No credits were taken.'
    );
  end if;

  -- Serialise charges on the same plan so two approvals at once cannot write
  -- the same balance_after. The ledger's unique job_id is still what makes a
  -- second charge for one job impossible.
  perform 1 from ops.school_plans where id = v_plan.id for update;

  select coalesce(sum(l.credits), 0)
    into v_used
    from ops.credit_ledger l
   where l.plan_id = v_plan.id
     and l.charged_at >= v_plan.period_start;

  v_balance := greatest(0, v_plan.credits_per_period - (v_used + v_price.credits));

  insert into ops.credit_ledger (
    job_id, school_id, plan_id, work_type, credits, balance_after, charged_at
  ) values (
    p_job_id, v_plan.school_id, v_plan.id, v_work_type, v_price.credits, v_balance, now()
  )
  on conflict (job_id) do nothing
  returning * into v_charge;

  if v_charge.id is null then
    select * into v_charge from ops.credit_ledger where job_id = p_job_id;
    return jsonb_build_object('ok', true, 'charged', false, 'already_charged', true,
      'charge', to_jsonb(v_charge),
      'balance', ops.credit_balance(v_job.school_id));
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'job.charged', 'ops.credit_ledger', v_charge.id,
          jsonb_build_object('work_type', v_work_type, 'credits', v_price.credits,
                             'balance_after', v_balance, 'plan_id', v_plan.id,
                             'school_id', v_job.school_id,
                             'placeholder_price', v_price.is_placeholder,
                             'public_write', false));

  return jsonb_build_object('ok', true, 'charged', true, 'already_charged', false,
    'charge', to_jsonb(v_charge),
    'balance', ops.credit_balance(v_job.school_id));
end;
$$;

revoke all on function ops.charge_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.charge_job(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. A proof copy inherits its source's school. A source with no school is
--    refused, because the copy would have no plan to charge.
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

  if v_src.school_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_JOB_NO_SCHOOL',
      'message', 'The source job has no school, so a copy cannot be charged. Nothing was copied.'
    );
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

notify pgrst, 'reload schema';

commit;
