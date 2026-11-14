-- The developer account is not school staff, so the developer's own approvals
-- must not use the school's credit allowance or show up in the staff usage
-- figures. The job still gets one ledger row, at zero credits, so the unique
-- job_id guard stays intact and the history can mark it "developer".
--
-- This replaces ops.charge_job with the same body plus a developer branch that
-- runs before any price or plan lookup.
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
  v_developer  boolean := false;
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

  -- A developer approval is recorded at zero credits and leaves the balance
  -- alone. is_developer is the flag; the role check covers older rows.
  select coalesce(p.is_developer, p.role = 'developer', false)
    into v_developer
    from public.staff_profiles p
   where p.id = p_actor;

  if coalesce(v_developer, false) then
    select coalesce((ops.credit_balance(v_job.school_id)->>'remaining')::integer, 0) into v_balance;
    insert into ops.credit_ledger (
      job_id, school_id, plan_id, work_type, credits, balance_after, charged_at
    ) values (
      p_job_id, v_job.school_id, null, v_work_type, 0, v_balance, now()
    )
    on conflict (job_id) do nothing
    returning * into v_charge;

    if v_charge.id is null then
      select * into v_charge from ops.credit_ledger where job_id = p_job_id;
      return jsonb_build_object('ok', true, 'charged', false, 'developer', true,
        'already_charged', true, 'charge', to_jsonb(v_charge),
        'balance', ops.credit_balance(v_job.school_id));
    end if;

    insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
    values (p_job_id, p_actor, p_actor_email, 'job.charged', 'ops.credit_ledger', v_charge.id,
            jsonb_build_object('work_type', v_work_type, 'credits', 0,
                               'balance_after', v_charge.balance_after,
                               'school_id', v_job.school_id, 'developer', true,
                               'public_write', false));

    return jsonb_build_object('ok', true, 'charged', false, 'developer', true,
      'already_charged', false, 'charge', to_jsonb(v_charge),
      'balance', ops.credit_balance(v_job.school_id));
  end if;

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
