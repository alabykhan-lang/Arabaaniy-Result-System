-- Surname-pool alignment and one-tap B rows.
--
-- The matcher now chooses a pupil globally (one line per pupil) and stages a B
-- row with the pupil already attached, so a single tap records that child.
-- Before this, B stored only candidate_admno and decide_row had no pupil to
-- accept.
--
-- Additive and inert for existing jobs: only future alignments are affected.
-- No school-loaded table, no public.scores or public.students write, no live
-- write.

begin;

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
    -- A is accepted; B is a suggestion that already names its pupil. The row
    -- stays pending either way, so a tap is still required for B.
    if v_list in ('A', 'B') then
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
           student_id = case when v_list in ('A', 'B') then v_student else null end,
           admno = case when v_list in ('A', 'B') then v_admno else null end,
           candidate_admno = case when v_list = 'B'
                                  then nullif(btrim(coalesce(v_item ->> 'candidate_admno', '')), '')
                                  else null end,
           status = case when v_list = 'A' then 'accepted' else 'pending' end,
           match_method = case when v_list in ('A', 'B')
                               then coalesce(nullif(btrim(v_item ->> 'match_method'), ''), 'name')
                               else 'none' end,
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
           'algorithm', 'one-to-one assignment, surname pool, exact-given fallback'
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

commit;
