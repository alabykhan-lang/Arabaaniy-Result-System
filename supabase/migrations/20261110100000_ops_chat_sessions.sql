-- 20261110100000_ops_chat_sessions.sql
-- Chat sections for the Command Center: one private conversation per task.
--
-- Every read and write goes through a function that takes the caller's
-- school_id and owner_user_id from the verified server session. The client
-- never sends them. A session belonging to another owner is simply not found,
-- so one user cannot read another user's chats even with a valid chat id.
--
-- The tables live in ops, like the rest of the assistant's private state.
-- Deleting a chat is a soft delete with a 30-day restore window; messages are
-- only removed by an explicit purge. Audit rows, batch ids and recorded scores
-- are in other tables and are never touched here.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists ops.chat_sessions (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.school_accounts(id) on delete cascade,
  owner_user_id   uuid not null,
  title           text not null default 'New chat',
  tags            jsonb not null default '{}'::jsonb,
  status          text not null default 'active'
                  check (status in ('active', 'archived', 'deleted')),
  pinned          boolean not null default false,
  summary         text,
  summary_through bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  deleted_at      timestamptz,
  purge_after     timestamptz
);

create index if not exists ops_chat_sessions_owner_idx
  on ops.chat_sessions (school_id, owner_user_id, status, last_active_at desc);
create index if not exists ops_chat_sessions_purge_idx
  on ops.chat_sessions (purge_after)
  where status = 'deleted';

comment on table ops.chat_sessions is
  'One private conversation per task. Owner scoping is enforced by every chat function, not by the screen.';
comment on column ops.chat_sessions.tags is
  'Small JSON object: class, subject, term. Tags are for grouping and search, never permission.';
comment on column ops.chat_sessions.purge_after is
  'Set when a chat is deleted. The owner can restore it until this time, then it may be purged.';

create table if not exists ops.chat_messages (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references ops.chat_sessions(id) on delete cascade,
  ordinal          bigint generated always as identity,
  role             text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content          text not null default '',
  tool_calls       jsonb not null default '[]'::jsonb,
  tool_results     jsonb not null default '[]'::jsonb,
  attachment_refs  jsonb not null default '[]'::jsonb,
  route            text,
  created_at       timestamptz not null default now()
);

create unique index if not exists ops_chat_messages_ordinal_idx
  on ops.chat_messages (ordinal);
create index if not exists ops_chat_messages_session_idx
  on ops.chat_messages (session_id, ordinal);

comment on table ops.chat_messages is
  'Full transcript. Attachment refs hold a filename and a text description, never the image bytes.';

create table if not exists ops.chat_state (
  session_id          uuid primary key references ops.chat_sessions(id) on delete cascade,
  working_context     jsonb not null default '{}'::jsonb,
  pending_review      jsonb,
  open_batch_id       uuid,
  open_job_id         uuid,
  updated_at          timestamptz not null default now()
);

comment on table ops.chat_state is
  'Where the chat stopped: class, subject, term, component, pending confirmation and the open page.';
comment on column ops.chat_state.open_batch_id is
  'The audited write batch, so an undo can be offered after a resume. Never deleted with the chat.';

-- ---------------------------------------------------------------------------
-- 2. Row level security as a second lock.
--    The API uses the service role and therefore calls the functions below.
--    These policies keep the same owner rule if a signed-in token ever reads
--    the tables directly.
-- ---------------------------------------------------------------------------
alter table ops.chat_sessions enable row level security;
alter table ops.chat_messages enable row level security;
alter table ops.chat_state enable row level security;

drop policy if exists chat_sessions_owner_read on ops.chat_sessions;
create policy chat_sessions_owner_read on ops.chat_sessions
  for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists chat_sessions_owner_write on ops.chat_sessions;
create policy chat_sessions_owner_write on ops.chat_sessions
  for all to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists chat_messages_owner_read on ops.chat_messages;
create policy chat_messages_owner_read on ops.chat_messages
  for select to authenticated
  using (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_messages.session_id and s.owner_user_id = auth.uid()
  ));

drop policy if exists chat_messages_owner_write on ops.chat_messages;
create policy chat_messages_owner_write on ops.chat_messages
  for all to authenticated
  using (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_messages.session_id and s.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_messages.session_id and s.owner_user_id = auth.uid()
  ));

drop policy if exists chat_state_owner_read on ops.chat_state;
create policy chat_state_owner_read on ops.chat_state
  for select to authenticated
  using (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_state.session_id and s.owner_user_id = auth.uid()
  ));

drop policy if exists chat_state_owner_write on ops.chat_state;
create policy chat_state_owner_write on ops.chat_state
  for all to authenticated
  using (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_state.session_id and s.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from ops.chat_sessions s
    where s.id = chat_state.session_id and s.owner_user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------
create or replace function ops.chat_title_from_text(p_text text)
returns text
language plpgsql
immutable
set search_path = ops, pg_temp
as $function$
declare
  v text;
begin
  v := regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g');
  v := btrim(v);
  if length(v) = 0 then return 'New chat'; end if;
  if length(v) > 60 then
    v := btrim(substr(v, 1, 57)) || '…';
  end if;
  return v;
end;
$function$;

create or replace function ops.chat_session_json(p_session ops.chat_sessions)
returns jsonb
language plpgsql
stable
set search_path = ops, pg_temp
as $function$
begin
  return jsonb_build_object(
    'id', p_session.id,
    'title', p_session.title,
    'tags', p_session.tags,
    'status', p_session.status,
    'pinned', p_session.pinned,
    'summary', p_session.summary,
    'created_at', p_session.created_at,
    'updated_at', p_session.updated_at,
    'last_active_at', p_session.last_active_at,
    'deleted_at', p_session.deleted_at,
    'purge_after', p_session.purge_after
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Session functions
-- ---------------------------------------------------------------------------
create or replace function public.ops_chat_session_create(
  p_school_id uuid,
  p_owner_user_id uuid,
  p_title text default null,
  p_tags jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
begin
  if p_school_id is null or p_owner_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED',
      'message', 'A signed-in owner and school are required.');
  end if;
  insert into ops.chat_sessions (school_id, owner_user_id, title, tags)
  values (
    p_school_id,
    p_owner_user_id,
    case when nullif(btrim(coalesce(p_title, '')), '') is null then 'New chat'
         else ops.chat_title_from_text(p_title) end,
    coalesce(p_tags, '{}'::jsonb)
  )
  returning * into v_row;
  return jsonb_build_object('ok', true, 'session', ops.chat_session_json(v_row));
end;
$function$;

create or replace function public.ops_chat_sessions_list(
  p_school_id uuid,
  p_owner_user_id uuid,
  p_search text default null,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'active');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb;
begin
  if p_school_id is null or p_owner_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED',
      'message', 'A signed-in owner and school are required.');
  end if;

  select coalesce(jsonb_agg(item.order_row order by item.pinned desc, item.last_active_at desc), '[]'::jsonb)
    into v_rows
    from (
      select
        ops.chat_session_json(s) || jsonb_build_object(
          'message_count', (select count(*) from ops.chat_messages m where m.session_id = s.id),
          'last_message', (
            select left(m.content, 160)
              from ops.chat_messages m
             where m.session_id = s.id and m.role in ('user', 'assistant')
             order by m.ordinal desc
             limit 1
          )
        ) as order_row,
        s.pinned,
        s.last_active_at
      from ops.chat_sessions s
      where s.school_id = p_school_id
        and s.owner_user_id = p_owner_user_id
        and case
              when v_status = 'all' then true
              when v_status = 'deleted' then s.status = 'deleted'
              else s.status = v_status
            end
        and (
          v_search is null
          or s.title ilike '%' || v_search || '%'
          or s.tags::text ilike '%' || v_search || '%'
          or exists (
            select 1 from ops.chat_messages m
             where m.session_id = s.id and m.content ilike '%' || v_search || '%'
          )
        )
    ) item;

  return jsonb_build_object('ok', true, 'sessions', v_rows);
end;
$function$;

create or replace function public.ops_chat_session_get(
  p_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_message_limit integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
  v_state ops.chat_state;
  v_messages jsonb;
  v_limit integer := greatest(1, least(coalesce(p_message_limit, 60), 200));
begin
  if p_id is null or p_school_id is null or p_owner_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED');
  end if;

  select * into v_row
    from ops.chat_sessions
   where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND',
      'message', 'That chat is not in this account.');
  end if;

  select * into v_state from ops.chat_state where session_id = v_row.id;

  select coalesce(jsonb_agg(msg order by msg_ordinal), '[]'::jsonb)
    into v_messages
    from (
      select jsonb_build_object(
               'id', m.id,
               'role', m.role,
               'content', m.content,
               'tool_calls', m.tool_calls,
               'tool_results', m.tool_results,
               'attachment_refs', m.attachment_refs,
               'route', m.route,
               'created_at', m.created_at
             ) as msg,
             m.ordinal as msg_ordinal
        from (
          select * from ops.chat_messages
           where session_id = v_row.id
           order by ordinal desc
           limit v_limit
        ) m
    ) picked;

  return jsonb_build_object(
    'ok', true,
    'session', ops.chat_session_json(v_row) || jsonb_build_object('message_count',
      (select count(*) from ops.chat_messages m where m.session_id = v_row.id)),
    'messages', v_messages,
    'state', case when v_state.session_id is null then null else jsonb_build_object(
      'working_context', v_state.working_context,
      'pending_review', v_state.pending_review,
      'open_batch_id', v_state.open_batch_id,
      'open_job_id', v_state.open_job_id,
      'updated_at', v_state.updated_at
    ) end
  );
end;
$function$;

create or replace function public.ops_chat_session_update(
  p_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_title text default null,
  p_tags jsonb default null,
  p_status text default null,
  p_pinned boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
begin
  if v_status is not null and v_status not in ('active', 'archived') then
    return jsonb_build_object('ok', false, 'code', 'CHAT_STATUS_INVALID',
      'message', 'Use delete to remove a chat.');
  end if;
  select * into v_row
    from ops.chat_sessions
   where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;

  update ops.chat_sessions set
    title = case when nullif(btrim(coalesce(p_title, '')), '') is null then title
                 else ops.chat_title_from_text(p_title) end,
    tags = coalesce(p_tags, tags),
    status = coalesce(v_status, status),
    pinned = coalesce(p_pinned, pinned),
    updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'session', ops.chat_session_json(v_row));
end;
$function$;

create or replace function public.ops_chat_session_delete(
  p_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
begin
  update ops.chat_sessions set
    status = 'deleted',
    deleted_at = now(),
    purge_after = now() + interval '30 days',
    updated_at = now()
  where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id
    and status <> 'deleted'
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'deleted', true,
    'purge_after', v_row.purge_after,
    'message', 'The chat is in Deleted for 30 days. Nothing in the school records was removed.');
end;
$function$;

create or replace function public.ops_chat_session_restore(
  p_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
begin
  update ops.chat_sessions set
    status = 'active',
    deleted_at = null,
    purge_after = null,
    updated_at = now(),
    last_active_at = now()
  where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id
    and status = 'deleted'
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'session', ops.chat_session_json(v_row));
end;
$function$;

create or replace function public.ops_chat_session_purge(  p_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.chat_sessions;
begin
  select * into v_row
    from ops.chat_sessions
   where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id
     and status = 'deleted'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;
  if not p_force and (v_row.purge_after is null or v_row.purge_after > now()) then
    return jsonb_build_object('ok', false, 'code', 'CHAT_PURGE_TOO_SOON',
      'purge_after', v_row.purge_after,
      'message', 'This chat can still be restored until its purge date.');
  end if;
  delete from ops.chat_sessions where id = v_row.id;
  return jsonb_build_object('ok', true, 'purged', true,
    'message', 'The chat transcript is permanently gone. School records, audit rows and batch ids were not touched.');
end;
$function$;

-- Purge chats whose 30-day restore window has passed. Called when an owner
-- opens the chat list, so no separate scheduler is required. Only rows that
-- were already soft-deleted are touched.
create or replace function public.ops_chat_purge_due(p_school_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_count integer := 0;
begin
  delete from ops.chat_sessions
   where status = 'deleted'
     and purge_after is not null
     and purge_after <= now()
     and (p_school_id is null or school_id = p_school_id);
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'purged', v_count);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Messages and state
-- ---------------------------------------------------------------------------
create or replace function public.ops_chat_message_add(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_role text,
  p_content text,
  p_tool_calls jsonb default '[]'::jsonb,
  p_tool_results jsonb default '[]'::jsonb,
  p_attachment_refs jsonb default '[]'::jsonb,
  p_route text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_session ops.chat_sessions;
  v_id uuid;
  v_ordinal bigint;
  v_role text := case when p_role in ('user', 'assistant', 'system', 'tool') then p_role else 'user' end;
begin
  if p_session_id is null or p_school_id is null or p_owner_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED');
  end if;

  select * into v_session
    from ops.chat_sessions
   where id = p_session_id and school_id = p_school_id and owner_user_id = p_owner_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;
  if v_session.status = 'deleted' then
    return jsonb_build_object('ok', false, 'code', 'CHAT_DELETED',
      'message', 'That chat is in Deleted. Restore it first.');
  end if;

  insert into ops.chat_messages (session_id, role, content, tool_calls, tool_results, attachment_refs, route)
  values (
    v_session.id, v_role, coalesce(p_content, ''),
    coalesce(p_tool_calls, '[]'::jsonb),
    coalesce(p_tool_results, '[]'::jsonb),
    coalesce(p_attachment_refs, '[]'::jsonb),
    nullif(btrim(coalesce(p_route, '')), '')
  )
  returning id, ordinal into v_id, v_ordinal;

  update ops.chat_sessions set
    title = case
      when v_role = 'user' and (title = 'New chat' or title = '' or title is null)
        then ops.chat_title_from_text(p_content)
      else title
    end,
    status = case when status = 'archived' then 'active' else status end,
    updated_at = now(),
    last_active_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_id,
    'ordinal', v_ordinal,
    'title', v_session.title,
    'session', ops.chat_session_json(v_session)
  );
end;
$function$;

create or replace function public.ops_chat_turn_finish(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_content text,
  p_tool_calls jsonb default '[]'::jsonb,
  p_tool_results jsonb default '[]'::jsonb,
  p_attachment_refs jsonb default '[]'::jsonb,
  p_working_context jsonb default null,
  p_pending_review jsonb default null,
  p_open_batch_id uuid default null,
  p_open_job_id uuid default null,
  p_route text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_session ops.chat_sessions;
  v_message_id uuid;
  v_ordinal bigint;
begin
  if p_session_id is null or p_school_id is null or p_owner_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED');
  end if;

  select * into v_session
    from ops.chat_sessions
   where id = p_session_id and school_id = p_school_id and owner_user_id = p_owner_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;
  if v_session.status = 'deleted' then
    return jsonb_build_object('ok', false, 'code', 'CHAT_DELETED');
  end if;

  insert into ops.chat_messages (session_id, role, content, tool_calls, tool_results, attachment_refs, route)
  values (
    v_session.id, 'assistant', coalesce(p_content, ''),
    coalesce(p_tool_calls, '[]'::jsonb),
    coalesce(p_tool_results, '[]'::jsonb),
    coalesce(p_attachment_refs, '[]'::jsonb),
    nullif(btrim(coalesce(p_route, '')), '')
  )
  returning id, ordinal into v_message_id, v_ordinal;

  insert into ops.chat_state (
    session_id, working_context, pending_review, open_batch_id, open_job_id, updated_at
  ) values (
    v_session.id,
    coalesce(p_working_context, '{}'::jsonb),
    p_pending_review,
    p_open_batch_id,
    p_open_job_id,
    now()
  )
  on conflict (session_id) do update set
    working_context = coalesce(excluded.working_context, ops.chat_state.working_context),
    pending_review = excluded.pending_review,
    open_batch_id = coalesce(excluded.open_batch_id, ops.chat_state.open_batch_id),
    open_job_id = coalesce(excluded.open_job_id, ops.chat_state.open_job_id),
    updated_at = now();

  update ops.chat_sessions set
    status = case when status = 'archived' then 'active' else status end,
    tags = coalesce(tags, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'class', coalesce(nullif(p_working_context->>'class_label', ''), nullif(p_working_context->>'class_key', '')),
      'subject', nullif(p_working_context->>'subject', ''),
      'term', nullif(p_working_context->>'term', '')
    )),
    updated_at = now(),
    last_active_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_message_id,
    'ordinal', v_ordinal,
    'session', ops.chat_session_json(v_session)
  );
end;
$function$;

create or replace function public.ops_chat_state_put(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_working_context jsonb default null,
  p_pending_review jsonb default null,
  p_open_batch_id uuid default null,
  p_open_job_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_session ops.chat_sessions;
begin
  select * into v_session
    from ops.chat_sessions
   where id = p_session_id and school_id = p_school_id and owner_user_id = p_owner_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;

  insert into ops.chat_state (session_id, working_context, pending_review, open_batch_id, open_job_id, updated_at)
  values (v_session.id, coalesce(p_working_context, '{}'::jsonb), p_pending_review,
          p_open_batch_id, p_open_job_id, now())
  on conflict (session_id) do update set
    working_context = coalesce(excluded.working_context, ops.chat_state.working_context),
    pending_review = excluded.pending_review,
    open_batch_id = coalesce(excluded.open_batch_id, ops.chat_state.open_batch_id),
    open_job_id = coalesce(excluded.open_job_id, ops.chat_state.open_job_id),
    updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Developer usage counts. Counts only: no title, no message text.
-- ---------------------------------------------------------------------------
create or replace function public.ops_chat_usage(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_rows jsonb;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'CHAT_SCOPE_REQUIRED');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', s.id,
      'owner_user_id', s.owner_user_id,
      'status', s.status,
      'message_count', coalesce(m.message_count, 0),
      'user_turns', coalesce(m.user_turns, 0),
      'assistant_turns', coalesce(m.assistant_turns, 0),
      'created_at', s.created_at,
      'last_active_at', s.last_active_at
    ) order by s.last_active_at desc), '[]'::jsonb)
    into v_rows
    from ops.chat_sessions s
    left join (
      select session_id,
             count(*) as message_count,
             count(*) filter (where role = 'user') as user_turns,
             count(*) filter (where role = 'assistant') as assistant_turns
        from ops.chat_messages
       group by session_id
    ) m on m.session_id = s.id
   where s.school_id = p_school_id;
  return jsonb_build_object('ok', true, 'chats', v_rows);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Grants. The service role calls the functions; signed-in users may read
--    their own rows through the policies above if ops is ever exposed.
-- ---------------------------------------------------------------------------
grant usage on schema ops to authenticated, service_role;
grant select, insert, update, delete on ops.chat_sessions to authenticated, service_role;
grant select, insert, update, delete on ops.chat_messages to authenticated, service_role;
grant select, insert, update, delete on ops.chat_state to authenticated, service_role;
grant usage, select on all sequences in schema ops to authenticated, service_role;

revoke all on function public.ops_chat_session_create(uuid, uuid, text, jsonb) from public;
revoke all on function public.ops_chat_sessions_list(uuid, uuid, text, text) from public;
revoke all on function public.ops_chat_session_get(uuid, uuid, uuid, integer) from public;
revoke all on function public.ops_chat_session_update(uuid, uuid, uuid, text, jsonb, text, boolean) from public;
revoke all on function public.ops_chat_session_delete(uuid, uuid, uuid) from public;
revoke all on function public.ops_chat_session_restore(uuid, uuid, uuid) from public;
revoke all on function public.ops_chat_session_purge(uuid, uuid, uuid, boolean) from public;
revoke all on function public.ops_chat_purge_due(uuid) from public;revoke all on function public.ops_chat_message_add(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, text) from public;
revoke all on function public.ops_chat_turn_finish(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, uuid, text) from public;
revoke all on function public.ops_chat_state_put(uuid, uuid, uuid, jsonb, jsonb, uuid, uuid) from public;
revoke all on function public.ops_chat_usage(uuid) from public;

grant execute on function public.ops_chat_session_create(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.ops_chat_sessions_list(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_chat_session_get(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.ops_chat_session_update(uuid, uuid, uuid, text, jsonb, text, boolean) to service_role;
grant execute on function public.ops_chat_session_delete(uuid, uuid, uuid) to service_role;
grant execute on function public.ops_chat_session_restore(uuid, uuid, uuid) to service_role;
grant execute on function public.ops_chat_session_purge(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.ops_chat_purge_due(uuid) to service_role;
grant execute on function public.ops_chat_message_add(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.ops_chat_turn_finish(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, uuid, text) to service_role;
grant execute on function public.ops_chat_state_put(uuid, uuid, uuid, jsonb, jsonb, uuid, uuid) to service_role;
grant execute on function public.ops_chat_usage(uuid) to service_role;
