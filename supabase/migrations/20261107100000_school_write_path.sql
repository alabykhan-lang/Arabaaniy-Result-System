-- 20261107100000_school_write_path.sql
-- One audited, undoable write path for the Command Center assistant.
--
-- public.scores remains the school's table. The assistant never writes it
-- directly: it calls public.school_record_scores / school_correct_score, which
-- create one batch, append one audit row per cell, and can be reversed with
-- school_undo_batch. public.scores gets a catalog guard so an index that is
-- not in that class's subject list is rejected at the database.
--
-- Nothing here charges credits or changes the pilot's existing document tables.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists ops.write_batches (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null,
  actor_id        uuid not null,
  actor_email     text not null,
  action          text not null,
  request_id      text not null,
  class_key       text,
  term            text,
  academic_session text,
  subject_index   integer,
  component       text,
  status          text not null default 'committed'
                  check (status in ('committed', 'undone')),
  summary         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  undone_at       timestamptz
);

create index if not exists ops_write_batches_school_idx
  on ops.write_batches (school_id, created_at desc);
create index if not exists ops_write_batches_request_idx
  on ops.write_batches (request_id);

create table if not exists ops.write_audit (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references ops.write_batches(id) on delete restrict,
  request_id      text not null,
  school_id       uuid not null,
  actor_id        uuid not null,
  actor_email     text not null,
  action          text not null,
  student_id      uuid,
  class_key       text,
  term            text,
  subject_index   integer,
  component       text,
  old_value       numeric,
  new_value       numeric,
  reason          text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists ops_write_audit_batch_idx
  on ops.write_audit (batch_id, created_at);
create index if not exists ops_write_audit_cell_idx
  on ops.write_audit (student_id, subject_index, term, component);

comment on table ops.write_audit is
  'Append-only audit of every school write. One row per changed cell, with a batch id and request id.';

-- Append-only: even the service role cannot edit or delete an audit row.
create or replace function ops.write_audit_append_only()
returns trigger
language plpgsql
set search_path = ops, pg_temp
as $$
begin
  raise exception 'The write audit is append-only.' using errcode = '42501';
end;
$$;

drop trigger if exists ops_write_audit_no_update on ops.write_audit;
create trigger ops_write_audit_no_update
  before update or delete on ops.write_audit
  for each row execute function ops.write_audit_append_only();

create table if not exists ops.name_aliases (
  school_id       uuid not null,
  class_key       text not null,
  alias_norm      text not null,
  student_id      uuid not null,
  confirmed_by    uuid,
  times_used      integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (school_id, class_key, alias_norm)
);

create table if not exists ops.subject_aliases (
  school_id       uuid not null,
  class_key       text not null,
  alias_norm      text not null,
  subject_index   integer not null,
  subject_label   text,
  confirmed_by    uuid,
  created_at      timestamptz not null default now(),
  primary key (school_id, class_key, alias_norm)
);

create table if not exists ops.result_approvals (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null,
  class_key       text not null,
  term            text not null,
  academic_session text not null,
  subjects        jsonb not null default '[]'::jsonb,
  approved_all    boolean not null default false,
  approved_by     uuid not null,
  approved_by_email text not null,
  created_at      timestamptz not null default now(),
  unique (school_id, class_key, term, academic_session)
);

create table if not exists ops.generated_documents (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null,
  actor_id        uuid not null,
  actor_email     text not null,
  class_key       text not null,
  term            text not null,
  academic_session text not null,
  template        text not null default 'modern',
  kind            text not null check (kind in ('cards', 'broadsheet')),
  mode            text not null check (mode in ('sample', 'final')),
  filename        text not null,
  mime            text not null default 'application/pdf',
  page_count      integer,
  byte_size       integer,
  sha256          text,
  summary         jsonb not null default '{}'::jsonb,
  content         bytea not null,
  created_at      timestamptz not null default now()
);

create index if not exists ops_generated_documents_school_idx
  on ops.generated_documents (school_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Database guards: a subject index must exist in that class's catalog.
-- ---------------------------------------------------------------------------
create or replace function public.school_guard_subject_index()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subjects jsonb;
  v_count integer;
begin
  select config -> 'depts' -> new.class_key -> 'subjects'
    into v_subjects
    from public.app_config
   where id = 1;

  if v_subjects is null or jsonb_typeof(v_subjects) <> 'array' then
    raise exception 'Class "%" is not in the school subject catalog.', new.class_key
      using errcode = '23514',
            hint = 'Use a class key from app_config.depts, or add the class first.';
  end if;

  v_count := jsonb_array_length(v_subjects);
  if new.subject_index is null or new.subject_index < 0 or new.subject_index >= v_count then
    raise exception 'Subject index % is not in the catalog for class % (0..%).',
      new.subject_index, new.class_key, greatest(v_count - 1, 0)
      using errcode = '23514',
            hint = 'Resolve the subject with resolve_subject and use its stored index. Never use a list position from a different class.';
  end if;

  return new;
end;
$$;

drop trigger if exists school_scores_subject_guard on public.scores;
create trigger school_scores_subject_guard
  before insert or update of class_key, subject_index on public.scores
  for each row execute function public.school_guard_subject_index();

drop trigger if exists school_published_subject_guard on public.published_subjects;
create trigger school_published_subject_guard
  before insert or update of class_key, subject_index on public.published_subjects
  for each row execute function public.school_guard_subject_index();

-- ---------------------------------------------------------------------------
-- 3. Batch + audit helpers
-- ---------------------------------------------------------------------------
create or replace function public.school_log_batch(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_action text,
  p_request_id text,
  p_class_key text default null,
  p_term text default null,
  p_academic_session text default null,
  p_subject_index integer default null,
  p_summary jsonb default '{}'::jsonb,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_batch uuid;
begin
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'SCHOOL_REQUEST_ID_REQUIRED',
      'error', 'A request id is required for an audited write.',
      'next', 'Call the same action again; the assistant supplies the request id.'
    );
  end if;

  insert into ops.write_batches (
    school_id, actor_id, actor_email, action, request_id,
    class_key, term, academic_session, subject_index, summary
  ) values (
    p_school_id, p_actor_id, p_actor_email, p_action, p_request_id,
    p_class_key, p_term, p_academic_session, p_subject_index, coalesce(p_summary, '{}'::jsonb)
  ) returning id into v_batch;

  insert into ops.write_audit (
    batch_id, request_id, school_id, actor_id, actor_email, action,
    class_key, subject_index, detail
  ) values (
    v_batch, p_request_id, p_school_id, p_actor_id, p_actor_email, p_action,
    p_class_key, p_subject_index, coalesce(p_detail, '{}'::jsonb)
  );

  return jsonb_build_object('ok', true, 'batch_id', v_batch);
end;
$$;

create or replace function public.school_remember_alias(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_alias text,
  p_alias_norm text,
  p_student_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_student public.students;
  v_batch jsonb;
begin
  select * into v_student from public.students where id = p_student_id;
  if v_student.id is null then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_STUDENT_NOT_FOUND',
      'error', 'That pupil was not found.',
      'next', 'Call resolve_students(class, names) to get a real student_id.');
  end if;
  if p_class_key is not null and v_student.class_key <> p_class_key then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_STUDENT_CLASS_MISMATCH',
      'error', 'That pupil is in another class.',
      'next', 'Resolve the name inside the class on the sheet.');
  end if;
  if p_alias_norm is null or length(trim(p_alias_norm)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_ALIAS_EMPTY',
      'error', 'The sheet name is empty.',
      'next', 'Pass the name exactly as written on the sheet.');
  end if;

  insert into ops.name_aliases (school_id, class_key, alias_norm, student_id, confirmed_by)
  values (p_school_id, v_student.class_key, p_alias_norm, p_student_id, p_actor_id)
  on conflict (school_id, class_key, alias_norm)
  do update set student_id = excluded.student_id,
                confirmed_by = excluded.confirmed_by,
                times_used = ops.name_aliases.times_used + 1,
                updated_at = now();

  v_batch := public.school_log_batch(
    p_school_id, p_actor_id, p_actor_email, 'remember_alias', p_request_id,
    v_student.class_key, null, v_student.academic_session, null,
    jsonb_build_object('alias', p_alias, 'student_id', p_student_id, 'name', v_student.name),
    jsonb_build_object('alias', p_alias, 'alias_norm', p_alias_norm, 'student_id', p_student_id)
  );

  return jsonb_build_object(
    'ok', true,
    'remembered', true,
    'alias', p_alias,
    'student', jsonb_build_object('id', v_student.id, 'name', v_student.name, 'class_key', v_student.class_key),
    'batch_id', v_batch -> 'batch_id'
  );
end;
$$;

create or replace function public.school_subject_alias(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_alias text,
  p_alias_norm text,
  p_subject_index integer,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_subjects jsonb;
  v_label text;
  v_batch jsonb;
begin
  select config -> 'depts' -> p_class_key -> 'subjects'
    into v_subjects from public.app_config where id = 1;
  if v_subjects is null or jsonb_typeof(v_subjects) <> 'array'
     or p_subject_index is null or p_subject_index < 0 or p_subject_index >= jsonb_array_length(v_subjects) then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_SUBJECT_INDEX_INVALID',
      'error', 'That subject index is not in the class catalog.',
      'next', 'Call resolve_subject(class, name) and use the returned index.');
  end if;
  v_label := case when jsonb_typeof(v_subjects -> p_subject_index) = 'object'
    then coalesce((v_subjects -> p_subject_index) ->> 'label', (v_subjects -> p_subject_index) ->> 'name')
    else v_subjects ->> p_subject_index end;

  insert into ops.subject_aliases (school_id, class_key, alias_norm, subject_index, subject_label, confirmed_by)
  values (p_school_id, p_class_key, p_alias_norm, p_subject_index, v_label, p_actor_id)
  on conflict (school_id, class_key, alias_norm)
  do update set subject_index = excluded.subject_index,
                subject_label = excluded.subject_label,
                confirmed_by = excluded.confirmed_by;

  v_batch := public.school_log_batch(
    p_school_id, p_actor_id, p_actor_email, 'remember_subject_alias', p_request_id,
    p_class_key, null, null, p_subject_index,
    jsonb_build_object('alias', p_alias, 'subject_index', p_subject_index, 'subject_label', v_label),
    jsonb_build_object('alias', p_alias, 'alias_norm', p_alias_norm)
  );

  return jsonb_build_object(
    'ok', true, 'alias', p_alias, 'subject_index', p_subject_index,
    'subject_label', v_label, 'batch_id', v_batch -> 'batch_id'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Record and correct scores under one batch, with audit + verify.
-- ---------------------------------------------------------------------------
create or replace function public.school_record_scores(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_subject_index integer,
  p_component text,
  p_entries jsonb,
  p_request_id text,
  p_dry_run boolean default false,
  p_allow_overwrite boolean default false,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_subjects jsonb;
  v_subject_label text;
  v_component text := lower(trim(coalesce(p_component, '')));
  v_batch uuid;
  v_entry jsonb;
  v_student uuid;
  v_value numeric;
  v_class text;
  v_archived boolean;
  v_existing_id uuid;
  v_old numeric;
  v_action text;
  v_rows jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
  v_overwrites jsonb := '[]'::jsonb;
  v_dupes jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  -- A second pass over the same pupil is always skipped: the validation pass
  -- already held it, so the preview and the write must skip it too.
  v_processed text[] := '{}';
  v_recorded integer := 0;
  v_skipped integer := 0;
  v_overwritten integer := 0;
  v_blank integer := 0;
  v_held_count integer := 0;
  v_class_size integer := 0;
  v_with_value integer := 0;
  v_all_blank integer := 0;
  v_verify jsonb;
  v_count integer;
begin
  if v_component not in ('ca1', 'ca2', 'ca3', 'exam') then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_COMPONENT_INVALID',
      'error', 'The component must be ca1, ca2, ca3 or exam.',
      'next', 'Call record_scores with component "ca1", "ca2", "ca3" or "exam".'
    );
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_REQUEST_ID_REQUIRED',
      'error', 'A request id is required for an audited write.',
      'next', 'Call record_scores again; the assistant supplies the request id.'
    );
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_ENTRIES_REQUIRED',
      'error', 'There is nothing to record.',
      'next', 'Send the sheet lines to record_scores, or call resolve_students first.'
    );
  end if;

  select config -> 'depts' -> p_class_key -> 'subjects'
    into v_subjects from public.app_config where id = 1;
  if v_subjects is null or jsonb_typeof(v_subjects) <> 'array' then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_CLASS_NOT_FOUND',
      'error', 'That class is not in the subject catalog.',
      'next', 'Call get_school_snapshot to see the real class list.'
    );
  end if;
  if p_subject_index is null or p_subject_index < 0 or p_subject_index >= jsonb_array_length(v_subjects) then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_SUBJECT_INDEX_INVALID',
      'error', 'That subject index is not in the class catalog.',
      'next', 'Call resolve_subject(class, name) and use its stored index.'
    );
  end if;
  v_subject_label := case when jsonb_typeof(v_subjects -> p_subject_index) = 'object'
    then coalesce((v_subjects -> p_subject_index) ->> 'label', (v_subjects -> p_subject_index) ->> 'name')
    else v_subjects ->> p_subject_index end;

  -- Validate the whole sheet before the first write. Two lines that point at
  -- one pupil are never both written; only the first is considered.
  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_student := nullif(v_entry ->> 'student_id', '')::uuid;
    if v_student is null then
      v_held_count := v_held_count + 1;
      v_held := v_held || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'reason', 'no pupil matched'
      ));
      continue;
    end if;
    if v_student::text = any(v_seen) then
      v_held_count := v_held_count + 1;
      v_dupes := v_dupes || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
        'reason', 'two sheet lines name one pupil'
      ));
      continue;
    end if;
    v_seen := array_append(v_seen, v_student::text);

    select class_key, archived into v_class, v_archived from public.students where id = v_student;
    if v_class is null then
      v_held_count := v_held_count + 1;
      v_held := v_held || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'reason', 'pupil not found'
      ));
      continue;
    end if;
    if v_class <> p_class_key or coalesce(v_archived, false) then
      v_held_count := v_held_count + 1;
      v_held := v_held || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name',
        'reason', case when v_class <> p_class_key then 'pupil is in another class' else 'pupil is archived' end
      ));
      continue;
    end if;
  end loop;

  if p_dry_run then
    -- Build the diff without writing.
    v_processed := '{}';
    for v_entry in select * from jsonb_array_elements(p_entries) loop
      v_student := nullif(v_entry ->> 'student_id', '')::uuid;
      if v_student is null then continue; end if;
      if v_student::text = any(v_processed) then continue; end if;
      -- The validation pass held wrong-class and archived pupils. Skip them
      -- here as well so the preview counts match what the write will do.
      select class_key, archived into v_class, v_archived from public.students where id = v_student;
      if v_class is distinct from p_class_key or coalesce(v_archived, false) then continue; end if;
      v_processed := array_append(v_processed, v_student::text);
      if (v_entry ->> 'value') is null or trim(v_entry ->> 'value') = '' then
        v_blank := v_blank + 1;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
          'old', null, 'new', null, 'action', 'blank'
        ));
        continue;
      end if;
      begin
        v_value := (v_entry ->> 'value')::numeric;
      exception when others then
        v_held_count := v_held_count + 1;
        v_held := v_held || jsonb_build_array(jsonb_build_object(
          'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'reason', 'not a number'
        ));
        continue;
      end;
      select id, case v_component
               when 'ca1' then ca1 when 'ca2' then ca2 when 'ca3' then ca3 else exam end
        into v_existing_id, v_old
        from public.scores
       where student_id = v_student
         and subject_index = p_subject_index
         and term = p_term
         and academic_session = p_academic_session
       limit 1;
      if v_old is not null and not p_allow_overwrite then
        v_skipped := v_skipped + 1;
        v_overwrites := v_overwrites || jsonb_build_array(jsonb_build_object(
          'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
          'old', v_old, 'new', v_value
        ));
        v_action := 'skip_existing';
      elsif v_old is not null then
        v_overwritten := v_overwritten + 1;
        v_action := 'overwrite';
      else
        v_recorded := v_recorded + 1;
        v_action := 'record';
      end if;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
        'old', v_old, 'new', v_value, 'action', v_action
      ));
    end loop;

    select count(*) into v_class_size from public.students
     where class_key = p_class_key and academic_session = p_academic_session and coalesce(archived, false) = false;
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'batch_id', null,
      'class_key', p_class_key, 'subject_index', p_subject_index, 'subject_label', v_subject_label,
      'component', v_component, 'class_size', v_class_size,
      'recorded', v_recorded, 'overwritten', v_overwritten,
      'skipped_existing', v_skipped, 'held_back', v_held_count, 'blank', v_blank,
      'rows', v_rows, 'held', v_held, 'duplicates', v_dupes, 'existing', v_overwrites
    );
  end if;

  insert into ops.write_batches (
    school_id, actor_id, actor_email, action, request_id,
    class_key, term, academic_session, subject_index, component, summary
  ) values (
    p_school_id, p_actor_id, p_actor_email, 'record_scores', p_request_id,
    p_class_key, p_term, p_academic_session, p_subject_index, v_component, '{}'::jsonb
  ) returning id into v_batch;

  v_processed := '{}';
  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_student := nullif(v_entry ->> 'student_id', '')::uuid;
    if v_student is null then continue; end if;
    if v_student::text = any(v_processed) then continue; end if;
    -- The validation pass already held duplicates and wrong classes. Keep the
    -- guard here too so a malformed call cannot slip a row through.
    select class_key, archived into v_class, v_archived from public.students where id = v_student;
    if v_class is distinct from p_class_key or coalesce(v_archived, false) then continue; end if;
    v_processed := array_append(v_processed, v_student::text);
    if (v_entry ->> 'value') is null or trim(v_entry ->> 'value') = '' then
      v_blank := v_blank + 1;
      continue;
    end if;
    begin
      v_value := (v_entry ->> 'value')::numeric;
    exception when others then
      v_held_count := v_held_count + 1;
      continue;
    end;

    select id, case v_component
             when 'ca1' then ca1 when 'ca2' then ca2 when 'ca3' then ca3 else exam end
      into v_existing_id, v_old
      from public.scores
     where student_id = v_student
       and subject_index = p_subject_index
       and term = p_term
       and academic_session = p_academic_session
     limit 1;

    if v_old is not null and not p_allow_overwrite then
      v_skipped := v_skipped + 1;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
        'old', v_old, 'new', v_value, 'action', 'skip_existing'
      ));
      continue;
    end if;
    if v_existing_id is not null and v_old is not null then
      v_overwritten := v_overwritten + 1;
      v_action := 'overwrite';
    else
      v_action := 'record';
    end if;

    if v_existing_id is null then
      execute format(
        'insert into public.scores (student_id, class_key, subject_index, term, academic_session, %I) values ($1,$2,$3,$4,$5,$6)',
        v_component
      ) using v_student, p_class_key, p_subject_index, p_term, p_academic_session, v_value;
      v_recorded := v_recorded + 1;
    else
      execute format('update public.scores set %I = $1, updated_at = now() where id = $2', v_component)
        using v_value, v_existing_id;
      if v_action = 'record' then v_recorded := v_recorded + 1; end if;
    end if;

    insert into ops.write_audit (
      batch_id, request_id, school_id, actor_id, actor_email, action,
      student_id, class_key, subject_index, component, old_value, new_value, reason,
      detail
    ) values (
      v_batch, p_request_id, p_school_id, p_actor_id, p_actor_email,
      case when v_action = 'overwrite' then 'overwrite_score' else 'record_score' end,
      v_student, p_class_key, p_subject_index, v_component, v_old, v_value, p_reason,
      jsonb_build_object('line', v_entry -> 'line', 'name', v_entry ->> 'name', 'flags', coalesce(v_entry -> 'flags', '[]'::jsonb))
    );

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'line', v_entry -> 'line', 'name', v_entry ->> 'name', 'student_id', v_student,
      'old', v_old, 'new', v_value, 'action', v_action
    ));
  end loop;

  -- Verify by reading the database back, never by trusting the loop counters.
  select count(*) into v_class_size from public.students
   where class_key = p_class_key and academic_session = p_academic_session and coalesce(archived, false) = false;
  execute format(
    'select count(*) filter (where %I is not null), count(*) filter (where ca1 is null and ca2 is null and ca3 is null and exam is null) from public.scores where class_key = $1 and subject_index = $2 and term = $3 and academic_session = $4',
    v_component
  ) into v_with_value, v_all_blank
  using p_class_key, p_subject_index, p_term, p_academic_session;

  update ops.write_batches
     set summary = jsonb_build_object(
       'recorded', v_recorded, 'overwritten', v_overwritten,
       'skipped_existing', v_skipped, 'held_back', v_held_count,
       'blank', v_blank, 'class_size', v_class_size, 'with_value', v_with_value
     )
   where id = v_batch;

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'batch_id', v_batch,
    'class_key', p_class_key, 'subject_index', p_subject_index, 'subject_label', v_subject_label,
    'component', v_component, 'class_size', v_class_size,
    'recorded', v_recorded, 'overwritten', v_overwritten,
    'skipped_existing', v_skipped, 'held_back', v_held_count, 'blank', v_blank,
    'rows', v_rows, 'held', v_held, 'duplicates', v_dupes, 'existing', v_overwrites,
    'verify', jsonb_build_object(
      'with_value', v_with_value, 'blank_rows', v_all_blank, 'class_size', v_class_size
    ),
    'undo', 'Call undo_batch with this batch_id to reverse every row.',
    'next', 'Re-read the class with get_scores or completeness_report, then report counts.'
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false, 'code', 'SCHOOL_WRITE_FAILED',
      'error', sqlerrm,
      'next', 'Nothing was written. Re-read the class with get_scores, then send the sheet again.'
    );
end;
$$;

create or replace function public.school_correct_score(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_subject_index integer,
  p_component text,
  p_student_id uuid,
  p_new_value numeric,
  p_reason text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_component text := lower(trim(coalesce(p_component, '')));
  v_subjects jsonb;
  v_subject_label text;
  v_batch uuid;
  v_old numeric;
  v_existing_id uuid;
  v_class text;
  v_archived boolean;
  v_with_value integer;
  v_blank_rows integer;
  v_class_size integer;
begin
  if v_component not in ('ca1', 'ca2', 'ca3', 'exam') then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_COMPONENT_INVALID',
      'error', 'The component must be ca1, ca2, ca3 or exam.',
      'next', 'Call correct_score with component "ca1", "ca2", "ca3" or "exam".');
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_REQUEST_ID_REQUIRED',
      'error', 'A request id is required for an audited correction.',
      'next', 'Call correct_score again; the assistant supplies the request id.');
  end if;

  select config -> 'depts' -> p_class_key -> 'subjects' into v_subjects
    from public.app_config where id = 1;
  if v_subjects is null or p_subject_index < 0 or p_subject_index >= jsonb_array_length(v_subjects) then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_SUBJECT_INDEX_INVALID',
      'error', 'That subject index is not in the class catalog.',
      'next', 'Call resolve_subject(class, name) and use its stored index.');
  end if;
  v_subject_label := case when jsonb_typeof(v_subjects -> p_subject_index) = 'object'
    then coalesce((v_subjects -> p_subject_index) ->> 'label', (v_subjects -> p_subject_index) ->> 'name')
    else v_subjects ->> p_subject_index end;

  select class_key, archived into v_class, v_archived from public.students where id = p_student_id;
  if v_class is null or v_class <> p_class_key or coalesce(v_archived, false) then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_STUDENT_CLASS_MISMATCH',
      'error', 'That pupil is not active in this class.',
      'next', 'Call resolve_students(class, names) to get the right pupil.');
  end if;

  select id, case v_component
           when 'ca1' then ca1 when 'ca2' then ca2 when 'ca3' then ca3 else exam end
    into v_existing_id, v_old
    from public.scores
   where student_id = p_student_id
     and subject_index = p_subject_index
     and term = p_term
     and academic_session = p_academic_session
   limit 1;

  insert into ops.write_batches (
    school_id, actor_id, actor_email, action, request_id,
    class_key, term, academic_session, subject_index, component, summary
  ) values (
    p_school_id, p_actor_id, p_actor_email, 'correct_score', p_request_id,
    p_class_key, p_term, p_academic_session, p_subject_index, v_component, '{}'::jsonb
  ) returning id into v_batch;

  if v_existing_id is null then
    execute format(
      'insert into public.scores (student_id, class_key, subject_index, term, academic_session, %I) values ($1,$2,$3,$4,$5,$6)',
      v_component
    ) using p_student_id, p_class_key, p_subject_index, p_term, p_academic_session, p_new_value;
  else
    execute format('update public.scores set %I = $1, updated_at = now() where id = $2', v_component)
      using p_new_value, v_existing_id;
  end if;

  insert into ops.write_audit (
    batch_id, request_id, school_id, actor_id, actor_email, action,
    student_id, class_key, subject_index, component, old_value, new_value, reason
  ) values (
    v_batch, p_request_id, p_school_id, p_actor_id, p_actor_email, 'correct_score',
    p_student_id, p_class_key, p_subject_index, v_component, v_old, p_new_value, p_reason
  );

  select count(*) into v_class_size from public.students
   where class_key = p_class_key and academic_session = p_academic_session and coalesce(archived, false) = false;
  execute format(
    'select count(*) filter (where %I is not null), count(*) filter (where ca1 is null and ca2 is null and ca3 is null and exam is null) from public.scores where class_key = $1 and subject_index = $2 and term = $3 and academic_session = $4',
    v_component
  ) into v_with_value, v_blank_rows
  using p_class_key, p_subject_index, p_term, p_academic_session;

  update ops.write_batches
     set summary = jsonb_build_object('old', v_old, 'new', p_new_value, 'with_value', v_with_value)
   where id = v_batch;

  return jsonb_build_object(
    'ok', true, 'batch_id', v_batch,
    'class_key', p_class_key, 'subject_index', p_subject_index, 'subject_label', v_subject_label,
    'component', v_component, 'old_value', v_old, 'new_value', p_new_value,
    'reason', p_reason,
    'verify', jsonb_build_object('with_value', v_with_value, 'blank_rows', v_blank_rows, 'class_size', v_class_size),
    'undo', 'Call undo_batch with this batch_id to restore the old value.'
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_CORRECTION_FAILED',
      'error', sqlerrm,
      'next', 'Nothing was changed. Read the score again with get_scores, then retry.');
end;
$$;

create or replace function public.school_undo_batch(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_batch_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_batch ops.write_batches;
  v_row record;
  v_restored integer := 0;
  v_removed integer := 0;
  v_left integer;
begin
  select * into v_batch from ops.write_batches where id = p_batch_id and school_id = p_school_id;
  if v_batch.id is null then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_BATCH_NOT_FOUND',
      'error', 'That batch is not here.',
      'next', 'Ask for the last batch with get_school_snapshot, or pass the batch id you were given.');
  end if;
  if v_batch.status = 'undone' then
    return jsonb_build_object('ok', true, 'already_undone', true, 'batch_id', p_batch_id,
      'summary', v_batch.summary);
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_REQUEST_ID_REQUIRED',
      'error', 'A request id is required for an audited undo.',
      'next', 'Call undo_batch again; the assistant supplies the request id.');
  end if;

  -- Reverse in the opposite order so a cell touched twice in one batch ends
  -- at the value it had before the batch began.
  for v_row in
    select * from ops.write_audit
     where batch_id = p_batch_id
       and action in ('record_score', 'overwrite_score', 'correct_score')
     order by created_at desc, id desc
  loop
    if v_row.student_id is null or v_row.subject_index is null or v_row.component is null then
      continue;
    end if;
    if v_row.old_value is null then
      execute format('update public.scores set %I = null, updated_at = now() where student_id = $1 and subject_index = $2 and term = $3 and academic_session = $4', v_row.component)
        using v_row.student_id, v_row.subject_index, v_batch.term, v_batch.academic_session;
      v_restored := v_restored + 1;
    else
      execute format('update public.scores set %I = $1, updated_at = now() where student_id = $2 and subject_index = $3 and term = $4 and academic_session = $5', v_row.component)
        using v_row.old_value, v_row.student_id, v_row.subject_index, v_batch.term, v_batch.academic_session;
      v_restored := v_restored + 1;
    end if;

    -- A row that existed only for this batch is removed, not left as four
    -- empty cells. A row with any other value stays.
    delete from public.scores
     where student_id = v_row.student_id
       and subject_index = v_row.subject_index
       and term = v_batch.term
       and academic_session = v_batch.academic_session
       and ca1 is null and ca2 is null and ca3 is null and exam is null;
    get diagnostics v_left = row_count;
    v_removed := v_removed + v_left;

    insert into ops.write_audit (
      batch_id, request_id, school_id, actor_id, actor_email, action,
      student_id, class_key, subject_index, component, old_value, new_value, reason, detail
    ) values (
      p_batch_id, p_request_id, p_school_id, p_actor_id, p_actor_email, 'undo',
      v_row.student_id, v_batch.class_key, v_row.subject_index, v_row.component,
      v_row.new_value, v_row.old_value, 'Undo of batch ' || p_batch_id,
      jsonb_build_object('source_audit_id', v_row.id)
    );
  end loop;

  update ops.write_batches
     set status = 'undone', undone_at = now(),
         summary = summary || jsonb_build_object('undo_restored', v_restored, 'undo_removed_rows', v_removed)
   where id = p_batch_id;

  return jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'action', v_batch.action,
    'restored', v_restored, 'removed_rows', v_removed,
    'summary', v_batch.summary,
    'next', 'Re-read the class with completeness_report to confirm the counts.'
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_UNDO_FAILED',
      'error', sqlerrm,
      'next', 'Nothing was changed. Read the batch with get_school_snapshot, then retry.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Class approval (one action for the whole class, never per subject page)
-- ---------------------------------------------------------------------------
create or replace function public.school_approve_batch(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_subjects jsonb,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_subjects jsonb;
  v_indexes jsonb := '[]'::jsonb;
  v_count integer;
  v_all boolean := false;
  v_batch jsonb;
begin
  select config -> 'depts' -> p_class_key -> 'subjects' into v_subjects
    from public.app_config where id = 1;
  if v_subjects is null or jsonb_typeof(v_subjects) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_CLASS_NOT_FOUND',
      'error', 'That class is not in the subject catalog.',
      'next', 'Call get_school_snapshot to see the real class list.');
  end if;
  v_count := jsonb_array_length(v_subjects);

  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' or jsonb_array_length(p_subjects) = 0
     or p_subjects @> '["all"]'::jsonb then
    v_all := true;
    select coalesce(jsonb_agg(i), '[]'::jsonb) into v_indexes
      from generate_series(0, v_count - 1) i;
  else
    select coalesce(jsonb_agg(distinct value::integer), '[]'::jsonb) into v_indexes
      from jsonb_array_elements_text(p_subjects) value
     where value ~ '^[0-9]+$' and value::integer >= 0 and value::integer < v_count;
    if jsonb_array_length(v_indexes) = 0 then
      return jsonb_build_object('ok', false, 'code', 'SCHOOL_SUBJECT_INDEX_INVALID',
        'error', 'None of those subject indexes are in the class catalog.',
        'next', 'Call resolve_subject(class, name) and use its stored index, or pass ["all"].');
    end if;
  end if;

  insert into ops.result_approvals (
    school_id, class_key, term, academic_session, subjects, approved_all, approved_by, approved_by_email
  ) values (
    p_school_id, p_class_key, p_term, p_academic_session, v_indexes, v_all, p_actor_id, p_actor_email
  )
  on conflict (school_id, class_key, term, academic_session)
  do update set subjects = excluded.subjects,
                approved_all = excluded.approved_all,
                approved_by = excluded.approved_by,
                approved_by_email = excluded.approved_by_email,
                created_at = now();

  v_batch := public.school_log_batch(
    p_school_id, p_actor_id, p_actor_email, 'approve_batch', p_request_id,
    p_class_key, p_term, p_academic_session, null,
    jsonb_build_object('approved_subjects', jsonb_array_length(v_indexes), 'approved_all', v_all),
    jsonb_build_object('subjects', v_indexes, 'approved_all', v_all)
  );

  return jsonb_build_object(
    'ok', true, 'approved', true, 'batch_id', v_batch -> 'batch_id',
    'class_key', p_class_key, 'term', p_term, 'academic_session', p_academic_session,
    'subjects_approved', jsonb_array_length(v_indexes), 'approved_all', v_all,
    'next', 'Generate with mode="final" now; previews still need no approval.'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Publish / unpublish through the same batch trail
-- ---------------------------------------------------------------------------
create or replace function public.school_set_published(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_subject_indexes jsonb,
  p_published boolean,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_subjects jsonb;
  v_idx integer;
  v_count integer := 0;
  v_batch jsonb;
begin
  select config -> 'depts' -> p_class_key -> 'subjects' into v_subjects
    from public.app_config where id = 1;
  if v_subjects is null or jsonb_typeof(v_subjects) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_CLASS_NOT_FOUND',
      'error', 'That class is not in the subject catalog.',
      'next', 'Call get_school_snapshot to see the real class list.');
  end if;
  if p_subject_indexes is null or jsonb_typeof(p_subject_indexes) <> 'array'
     or jsonb_array_length(p_subject_indexes) = 0 or p_subject_indexes @> '["all"]'::jsonb then
    p_subject_indexes := (select coalesce(jsonb_agg(i), '[]'::jsonb) from generate_series(0, jsonb_array_length(v_subjects) - 1) i);
  end if;

  for v_idx in select distinct value::integer from jsonb_array_elements_text(p_subject_indexes) value
               where value ~ '^[0-9]+$' and value::integer >= 0 and value::integer < jsonb_array_length(v_subjects)
  loop
    if p_published then
      insert into public.published_subjects (class_key, subject_index, term, academic_session, published)
      values (p_class_key, v_idx, p_term, p_academic_session, true)
      on conflict (class_key, subject_index, term, academic_session)
      do update set published = true;
    else
      delete from public.published_subjects
       where class_key = p_class_key and subject_index = v_idx
         and term = p_term and academic_session = p_academic_session;
    end if;
    v_count := v_count + 1;
  end loop;

  v_batch := public.school_log_batch(
    p_school_id, p_actor_id, p_actor_email,
    case when p_published then 'publish_results' else 'unpublish_results' end,
    p_request_id, p_class_key, p_term, p_academic_session, null,
    jsonb_build_object('published', p_published, 'subjects', v_count),
    jsonb_build_object('subject_indexes', p_subject_indexes)
  );

  return jsonb_build_object(
    'ok', true, 'batch_id', v_batch -> 'batch_id',
    'published', p_published, 'subjects_changed', v_count,
    'class_key', p_class_key, 'term', p_term
  );
end;
$$;

create or replace function public.school_last_batch(p_school_id uuid)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select coalesce(
    (select to_jsonb(b) from ops.write_batches b
      where b.school_id = p_school_id
      order by b.created_at desc limit 1),
    'null'::jsonb
  );
end;

create or replace function public.school_name_aliases(
  p_school_id uuid,
  p_class_key text default null
)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select coalesce(jsonb_agg(jsonb_build_object(
    'class_key', a.class_key, 'alias_norm', a.alias_norm,
    'student_id', a.student_id, 'times_used', a.times_used
  ) order by a.class_key, a.alias_norm), '[]'::jsonb)
  from ops.name_aliases a
  where a.school_id = p_school_id
    and (p_class_key is null or a.class_key = p_class_key);
end;

create or replace function public.school_subject_aliases(
  p_school_id uuid,
  p_class_key text default null
)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select coalesce(jsonb_agg(jsonb_build_object(
    'class_key', a.class_key, 'alias_norm', a.alias_norm,
    'subject_index', a.subject_index, 'subject_label', a.subject_label
  ) order by a.class_key, a.alias_norm), '[]'::jsonb)
  from ops.subject_aliases a
  where a.school_id = p_school_id
    and (p_class_key is null or a.class_key = p_class_key);
end;

create or replace function public.school_result_approval(
  p_school_id uuid,
  p_class_key text,
  p_term text,
  p_academic_session text
)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select coalesce(
    (select to_jsonb(a) from ops.result_approvals a
      where a.school_id = p_school_id
        and a.class_key = p_class_key
        and a.term = p_term
        and a.academic_session = p_academic_session
      limit 1),
    'null'::jsonb
  );
end;

create or replace function public.school_batches(p_school_id uuid, p_limit integer default 10)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select coalesce(jsonb_agg(jsonb_build_object(
    'batch_id', b.id, 'action', b.action, 'status', b.status,
    'class_key', b.class_key, 'term', b.term, 'subject_index', b.subject_index,
    'component', b.component, 'summary', b.summary, 'created_at', b.created_at,
    'undone_at', b.undone_at
  ) order by b.created_at desc), '[]'::jsonb)
  from (
    select * from ops.write_batches
     where school_id = p_school_id
     order by created_at desc
     limit greatest(coalesce(p_limit, 10), 1)
  ) b;
end;

-- ---------------------------------------------------------------------------
-- 7. Preview / final document storage
-- ---------------------------------------------------------------------------
create or replace function public.school_store_document(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_template text,
  p_kind text,
  p_mode text,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_page_count integer,
  p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_id uuid;
  v_size integer;
begin
  if p_kind not in ('cards', 'broadsheet') then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_KIND_INVALID',
      'error', 'The document kind must be cards or broadsheet.',
      'next', 'Call generate_documents with kind "cards" or "broadsheet".');
  end if;
  if p_mode not in ('sample', 'final') then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_MODE_INVALID',
      'error', 'The mode must be sample or final.',
      'next', 'Call generate_documents with mode "sample" or "final".');
  end if;
  if p_content_b64 is null or length(p_content_b64) < 100 then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_EMPTY',
      'error', 'The document was empty.',
      'next', 'Render again; nothing was stored.');
  end if;

  insert into ops.generated_documents (
    school_id, actor_id, actor_email, class_key, term, academic_session,
    template, kind, mode, filename, mime, page_count, byte_size, sha256, summary, content
  ) values (
    p_school_id, p_actor_id, p_actor_email, p_class_key, p_term, p_academic_session,
    coalesce(p_template, 'modern'), p_kind, p_mode, p_filename, coalesce(p_mime, 'application/pdf'),
    p_page_count, octet_length(decode(p_content_b64, 'base64')), p_sha256,
    coalesce(p_summary, '{}'::jsonb), decode(p_content_b64, 'base64')
  ) returning id, byte_size into v_id, v_size;

  -- Keep the private bucket small: a generated preview is disposable.
  delete from ops.generated_documents
   where created_at < now() - interval '2 days';

  return jsonb_build_object(
    'ok', true, 'document_id', v_id, 'filename', p_filename, 'byte_size', v_size,
    'url', '/api/ops-jobs?document=' || v_id
  );
end;
$$;

create or replace function public.school_get_document(p_id uuid)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'document_id', d.id,
    'filename', d.filename,
    'mime', d.mime,
    'kind', d.kind,
    'mode', d.mode,
    'page_count', d.page_count,
    'summary', d.summary,
    'content_b64', encode(d.content, 'base64')
  )
  from ops.generated_documents d where d.id = p_id;
end;

-- ---------------------------------------------------------------------------
-- 8. Grants: service role only. The assistant runs on the server.
-- ---------------------------------------------------------------------------
revoke all on function public.school_log_batch(uuid, uuid, text, text, text, text, text, text, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.school_remember_alias(uuid, uuid, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.school_subject_alias(uuid, uuid, text, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.school_record_scores(uuid, uuid, text, text, text, text, integer, text, jsonb, text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.school_correct_score(uuid, uuid, text, text, text, text, integer, text, uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.school_undo_batch(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.school_approve_batch(uuid, uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.school_set_published(uuid, uuid, text, text, text, text, jsonb, boolean, text) from public, anon, authenticated;
revoke all on function public.school_last_batch(uuid) from public, anon, authenticated;
revoke all on function public.school_name_aliases(uuid, text) from public, anon, authenticated;
revoke all on function public.school_subject_aliases(uuid, text) from public, anon, authenticated;
revoke all on function public.school_result_approval(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.school_batches(uuid, integer) from public, anon, authenticated;
revoke all on function public.school_store_document(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.school_get_document(uuid) from public, anon, authenticated;

grant execute on function public.school_log_batch(uuid, uuid, text, text, text, text, text, text, integer, jsonb, jsonb) to service_role;
grant execute on function public.school_remember_alias(uuid, uuid, text, text, text, text, uuid, text) to service_role;
grant execute on function public.school_subject_alias(uuid, uuid, text, text, text, text, integer, text) to service_role;
grant execute on function public.school_record_scores(uuid, uuid, text, text, text, text, integer, text, jsonb, text, boolean, boolean, text) to service_role;
grant execute on function public.school_correct_score(uuid, uuid, text, text, text, text, integer, text, uuid, numeric, text, text) to service_role;
grant execute on function public.school_undo_batch(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.school_approve_batch(uuid, uuid, text, text, text, text, jsonb, text) to service_role;
grant execute on function public.school_set_published(uuid, uuid, text, text, text, text, jsonb, boolean, text) to service_role;
grant execute on function public.school_last_batch(uuid) to service_role;
grant execute on function public.school_name_aliases(uuid, text) to service_role;
grant execute on function public.school_subject_aliases(uuid, text) to service_role;
grant execute on function public.school_result_approval(uuid, text, text, text) to service_role;
grant execute on function public.school_batches(uuid, integer) to service_role;
grant execute on function public.school_store_document(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer, jsonb) to service_role;
grant execute on function public.school_get_document(uuid) to service_role;
