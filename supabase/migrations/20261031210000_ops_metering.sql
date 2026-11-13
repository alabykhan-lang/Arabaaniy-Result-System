-- Pilot step 6: metering.
--
-- ADDITIVE. Everything lives in schema ops, plus replacements for the pilot's
-- own public wrappers (same names and service-role grants). No school table is
-- touched. No payment provider, no card handling, no invoicing.
--
-- One charge per finished job, enforced by a unique key on the ledger, never by
-- API code. A retry is free because the insert is idempotent. A job parked at
-- needs_input never reaches the charge point.
--
-- Reversal is still one statement:  drop schema if exists ops cascade;

begin;

-- ---------------------------------------------------------------------------
-- 1. Work types are rows, not constants. The credit values are placeholders
--    until the school sets them.
-- ---------------------------------------------------------------------------
create table if not exists ops.work_types (
  key            text primary key,
  label          text not null,
  credits        integer not null check (credits >= 0),
  active         boolean not null default true,
  is_placeholder boolean not null default true,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table ops.work_types is
  'Price list as data. Change a credit value here and every later charge uses it; no deploy.';
comment on column ops.work_types.is_placeholder is
  'True until the school sets a real price. The pilot seeds are placeholders, not prices.';

insert into ops.work_types (key, label, credits, active, is_placeholder, note) values
  ('names', 'Names only', 1, true, true,
   'Placeholder credit value, not a real price. Set by the school.'),
  ('names_marks', 'Names plus marks', 2, true, true,
   'Placeholder credit value, not a real price. Set by the school.'),
  ('names_marks_documents', 'Names plus marks plus documents', 3, true, true,
   'Placeholder credit value, not a real price. Set by the school.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. One plan row per school. The pilot seeds First Choice as a pilot plan.
-- ---------------------------------------------------------------------------
create table if not exists ops.school_plans (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null unique references public.school_accounts(id) on delete cascade,
  name                text not null,
  credits_per_period  integer not null check (credits_per_period >= 0),
  period_start        timestamptz not null default date_trunc('month', now()),
  status              text not null default 'pilot'
                      check (status in ('pilot', 'active', 'paused', 'ended')),
  is_placeholder      boolean not null default true,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table ops.school_plans is
  'One plan per school. Accounting only: no card, no invoice, no payment provider.';
comment on column ops.school_plans.credits_per_period is
  'Credits available from period_start. The pilot value is a labelled placeholder.';

insert into ops.school_plans (school_id, name, credits_per_period, period_start, status, is_placeholder, note)
select s.id, 'First Choice pilot', 250, date_trunc('month', now()), 'pilot', true,
       'Placeholder plan for the pilot. 250 credits per period is not a real price.'
  from public.school_accounts s
 where lower(s.name) = lower('First Choice Standard Schools')
on conflict (school_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The ledger. job_id is unique: the database, not the API, makes a second
--    charge for the same job impossible.
-- ---------------------------------------------------------------------------
create table if not exists ops.credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null unique references ops.jobs(id) on delete cascade,
  school_id     uuid references public.school_accounts(id) on delete set null,
  plan_id       uuid references ops.school_plans(id) on delete set null,
  work_type     text not null references ops.work_types(key),
  credits       integer not null check (credits >= 0),
  balance_after integer not null check (balance_after >= 0),
  charged_at    timestamptz not null default now()
);

comment on table ops.credit_ledger is
  'One row per charge. The unique job_id constraint is the double-charge guard.';
comment on column ops.credit_ledger.balance_after is
  'Credits left immediately after this charge, so the finished card can say "Used X credits · Y left" without recalculation.';

create index if not exists credit_ledger_charged_idx
  on ops.credit_ledger (plan_id, charged_at desc);

-- ---------------------------------------------------------------------------
-- 4. Read the active plan and its balance. A charge is counted against the
--    plan period it falls in.
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
   where p.status in ('pilot', 'active')
     and (p_school_id is null or p.school_id = p_school_id)
   order by (p.school_id = p_school_id) desc nulls last, p.created_at asc
   limit 1;
$$;

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

create or replace function public.ops_credit_balance(p_school_id uuid default null)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.credit_balance(p_school_id);
$$;

revoke all on function public.ops_credit_balance(uuid) from public, anon, authenticated;
grant execute on function public.ops_credit_balance(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Charge once. Called only after a job has reached a finished state.
--    The insert is idempotent: a retry finds the existing row and adds none.
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
      'message', 'No active price row for this work type.');
  end if;

  select * into v_plan from ops.current_plan(v_job.school_id);
  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_NO_PLAN',
      'message', 'No active plan for this school. The job is finished but not charged.');
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
                             'placeholder_price', v_price.is_placeholder,
                             'public_write', false));

  return jsonb_build_object('ok', true, 'charged', true, 'already_charged', false,
    'charge', to_jsonb(v_charge),
    'balance', ops.credit_balance(v_job.school_id));
end;
$$;

revoke all on function ops.charge_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.charge_job(uuid, uuid, text) to service_role;

create or replace function public.ops_charge_job(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.charge_job(p_job_id, p_actor, p_actor_email);
$$;

revoke all on function public.ops_charge_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_charge_job(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Approval is the charge point. Parked jobs never reach it; a retry on an
--    approved job finds the ledger row and adds nothing.
-- ---------------------------------------------------------------------------
create or replace function ops.confirm_job(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job      ops.jobs;
  v_total    integer;
  v_pending  integer;
  v_accepted integer;
  v_marks    integer;
  v_decision ops.decisions;
  v_charge   jsonb;
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
$$;

revoke all on function ops.confirm_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.confirm_job(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Job list and detail carry the charge, so the finished card can say
--    "Used X credits · Y left" and the thread needs no second request.
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
        from ops.job_files f where f.job_id = j.id), '[]'::jsonb),
      'charge', (select jsonb_build_object(
          'work_type', l.work_type, 'credits', l.credits,
          'balance_after', l.balance_after, 'charged_at', l.charged_at)
        from ops.credit_ledger l where l.job_id = j.id)
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
    'job', to_jsonb(j) || jsonb_build_object(
      'charge', (select jsonb_build_object(
          'work_type', l.work_type, 'credits', l.credits,
          'balance_after', l.balance_after, 'charged_at', l.charged_at)
        from ops.credit_ledger l where l.job_id = j.id)
    ),
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

notify pgrst, 'reload schema';

commit;
