-- Retry an open job without making a second one.
--
-- A page that never reached a reader (queued and unclaimed), or a reader that
-- stopped part way, can be handed back to the reader queue. The same job, the
-- same stored photo and the same rows are kept. Nothing is charged: credit is
-- still taken once, when a finished page is approved.
--
-- A job that already has rows is returned untouched, so a second tap on Retry
-- can never wipe a finished read.

create or replace function ops.retry_job(
  p_job_id uuid,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_job   ops.jobs;
  v_rows  integer;
  v_queue jsonb;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if (v_job.status in ('approved', 'applied', 'cancelled')) then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_JOB_FINISHED',
      'message', 'This page is finished, so it cannot be read again.'
    );
  end if;
  if v_job.status = 'processing' and v_job.lease_until is not null and v_job.lease_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPS_JOB_BUSY',
      'message', 'The reader is still working on this page. Give it a moment.'
    );
  end if;

  select count(*) into v_rows from ops.staged_rows where job_id = p_job_id;
  if v_rows > 0 then
    return jsonb_build_object(
      'ok', true,
      'job', to_jsonb(v_job),
      'already', true,
      'rows', v_rows,
      'queued', false,
      'charged', false
    );
  end if;

  update ops.jobs
     set status      = 'queued',
         attempts    = 0,
         claimed_by  = null,
         claimed_at  = null,
         lease_until = null,
         last_error  = null,
         updated_at  = now()
   where id = p_job_id
   returning * into v_job;

  select * into v_job from ops.jobs where id = p_job_id;
  v_queue := ops.queue_reader(p_job_id);
  select * into v_job from ops.jobs where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'job.retry_requested', 'ops.jobs', p_job_id,
          jsonb_build_object('rows', 0, 'charged', false,
                             'reader', v_queue -> 'provider' ->> 'label',
                             'reader_ok', coalesce((v_queue ->> 'ok')::boolean, false)));

  return jsonb_build_object(
    'ok', true,
    'job', to_jsonb(v_job),
    'already', false,
    'rows', 0,
    'queued', true,
    'charged', false,
    'provider', v_queue -> 'provider'
  );
exception when others then
  return jsonb_build_object(
    'ok', false,
    'code', 'OPS_RETRY_FAILED',
    'message', SQLERRM
  );
end;
$$;

revoke all on function ops.retry_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function ops.retry_job(uuid, uuid, text) to service_role;

create or replace function public.ops_retry_job(
  p_job_id uuid,
  p_actor uuid,
  p_actor_email text
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
as $$
  select ops.retry_job(p_job_id, p_actor, p_actor_email);
$$;

revoke all on function public.ops_retry_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_retry_job(uuid, uuid, text) to service_role;
