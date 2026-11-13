-- Attaching a pupil also removes them from the "portal, not on the sheet"
-- list, so the fourth alignment list never says a pupil is missing after
-- they were attached by hand.

begin;

CREATE OR REPLACE FUNCTION ops.attach_row(p_job_id uuid, p_staged_row_id uuid, p_student_id uuid, p_actor uuid, p_actor_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public', 'pg_temp'
AS $function$
declare
  v_job        ops.jobs;
  v_row        ops.staged_rows;
  v_name       text;
  v_admno      text;
  v_other_no   integer;
  v_pending    integer;
  v_counts     jsonb;
  v_portal     integer;
  v_portal_only jsonb;
begin
  select * into v_job from ops.jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_NOT_FOUND');
  end if;
  if v_job.status in ('applied', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'OPS_JOB_CLOSED');
  end if;

  select * into v_row from ops.staged_rows
   where id = p_staged_row_id and job_id = p_job_id
   for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_ROW_NOT_FOUND');
  end if;

  select p ->> 'name', p ->> 'admno'
    into v_name, v_admno
    from ops.roster_snapshots rs, jsonb_array_elements(rs.pupils) p
   where rs.job_id = p_job_id
     and (p ->> 'id')::uuid = p_student_id
   limit 1;
  if nullif(btrim(coalesce(v_name, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'OPS_PUPIL_NOT_IN_CLASS',
                              'message', 'That pupil is not in this class list.');
  end if;

  select row_no into v_other_no
    from ops.staged_rows
   where job_id = p_job_id
     and id <> p_staged_row_id
     and student_id = p_student_id
     and status <> 'rejected'
   order by row_no
   limit 1;
  if v_other_no is not null then
    return jsonb_build_object('ok', false, 'code', 'OPS_PUPIL_ALREADY_ATTACHED',
                              'message', 'That pupil is already attached to line ' || v_other_no || '.',
                              'row_no', v_other_no);
  end if;

  update ops.staged_rows
     set student_id = p_student_id,
         admno = v_admno,
         candidate_admno = null,
         candidate_names = jsonb_build_array(v_name),
         match_method = 'manual',
         match_confidence = 1,
         surname_score = null,
         first_score = null,
         confidence = coalesce(confidence, 1),
         flag = null,
         match_list = 'B',
         status = 'accepted',
         updated_at = now()
   where id = p_staged_row_id
   returning * into v_row;

  select count(*) into v_pending
    from ops.staged_rows
   where job_id = p_job_id and status = 'pending';

  -- A pupil who was listed as "in the portal, not on the sheet" is now on a
  -- line. Drop that pupil from the fourth list so the screen does not keep
  -- saying they are missing after they were attached.
  select coalesce(jsonb_agg(p), '[]'::jsonb)
    into v_portal_only
    from jsonb_array_elements(
           case when jsonb_typeof(v_job.alignment -> 'portal_only') = 'array'
                then v_job.alignment -> 'portal_only' else '[]'::jsonb end) p
   where (p ->> 'id') is distinct from p_student_id::text;

  v_portal := jsonb_array_length(v_portal_only);

  v_counts := jsonb_build_object(
    'A', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'A'),
    'B', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'B'),
    'C', (select count(*) from ops.staged_rows where job_id = p_job_id and match_list = 'C'),
    'D', v_portal,
    'pending', v_pending
  );

  update ops.jobs
     set status = case when v_pending > 0 then 'needs_input' else 'needs_review' end,
         last_error = case when v_pending > 0 then v_pending || ' lines need a human' else null end,
         alignment = jsonb_set(
           jsonb_set(coalesce(alignment, '{}'::jsonb), '{counts}', v_counts, true),
           '{portal_only}', v_portal_only, true),
         updated_at = now()
   where id = p_job_id;

  insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
  values (p_job_id, p_actor, p_actor_email, 'staged_row.attach', 'ops.staged_rows', p_staged_row_id,
          jsonb_build_object('row_no', v_row.row_no, 'page', v_row.student_name_raw,
                             'pupil', v_name, 'admno', v_admno,
                             'from_list', 'C', 'to_list', 'B', 'live_write', false));

  return jsonb_build_object('ok', true, 'staged_row', to_jsonb(v_row), 'counts', v_counts);
end;
$function$;

commit;
