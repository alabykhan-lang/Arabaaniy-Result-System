-- One score, typed on the page card. The reader normally makes a staged mark
-- for every line, but a page can arrive with a line whose mark was never
-- stored. This creates that one cell, or corrects the one already there, and
-- leaves every other mark on the page untouched.

begin;

create or replace function ops.set_mark(
  p_job_id uuid,
  p_staged_row_id uuid,
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
  v_job     ops.jobs;
  v_row     ops.staged_rows;
  v_mark    ops.staged_marks;
  v_stat    text := lower(coalesce(nullif(btrim(p_status), ''), 'read'));
  v_group   text;
  v_label   text;
  v_summary jsonb;
  v_pending integer := 0;
  v_marks   integer := 0;
begin
  if v_stat not in ('read', 'blank') then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_STATUS_INVALID');
  end if;
  if v_stat = 'read' and (p_value is null or p_value < 0 or p_value > 100) then
    return jsonb_build_object('ok', false, 'code', 'OPS_MARK_VALUE_INVALID');
  end if;

  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  select * into v_row
    from ops.staged_rows
   where id = p_staged_row_id and job_id = p_job_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROW_NOT_FOUND');
  end if;

  v_group := left(coalesce(nullif(btrim(v_job.column_group), ''), '1ST TERM'), 80);
  v_label := left(coalesce(nullif(btrim(v_job.column_label), ''), 'CLASS EXERCISE'), 80);

  insert into ops.staged_marks (
    job_id, staged_row_id, column_group, column_label, value, status,
    candidates, confidence, note
  ) values (
    p_job_id, p_staged_row_id, v_group, v_label,
    case when v_stat = 'read' then p_value else null end,
    v_stat, '[]'::jsonb, 1,
    nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (staged_row_id, column_group, column_label) do update
     set value = excluded.value,
         status = excluded.status,
         candidates = '[]'::jsonb,
         confidence = 1,
         note = coalesce(excluded.note, ops.staged_marks.note),
         updated_at = now()
  returning * into v_mark;

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
  values (p_job_id, p_actor, p_actor_email, 'mark.set', 'ops.staged_marks', v_mark.id,
          jsonb_build_object('column_group', v_mark.column_group, 'column_label', v_mark.column_label,
                             'status', v_mark.status, 'value', v_mark.value,
                             'row_no', v_row.row_no, 'live_write', false));

  return jsonb_build_object('ok', true, 'mark', to_jsonb(v_mark), 'summary', v_summary);
end;
$$;

revoke all on function ops.set_mark(uuid, uuid, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function ops.set_mark(uuid, uuid, numeric, text, uuid, text, text) to service_role;

create or replace function public.ops_set_mark(
  p_job_id uuid,
  p_staged_row_id uuid,
  p_value numeric,
  p_status text,
  p_actor uuid,
  p_actor_email text,
  p_note text default null
)
returns jsonb
language sql
set search_path = ops, public, pg_temp
begin atomic
  select ops.set_mark(p_job_id, p_staged_row_id, p_value, p_status, p_actor, p_actor_email, p_note);
end;

revoke all on function public.ops_set_mark(uuid, uuid, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ops_set_mark(uuid, uuid, numeric, text, uuid, text, text) to service_role;

commit;
