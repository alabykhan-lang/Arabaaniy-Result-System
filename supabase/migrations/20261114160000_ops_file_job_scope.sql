-- School scope for a stored page photo.
--
-- A file id alone used to be enough to read any school's page photo, because
-- ops.read_file has no school argument. This returns the owning job so the
-- HTTP layer can compare it with the signed-in account before any bytes leave.

create or replace function ops.file_job(p_file_id uuid)
returns jsonb
language sql
security definer
set search_path to 'ops', 'public', 'pg_temp'
begin atomic
  select jsonb_build_object(
    'ok', true,
    'job_id', f.job_id,
    'school_id', j.school_id,
    'submitted_by', j.submitted_by
  )
  from ops.job_files f
  join ops.jobs j on j.id = f.job_id
  where f.id = p_file_id;
end;

create or replace function public.ops_file_job(p_file_id uuid)
returns jsonb
language sql
begin atomic
  select ops.file_job(p_file_id);
end;

grant execute on function ops.file_job(uuid) to service_role, authenticated;
grant execute on function public.ops_file_job(uuid) to service_role, authenticated;
