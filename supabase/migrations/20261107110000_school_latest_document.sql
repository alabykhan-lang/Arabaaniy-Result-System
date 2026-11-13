-- A download button already drawn in an older chat has no document id. It can
-- still fetch the newest document for the same school instead of being a dead
-- button. Read-only, internal service role only.
create or replace function public.school_latest_document(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $function$
declare
  v jsonb;
begin
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
  into v
  from ops.generated_documents d
  where d.school_id = p_school_id
  order by d.created_at desc
  limit 1;
  return v;
end;
$function$;

revoke all on function public.school_latest_document(uuid) from public, anon, authenticated;
grant execute on function public.school_latest_document(uuid) to service_role;
