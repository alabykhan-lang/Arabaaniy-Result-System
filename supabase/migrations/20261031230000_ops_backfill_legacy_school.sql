-- Pilot step 6c: set the school on the two legacy jobs that predate school
-- binding, without changing their status, rows or files.
--
-- Both were created by the developer account on this project. The update runs
-- only while school_id is still null, so applying this file twice is a no-op.
-- One audit row per job records the after-the-fact change.

begin;

with updated as (
  update ops.jobs
     set school_id = '1ec18fb7-3c5b-430d-a77e-2419f16fbfa9'
   where id = '745ddd06-b17e-4c8a-9648-cb120e7a0d5b'
     and school_id is null
  returning id
)
insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
select id,
       '371f2d65-01e3-4043-91da-0fdd634386d3'::uuid,
       'alabykhan@gmail.com',
       'job.school_backfilled',
       'ops.jobs',
       id,
       jsonb_build_object(
         'previous_school_id', null,
         'school_id', '1ec18fb7-3c5b-430d-a77e-2419f16fbfa9',
         'reason', 'Legacy job created before school binding; set from the developer account on this project.',
         'status_unchanged', true,
         'rows_unchanged', true,
         'files_unchanged', true,
         'public_write', false
       )
  from updated;

with updated as (
  update ops.jobs
     set school_id = '1ec18fb7-3c5b-430d-a77e-2419f16fbfa9'
   where id = '9dec48c2-4e1d-4dc3-8da0-0ec6430f4e1a'
     and school_id is null
  returning id
)
insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
select id,
       '371f2d65-01e3-4043-91da-0fdd634386d3'::uuid,
       'alabykhan@gmail.com',
       'job.school_backfilled',
       'ops.jobs',
       id,
       jsonb_build_object(
         'previous_school_id', null,
         'school_id', '1ec18fb7-3c5b-430d-a77e-2419f16fbfa9',
         'reason', 'Legacy job created before school binding; set from the developer account on this project.',
         'status_unchanged', true,
         'rows_unchanged', true,
         'files_unchanged', true,
         'public_write', false
       )
  from updated;

commit;
