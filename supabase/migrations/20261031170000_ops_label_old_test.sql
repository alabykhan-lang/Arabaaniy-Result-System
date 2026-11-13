-- Pilot step 7: label the superseded manual test job so it no longer looks
-- like live work, without changing its status, rows or files.
--
-- The label lives in a dedicated column, so no job data is rewritten. Applying
-- this file twice is a no-op, and one audit row records the after-the-fact
-- label.

begin;

alter table ops.jobs add column if not exists internal_label text;

with updated as (
  update ops.jobs
     set internal_label = 'Old test - ignore'
   where id = '745ddd06-b17e-4c8a-9648-cb120e7a0d5b'
     and internal_label is null
  returning id
)
insert into ops.audit (job_id, actor_id, actor_email, action, entity, entity_id, detail)
select id,
       '371f2d65-01e3-4043-91da-0fdd634386d3'::uuid,
       'alabykhan@gmail.com',
       'job.internal_label_set',
       'ops.jobs',
       id,
       jsonb_build_object(
         'internal_label', 'Old test - ignore',
         'reason', 'Superseded manual test; labelled so it does not look like live work.',
         'status_unchanged', true,
         'rows_unchanged', true,
         'files_unchanged', true,
         'public_write', false
       )
  from updated;

commit;
