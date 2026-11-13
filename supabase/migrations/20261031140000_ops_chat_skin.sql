-- Pilot step 2: chat skin over the existing endpoints, plus a roster snapshot
-- taken when a job is created.
--
-- ADDITIVE: everything lives in schema ops, plus replacements for the pilot's
-- own public wrappers (same signatures, same grants). No school-loaded file or
-- table is touched.
--
-- Reversal is still one statement:  drop schema if exists ops cascade;
--
-- Why the snapshot: a class list can change while a job is running. Matching
-- later against a bigger list would turn "pupil added after the photo" into a
-- false mismatch. The snapshot freezes the class as it was at intake.

begin;

-- ---------------------------------------------------------------------------
-- 1. Roster snapshot per job.
-- ---------------------------------------------------------------------------
alter table ops.jobs add column if not exists roster_snapshot_count integer;
alter table ops.jobs add column if not exists roster_snapshot_at    timestamptz;

comment on column ops.jobs.roster_snapshot_count is
  'Number of active pupils in the class at the moment the job was created. Shown on the job card.';
comment on column ops.jobs.roster_snapshot_at is
  'When that class list was frozen.';

create table if not exists ops.roster_snapshots (
  job_id       uuid primary key references ops.jobs(id) on delete cascade,
  class_key    text not null,
  captured_at  timestamptz not null default now(),
  pupil_count  integer not null,
  pupils       jsonb not null default '[]'::jsonb
);

comment on table ops.roster_snapshots is
  'Frozen class list at job creation: id, admission number and name for each active pupil. Private to ops.';

alter table ops.roster_snapshots enable row level security;

create or replace function ops.snapshot_roster(p_job_id uuid, p_class_key text)
returns integer
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_count  integer;
  v_pupils jsonb;
begin
  select count(*) into v_count
    from public.students
   where class_key = p_class_key and archived = false;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'admno', s.admno, 'name', s.name) order by s.name), '[]'::jsonb)
    into v_pupils
    from public.students s
   where s.class_key = p_class_key and s.archived = false;

  insert into ops.roster_snapshots (job_id, class_key, pupil_count, pupils)
  values (p_job_id, p_class_key, v_count, v_pupils)
  on conflict (job_id) do update
     set class_key   = excluded.class_key,
         pupil_count = excluded.pupil_count,
         pupils      = excluded.pupils,
         captured_at = now();

  update ops.jobs
     set roster_snapshot_count = v_count,
         roster_snapshot_at    = now(),
         updated_at            = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'intake',
          'roster.snapshot', 'ops.roster_snapshots', p_job_id,
          jsonb_build_object('class_key', p_class_key, 'pupils', v_count));

  return v_count;
end;
$$;

revoke all on function ops.snapshot_roster(uuid, text) from public, anon, authenticated;
grant execute on function ops.snapshot_roster(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Creation freezes the class list in the same transaction.
--    Same signature and grants, so the API needs no change.
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
  p_file_refs jsonb default '[]'::jsonb
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
    submitted_by, submitted_by_email, instruction, file_refs
  )
  values (
    p_school_id, p_class_key, p_academic_session, p_term, p_service, 'draft',
    p_submitted_by, p_submitted_by_email, p_instruction,
    coalesce(p_file_refs, '[]'::jsonb)
  )
  returning * into v_job;

  if v_job.class_key is not null then
    v_count := ops.snapshot_roster(v_job.id, v_job.class_key);
    select * into v_job from ops.jobs where id = v_job.id;
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, p_submitted_by, p_submitted_by_email, 'job.created', 'ops.jobs', v_job.id,
          jsonb_build_object('service', v_job.service, 'class_key', v_job.class_key,
                             'roster_snapshot', v_count));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. List carries the counts and the photo reference the chat needs, so one
--    request renders the whole thread. Same signature and grants.
-- ---------------------------------------------------------------------------
create or replace function public.ops_jobs_list()
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'jobs', coalesce(
      (select jsonb_agg(
          to_jsonb(j) || jsonb_build_object(
            'counts', jsonb_build_object(
              'read',       (select count(*) from ops.staged_rows s where s.job_id = j.id),
              'matched',    (select count(*) from ops.staged_rows s where s.job_id = j.id and s.student_id is not null),
              'distinct',   (select count(distinct s.student_id) from ops.staged_rows s where s.job_id = j.id and s.student_id is not null),
              'accepted',   (select count(*) from ops.staged_rows s where s.job_id = j.id and s.status = 'accepted'),
              'need_eye',   (select count(*) from ops.staged_rows s where s.job_id = j.id and s.status = 'pending')
            ),
            'files', coalesce(
              (select jsonb_agg(jsonb_build_object('id', f.id, 'filename', f.filename, 'byte_size', f.byte_size)
                                order by f.created_at)
                 from ops.job_files f where f.job_id = j.id),
              '[]'::jsonb)
          ) order by j.created_at desc)
       from ops.jobs j),
      '[]'::jsonb)
  );
end;

-- ---------------------------------------------------------------------------
-- 4. Detail carries the frozen class list so the review screen can show the
--    suggested pupil beside the handwritten name without a second request.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Backfill the one real job already on the system. It was matched against
--    the same 50 active pupils that are there now, so the snapshot is exact;
--    the audit row says it was taken after the fact.
-- ---------------------------------------------------------------------------
do $$
declare
  v_job  record;
  v_count integer;
begin
  for v_job in
    select id, class_key from ops.jobs
     where class_key is not null
       and not exists (select 1 from ops.roster_snapshots rs where rs.job_id = ops.jobs.id)
  loop
    v_count := ops.snapshot_roster(v_job.id, v_job.class_key);
    insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
    values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, 'intake',
            'roster.snapshot_backfill', 'ops.roster_snapshots', v_job.id,
            jsonb_build_object('class_key', v_job.class_key, 'pupils', v_count,
                               'note', 'snapshot taken after the job was created'));
  end loop;
end;
$$;

commit;
