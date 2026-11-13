-- Pilot step 3: the OpenBot agent becomes a real provider in the chain, and a
-- worker can claim a queued job, stage contract-valid rows, and finish it.
--
-- ADDITIVE: new provider row, two additive columns on ops.staged_rows, new
-- functions in ops, and new public wrappers for service_role only. No
-- school-loaded file or table is touched. No live writes.
--
-- Reversal is still one statement:  drop schema if exists ops cascade;
--
-- The worker never invents a pupil. It reads a name and, at most, proposes an
-- admission number. Student resolution happens here, against the frozen class
-- list for that job, so a later roster change cannot change the result.

begin;

-- ---------------------------------------------------------------------------
-- 1. Provider row. Lowest priority runs first; Manual stays at 1000 as the
--    floor. No key_ref: the agent is the local OpenBot teammate, not an API.
-- ---------------------------------------------------------------------------
insert into ops.providers (label, kind, adapter, model, key_ref, priority, enabled)
values ('OpenBot agent', 'agent', 'openbot_agent', null, null, 10, true)
on conflict (label) do update
   set kind       = 'agent',
       adapter    = 'openbot_agent',
       priority   = 10,
       enabled    = true,
       updated_at = now();

-- What the reader could not settle. Status 'pending' is still the gate; the
-- flag carries the reason so the review screen can say why.
alter table ops.staged_rows add column if not exists candidate_admno text;
alter table ops.staged_rows add column if not exists flag text;

comment on column ops.staged_rows.candidate_admno is
  'Admission number the reader suggests but did not accept. Resolved only against the job roster snapshot.';
comment on column ops.staged_rows.flag is
  'Why a line is waiting for a human: near_match, no_confident_match, ambiguous, admno_not_in_snapshot.';

-- ---------------------------------------------------------------------------
-- 2. Queue a job for a worker. Upload already set status = queued; this
--    records which adapter owns it and leaves a worker-readable audit line.
-- ---------------------------------------------------------------------------
create or replace function ops.queue_for_worker(p_job_id uuid, p_adapter text)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
begin
  update ops.jobs
     set adapter    = coalesce(nullif(btrim(p_adapter), ''), adapter),
         last_error = null,
         updated_at = now()
   where id = p_job_id
     and status = 'queued'
   returning * into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_QUEUED');
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, 'intake',
          'job.queued_for_worker', 'ops.jobs', v_job.id,
          jsonb_build_object('adapter', v_job.adapter, 'status', v_job.status));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

revoke all on function ops.queue_for_worker(uuid, text) from public, anon, authenticated;
grant execute on function ops.queue_for_worker(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Worker step audit. Fenced by worker label and attempt, so a worker whose
--    lease expired cannot write into a job another worker now owns.
-- ---------------------------------------------------------------------------
create or replace function ops.worker_event(
  p_job_id uuid,
  p_worker text,
  p_attempt integer,
  p_action text,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job    ops.jobs;
  v_action text := left(coalesce(nullif(btrim(p_action), ''), 'step'), 80);
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status <> 'processing'
     or v_job.claimed_by is distinct from p_worker
     or v_job.attempts <> p_attempt then
    return jsonb_build_object('ok', false, 'code', 'OPS_CLAIM_LOST');
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, p_worker,
          'worker.' || v_action, 'ops.jobs', v_job.id,
          v_detail || jsonb_build_object('attempt', p_attempt));

  return jsonb_build_object('ok', true, 'action', v_action, 'attempt', p_attempt);
end;
$$;

revoke all on function ops.worker_event(uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function ops.worker_event(uuid, text, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Finish a claimed job: replace its staged rows with the reader's
--    contract-valid output, resolve pupils against the frozen snapshot, then
--    move to needs_input (some lines need a human) or needs_review (none do).
--
--    Fencing: the job must still be processing, claimed by this worker, at
--    this attempt. Otherwise nothing is written.
-- ---------------------------------------------------------------------------
create or replace function ops.finish_job(
  p_job_id uuid,
  p_worker text,
  p_attempt integer,
  p_rows jsonb,
  p_adapter text default 'openbot_agent',
  p_model text default null,
  p_contract_version text default '1.0.0',
  p_response_hash text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
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
      nullif(btrim(coalesce(v_row->>'subject_key', '')), ''),
      nullif(btrim(coalesce(v_row->>'subject_label', '')), ''),
      v_component, v_value, v_conf, v_status_row, v_flag
    );
  end loop;

  select count(distinct student_id) into v_distinct
    from ops.staged_rows
   where job_id = p_job_id and student_id is not null;

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
                             'distinct', v_distinct));

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
      'snapshot', v_job.roster_snapshot_count
    )
  );
end;
$$;

revoke all on function ops.finish_job(uuid, text, integer, jsonb, text, text, text, text, text) from public, anon, authenticated;
grant execute on function ops.finish_job(uuid, text, integer, jsonb, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. A worker that fails three times hands the job to Manual instead of
--    leaving it owned by an adapter nobody is running.
-- ---------------------------------------------------------------------------
create or replace function ops.fail_job(p_job_id uuid, p_worker text, p_error text)
returns ops.jobs
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
begin
  update ops.jobs
     set status      = case when attempts >= 3 then 'needs_input' else 'queued' end,
         claimed_by  = null,
         claimed_at  = null,
         lease_until = null,
         last_error  = left(coalesce(nullif(btrim(p_error), ''), 'worker failed'), 2000),
         adapter     = case when attempts >= 3 then 'manual' else adapter end,
         updated_at  = now()
   where id = p_job_id
     and status = 'processing'
     and claimed_by = p_worker
   returning * into v_job;

  if v_job.id is null then
    return null;
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, p_worker,
          'job.failed', 'ops.jobs', v_job.id,
          jsonb_build_object('status', v_job.status, 'attempt', v_job.attempts,
                             'error', v_job.last_error, 'adapter', v_job.adapter));

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public wrappers. Service_role only, same rule as every other door.
-- ---------------------------------------------------------------------------
create or replace function public.ops_queue_for_worker(p_job_id uuid, p_adapter text)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.queue_for_worker(p_job_id, p_adapter);
end;

create or replace function public.ops_worker_event(
  p_job_id uuid, p_worker text, p_attempt integer, p_action text, p_detail jsonb default '{}'::jsonb
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.worker_event(p_job_id, p_worker, p_attempt, p_action, p_detail);
end;

create or replace function public.ops_finish_job(
  p_job_id uuid, p_worker text, p_attempt integer, p_rows jsonb,
  p_adapter text default 'openbot_agent', p_model text default null,
  p_contract_version text default '1.0.0', p_response_hash text default null,
  p_reason text default null
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.finish_job(p_job_id, p_worker, p_attempt, p_rows, p_adapter, p_model,
                        p_contract_version, p_response_hash, p_reason);
end;

revoke all on function public.ops_queue_for_worker(uuid, text) from public, anon, authenticated;
revoke all on function public.ops_worker_event(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.ops_finish_job(uuid, text, integer, jsonb, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_queue_for_worker(uuid, text) to service_role;
grant execute on function public.ops_worker_event(uuid, text, integer, text, jsonb) to service_role;
grant execute on function public.ops_finish_job(uuid, text, integer, jsonb, text, text, text, text, text) to service_role;

commit;
