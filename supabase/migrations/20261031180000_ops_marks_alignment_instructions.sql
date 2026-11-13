-- Pilot step 4: marks, four-list name alignment, provider roles, free-text
-- instructions, individual entry and a blocked pupil proposal.
--
-- ADDITIVE: everything lives in schema ops, plus replacements for the pilot's
-- own public wrappers (same signatures, same grants). No school-loaded file or
-- table is touched. No live writes: public.students and public.scores are
-- never written here.
--
-- Reversal is still one statement:  drop schema if exists ops cascade;

begin;

-- ---------------------------------------------------------------------------
-- 1. Provider roles. A reader may look at handwriting; an assistant may only
--    read typed text and must never be the thing that reads a page.
--    Manual stays at priority 1000 and is a reader of last resort.
-- ---------------------------------------------------------------------------
alter table ops.providers add column if not exists role text not null default 'reader';

alter table ops.providers drop constraint if exists providers_role_check;
alter table ops.providers
  add constraint providers_role_check check (role in ('reader', 'assistant'));

comment on column ops.providers.role is
  'reader = may look at handwriting; assistant = typed text only, never handwriting.';

-- The current agent reader: this is the model that actually read job 9dec48c2.
update ops.providers
   set role = 'reader',
       model = coalesce(model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017'),
       updated_at = now()
 where adapter = 'openbot_agent';

-- The chat assistant is the same OpenBot agent but a different role. It records
-- its own adapter/model on every job it answers, and is never selected to read.
insert into ops.providers (label, kind, adapter, model, key_ref, priority, enabled, role)
values ('OpenBot assistant', 'agent', 'openbot_agent', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', null, 10, true, 'assistant')
on conflict (label) do update
   set kind = 'agent', adapter = 'openbot_agent',
       model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
       role = 'assistant', enabled = true, updated_at = now();

-- A keyed vision reader. key_ref is a variable NAME, never a value. It starts
-- disabled so the working agent reader stays first until the switch is made.
insert into ops.providers (label, kind, adapter, model, key_ref, priority, enabled, role)
values ('Gemini vision reader', 'api', 'gemini_vision',
        coalesce(nullif(current_setting('ops.gemini_model', true), ''), 'gemini-3.1-flash-lite'),
        'FIRST_CHOICE_GEMINI_API_KEY', 20, false, 'reader')
on conflict (label) do update
   set kind = 'api', adapter = 'gemini_vision',
       key_ref = 'FIRST_CHOICE_GEMINI_API_KEY',
       role = 'reader', updated_at = now();

update ops.providers set role = 'reader' where adapter = 'manual';

-- The old job already records its adapter; give it the model it actually ran on.
update ops.jobs
   set model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
 where adapter = 'openbot_agent' and model is null;

-- ---------------------------------------------------------------------------
-- 2. Job-level fields: the assistant role, the parsed instruction, the marks
--    totals and the alignment result all live on the job.
-- ---------------------------------------------------------------------------
alter table ops.jobs add column if not exists assistant_adapter text;
alter table ops.jobs add column if not exists assistant_model   text;
alter table ops.jobs add column if not exists instruction_parsed jsonb;
alter table ops.jobs add column if not exists marks_summary jsonb;
alter table ops.jobs add column if not exists alignment jsonb;

comment on column ops.jobs.assistant_model is
  'Model that handled the typed instruction. It must never be the handwriting reader.';

-- ---------------------------------------------------------------------------
-- 3. Alignment fields on a staged row. A, B and C are per row; D lives on the
--    job because it is a pupil with no row on the sheet.
-- ---------------------------------------------------------------------------
alter table ops.staged_rows add column if not exists match_list text;
alter table ops.staged_rows add column if not exists surname_score numeric;
alter table ops.staged_rows add column if not exists first_score numeric;
alter table ops.staged_rows add column if not exists candidate_names jsonb not null default '[]'::jsonb;

alter table ops.staged_rows drop constraint if exists staged_rows_match_list_check;
alter table ops.staged_rows
  add constraint staged_rows_match_list_check check (match_list is null or match_list in ('A', 'B', 'C'));

alter table ops.staged_rows drop constraint if exists staged_rows_scores_check;
alter table ops.staged_rows
  add constraint staged_rows_scores_check check (
    (surname_score is null or (surname_score >= 0 and surname_score <= 1)) and
    (first_score is null or (first_score >= 0 and first_score <= 1))
  );

-- ---------------------------------------------------------------------------
-- 4. One mark per printed column per row. Never a positional index.
-- ---------------------------------------------------------------------------
create table if not exists ops.staged_marks (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references ops.jobs(id) on delete cascade,
  staged_row_id uuid not null references ops.staged_rows(id) on delete cascade,
  column_group  text not null default '1ST TERM',
  column_label  text not null,
  value         numeric,
  status        text not null default 'read',
  candidates    jsonb not null default '[]'::jsonb,
  confidence    numeric,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (staged_row_id, column_group, column_label)
);

alter table ops.staged_marks drop constraint if exists staged_marks_status_check;
alter table ops.staged_marks
  add constraint staged_marks_status_check check (status in ('read', 'blank', 'ambiguous', 'rejected'));

alter table ops.staged_marks drop constraint if exists staged_marks_value_check;
alter table ops.staged_marks
  add constraint staged_marks_value_check check (
    (value is null or (value >= 0 and value <= 100)) and
    ((status = 'read' and value is not null) or (status <> 'read' and value is null))
  );

alter table ops.staged_marks drop constraint if exists staged_marks_confidence_check;
alter table ops.staged_marks
  add constraint staged_marks_confidence_check check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  );

create index if not exists ops_staged_marks_job_idx on ops.staged_marks (job_id, staged_row_id);

comment on table ops.staged_marks is
  'Marks staged under the printed column label for one job. A blank is blank, never zero.';

-- ---------------------------------------------------------------------------
-- 5. A proposed new pupil. This is a proposal only; creating a pupil is a live
--    write and remains blocked while live writes are off.
-- ---------------------------------------------------------------------------
create table if not exists ops.pupil_proposals (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references ops.jobs(id) on delete cascade,
  name        text,
  class_key   text,
  admno       text,
  fields      jsonb not null default '{}'::jsonb,
  status      text not null default 'proposed',
  reason      text,
  created_at  timestamptz not null default now()
);

alter table ops.pupil_proposals drop constraint if exists pupil_proposals_status_check;
alter table ops.pupil_proposals
  add constraint pupil_proposals_status_check check (status in ('proposed', 'blocked', 'withdrawn'));

comment on table ops.pupil_proposals is
  'A new pupil suggested by text or photo. Never written to public.students in this pilot.';

-- ---------------------------------------------------------------------------
-- 6. Active context, in one place: the portal's current class, term and
--    session, plus the school's own class and subject catalogue.
-- ---------------------------------------------------------------------------
create or replace function ops.class_section(p_class_key text)
returns text
language sql
immutable
as $$
  select case
    when p_class_key like 'jss%' then 'Junior secondary'
    when p_class_key like 'ss%' then 'Senior secondary'
    when p_class_key like 'primary%' then 'Primary'
    when p_class_key in ('creche', 'nursery1', 'nursery2', 'kg1', 'kg2') then 'Early childhood'
    else 'School'
  end;
$$;

create or replace function ops.active_context()
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_class   text;
  v_session text;
  v_term    text;
  v_depts   jsonb;
  v_subject jsonb;
begin
  select class_key, academic_session, term
    into v_class, v_session, v_term
    from public.academic_context where id = 1;

  select config -> 'depts' into v_depts from public.app_config where id = 1;
  v_depts := coalesce(v_depts, '{}'::jsonb);

  select to_jsonb(s) into v_subject
    from ops.subjects s
   where s.class_key = v_class
   order by s.subject_key
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'class_key', v_class,
    'class_label', coalesce(v_depts -> v_class ->> 'label', v_class),
    'academic_session', v_session,
    'term', v_term,
    'section', ops.class_section(v_class),
    'subject_key', v_subject ->> 'subject_key',
    'subject_label', coalesce(v_subject ->> 'subject_label', v_subject ->> 'label'),
    'classes', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'key', d.key,
          'label', d.value ->> 'label',
          'section', ops.class_section(d.key),
          'subjects', coalesce(d.value -> 'subjects', '[]'::jsonb)
        ) order by d.value ->> 'label')
       from jsonb_each(v_depts) d),
      '[]'::jsonb)
  );
end;
$$;

revoke all on function ops.active_context() from public, anon, authenticated;
grant execute on function ops.active_context() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Reader selection. The lowest-priority enabled reader is recorded on the
--    job, with its model, before the worker is asked to run.
-- ---------------------------------------------------------------------------
create or replace function ops.queue_reader(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_provider ops.providers;
  v_job      ops.jobs;
begin
  select * into v_provider
    from ops.providers
   where role = 'reader' and enabled = true
   order by priority asc, created_at asc
   limit 1;

  if v_provider.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_NO_READER');
  end if;

  update ops.jobs
     set adapter    = v_provider.adapter,
         model      = v_provider.model,
         updated_at = now()
   where id = p_job_id
     and status in ('draft', 'queued')
   returning * into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_QUEUED');
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (v_job.id, '00000000-0000-0000-0000-000000000000'::uuid, 'intake',
          'job.reader_selected', 'ops.providers', v_provider.id,
          jsonb_build_object('provider', v_provider.label, 'adapter', v_provider.adapter,
                             'model', v_provider.model, 'role', v_provider.role,
                             'priority', v_provider.priority));

  return jsonb_build_object('ok', true, 'provider', to_jsonb(v_provider), 'job', to_jsonb(v_job));
end;
$$;

revoke all on function ops.queue_reader(uuid) from public, anon, authenticated;
grant execute on function ops.queue_reader(uuid) to service_role;

create or replace function ops.record_assistant(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_provider ops.providers;
  v_job      ops.jobs;
begin
  select * into v_provider
    from ops.providers
   where role = 'assistant' and enabled = true
   order by priority asc, created_at asc
   limit 1;

  if v_provider.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_NO_ASSISTANT');
  end if;

  update ops.jobs
     set assistant_adapter = v_provider.adapter,
         assistant_model   = v_provider.model,
         updated_at        = now()
   where id = p_job_id
   returning * into v_job;

  return jsonb_build_object('ok', true, 'provider', to_jsonb(v_provider), 'job', to_jsonb(v_job));
end;
$$;

revoke all on function ops.record_assistant(uuid) from public, anon, authenticated;
grant execute on function ops.record_assistant(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Marks summary is recomputed from the cells, never typed in by hand.
-- ---------------------------------------------------------------------------
create or replace function ops.refresh_marks_summary(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_cells      integer := 0;
  v_read       integer := 0;
  v_blank      integer := 0;
  v_ambiguous  integer := 0;
  v_rejected   integer := 0;
  v_rows       integer := 0;
  v_rows_full  integer := 0;
  v_columns    jsonb := '[]'::jsonb;
  v_summary    jsonb;
  v_pending    integer := 0;
begin
  select count(*),
         count(*) filter (where status = 'read'),
         count(*) filter (where status = 'blank'),
         count(*) filter (where status = 'ambiguous'),
         count(*) filter (where status = 'rejected'),
         count(distinct staged_row_id),
         count(distinct staged_row_id) filter (where status in ('ambiguous', 'rejected')),
         coalesce((select jsonb_agg(distinct column_label order by column_label)
                     from ops.staged_marks where job_id = p_job_id), '[]'::jsonb)
    into v_cells, v_read, v_blank, v_ambiguous, v_rejected, v_rows, v_rows_full, v_columns
    from ops.staged_marks
   where job_id = p_job_id;

  v_rows_full := greatest(0, v_rows - v_rows_full);

  v_summary := jsonb_build_object(
    'cells', v_cells,
    'read', v_read,
    'blank', v_blank,
    'ambiguous', v_ambiguous,
    'rejected', v_rejected,
    'rows', v_rows,
    'rows_full', v_rows_full,
    'columns', v_columns,
    'line', 'Marks read: ' || v_read || ' of ' || v_cells || ' cells · '
            || (v_ambiguous + v_rejected)
            || case when (v_ambiguous + v_rejected) = 1 then ' needs your eye' else ' need your eye' end
  );

  -- A job is not ready to approve while a name or a mark cell is still open.
  -- The line counts read cells only; an ambiguous cell is not read yet.
  select count(*) into v_pending
    from ops.staged_rows
   where job_id = p_job_id and status = 'pending';

  update ops.jobs
     set marks_summary = v_summary,
         status = case
           when v_pending > 0 then 'needs_input'
           when (v_ambiguous + v_rejected) > 0 then 'needs_input'
           when status in ('draft', 'queued', 'processing', 'needs_input') then 'needs_review'
           else status
         end,
         updated_at = now()
   where id = p_job_id;

  return v_summary;
end;
$$;

revoke all on function ops.refresh_marks_summary(uuid) from public, anon, authenticated;
grant execute on function ops.refresh_marks_summary(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Stage marks by row and printed column label. Values outside 0..100 and
--    non-marks are rejected as a cell, never as the job.
-- ---------------------------------------------------------------------------
create or replace function ops.stage_marks(p_job_id uuid, p_marks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job       ops.jobs;
  v_mark      jsonb;
  v_row_id    uuid;
  v_status    text;
  v_value     numeric;
  v_conf      numeric;
  v_group     text;
  v_label     text;
  v_cands     jsonb;
  v_summary   jsonb;
begin
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARKS_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  delete from ops.staged_marks where job_id = p_job_id;

  for v_mark in select value from jsonb_array_elements(p_marks) loop
    v_row_id := nullif(btrim(coalesce(v_mark ->> 'staged_row_id', '')), '')::uuid;

    if v_row_id is null and (v_mark ->> 'row_no') ~ '^[0-9]+$' then
      select id into v_row_id
        from ops.staged_rows
       where job_id = p_job_id and row_no = (v_mark ->> 'row_no')::integer
       limit 1;
    end if;

    if v_row_id is null then
      continue;
    end if;

    v_status := lower(coalesce(nullif(btrim(v_mark ->> 'status'), ''), 'read'));
    if v_status not in ('read', 'blank', 'ambiguous', 'rejected') then
      v_status := 'rejected';
    end if;

    v_value := case when (v_mark ->> 'value') ~ '^[0-9]+([.][0-9]+)?$'
                    then (v_mark ->> 'value')::numeric else null end;
    if v_status = 'read' and (v_value is null or v_value < 0 or v_value > 100) then
      v_status := 'rejected';
    end if;
    if v_status <> 'read' then
      v_value := null;
    end if;

    v_conf := case when (v_mark ->> 'confidence') ~ '^[0-9]*[.]?[0-9]+$'
                   then (v_mark ->> 'confidence')::numeric else null end;
    if v_conf is not null and (v_conf < 0 or v_conf > 1) then
      v_conf := null;
    end if;

    v_group := left(coalesce(nullif(btrim(v_mark ->> 'column_group'), ''), '1ST TERM'), 80);
    v_label := left(coalesce(nullif(btrim(v_mark ->> 'column_label'), ''), ''), 80);
    if v_label = '' then
      continue;
    end if;

    v_cands := case when jsonb_typeof(v_mark -> 'candidates') = 'array'
                    then v_mark -> 'candidates' else '[]'::jsonb end;

    insert into ops.staged_marks (
      job_id, staged_row_id, column_group, column_label, value, status,
      candidates, confidence, note
    ) values (
      p_job_id, v_row_id, v_group, v_label, v_value, v_status,
      v_cands, v_conf, left(nullif(btrim(v_mark ->> 'note'), ''), 500)
    )
    on conflict (staged_row_id, column_group, column_label) do update
       set value = excluded.value,
           status = excluded.status,
           candidates = excluded.candidates,
           confidence = excluded.confidence,
           note = excluded.note,
           updated_at = now();
  end loop;

  v_summary := ops.refresh_marks_summary(p_job_id);

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'marks.staged', 'ops.staged_marks', p_job_id, v_summary);

  return jsonb_build_object('ok', true, 'summary', v_summary);
end;
$$;

revoke all on function ops.stage_marks(uuid, jsonb) from public, anon, authenticated;
grant execute on function ops.stage_marks(uuid, jsonb) to service_role;

-- Resolve one ambiguous cell: the human picks the value, or keeps it blank.
create or replace function ops.decide_mark(
  p_job_id uuid,
  p_mark_id uuid,
  p_value numeric,
  p_status text,
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
  v_mark ops.staged_marks;
  v_stat text := lower(coalesce(nullif(btrim(p_status), ''), 'read'));
  v_summary jsonb;
  v_pending integer := 0;
  v_marks integer := 0;
begin
  if v_stat not in ('read', 'blank') then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_STATUS_INVALID');
  end if;
  if v_stat = 'read' and (p_value is null or p_value < 0 or p_value > 100) then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_VALUE_INVALID');
  end if;

  update ops.staged_marks
     set value = case when v_stat = 'read' then p_value else null end,
         status = v_stat,
         candidates = '[]'::jsonb,
         note = left(coalesce(nullif(btrim(p_note), ''), note), 500),
         updated_at = now()
   where id = p_mark_id and job_id = p_job_id
   returning * into v_mark;

  if v_mark.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_NOT_FOUND');
  end if;

  v_summary := ops.refresh_marks_summary(p_job_id);

  select count(*) into v_pending
    from ops.staged_rows
   where job_id = p_job_id and status = 'pending';
  select count(*) into v_marks
    from ops.staged_marks
   where job_id = p_job_id and status in ('ambiguous', 'rejected');

  update ops.jobs
     set status = case when v_pending > 0 or v_marks > 0 then 'needs_input' else 'needs_review' end,
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'mark.decided', 'ops.staged_marks', v_mark.id,
          jsonb_build_object('column_group', v_mark.column_group, 'column_label', v_mark.column_label,
                             'status', v_mark.status, 'value', v_mark.value,
                             'summary', v_summary));

  return jsonb_build_object('ok', true, 'mark', to_jsonb(v_mark), 'summary', v_summary);
end;
$$;

revoke all on function ops.decide_mark(uuid, uuid, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function ops.decide_mark(uuid, uuid, numeric, text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Four-list alignment. A is accepted, B is suggested only, C is a sheet
--     name with no portal pupil, D is a portal pupil with no sheet line.
--     D is stored on the job; the RPC is idempotent.
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
-- 11. Instruction record and pupil proposal.
-- ---------------------------------------------------------------------------
create or replace function ops.save_instruction(p_job_id uuid, p_raw text, p_parsed jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
  v_old_class text;
  v_rows integer;
begin
  -- The first sentence is the job's instruction; later sentences are notes on
  -- it. Keep the original raw text, and keep the latest parsed result.
  select class_key,
         (select count(*) from ops.staged_rows where job_id = p_job_id)
    into v_old_class, v_rows
    from ops.jobs where id = p_job_id;

  update ops.jobs
     set instruction = case when instruction is null or btrim(instruction) = ''
                            then left(coalesce(p_raw, ''), 4000) else instruction end,
         instruction_parsed = coalesce(p_parsed, instruction_parsed)
                              || jsonb_build_object('raw', left(coalesce(p_raw, ''), 4000)),
         -- Class and term may follow a photo, but only before a reader has
         -- staged rows. Once rows exist the frozen class list is the truth.
         class_key = case when v_rows = 0
                          then coalesce(nullif(p_parsed ->> 'class_key', ''), class_key)
                          else class_key end,
         term = case when v_rows = 0
                     then coalesce(nullif(p_parsed ->> 'term', ''), term)
                     else term end,
         academic_session = case when v_rows = 0
                                 then coalesce(nullif(p_parsed ->> 'academic_session', ''), academic_session)
                                 else academic_session end,
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  -- If the sentence moved the job to another class before any row existed,
  -- freeze that class list now, so the reader matches against the right one.
  if v_rows = 0 and v_job.class_key is distinct from v_old_class then
    perform ops.snapshot_roster(p_job_id, v_job.class_key);
    select * into v_job from ops.jobs where id = p_job_id;
  end if;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'instruction.parsed', 'ops.jobs', p_job_id,
          jsonb_build_object('parsed', p_parsed, 'raw', left(coalesce(p_raw, ''), 4000)));

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

revoke all on function ops.save_instruction(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function ops.save_instruction(uuid, text, jsonb) to service_role;

create or replace function ops.propose_pupil(p_job_id uuid, p_proposal jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job ops.jobs;
  v_row ops.pupil_proposals;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  insert into ops.pupil_proposals (job_id, name, class_key, admno, fields, status, reason)
  values (
    p_job_id,
    left(nullif(btrim(coalesce(p_proposal ->> 'name', '')), ''), 200),
    left(nullif(btrim(coalesce(p_proposal ->> 'class_key', '')), ''), 80),
    left(nullif(btrim(coalesce(p_proposal ->> 'admno', '')), ''), 80),
    case when jsonb_typeof(p_proposal -> 'fields') = 'object' then p_proposal -> 'fields' else '{}'::jsonb end,
    'blocked',
    'Creating a pupil is a live write. It stays blocked until live writes are turned on.'
  )
  returning * into v_row;

  update ops.jobs
     set status = 'needs_input',
         last_error = 'New pupil held as a proposal. Creating a pupil is a live write and is still blocked.',
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'pupil.proposed', 'ops.pupil_proposals', v_row.id,
          jsonb_build_object('name', v_row.name, 'class_key', v_row.class_key,
                             'status', v_row.status, 'public_write', false));

  return jsonb_build_object('ok', true, 'proposal', to_jsonb(v_row), 'live_write', false,
                            'message', 'New pupil held as a proposal. Creating a pupil is blocked until live writes are on.');
end;
$$;

revoke all on function ops.propose_pupil(uuid, jsonb) from public, anon, authenticated;
grant execute on function ops.propose_pupil(uuid, jsonb) to service_role;

-- One pupil, one mark, no photo. The same staged row and the same approval gate
-- as a photo job; public.scores is never written.
create or replace function ops.stage_individual(
  p_job_id uuid,
  p_name text,
  p_mark numeric,
  p_column_group text,
  p_column_label text,
  p_subject_key text,
  p_subject_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job       ops.jobs;
  v_student   uuid;
  v_admno     text;
  v_name      text;
  v_count     integer;
  v_row       ops.staged_rows;
  v_mark      ops.staged_marks;
  v_summary   jsonb;
begin
  if p_mark is null or p_mark < 0 or p_mark > 100 then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_VALUE_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;

  -- Exact full name first; then a single token that matches exactly one pupil.
  select count(*) into v_count
    from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
   where rs.job_id = p_job_id
     and upper(regexp_replace(p ->> 'name', '\s+', ' ', 'g')) = upper(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));

  if v_count = 1 then
    select (p ->> 'id')::uuid, p ->> 'name', p ->> 'admno'
      into v_student, v_name, v_admno
      from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
     where rs.job_id = p_job_id
       and upper(regexp_replace(p ->> 'name', '\s+', ' ', 'g')) = upper(regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
     limit 1;
  else
    select count(*) into v_count
      from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
     where rs.job_id = p_job_id
       and (upper(p ->> 'name') like '% ' || upper(btrim(p_name)) || ' %'
            or upper(p ->> 'name') like upper(btrim(p_name)) || ' %');
    if v_count = 1 then
      select (p ->> 'id')::uuid, p ->> 'name', p ->> 'admno'
        into v_student, v_name, v_admno
        from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
       where rs.job_id = p_job_id
         and (upper(p ->> 'name') like '% ' || upper(btrim(p_name)) || ' %'
              or upper(p ->> 'name') like upper(btrim(p_name)) || ' %')
       limit 1;
    end if;
  end if;

  insert into ops.staged_rows (
    job_id, row_no, student_id, admno, student_name_raw, match_method,
    match_confidence, subject_key, subject_label, component, value, confidence,
    status, flag, match_list
  ) values (
    p_job_id,
    coalesce((select max(row_no) + 1 from ops.staged_rows where job_id = p_job_id), 1),
    v_student, v_admno, left(btrim(p_name), 300),
    case when v_student is not null then 'name' else 'none' end,
    case when v_student is not null then 1 else null end,
    nullif(btrim(p_subject_key), ''), nullif(btrim(p_subject_label), ''),
    'ca1', p_mark, case when v_student is not null then 1 else null end,
    case when v_student is not null then 'accepted' else 'pending' end,
    case when v_student is not null then null else 'no_confident_match' end,
    case when v_student is not null then 'A' else 'C' end
  )
  returning * into v_row;

  insert into ops.staged_marks (
    job_id, staged_row_id, column_group, column_label, value, status, confidence
  ) values (
    p_job_id, v_row.id,
    left(coalesce(nullif(btrim(p_column_group), ''), '1ST TERM'), 80),
    left(coalesce(nullif(btrim(p_column_label), ''), 'CLASS EXERCISE'), 80),
    p_mark, 'read', case when v_student is not null then 1 else null end
  )
  returning * into v_mark;

  v_summary := ops.refresh_marks_summary(p_job_id);

  update ops.jobs
     set status = case when v_student is not null then 'needs_review' else 'needs_input' end,
         last_error = case when v_student is null
                           then 'No pupil called ' || left(btrim(p_name), 100) || ' in this class list; the mark is held for you.'
                           else null end,
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, '00000000-0000-0000-0000-000000000000'::uuid, 'openbot_agent',
          'mark.individual', 'ops.staged_marks', v_mark.id,
          jsonb_build_object('name', p_name, 'pupil', v_name, 'mark', p_mark,
                             'column', p_column_label, 'matched', v_student is not null,
                             'public_write', false));

  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row), 'mark', to_jsonb(v_mark),
                            'summary', v_summary, 'matched', v_student is not null,
                            'live_write', false);
end;
$$;

revoke all on function ops.stage_individual(uuid, text, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function ops.stage_individual(uuid, text, numeric, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Approval gate now also waits for ambiguous or rejected mark cells.
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

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'decision', to_jsonb(v_decision),
                            'live_write', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Public wrappers. Service_role only, same rule as every other door.
-- ---------------------------------------------------------------------------
create or replace function public.ops_active_context()
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.active_context();
end;

create or replace function public.ops_queue_reader(p_job_id uuid)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.queue_reader(p_job_id);
end;

create or replace function public.ops_record_assistant(p_job_id uuid)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.record_assistant(p_job_id);
end;

create or replace function public.ops_stage_marks(p_job_id uuid, p_marks jsonb)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.stage_marks(p_job_id, p_marks);
end;

create or replace function public.ops_decide_mark(
  p_job_id uuid, p_mark_id uuid, p_value numeric, p_status text,
  p_actor uuid, p_actor_email text, p_note text default null
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.decide_mark(p_job_id, p_mark_id, p_value, p_status, p_actor, p_actor_email, p_note);
end;

create or replace function public.ops_stage_alignment(
  p_job_id uuid, p_rows jsonb, p_counts jsonb, p_portal_only jsonb
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.stage_alignment(p_job_id, p_rows, p_counts, p_portal_only);
end;

create or replace function public.ops_save_instruction(p_job_id uuid, p_raw text, p_parsed jsonb)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.save_instruction(p_job_id, p_raw, p_parsed);
end;

create or replace function public.ops_propose_pupil(p_job_id uuid, p_proposal jsonb)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.propose_pupil(p_job_id, p_proposal);
end;

create or replace function public.ops_stage_individual(
  p_job_id uuid, p_name text, p_mark numeric,
  p_column_group text, p_column_label text, p_subject_key text, p_subject_label text
)
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select ops.stage_individual(p_job_id, p_name, p_mark, p_column_group, p_column_label,
                              p_subject_key, p_subject_label);
end;

-- The job list carries its own counts, including open mark cells and held
-- pupil proposals, so the card never has to guess.
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
      'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'filename', f.filename, 'byte_size', f.byte_size) order by f.created_at)
                         from ops.job_files f where f.job_id = j.id), '[]'::jsonb)
    ) order by j.created_at desc) from ops.jobs j), '[]'::jsonb));
end;

revoke all on function public.ops_active_context() from public, anon, authenticated;
revoke all on function public.ops_queue_reader(uuid) from public, anon, authenticated;
revoke all on function public.ops_record_assistant(uuid) from public, anon, authenticated;
revoke all on function public.ops_stage_marks(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ops_decide_mark(uuid, uuid, numeric, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.ops_stage_alignment(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ops_save_instruction(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.ops_propose_pupil(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ops_stage_individual(uuid, text, numeric, text, text, text, text) from public, anon, authenticated;
revoke all on function public.ops_jobs_list() from public, anon, authenticated;

grant execute on function public.ops_active_context() to service_role;
grant execute on function public.ops_queue_reader(uuid) to service_role;
grant execute on function public.ops_record_assistant(uuid) to service_role;
grant execute on function public.ops_stage_marks(uuid, jsonb) to service_role;
grant execute on function public.ops_decide_mark(uuid, uuid, numeric, text, uuid, text, text) to service_role;
grant execute on function public.ops_stage_alignment(uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.ops_save_instruction(uuid, text, jsonb) to service_role;
grant execute on function public.ops_propose_pupil(uuid, jsonb) to service_role;
grant execute on function public.ops_stage_individual(uuid, text, numeric, text, text, text, text) to service_role;
grant execute on function public.ops_jobs_list() to service_role;

-- Detail now carries marks and proposals as well.
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

-- Provider list carries the role, never a key value.
create or replace function public.ops_providers_list()
returns jsonb language sql set search_path = ops, public, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'providers', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'id', p.id, 'label', p.label, 'kind', p.kind, 'adapter', p.adapter,
          'model', p.model, 'key_ref', p.key_ref, 'priority', p.priority,
          'enabled', p.enabled, 'role', p.role
        ) order by p.priority asc)
       from ops.providers p),
      '[]'::jsonb)
  );
end;

revoke all on function public.ops_jobs_get(uuid) from public, anon, authenticated;
revoke all on function public.ops_providers_list() from public, anon, authenticated;
grant execute on function public.ops_jobs_get(uuid) to service_role;
grant execute on function public.ops_providers_list() to service_role;

commit;
