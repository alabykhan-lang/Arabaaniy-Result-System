-- Generated documents are school records, not scratch previews.
--
-- 1. Stop deleting documents on a two-day timer. A final report card that
--    disappears after a logout is not acceptable, so documents stay until the
--    school removes them.
-- 2. Read one document for a named school only, so a document id from one
--    school cannot be fetched with another school's session.
-- 3. List recent documents for a school, with the class, term, template and
--    mode, so the dashboard can show them after a reload or a new login.

create or replace function public.school_store_document(
  p_school_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_class_key text,
  p_term text,
  p_academic_session text,
  p_template text,
  p_kind text,
  p_mode text,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_page_count integer,
  p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops, pg_temp
as $$
declare
  v_id uuid;
  v_size integer;
begin
  if p_kind not in ('cards', 'broadsheet') then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_KIND_INVALID',
      'error', 'The document kind must be cards or broadsheet.',
      'next', 'Call generate_documents with kind "cards" or "broadsheet".');
  end if;
  if p_mode not in ('sample', 'final') then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_MODE_INVALID',
      'error', 'The mode must be sample or final.',
      'next', 'Call generate_documents with mode "sample" or "final".');
  end if;
  if p_content_b64 is null or length(p_content_b64) < 100 then
    return jsonb_build_object('ok', false, 'code', 'SCHOOL_DOCUMENT_EMPTY',
      'error', 'The document was empty.',
      'next', 'Render again; nothing was stored.');
  end if;

  insert into ops.generated_documents (
    school_id, actor_id, actor_email, class_key, term, academic_session,
    template, kind, mode, filename, mime, page_count, byte_size, sha256, summary, content
  ) values (
    p_school_id, p_actor_id, p_actor_email, p_class_key, p_term, p_academic_session,
    coalesce(p_template, 'modern'), p_kind, p_mode, p_filename, coalesce(p_mime, 'application/pdf'),
    p_page_count, octet_length(decode(p_content_b64, 'base64')), p_sha256,
    coalesce(p_summary, '{}'::jsonb), decode(p_content_b64, 'base64')
  ) returning id, byte_size into v_id, v_size;

  return jsonb_build_object(
    'ok', true, 'document_id', v_id, 'filename', p_filename, 'byte_size', v_size,
    'url', '/api/ops-jobs?document=' || v_id
  );
end;
$$;

create or replace function public.school_get_document_for_school(p_id uuid, p_school_id uuid)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'document_id', d.id,
    'school_id', d.school_id,
    'filename', d.filename,
    'mime', d.mime,
    'kind', d.kind,
    'mode', d.mode,
    'template', d.template,
    'class_key', d.class_key,
    'term', d.term,
    'academic_session', d.academic_session,
    'page_count', d.page_count,
    'summary', d.summary,
    'content_b64', encode(d.content, 'base64')
  )
  from ops.generated_documents d
  where d.id = p_id and d.school_id = p_school_id;
end;

create or replace function public.school_recent_documents(p_school_id uuid, p_limit integer default 24)
returns jsonb
language sql
security definer
set search_path = public, ops, pg_temp
begin atomic
  select jsonb_build_object(
    'ok', true,
    'documents', coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id,
      'url', '/api/ops-jobs?document=' || d.id,
      'filename', d.filename,
      'type', d.kind,
      'kind', d.kind,
      'mode', d.mode,
      'template', d.template,
      'class_key', d.class_key,
      'class', d.summary->>'class',
      'term', d.term,
      'academic_session', d.academic_session,
      'page_count', d.page_count,
      'sample', d.mode = 'sample',
      'created_at', d.created_at
    ) order by d.created_at desc), '[]'::jsonb)
  )
  from (
    select * from ops.generated_documents
     where school_id = p_school_id
     order by created_at desc
     limit greatest(1, least(coalesce(p_limit, 24), 100))
  ) d;
end;

revoke all on function public.school_store_document(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.school_get_document_for_school(uuid, uuid) from public, anon, authenticated;
revoke all on function public.school_recent_documents(uuid, integer) from public, anon, authenticated;

grant execute on function public.school_store_document(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, integer, jsonb) to service_role;
grant execute on function public.school_get_document_for_school(uuid, uuid) to service_role;
grant execute on function public.school_recent_documents(uuid, integer) to service_role;
