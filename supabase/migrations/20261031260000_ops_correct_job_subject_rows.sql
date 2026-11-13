-- Correct an open job in place, and carry the subject through the rows.
-- (Replaces ops.correct_job from 20261031250000 to move staged rows with it.)
--
-- A correction typed before a page has any rows edits the job the person
-- already started: the class, subject, term and column change together, the
-- roster snapshot follows a class change, and nothing is charged. Credit is
-- taken once, when a finished job is approved, never for a correction.
--
-- Once rows exist only the subject may change in place. A class, term or
-- column change would make the read describe something else, so the function
-- refuses it and returns what is in force and what was asked. The page then
-- offers "Keep what I have" or "Start again"; starting again is a new job and
-- a new charge, decided by the person, never silently.

create or replace function ops.correct_job(
  p_job_id uuid,
  p_parsed jsonb,
  p_raw text,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job       ops.jobs;
  v_rows      integer;
  v_old_class text;
  v_old_sub   text;
  v_class     text;
  v_subject   text;
  v_term      text;
  v_column    text;
  v_in_force  jsonb;
  v_asked     jsonb;
  v_raw       text := left(coalesce(p_raw, ''), 4000);
begin
  if p_parsed is null or jsonb_typeof(p_parsed) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'OPS_CORRECTION_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('approved', 'applied', 'cancelled') then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_JOB_FINISHED',
      'message', 'This page is finished, so it cannot be changed.'
    );
  end if;

  select count(*) into v_rows from ops.staged_rows where job_id = p_job_id;

  v_class   := nullif(btrim(coalesce(p_parsed ->> 'class_key', '')), '');
  v_subject := nullif(btrim(coalesce(p_parsed ->> 'subject', '')), '');
  v_term    := nullif(btrim(coalesce(p_parsed ->> 'term', '')), '');
  v_column  := nullif(btrim(coalesce(p_parsed ->> 'column_label', '')), '');

  v_old_class := v_job.class_key;
  v_old_sub   := v_job.subject_set -> 0 ->> 'label';

  v_in_force := jsonb_build_object(
    'class_key', v_job.class_key,
    'class_label', coalesce(v_job.config_snapshot -> 'class_label', to_jsonb(v_job.class_key)),
    'subject', v_old_sub,
    'term', v_job.term,
    'column_label', v_job.column_label
  );
  v_asked := jsonb_build_object(
    'class_key', v_class,
    'class_label', nullif(btrim(coalesce(p_parsed ->> 'class_label', '')), ''),
    'subject', v_subject,
    'term', v_term,
    'column_label', v_column
  );

  -- Rows already exist. Only the subject label can move without another read.
  if v_rows > 0 then
    if (v_class is not null and lower(v_class) <> lower(coalesce(v_job.class_key, '')))
       or (v_term is not null and lower(v_term) <> lower(coalesce(v_job.term, '')))
       or (v_column is not null and lower(v_column) <> lower(coalesce(v_job.column_label, ''))) then
      insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
      values (p_job_id, p_actor, p_actor_email, 'instruction.correction_refused', 'ops.jobs', p_job_id,
              jsonb_build_object('raw', v_raw, 'asked', v_asked, 'in_force', v_in_force,
                                 'rows', v_rows, 'charged', false));

      return jsonb_build_object(
        'ok', false,
        'conflict', true,
        'code', 'OPS_INSTRUCTION_CONFLICT',
        'in_force', v_in_force,
        'asked', v_asked,
        'rows', v_rows,
        'raw', v_raw
      );
    end if;

    if v_in_force ->> 'subject' is not distinct from v_subject then
      return jsonb_build_object(
        'ok', true,
        'job', to_jsonb(v_job),
        'changed', false,
        'rows', v_rows,
        'in_force', v_in_force,
        'charged', false
      );
    end if;

    update ops.jobs
       set instruction_parsed = p_parsed || jsonb_build_object('raw', v_raw),
           instruction_frozen = p_parsed || jsonb_build_object('raw', v_raw),
           updated_at = now()
     where id = p_job_id
     returning * into v_job;

    perform ops.freeze_job_config(p_job_id, p_parsed);
    select * into v_job from ops.jobs where id = p_job_id;

    -- The read itself and any document built from it take the subject from
    -- the rows, so the rows move with the job. Names and marks do not change.
    update ops.staged_rows
       set subject_key = v_job.subject_set -> 0 ->> 'key',
           subject_label = v_job.subject_set -> 0 ->> 'label',
           updated_at = now()
     where job_id = p_job_id;

    insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
    values (p_job_id, p_actor, p_actor_email, 'instruction.subject_corrected', 'ops.jobs', p_job_id,
            jsonb_build_object('raw', v_raw, 'subject', v_subject,
                               'rows', v_rows, 'charged', false));

    return jsonb_build_object(
      'ok', true,
      'job', to_jsonb(v_job),
      'changed', true,
      'rows', v_rows,
      'in_force', v_in_force,
      'subject_only', true,
      'charged', false
    );
  end if;

  -- No rows yet: edit the open job the person already started.
  update ops.jobs
     set class_key = coalesce(v_class, class_key),
         term = coalesce(v_term, term),
         academic_session = coalesce(nullif(btrim(coalesce(p_parsed ->> 'academic_session', '')), ''), academic_session),
         instruction = case when v_raw = '' then instruction else v_raw end,
         instruction_parsed = p_parsed || jsonb_build_object('raw', v_raw),
         instruction_frozen = p_parsed || jsonb_build_object('raw', v_raw),
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  if v_job.class_key is distinct from v_old_class then
    perform ops.snapshot_roster(p_job_id, v_job.class_key);
    select * into v_job from ops.jobs where id = p_job_id;
  end if;

  perform ops.freeze_job_config(p_job_id, p_parsed);
  select * into v_job from ops.jobs where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'instruction.corrected', 'ops.jobs', p_job_id,
          jsonb_build_object('raw', v_raw, 'in_force', v_in_force, 'asked', v_asked,
                             'rows', 0, 'charged', false));

  return jsonb_build_object(
    'ok', true,
    'job', to_jsonb(v_job),
    'changed', true,
    'rows', 0,
    'in_force', v_in_force,
    'charged', false
  );
end;
$$;

revoke all on function ops.correct_job(uuid, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function ops.correct_job(uuid, jsonb, text, uuid, text) to service_role;

create or replace function public.ops_correct_job(
  p_job_id uuid,
  p_parsed jsonb,
  p_raw text,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.correct_job(p_job_id, p_parsed, p_raw, p_actor, p_actor_email);
$$;

revoke all on function public.ops_correct_job(uuid, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_correct_job(uuid, jsonb, text, uuid, text) to service_role;
