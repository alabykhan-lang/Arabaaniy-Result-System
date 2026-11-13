-- Agent-as-staff pilot: private staging schema for First Choice.
--
-- ADDITIVE ONLY. This file creates objects in schema "ops" and nothing else.
-- It does not alter, rename, move or drop anything in public.*, so the school's
-- portal, its RLS policies, functions, triggers and data are untouched.
--
-- Reversal is one statement:
--     drop schema if exists ops cascade;
-- The three public entry points (ops_jobs_list, ops_jobs_get, ops_jobs_create)
-- are dependent objects of the ops tables, so the cascade removes them too. No
-- public table, column, policy, function or trigger that existed before this
-- migration is touched.
--
-- SUBJECTS AND THE POSITIONAL subject_index
-- public.scores has no subject id. It stores "subject_index", the 0-based
-- position of the subject in app_config.config.depts[class_key].subjects.
-- Renaming or reordering that array silently re-points every saved score.
--
-- The pilot therefore never stores a position as identity. Every staged row
-- points at ops.subjects.id and ops.subjects.subject_key (a stable slug such as
-- "primary5:mathematics"), and records label + source_index only as evidence
-- of what was on screen when the row was captured.
--
-- At cutover, writing public.scores.subject_index is a separate, approved step
-- (not part of this migration and not implemented in the pilot). That step must
-- resolve subject_key -> current array position at write time and must refuse
-- the write when app_config's label at that position no longer matches the
-- stored subject_label, or when the position no longer exists. It must also
-- write against the exact academic_session + term recorded on the job, never
-- the portal's current term.

create schema if not exists ops;

-- ---------------------------------------------------------------------------
-- Reference subjects, keyed by us, not by array position.
-- ---------------------------------------------------------------------------
create table if not exists ops.subjects (
  id            uuid primary key default gen_random_uuid(),
  class_key     text not null,
  subject_key   text not null unique,
  label         text not null,
  source_index  integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ops_subjects_class_label_unique unique (class_key, label)
);

comment on table ops.subjects is
  'Stable subject identity for the pilot. subject_key never changes; source_index only records where the subject sat in app_config at registration time.';
comment on column ops.subjects.subject_key is
  'Stable slug, e.g. primary5:mathematics. Use this for matching and cutover, never subject_index.';

-- ---------------------------------------------------------------------------
-- Jobs: one unit of work submitted by a staff account.
-- ---------------------------------------------------------------------------
create table if not exists ops.jobs (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid,
  class_key          text,
  academic_session   text,
  term               text,
  service            text not null
                     check (service in ('roster', 'scores', 'documents')),
  status             text not null default 'draft'
                     check (status in ('draft', 'queued', 'processing', 'needs_review',
                                       'approved', 'applied', 'failed', 'cancelled')),
  submitted_by       uuid not null,
  submitted_by_email text not null,
  instruction        text,
  file_refs          jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table ops.jobs is
  'Pilot job queue. Writes here never touch public.scores or public.students.';
comment on column ops.jobs.file_refs is
  'Opaque references to uploaded files (storage path + checksum + mime). No upload processing in the skeleton.';

create index if not exists ops_jobs_created_at_idx on ops.jobs (created_at desc);
create index if not exists ops_jobs_status_idx on ops.jobs (status);
create index if not exists ops_jobs_submitted_by_idx on ops.jobs (submitted_by);

-- ---------------------------------------------------------------------------
-- Staged rows: what a photo claimed, before anyone trusts it.
-- ---------------------------------------------------------------------------
create table if not exists ops.staged_rows (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references ops.jobs(id) on delete cascade,
  row_no            integer,
  student_id        uuid,
  admno             text,
  student_name_raw  text,
  match_method      text check (match_method in ('admno', 'name', 'manual', 'none')),
  match_confidence  numeric(4,3) check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  subject_id        uuid references ops.subjects(id) on delete restrict,
  subject_key       text,
  subject_label     text,
  component         text not null check (component in ('ca1', 'ca2', 'ca3', 'exam')),
  value             numeric(7,2),
  confidence        numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status            text not null default 'pending'
                    check (status in ('pending', 'accepted', 'rejected', 'applied')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ops.staged_rows is
  'Parsed but unapproved rows. Nothing here is a live score. student_id is a match candidate, admno is the only safe join key.';
comment on column ops.staged_rows.subject_key is
  'Denormalised copy of ops.subjects.subject_key for readable exports. subject_id is the authority.';

create index if not exists ops_staged_rows_job_idx on ops.staged_rows (job_id, row_no);
create index if not exists ops_staged_rows_status_idx on ops.staged_rows (job_id, status);
create index if not exists ops_staged_rows_subject_idx on ops.staged_rows (subject_id);

-- ---------------------------------------------------------------------------
-- Decisions: a human or the pipeline accepting/rejecting a staged row or job.
-- ---------------------------------------------------------------------------
create table if not exists ops.decisions (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references ops.jobs(id) on delete cascade,
  staged_row_id  uuid references ops.staged_rows(id) on delete cascade,
  decision       text not null check (decision in ('approve', 'reject', 'edit', 'hold')),
  decided_by     uuid not null,
  decided_by_email text not null,
  note           text,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table ops.decisions is
  'Review history. A job cannot be applied without an approve decision; enforcement lands with the cutover, not this skeleton.';

create index if not exists ops_decisions_job_idx on ops.decisions (job_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit: actor on every write. Append-only by policy (no update/delete grants).
-- ---------------------------------------------------------------------------
create table if not exists ops.audit (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references ops.jobs(id) on delete cascade,
  actor_id    uuid not null,
  actor_email text not null,
  action      text not null,
  entity      text,
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table ops.audit is
  'Append-only trail. actor_id + actor_email are NOT NULL so no write can be anonymous.';

create index if not exists ops_audit_job_idx on ops.audit (job_id, created_at desc);
create index if not exists ops_audit_actor_idx on ops.audit (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance, inside ops only.
-- ---------------------------------------------------------------------------
create or replace function ops.touch_updated_at()
returns trigger
language plpgsql
set search_path = ops, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ops_jobs_touch_updated_at on ops.jobs;
create trigger ops_jobs_touch_updated_at
  before update on ops.jobs
  for each row execute function ops.touch_updated_at();

drop trigger if exists ops_subjects_touch_updated_at on ops.subjects;
create trigger ops_subjects_touch_updated_at
  before update on ops.subjects
  for each row execute function ops.touch_updated_at();

drop trigger if exists ops_staged_rows_touch_updated_at on ops.staged_rows;
create trigger ops_staged_rows_touch_updated_at
  before update on ops.staged_rows
  for each row execute function ops.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The only doors into the pilot. Three SQL-standard functions in public; ops is
-- not in PostgREST's exposed schema list, so nothing else is reachable.
--
-- They are SECURITY INVOKER: the caller must already hold the ops grants, which
-- only service_role does. EXECUTE is revoked from PUBLIC/anon/authenticated, so
-- the publishable browser key cannot call them.
--
-- Each body references ops tables, so each function is a dependent object: the
-- one-line reversal below drops all of them automatically.
-- ---------------------------------------------------------------------------
create or replace function public.ops_jobs_list()
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'jobs', coalesce(
      (select jsonb_agg(to_jsonb(j) order by j.created_at desc) from ops.jobs j),
      '[]'::jsonb
    )
  );
end;

create or replace function public.ops_jobs_get(p_id uuid)
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'job', to_jsonb(j),
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
language sql
set search_path = ops, public, pg_temp
begin atomic
  with inserted as (
    insert into ops.jobs (
      school_id, class_key, academic_session, term, service, status,
      submitted_by, submitted_by_email, instruction, file_refs
    )
    values (
      p_school_id, p_class_key, p_academic_session, p_term, p_service, 'draft',
      p_submitted_by, p_submitted_by_email, p_instruction,
      coalesce(p_file_refs, '[]'::jsonb)
    )
    returning *
  ), logged as (
    insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
    select
      inserted.id, p_submitted_by, p_submitted_by_email, 'job.created', 'ops.jobs', inserted.id,
      jsonb_build_object('service', inserted.service, 'class_key', inserted.class_key)
    from inserted
  )
  select jsonb_build_object('ok', true, 'job', to_jsonb(inserted)) from inserted;
end;

revoke all on function public.ops_jobs_list() from public, anon, authenticated;
revoke all on function public.ops_jobs_get(uuid) from public, anon, authenticated;
revoke all on function public.ops_jobs_create(uuid, text, text, text, text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_jobs_list() to service_role;
grant execute on function public.ops_jobs_get(uuid) to service_role;
grant execute on function public.ops_jobs_create(uuid, text, text, text, text, uuid, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Lock the schema away from the public API.
-- ops is not in PostgREST's exposed schema list, so it is already unreachable
-- through /rest/v1. These grants make that explicit and keep it true if the
-- exposed list is ever widened.
-- ---------------------------------------------------------------------------
alter table ops.subjects    enable row level security;
alter table ops.jobs        enable row level security;
alter table ops.staged_rows enable row level security;
alter table ops.decisions   enable row level security;
alter table ops.audit       enable row level security;

revoke all on schema ops from public;
revoke all on schema ops from anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
revoke all on all functions in schema ops from public, anon, authenticated;

grant usage on schema ops to service_role;
grant all on all tables in schema ops to service_role;
grant all on all functions in schema ops to service_role;

alter default privileges in schema ops revoke all on tables from public, anon, authenticated;
alter default privileges in schema ops grant all on tables to service_role;
