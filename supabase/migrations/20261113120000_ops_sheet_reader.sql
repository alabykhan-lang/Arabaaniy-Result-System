-- 20261113120000_ops_sheet_reader.sql
-- Durable photo attachments, extracted sheet lines and the open review for the
-- Command Center sheet reader.
--
-- The whole point is that a page refresh, a second device or a later turn does
-- not lose the photo read. Images are stored once, lines are stored as they are
-- extracted, and the review lives in the database until it is written or
-- dismissed. Nothing here touches public.scores; writes still go through the
-- audited public.school_record_scores path.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists ops.sheet_attachments (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references ops.chat_sessions(id) on delete cascade,
  school_id       uuid not null,
  uploaded_by     uuid not null,
  filename        text,
  mime            text not null default 'image/jpeg',
  byte_size       integer not null default 0,
  sha256          text not null,
  content         bytea not null,
  description     text,
  sheet_type      text,
  class_key       text,
  subject_label   text,
  term            text,
  created_at      timestamptz not null default now()
);

create index if not exists ops_sheet_attachments_chat_idx
  on ops.sheet_attachments (session_id, created_at desc);

comment on table ops.sheet_attachments is
  'One stored photo per upload, with a description produced by the vision pass. The chat transcript keeps the file id and description, not the bytes.';

create table if not exists ops.sheet_draft_line (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references ops.chat_sessions(id) on delete cascade,
  file_id          uuid not null references ops.sheet_attachments(id) on delete cascade,
  school_id        uuid not null,
  item_no          integer,
  class_key        text not null,
  subject_index    integer,
  subject_label    text,
  term             text,
  academic_session text,
  component        text,
  column_key       text not null default 'primary',
  column_title     text,
  sheet_line       integer not null,
  raw_name         text not null default '',
  raw_score        text,
  score_value      numeric,
  flags            jsonb not null default '[]'::jsonb,
  note             text,
  confidence       numeric,
  match_student_id uuid,
  match_confidence numeric,
  match_status     text not null default 'unmatched'
                   check (match_status in ('unmatched', 'auto', 'confirmed', 'rejected', 'held', 'existing')),
  batch_id         uuid,
  written_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists ops_sheet_draft_line_key
  on ops.sheet_draft_line (session_id, file_id, column_key, sheet_line);
create index if not exists ops_sheet_draft_line_chat_idx
  on ops.sheet_draft_line (session_id, file_id, item_no);

comment on table ops.sheet_draft_line is
  'Every line read from a photo, saved as soon as it is extracted. Re-reading the same file updates the same line instead of adding a duplicate.';

create table if not exists ops.sheet_review (
  session_id      uuid not null references ops.chat_sessions(id) on delete cascade,
  file_id         uuid not null references ops.sheet_attachments(id) on delete cascade,
  school_id       uuid not null,
  review          jsonb not null default '{}'::jsonb,
  status          text not null default 'open'
                  check (status in ('open', 'ready', 'written', 'dismissed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (session_id, file_id)
);

create index if not exists ops_sheet_review_session_idx
  on ops.sheet_review (session_id, updated_at desc);

comment on table ops.sheet_review is
  'The one open batch review for a sheet. It survives a refresh and is what the user answers in one message.';

-- ---------------------------------------------------------------------------
-- 2. Functions
-- ---------------------------------------------------------------------------
create or replace function ops.sheet_owned(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ops, public, pg_temp
as $$
  select exists (
    select 1 from ops.chat_sessions s
     where s.id = p_session_id
       and s.school_id = p_school_id
       and s.owner_user_id = p_owner_user_id
       and s.status in ('active', 'archived')
  );
$$;

create or replace function ops.sheet_attachment_put(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_filename text,
  p_mime text,
  p_content_b64 text,
  p_sha256 text,
  p_byte_size integer,
  p_description text default null,
  p_sheet_type text default null,
  p_class_key text default null,
  p_subject_label text default null,
  p_term text default null
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_id uuid;
  v_bytes bytea;
  v_size integer;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND',
      'message', 'That chat is not in this account.');
  end if;
  if p_content_b64 is null or length(p_content_b64) = 0 then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_EMPTY',
      'message', 'The photo was empty.');
  end if;
  begin
    v_bytes := decode(p_content_b64, 'base64');
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_INVALID',
      'message', 'The photo could not be decoded.');
  end;
  v_size := coalesce(nullif(p_byte_size, 0), octet_length(v_bytes));
  if v_size > 8388608 then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_TOO_LARGE',
      'message', 'The photo is larger than 8 MB.');
  end if;

  insert into ops.sheet_attachments (
    session_id, school_id, uploaded_by, filename, mime, byte_size, sha256,
    content, description, sheet_type, class_key, subject_label, term
  ) values (
    p_session_id, p_school_id, p_owner_user_id, nullif(btrim(coalesce(p_filename, '')), ''),
    coalesce(nullif(btrim(coalesce(p_mime, '')), ''), 'image/jpeg'), v_size,
    coalesce(nullif(btrim(coalesce(p_sha256, '')), ''), encode(sha256(v_bytes), 'hex')),
    v_bytes, nullif(btrim(coalesce(p_description, '')), ''),
    nullif(btrim(coalesce(p_sheet_type, '')), ''),
    nullif(btrim(coalesce(p_class_key, '')), ''),
    nullif(btrim(coalesce(p_subject_label, '')), ''),
    nullif(btrim(coalesce(p_term, '')), '')
  ) returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'attachment', jsonb_build_object(
      'id', v_id,
      'filename', p_filename,
      'mime', p_mime,
      'byte_size', v_size,
      'sha256', p_sha256,
      'description', p_description,
      'created_at', now()
    )
  );
end;
$$;

create or replace function ops.sheet_attachment_latest(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_attachments;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_attachments
   where session_id = p_session_id
   order by created_at desc
   limit 1;
  if v_row.id is null then
    return jsonb_build_object('ok', true, 'attachment', null);
  end if;
  return jsonb_build_object('ok', true, 'attachment', jsonb_build_object(
    'id', v_row.id,
    'filename', v_row.filename,
    'mime', v_row.mime,
    'byte_size', v_row.byte_size,
    'sha256', v_row.sha256,
    'description', v_row.description,
    'sheet_type', v_row.sheet_type,
    'class_key', v_row.class_key,
    'subject_label', v_row.subject_label,
    'term', v_row.term,
    'created_at', v_row.created_at
  ));
end;
$$;

create or replace function ops.sheet_attachment_get(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_file_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_attachments;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_attachments
   where id = p_file_id and session_id = p_session_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'attachment', jsonb_build_object(
    'id', v_row.id,
    'filename', v_row.filename,
    'mime', v_row.mime,
    'description', v_row.description,
    'content_base64', encode(v_row.content, 'base64')
  ));
end;
$$;

create or replace function ops.sheet_draft_put(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_file_id uuid,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_line jsonb;
  v_count integer := 0;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  if not exists (
    select 1 from ops.sheet_attachments where id = p_file_id and session_id = p_session_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_NOT_FOUND');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'SHEET_LINES_REQUIRED');
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into ops.sheet_draft_line (
      session_id, file_id, school_id, item_no, class_key, subject_index,
      subject_label, term, academic_session, component, column_key, column_title,
      sheet_line, raw_name, raw_score, score_value, flags, note, confidence,
      match_student_id, match_confidence, match_status
    ) values (
      p_session_id, p_file_id, p_school_id,
      nullif(v_line ->> 'item_no', '')::integer,
      coalesce(nullif(v_line ->> 'class_key', ''), ''),
      nullif(v_line ->> 'subject_index', '')::integer,
      nullif(v_line ->> 'subject_label', ''),
      nullif(v_line ->> 'term', ''),
      nullif(v_line ->> 'academic_session', ''),
      nullif(v_line ->> 'component', ''),
      coalesce(nullif(v_line ->> 'column_key', ''), 'primary'),
      nullif(v_line ->> 'column_title', ''),
      coalesce(nullif(v_line ->> 'sheet_line', '')::integer, 0),
      coalesce(v_line ->> 'raw_name', ''),
      nullif(v_line ->> 'raw_score', ''),
      nullif(v_line ->> 'score_value', '')::numeric,
      coalesce(v_line -> 'flags', '[]'::jsonb),
      nullif(v_line ->> 'note', ''),
      nullif(v_line ->> 'confidence', '')::numeric,
      nullif(v_line ->> 'match_student_id', '')::uuid,
      nullif(v_line ->> 'match_confidence', '')::numeric,
      coalesce(nullif(v_line ->> 'match_status', ''), 'unmatched')
    )
    on conflict (session_id, file_id, column_key, sheet_line) do update set
      item_no = excluded.item_no,
      class_key = excluded.class_key,
      subject_index = excluded.subject_index,
      subject_label = excluded.subject_label,
      term = excluded.term,
      academic_session = excluded.academic_session,
      component = excluded.component,
      column_title = excluded.column_title,
      raw_name = excluded.raw_name,
      raw_score = excluded.raw_score,
      score_value = excluded.score_value,
      flags = excluded.flags,
      note = excluded.note,
      confidence = excluded.confidence,
      match_student_id = excluded.match_student_id,
      match_confidence = excluded.match_confidence,
      match_status = excluded.match_status,
      updated_at = now();
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'saved', v_count);
end;
$$;

create or replace function ops.sheet_draft_list(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_file_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.item_no nulls last, l.column_key, l.sheet_line), '[]'::jsonb)
    into v_rows
    from ops.sheet_draft_line l
   where l.session_id = p_session_id
     and (p_file_id is null or l.file_id = p_file_id);
  return jsonb_build_object('ok', true, 'lines', v_rows);
end;
$$;

create or replace function ops.sheet_draft_mark_written(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_file_id uuid,
  p_batch_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_count integer := 0;
  v_row integer;
  v_item jsonb;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  -- Each item names the printed line it came from: {column_key, sheet_line}.
  -- A plain number still means a sheet line, for older callers.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if jsonb_typeof(v_item) = 'object' then
      update ops.sheet_draft_line
         set batch_id = p_batch_id,
             written_at = now(),
             updated_at = now()
       where session_id = p_session_id
         and file_id = p_file_id
         and column_key = coalesce(nullif(v_item ->> 'column_key', ''), 'primary')
         and sheet_line = coalesce(nullif(v_item ->> 'sheet_line', '')::integer, -1);
    else
      update ops.sheet_draft_line
         set batch_id = p_batch_id,
             written_at = now(),
             updated_at = now()
       where session_id = p_session_id
         and file_id = p_file_id
         and sheet_line = (v_item #>> '{}')::integer;
    end if;
    get diagnostics v_row = row_count;
    v_count := v_count + v_row;
  end loop;
  return jsonb_build_object('ok', true, 'written', v_count);
end;
$$;

create or replace function ops.sheet_review_put(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_file_id uuid,
  p_review jsonb,
  p_status text default 'open'
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  insert into ops.sheet_review (session_id, file_id, school_id, review, status)
  values (p_session_id, p_file_id, p_school_id, coalesce(p_review, '{}'::jsonb),
          case when p_status in ('open', 'ready', 'written', 'dismissed') then p_status else 'open' end)
  on conflict (session_id, file_id) do update set
    review = excluded.review,
    status = excluded.status,
    updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function ops.sheet_review_get(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_review;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_review
   where session_id = p_session_id and status in ('open', 'ready', 'written')
   order by updated_at desc
   limit 1;
  if v_row.session_id is null then
    return jsonb_build_object('ok', true, 'review', null);
  end if;
  return jsonb_build_object('ok', true, 'review', v_row.review, 'status', v_row.status,
    'file_id', v_row.file_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Public wrappers
-- ---------------------------------------------------------------------------
create or replace function public.ops_sheet_attachment_put(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_filename text,
  p_mime text, p_content_b64 text, p_sha256 text, p_byte_size integer,
  p_description text default null, p_sheet_type text default null,
  p_class_key text default null, p_subject_label text default null,
  p_term text default null
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_attachment_put($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13); $$;

create or replace function public.ops_sheet_attachment_latest(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_attachment_latest($1,$2,$3); $$;

create or replace function public.ops_sheet_attachment_get(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_attachment_get($1,$2,$3,$4); $$;

create or replace function public.ops_sheet_draft_put(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid, p_lines jsonb
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_draft_put($1,$2,$3,$4,$5); $$;

create or replace function public.ops_sheet_draft_list(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid default null
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_draft_list($1,$2,$3,$4); $$;

create or replace function public.ops_sheet_draft_mark_written(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid,
  p_batch_id uuid, p_items jsonb
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_draft_mark_written($1,$2,$3,$4,$5,$6); $$;

create or replace function public.ops_sheet_review_put(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid,
  p_review jsonb, p_status text default 'open'
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_review_put($1,$2,$3,$4,$5,$6); $$;

create or replace function public.ops_sheet_review_get(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_review_get($1,$2,$3); $$;

-- ---------------------------------------------------------------------------
-- 4. Permissions: service role only, like the rest of the assistant state.
-- ---------------------------------------------------------------------------
revoke all on function public.ops_sheet_attachment_put(uuid,uuid,uuid,text,text,text,text,integer,text,text,text,text,text) from public;
revoke all on function public.ops_sheet_attachment_latest(uuid,uuid,uuid) from public;
revoke all on function public.ops_sheet_attachment_get(uuid,uuid,uuid,uuid) from public;
revoke all on function public.ops_sheet_draft_put(uuid,uuid,uuid,uuid,jsonb) from public;
revoke all on function public.ops_sheet_draft_list(uuid,uuid,uuid,uuid) from public;
revoke all on function public.ops_sheet_draft_mark_written(uuid,uuid,uuid,uuid,uuid,jsonb) from public;
revoke all on function public.ops_sheet_review_put(uuid,uuid,uuid,uuid,jsonb,text) from public;
revoke all on function public.ops_sheet_review_get(uuid,uuid,uuid) from public;

grant execute on function public.ops_sheet_attachment_put(uuid,uuid,uuid,text,text,text,text,integer,text,text,text,text,text) to service_role;
grant execute on function public.ops_sheet_attachment_latest(uuid,uuid,uuid) to service_role;
grant execute on function public.ops_sheet_attachment_get(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.ops_sheet_draft_put(uuid,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.ops_sheet_draft_list(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.ops_sheet_draft_mark_written(uuid,uuid,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.ops_sheet_review_put(uuid,uuid,uuid,uuid,jsonb,text) to service_role;
grant execute on function public.ops_sheet_review_get(uuid,uuid,uuid) to service_role;
alter table ops.sheet_attachments add column if not exists sheet_read jsonb;
alter table ops.sheet_draft_line add column if not exists candidates jsonb not null default '[]'::jsonb;

create or replace function ops.sheet_attachment_describe(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid,
  p_description text, p_sheet_type text, p_class_key text, p_subject_label text,
  p_term text, p_sheet_read jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  update ops.sheet_attachments
     set description = nullif(btrim(coalesce(p_description, '')), ''),
         sheet_type = nullif(btrim(coalesce(p_sheet_type, '')), ''),
         class_key = nullif(btrim(coalesce(p_class_key, '')), ''),
         subject_label = nullif(btrim(coalesce(p_subject_label, '')), ''),
         term = nullif(btrim(coalesce(p_term, '')), ''),
         sheet_read = p_sheet_read
   where id = p_file_id and session_id = p_session_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.ops_sheet_attachment_describe(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid,
  p_description text, p_sheet_type text, p_class_key text, p_subject_label text,
  p_term text, p_sheet_read jsonb
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_attachment_describe($1,$2,$3,$4,$5,$6,$7,$8,$9,$10); $$;

revoke all on function public.ops_sheet_attachment_describe(uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb) from public;
grant execute on function public.ops_sheet_attachment_describe(uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function ops.sheet_attachment_latest(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_attachments;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_attachments
   where session_id = p_session_id
   order by created_at desc
   limit 1;
  if v_row.id is null then
    return jsonb_build_object('ok', true, 'attachment', null);
  end if;
  return jsonb_build_object('ok', true, 'attachment', jsonb_build_object(
    'id', v_row.id,
    'filename', v_row.filename,
    'mime', v_row.mime,
    'byte_size', v_row.byte_size,
    'sha256', v_row.sha256,
    'description', v_row.description,
    'sheet_type', v_row.sheet_type,
    'class_key', v_row.class_key,
    'subject_label', v_row.subject_label,
    'term', v_row.term,
    'sheet_read', v_row.sheet_read,
    'created_at', v_row.created_at
  ));
end;
$$;

create or replace function ops.sheet_attachment_get(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_attachments;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_attachments
   where id = p_file_id and session_id = p_session_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'attachment', jsonb_build_object(
    'id', v_row.id,
    'filename', v_row.filename,
    'mime', v_row.mime,
    'description', v_row.description,
    'sheet_read', v_row.sheet_read,
    'content_base64', encode(v_row.content, 'base64')
  ));
end;
$$;

create or replace function ops.sheet_draft_put(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid, p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_line jsonb;
  v_count integer := 0;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  if not exists (
    select 1 from ops.sheet_attachments where id = p_file_id and session_id = p_session_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_PHOTO_NOT_FOUND');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'SHEET_LINES_REQUIRED');
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into ops.sheet_draft_line (
      session_id, file_id, school_id, item_no, class_key, subject_index,
      subject_label, term, academic_session, component, column_key, column_title,
      sheet_line, raw_name, raw_score, score_value, flags, note, confidence,
      match_student_id, match_confidence, match_status, candidates
    ) values (
      p_session_id, p_file_id, p_school_id,
      nullif(v_line ->> 'item_no', '')::integer,
      coalesce(nullif(v_line ->> 'class_key', ''), ''),
      nullif(v_line ->> 'subject_index', '')::integer,
      nullif(v_line ->> 'subject_label', ''),
      nullif(v_line ->> 'term', ''),
      nullif(v_line ->> 'academic_session', ''),
      nullif(v_line ->> 'component', ''),
      coalesce(nullif(v_line ->> 'column_key', ''), 'primary'),
      nullif(v_line ->> 'column_title', ''),
      coalesce(nullif(v_line ->> 'sheet_line', '')::integer, 0),
      coalesce(v_line ->> 'raw_name', ''),
      nullif(v_line ->> 'raw_score', ''),
      nullif(v_line ->> 'score_value', '')::numeric,
      coalesce(v_line -> 'flags', '[]'::jsonb),
      nullif(v_line ->> 'note', ''),
      nullif(v_line ->> 'confidence', '')::numeric,
      nullif(v_line ->> 'match_student_id', '')::uuid,
      nullif(v_line ->> 'match_confidence', '')::numeric,
      coalesce(nullif(v_line ->> 'match_status', ''), 'unmatched'),
      coalesce(v_line -> 'candidates', '[]'::jsonb)
    )
    on conflict (session_id, file_id, column_key, sheet_line) do update set
      item_no = excluded.item_no,
      class_key = excluded.class_key,
      subject_index = excluded.subject_index,
      subject_label = excluded.subject_label,
      term = excluded.term,
      academic_session = excluded.academic_session,
      component = excluded.component,
      column_title = excluded.column_title,
      raw_name = excluded.raw_name,
      raw_score = excluded.raw_score,
      score_value = excluded.score_value,
      flags = excluded.flags,
      note = excluded.note,
      confidence = excluded.confidence,
      match_student_id = excluded.match_student_id,
      match_confidence = excluded.match_confidence,
      match_status = excluded.match_status,
      candidates = excluded.candidates,
      updated_at = now();
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'saved', v_count);
end;
$$;
create or replace function ops.sheet_attachment_meta(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $$
declare
  v_row ops.sheet_attachments;
begin
  if not ops.sheet_owned(p_session_id, p_school_id, p_owner_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SHEET_CHAT_NOT_FOUND');
  end if;
  select * into v_row from ops.sheet_attachments
   where id = p_file_id and session_id = p_session_id;
  if v_row.id is null then
    return jsonb_build_object('ok', true, 'attachment', null);
  end if;
  return jsonb_build_object('ok', true, 'attachment', jsonb_build_object(
    'id', v_row.id,
    'filename', v_row.filename,
    'mime', v_row.mime,
    'byte_size', v_row.byte_size,
    'sha256', v_row.sha256,
    'description', v_row.description,
    'sheet_type', v_row.sheet_type,
    'class_key', v_row.class_key,
    'subject_label', v_row.subject_label,
    'term', v_row.term,
    'sheet_read', v_row.sheet_read,
    'created_at', v_row.created_at
  ));
end;
$$;

create or replace function public.ops_sheet_attachment_meta(
  p_session_id uuid, p_school_id uuid, p_owner_user_id uuid, p_file_id uuid
) returns jsonb
language sql security definer set search_path = public, ops, pg_temp
as $$ select ops.sheet_attachment_meta($1,$2,$3,$4); $$;

revoke all on function public.ops_sheet_attachment_meta(uuid,uuid,uuid,uuid) from public;
grant execute on function public.ops_sheet_attachment_meta(uuid,uuid,uuid,uuid) to service_role;
