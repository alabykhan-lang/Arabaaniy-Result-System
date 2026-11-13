-- Agent-as-staff pilot, step 1: durable workers, providers and intake.
--
-- ADDITIVE ONLY for the school: everything lives in schema "ops", plus thin
-- public wrappers that are revoked from PUBLIC/anon/authenticated and granted
-- only to service_role. No public table, column, policy, function or trigger
-- that existed before the pilot is altered.
--
-- Reversal is still one statement:
--     drop schema if exists ops cascade;
-- The public wrappers depend on ops objects, so the cascade removes them too.
--
-- WORKER CONTRACT (see ops/README.md and ops-contract/v1/*.json)
-- A worker claims with:  select * from public.ops_claim_job('worker-name', 300);
-- The row is locked with FOR UPDATE SKIP LOCKED, so two workers cannot take the
-- same job. A lease is set; no heartbeat returns it to 'queued'. After three
-- attempts the job parks at 'needs_input' with last_error kept. Nothing is
-- silently dropped. The worker never needs OpenBot: any process with the
-- service-role key can call the same function.

begin;

-- ---------------------------------------------------------------------------
-- 1. Claim / lease / reproducibility columns on ops.jobs.
-- ---------------------------------------------------------------------------
alter table ops.jobs add column if not exists claimed_by      text;
alter table ops.jobs add column if not exists claimed_at      timestamptz;
alter table ops.jobs add column if not exists lease_until     timestamptz;
alter table ops.jobs add column if not exists attempts        integer not null default 0;
alter table ops.jobs add column if not exists last_error      text;
alter table ops.jobs add column if not exists adapter         text;
alter table ops.jobs add column if not exists model           text;
alter table ops.jobs add column if not exists contract_version text;
alter table ops.jobs add column if not exists response_hash   text;

comment on column ops.jobs.claimed_by is 'Worker label that holds the lease. Text, not a user id: a cron script or another agent can claim.';
comment on column ops.jobs.lease_until is 'Lease expiry. A missing heartbeat returns the job to queued.';
comment on column ops.jobs.attempts is 'Incremented on every claim. At three the job parks at needs_input, never dropped.';
comment on column ops.jobs.adapter is 'Reproducibility: adapter that produced this job output.';
comment on column ops.jobs.model is 'Reproducibility: model name reported by the adapter.';
comment on column ops.jobs.contract_version is 'Reproducibility: versioned JSON contract used at the boundary.';
comment on column ops.jobs.response_hash is 'Reproducibility: sha256 of the raw adapter response.';

-- Status vocabulary grows by one value: needs_input (parked for a human).
alter table ops.jobs drop constraint if exists jobs_status_check;
alter table ops.jobs add constraint jobs_status_check check (status in (
  'draft', 'queued', 'processing', 'needs_input', 'needs_review',
  'approved', 'applied', 'failed', 'cancelled'
));

create index if not exists ops_jobs_claim_idx on ops.jobs (status, created_at)
  where status in ('queued', 'processing');

-- ---------------------------------------------------------------------------
-- 2. Provider registry. Keys are referenced by name only.
-- ---------------------------------------------------------------------------
create table if not exists ops.providers (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,
  kind        text not null check (kind in ('agent', 'api', 'manual')),
  adapter     text not null,
  model       text,
  key_ref     text,
  priority    integer not null default 100,
  enabled     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table ops.providers is
  'Routing chain, lowest priority first. key_ref names a platform secret; no key material is ever stored here, in a job row, or in the school code.';
comment on column ops.providers.key_ref is
  'Secret name only, resolved by the platform secret store. Never the key itself.';

insert into ops.providers (label, kind, adapter, model, key_ref, priority, enabled)
values ('Manual (park for a human)', 'manual', 'manual', null, null, 1000, true)
on conflict (label) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Intake files. Bytes stay inside ops so dropping the schema removes them.
-- ---------------------------------------------------------------------------
create table if not exists ops.job_files (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references ops.jobs(id) on delete cascade,
  filename          text not null,
  mime              text not null,
  byte_size         integer not null,
  sha256            text not null,
  content           bytea not null,
  uploaded_by       uuid not null,
  uploaded_by_email text not null,
  created_at        timestamptz not null default now()
);

comment on table ops.job_files is
  'One intake photo per row, private to ops. A 3.5 MB server cap keeps the browser upload under the platform request limit.';

create index if not exists ops_job_files_job_idx on ops.job_files (job_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. Claim protocol.
-- ---------------------------------------------------------------------------
create or replace function ops.claim_job(p_worker text, p_lease_seconds integer default 300)
returns ops.jobs
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job   ops.jobs;
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
begin
  if coalesce(btrim(p_worker), '') = '' then
    raise exception 'OPS_WORKER_REQUIRED' using errcode = '22023';
  end if;

  -- Expired leases go back to the queue, or park after the third attempt.
  update ops.jobs
     set status      = case when attempts >= 3 then 'needs_input' else 'queued' end,
         claimed_by  = null,
         claimed_at  = null,
         lease_until = null,
         last_error  = coalesce(last_error, 'lease expired'),
         updated_at  = now()
   where status = 'processing'
     and lease_until is not null
     and lease_until < now();

  select * into v_job
    from ops.jobs
   where status = 'queued'
     and attempts < 3
   order by created_at asc
   for update skip locked
   limit 1;

  if v_job.id is null then
    return null;
  end if;

  update ops.jobs
     set status      = 'processing',
         claimed_by  = p_worker,
         claimed_at  = now(),
         lease_until = now() + make_interval(secs => v_lease),
         attempts    = attempts + 1,
         updated_at  = now()
   where id = v_job.id
   returning * into v_job;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (
    v_job.id,
    '00000000-0000-0000-0000-000000000000'::uuid,
    p_worker,
    'job.claimed',
    'ops.jobs',
    v_job.id,
    jsonb_build_object('lease_seconds', v_lease, 'attempt', v_job.attempts)
  );

  return v_job;
end;
$$;

create or replace function ops.heartbeat_job(p_job_id uuid, p_worker text, p_lease_seconds integer default 300)
returns ops.jobs
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job   ops.jobs;
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 300), 3600));
begin
  update ops.jobs
     set lease_until = now() + make_interval(secs => v_lease),
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
          'job.heartbeat', 'ops.jobs', v_job.id,
          jsonb_build_object('lease_until', v_job.lease_until));

  return v_job;
end;
$$;

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
          jsonb_build_object('status', v_job.status, 'attempt', v_job.attempts, 'error', v_job.last_error));

  return v_job;
end;
$$;

-- Park a job for a human. Used by the manual adapter and by any worker that
-- cannot finish. The job is never marked done.
--
-- Fencing: if the job is currently claimed, the caller must present the same
-- worker label (and attempt number when given). A worker whose lease expired
-- therefore cannot overwrite the job a newer worker now owns.
drop function if exists ops.park_job(uuid, text, text, text, text, text) cascade;

create or replace function ops.park_job(
  p_job_id uuid,
  p_reason text,
  p_adapter text default null,
  p_model text default null,
  p_contract_version text default null,
  p_response_hash text default null,
  p_worker text default null,
  p_attempt integer default null
)
returns ops.jobs
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return null;
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return null;
  end if;
  if v_job.status = 'processing' then
    if p_worker is null
       or p_worker <> v_job.claimed_by
       or (p_attempt is not null and p_attempt <> v_job.attempts) then
      return null;
    end if;
  end if;

  update ops.jobs
     set status           = 'needs_input',
         claimed_by       = null,
         claimed_at       = null,
         lease_until      = null,
         last_error       = left(coalesce(nullif(btrim(p_reason), ''), 'Parked for a human'), 2000),
         adapter          = coalesce(p_adapter, adapter),
         model            = coalesce(p_model, model),
         contract_version = coalesce(p_contract_version, contract_version),
         response_hash    = coalesce(p_response_hash, response_hash),
         updated_at       = now()
   where id = p_job_id
   returning * into v_job;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, coalesce(p_adapter, 'worker'),
          'job.parked', 'ops.jobs', v_job.id,
          jsonb_build_object('reason', v_job.last_error, 'adapter', v_job.adapter,
                             'contract_version', v_job.contract_version,
                             'attempt', v_job.attempts));
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Intake write. One photo, then queue the job.
-- ---------------------------------------------------------------------------
create or replace function ops.upload_file(
  p_job_id uuid,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_uploaded_by uuid,
  p_uploaded_by_email text,
  p_max_bytes integer default 3500000
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

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  insert into ops.job_files (job_id, filename, mime, byte_size, sha256, content, uploaded_by, uploaded_by_email)
  values (p_job_id, left(coalesce(p_filename, 'photo'), 200), left(coalesce(p_mime, 'application/octet-stream'), 100),
          v_size, coalesce(p_sha256, ''), v_bytes, p_uploaded_by, p_uploaded_by_email)
  returning * into v_file;

  update ops.jobs
     set status = 'queued', updated_at = now()
   where id = p_job_id
   returning * into v_job;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_uploaded_by, p_uploaded_by_email, 'job.file_uploaded', 'ops.job_files', v_file.id,
          jsonb_build_object('filename', v_file.filename, 'mime', v_file.mime, 'bytes', v_size, 'sha256', v_file.sha256));

  return jsonb_build_object(
    'ok', true,
    'file', jsonb_build_object('id', v_file.id, 'job_id', v_file.job_id, 'filename', v_file.filename,
                               'mime', v_file.mime, 'byte_size', v_file.byte_size, 'sha256', v_file.sha256,
                               'created_at', v_file.created_at),
    'job', to_jsonb(v_job)
  );
end;
$$;

create or replace function ops.read_file(p_file_id uuid)
returns jsonb
language sql
security definer
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'filename', f.filename,
    'mime', f.mime,
    'byte_size', f.byte_size,
    'sha256', f.sha256,
    'content_b64', encode(f.content, 'base64')
  )
  from ops.job_files f
  where f.id = p_file_id;
end;

-- ---------------------------------------------------------------------------
-- 6. Review / confirm gate. These change ops rows only. There is no code path
--    here (or anywhere in the pilot) that writes public.students or public.scores.
-- ---------------------------------------------------------------------------
create or replace function ops.decide_row(
  p_job_id uuid,
  p_staged_row_id uuid,
  p_decision text,
  p_actor uuid,
  p_actor_email text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row        ops.staged_rows;
  v_decision   ops.decisions;
  v_new_status text;
begin
  if p_decision is null or p_decision not in ('approve', 'reject', 'edit', 'hold') then
    return jsonb_build_object('ok', false, 'code', 'OPS_DECISION_INVALID');
  end if;

  select * into v_row from ops.staged_rows
   where id = p_staged_row_id and job_id = p_job_id
   for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROW_NOT_FOUND');
  end if;

  v_new_status := case p_decision
    when 'approve' then 'accepted'
    when 'reject'  then 'rejected'
    else 'pending'
  end;

  update ops.staged_rows
     set status = v_new_status, updated_at = now()
   where id = v_row.id
   returning * into v_row;

  insert into ops.decisions (job_id, staged_row_id, decision, decided_by, decided_by_email, note)
  values (p_job_id, p_staged_row_id, p_decision, p_actor, p_actor_email, left(p_note, 1000))
  returning * into v_decision;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'staged_row.' || p_decision, 'ops.staged_rows', p_staged_row_id,
          jsonb_build_object('note', p_note));

  return jsonb_build_object('ok', true, 'decision', to_jsonb(v_decision), 'staged_row', to_jsonb(v_row));
end;
$$;

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
  v_decision ops.decisions;
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

  if v_total = 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_NOTHING_TO_APPROVE');
  end if;
  if v_pending > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROWS_PENDING',
                              'pending', v_pending, 'total', v_total);
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

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'decision', to_jsonb(v_decision),
                            'live_write', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Public wrappers. Same rule as before: service_role only, no browser key.
--    Each body depends on ops objects, so one drop still removes everything.
-- ---------------------------------------------------------------------------
create or replace function public.ops_claim_job(p_worker text, p_lease_seconds integer default 300)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select to_jsonb(ops.claim_job(p_worker, p_lease_seconds));
end;

create or replace function public.ops_heartbeat_job(p_job_id uuid, p_worker text, p_lease_seconds integer default 300)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select to_jsonb(ops.heartbeat_job(p_job_id, p_worker, p_lease_seconds));
end;

create or replace function public.ops_fail_job(p_job_id uuid, p_worker text, p_error text)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select to_jsonb(ops.fail_job(p_job_id, p_worker, p_error));
end;

drop function if exists public.ops_park_job(uuid, text, text, text, text, text);

create or replace function public.ops_park_job(
  p_job_id uuid, p_reason text, p_adapter text default null, p_model text default null,
  p_contract_version text default null, p_response_hash text default null,
  p_worker text default null, p_attempt integer default null
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select to_jsonb(ops.park_job(p_job_id, p_reason, p_adapter, p_model, p_contract_version,
                               p_response_hash, p_worker, p_attempt));
end;

create or replace function public.ops_upload_file(
  p_job_id uuid, p_filename text, p_mime text, p_content_b64 text, p_sha256 text,
  p_uploaded_by uuid, p_uploaded_by_email text, p_max_bytes integer default 3500000
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.upload_file(p_job_id, p_filename, p_mime, p_content_b64, p_sha256,
                         p_uploaded_by, p_uploaded_by_email, p_max_bytes);
end;

create or replace function public.ops_read_file(p_file_id uuid)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.read_file(p_file_id);
end;

create or replace function public.ops_jobs_decide(
  p_job_id uuid, p_staged_row_id uuid, p_decision text, p_actor uuid, p_actor_email text, p_note text default null
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.decide_row(p_job_id, p_staged_row_id, p_decision, p_actor, p_actor_email, p_note);
end;

create or replace function public.ops_jobs_confirm(p_job_id uuid, p_actor uuid, p_actor_email text)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.confirm_job(p_job_id, p_actor, p_actor_email);
end;

create or replace function public.ops_providers_list()
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'providers', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'id', p.id, 'label', p.label, 'kind', p.kind, 'adapter', p.adapter,
          'model', p.model, 'key_ref', p.key_ref, 'priority', p.priority, 'enabled', p.enabled
        ) order by p.priority asc)
       from ops.providers p),
      '[]'::jsonb
    )
  );
end;

-- Extend the job reader with intake files. Signature is unchanged.
create or replace function public.ops_jobs_get(p_id uuid)
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'job', to_jsonb(j),
    'files', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'id', f.id, 'filename', f.filename, 'mime', f.mime,
          'byte_size', f.byte_size, 'sha256', f.sha256, 'created_at', f.created_at
        ) order by f.created_at asc)
       from ops.job_files f where f.job_id = j.id),
      '[]'::jsonb
    ),
    'staged_rows', coalesce(
      (select jsonb_agg(to_jsonb(s) order by s.row_no) from ops.staged_rows s where s.job_id = j.id),
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

revoke all on function public.ops_claim_job(text, integer) from public, anon, authenticated;
revoke all on function public.ops_heartbeat_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.ops_fail_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ops_park_job(uuid, text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.ops_upload_file(uuid, text, text, text, text, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.ops_read_file(uuid) from public, anon, authenticated;
revoke all on function public.ops_jobs_decide(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.ops_jobs_confirm(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ops_providers_list() from public, anon, authenticated;

grant execute on function public.ops_claim_job(text, integer) to service_role;
grant execute on function public.ops_heartbeat_job(uuid, text, integer) to service_role;
grant execute on function public.ops_fail_job(uuid, text, text) to service_role;
grant execute on function public.ops_park_job(uuid, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.ops_upload_file(uuid, text, text, text, text, uuid, text, integer) to service_role;
grant execute on function public.ops_read_file(uuid) to service_role;
grant execute on function public.ops_jobs_decide(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.ops_jobs_confirm(uuid, uuid, text) to service_role;
grant execute on function public.ops_providers_list() to service_role;

commit;
