-- Reader liveness and honest draft cleanup.
--
-- Additive: one small ops table, reader-status and sweep functions, a public
-- wrapper for the worker heartbeat, and a replacement of stage_alignment that
-- also clears or updates the job's last_error. No school-loaded table, no
-- public.scores or public.students write, no live write.
--
-- The page asks the database whether a reader is alive. It never infers that
-- from elapsed time, so the "nothing is reading" sentence only appears when a
-- heartbeat is genuinely older than three minutes.

begin;

-- ---------------------------------------------------------------------------
-- 1. One heartbeat row per worker process. Upserted every few seconds by the
--    continuous loop, and once at the start of a one-shot run.
-- ---------------------------------------------------------------------------
create table if not exists ops.worker_heartbeat (
  worker     text primary key,
  beat_at    timestamptz not null default now(),
  pid        integer,
  mode       text,
  detail     jsonb not null default '{}'::jsonb
);

revoke all on table ops.worker_heartbeat from public, anon, authenticated;

create or replace function ops.worker_beat(
  p_worker text,
  p_pid integer default null,
  p_mode text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_worker text := left(coalesce(nullif(btrim(p_worker), ''), 'ops-worker'), 120);
  v_mode   text := left(coalesce(nullif(btrim(p_mode), ''), 'loop'), 40);
  v_row    ops.worker_heartbeat;
begin
  insert into ops.worker_heartbeat as h (worker, beat_at, pid, mode)
  values (v_worker, now(), p_pid, v_mode)
  on conflict (worker) do update
     set beat_at = now(),
         pid     = excluded.pid,
         mode    = excluded.mode,
         detail  = h.detail
  returning * into v_row;

  return jsonb_build_object('ok', true, 'worker', v_row.worker, 'beat_at', v_row.beat_at);
end;
$$;

revoke all on function ops.worker_beat(text, integer, text) from public, anon, authenticated;
grant execute on function ops.worker_beat(text, integer, text) to service_role;

create or replace function public.ops_worker_beat(
  p_worker text,
  p_pid integer default null,
  p_mode text default null
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.worker_beat(p_worker, p_pid, p_mode);
$$;

revoke all on function public.ops_worker_beat(text, integer, text) from public, anon, authenticated;
grant execute on function public.ops_worker_beat(text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Is a reader alive? Alive means a heartbeat within the last three minutes.
--    The age is returned so the page can show a real number if it ever needs
--    one, and no caller has to guess.
-- ---------------------------------------------------------------------------
create or replace function ops.reader_status()
returns jsonb
language sql
stable
security definer
set search_path = ops, public, pg_temp
as $$
  with latest as (
    select max(beat_at) as beat_at from ops.worker_heartbeat
  )
  select jsonb_build_object(
    'ok', true,
    'alive', coalesce((select beat_at > now() - interval '3 minutes' from latest), false),
    'last_beat_at', (select beat_at from latest),
    'age_seconds', (select floor(extract(epoch from (now() - beat_at)))::integer from latest),
    'threshold_seconds', 180,
    'workers', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'worker', h.worker, 'mode', h.mode, 'pid', h.pid, 'beat_at', h.beat_at
        ) order by h.beat_at desc)
       from ops.worker_heartbeat h),
      '[]'::jsonb
    )
  );
$$;

revoke all on function ops.reader_status() from public, anon, authenticated;
grant execute on function ops.reader_status() to service_role;

create or replace function public.ops_reader_status()
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.reader_status();
$$;

revoke all on function public.ops_reader_status() from public, anon, authenticated;
grant execute on function public.ops_reader_status() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Close stale drafts. A draft that already holds a stored photo is queued
--    so the reader picks it up; a draft with no photo is closed with a plain
--    reason. Neither is ever reported as lost.
-- ---------------------------------------------------------------------------
create or replace function ops.sweep_drafts(p_age_seconds integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_age     integer := greatest(60, least(coalesce(p_age_seconds, 600), 86400));
  v_queued  integer := 0;
  v_closed  integer := 0;
begin
  with rescued as (
    update ops.jobs j
       set status = 'queued',
           last_error = null,
           updated_at = now()
     where j.status = 'draft'
       and j.created_at < now() - make_interval(secs => v_age)
       and exists (select 1 from ops.job_files f where f.job_id = j.id)
    returning j.id
  )
  select count(*) into v_queued from rescued;

  with closed as (
    update ops.jobs j
       set status = 'failed',
           last_error = 'No photo arrived, so there is nothing to read.',
           updated_at = now()
     where j.status = 'draft'
       and j.created_at < now() - make_interval(secs => v_age)
       and not exists (select 1 from ops.job_files f where f.job_id = j.id)
    returning j.id
  )
  select count(*) into v_closed from closed;

  return jsonb_build_object('ok', true, 'queued', v_queued, 'closed', v_closed);
end;
$$;

revoke all on function ops.sweep_drafts(integer) from public, anon, authenticated;
grant execute on function ops.sweep_drafts(integer) to service_role;

create or replace function public.ops_sweep_drafts(p_age_seconds integer default 600)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.sweep_drafts(p_age_seconds);
$$;

revoke all on function public.ops_sweep_drafts(integer) from public, anon, authenticated;
grant execute on function public.ops_sweep_drafts(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. stage_alignment now keeps last_error truthful: it clears the old
--    "50 lines need a human" when the four-list pass has settled the rows, and
--    writes the real pending count when it has not.
-- ---------------------------------------------------------------------------
create or replace function ops.stage_alignment(
  p_job_id uuid,
  p_rows jsonb,
  p_counts jsonb,
  p_portal_only jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job      ops.jobs;
  v_item     jsonb;
  v_row_id   uuid;
  v_list     text;
  v_student  uuid;
  v_admno    text;
  v_pending  integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'OPS_ALIGNMENT_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  for v_item in select value from jsonb_array_elements(p_rows) loop
    v_row_id := nullif(btrim(coalesce(v_item ->> 'staged_row_id', '')), '')::uuid;
    if v_row_id is null then
      continue;
    end if;

    v_list := upper(coalesce(nullif(btrim(v_item ->> 'match_list'), ''), 'C'));
    if v_list not in ('A', 'B', 'C') then
      v_list := 'C';
    end if;

    v_student := null;
    v_admno := null;
    if v_list = 'A' then
      v_student := nullif(btrim(coalesce(v_item ->> 'student_id', '')), '')::uuid;
      select p ->> 'admno' into v_admno
        from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
       where rs.job_id = p_job_id and (p ->> 'id')::uuid = v_student
       limit 1;
    end if;

    update ops.staged_rows
       set match_list = v_list,
           surname_score = nullif(btrim(coalesce(v_item ->> 'surname_score', '')), '')::numeric,
           first_score = nullif(btrim(coalesce(v_item ->> 'first_score', '')), '')::numeric,
           candidate_names = case when jsonb_typeof(v_item -> 'candidate_names') = 'array'
                                  then v_item -> 'candidate_names' else '[]'::jsonb end,
           student_id = case when v_list = 'A' then v_student else null end,
           admno = case when v_list = 'A' then v_admno else null end,
           candidate_admno = case when v_list = 'B'
                                  then nullif(btrim(coalesce(v_item ->> 'candidate_admno', '')), '')
                                  else null end,
           status = case when v_list = 'A' then 'accepted' else 'pending' end,
           match_method = case when v_list in ('A', 'B') then 'name' else 'none' end,
           flag = case when v_list = 'A' then null
                       when v_list = 'B' then coalesce(nullif(btrim(v_item ->> 'flag'), ''), 'near_match')
                       else 'no_confident_match' end,
           match_confidence = case when v_list = 'A' then 1
                                   else nullif(btrim(coalesce(v_item ->> 'confidence', '')), '')::numeric end,
           updated_at = now()
     where id = v_row_id and job_id = p_job_id;
  end loop;

  select count(*) into v_pending
    from ops.staged_rows
   where job_id = p_job_id and status = 'pending';

  update ops.jobs
     set alignment = jsonb_build_object(
           'counts', coalesce(p_counts, '{}'::jsonb),
           'portal_only', coalesce(p_portal_only, '[]'::jsonb),
           'ran_at', now(),
           'algorithm', 'token sets, surname first, per-token edit distance scaled by length'
         ),
         status = case when v_pending > 0 then 'needs_input' else 'needs_review' end,
         last_error = case when v_pending > 0
                           then v_pending || ' lines need a human'
                           else null end,
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'alignment.ran', 'ops.staged_rows', p_job_id,
          jsonb_build_object('counts', p_counts, 'pending', v_pending,
                             'portal_only', jsonb_array_length(coalesce(p_portal_only, '[]'::jsonb))));

  return jsonb_build_object('ok', true, 'counts', p_counts, 'pending', v_pending,
                            'alignment', v_job.alignment);
end;
$$;

revoke all on function ops.stage_alignment(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function ops.stage_alignment(uuid, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The job reader carries the live reader status. The page stops guessing
--    from the clock: it asks this same response.
-- ---------------------------------------------------------------------------
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
    'reader', ops.reader_status(),
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
