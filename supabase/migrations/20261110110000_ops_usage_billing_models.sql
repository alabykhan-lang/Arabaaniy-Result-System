-- 20261110110000_ops_context_usage_billing_models.sql
--
-- Addendum sections 16, 17, 18 and 20:
--   * a rolling summary so a long chat sends six turns, not the whole book
--   * a usage meter that never shows tokens or cost to the school
--   * subscription status, a seven day grace period, and a cutoff that stops
--     only the assistant
--   * developer model routes with encrypted keys and an audit of every change
--
-- Everything is additive and lives in ops. School records, scores and audit
-- rows are never touched by a compaction, a cutoff or a model switch.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Usage meter
--    One row per model call. Counts only, no prompt text and no reply text.
-- ---------------------------------------------------------------------------
create table if not exists ops.model_calls (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid references public.school_accounts(id) on delete cascade,
  user_id         uuid,
  session_id      uuid references ops.chat_sessions(id) on delete set null,
  route           text not null default 'primary'
                  check (route in ('primary', 'secondary', 'fallback', 'vision')),
  provider        text,
  model           text,
  tokens_in       integer not null default 0 check (tokens_in >= 0),
  tokens_out      integer not null default 0 check (tokens_out >= 0),
  cached_tokens   integer not null default 0 check (cached_tokens >= 0),
  context_tokens  integer not null default 0 check (context_tokens >= 0),
  tool_calls      integer not null default 0 check (tool_calls >= 0),
  ok              boolean not null default true,
  error_code      text,
  cost_estimate   numeric(12, 6) not null default 0,
  currency        text not null default 'NGN',
  created_at      timestamptz not null default now()
);

create index if not exists ops_model_calls_school_month_idx
  on ops.model_calls (school_id, created_at desc);
create index if not exists ops_model_calls_session_idx
  on ops.model_calls (session_id, created_at desc) where session_id is not null;

comment on table ops.model_calls is
  'Plain usage log. Written after every model call, never used to gate a write. The school sees work counts, never tokens or cost.';

create table if not exists ops.usage_rates (
  provider                text not null,
  model                   text not null,
  input_per_million       numeric(12, 4) not null default 0,
  output_per_million      numeric(12, 4) not null default 0,
  cached_per_million      numeric(12, 4) not null default 0,
  currency                text not null default 'NGN',
  is_placeholder          boolean not null default true,
  note                    text,
  updated_at              timestamptz not null default now(),
  primary key (provider, model)
);

comment on table ops.usage_rates is
  'Cost per million tokens. Placeholder until the developer enters the rate actually paid.';

insert into ops.usage_rates (provider, model, note) values
  ('river', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'Placeholder rate. Set after the first invoice.'),
  ('gemini', 'gemini-3.5-flash', 'Placeholder rate. Set after the first invoice.')
on conflict (provider, model) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Subscription per school
--    Billing stays outside the assistant. This table only carries status.
-- ---------------------------------------------------------------------------
create table if not exists ops.school_subscriptions (
  school_id           uuid primary key references public.school_accounts(id) on delete cascade,
  tier                text not null default 'entry'
                      check (tier in ('entry', 'standard', 'large')),
  price_naira         integer not null default 10000 check (price_naira >= 0),
  status              text not null default 'active'
                      check (status in ('active', 'grace', 'suspended')),
  period_start        timestamptz not null default date_trunc('month', now()),
  due_date            timestamptz,
  grace_days          integer not null default 7 check (grace_days between 0 and 60),
  included_tokens     bigint not null default 5000000 check (included_tokens >= 0),
  is_placeholder      boolean not null default true,
  note                text,
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table ops.school_subscriptions is
  'Status only. A suspended school loses the assistant, never its records, search or export.';

insert into ops.school_subscriptions (school_id, tier, price_naira, status, due_date, note)
select s.id, 'entry', 10000, 'active', date_trunc('month', now()) + interval '1 month',
       'Entry placeholder. Price and allowance are set after one measured month.'
  from public.school_accounts s
on conflict (school_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Developer model routes
--    A key is stored encrypted. The screen only ever sees the last four
--    characters. The school never sees the provider, model or key.
-- ---------------------------------------------------------------------------
create table if not exists ops.model_config (
  role            text primary key check (role in ('primary', 'secondary', 'vision')),
  provider        text not null default 'river',
  model           text not null,
  base_url        text,
  api_key_enc     bytea,
  key_last4       text,
  enabled         boolean not null default true,
  fail_count      integer not null default 0,
  last_error      text,
  last_tested_at  timestamptz,
  last_test_ok    boolean,
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

comment on table ops.model_config is
  'Primary, secondary and vision routes. api_key_enc is pgp_sym_encrypt(secret, OPS_SECRET_KEY); the plaintext key never leaves the server.';

insert into ops.model_config (role, provider, model, base_url) values
  ('primary', 'river', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', null),
  ('secondary', 'gemini', 'gemini-3.5-flash', null),
  ('vision', 'gemini', 'gemini-3.5-flash', null)
on conflict (role) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Cold storage for compaction
--    The full transcript moves here after 60 quiet days, and comes back on
--    reopen. Audit rows, batch ids and scores are untouched.
-- ---------------------------------------------------------------------------
create table if not exists ops.chat_messages_cold (
  id               uuid primary key,
  session_id       uuid not null,
  ordinal          bigint not null,
  role             text not null,
  content          text not null default '',
  tool_calls       jsonb not null default '[]'::jsonb,
  tool_results     jsonb not null default '[]'::jsonb,
  attachment_refs  jsonb not null default '[]'::jsonb,
  route            text,
  created_at       timestamptz not null,
  moved_at         timestamptz not null default now()
);

create index if not exists ops_chat_messages_cold_session_idx
  on ops.chat_messages_cold (session_id, ordinal);

comment on table ops.chat_messages_cold is
  'Cold copy of a compacted transcript. Reopening restores it to chat_messages and removes the cold row.';

-- 60 quiet days is a per-chat decision, so record when the owner was told.
alter table ops.chat_sessions
  add column if not exists compaction_notice_at timestamptz;

-- ---------------------------------------------------------------------------
-- 5. Helpers
-- ---------------------------------------------------------------------------
create or replace function ops.subscription_state(p_school_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.school_subscriptions;
  v_state text;
begin
  select * into v_row from ops.school_subscriptions where school_id = p_school_id;
  if not found then
    return jsonb_build_object(
      'ok', true, 'tier', 'entry', 'status', 'active', 'price_naira', 10000,
      'included_tokens', 5000000, 'is_placeholder', true, 'due_date', null,
      'grace_until', null, 'note', 'No subscription row yet; the assistant stays on.');
  end if;

  if v_row.status = 'suspended' then
    v_state := 'suspended';
  elsif v_row.due_date is null or now() <= v_row.due_date then
    v_state := 'active';
  elsif now() <= v_row.due_date + make_interval(days => v_row.grace_days) then
    v_state := 'grace';
  else
    v_state := 'suspended';
  end if;

  return jsonb_build_object(
    'ok', true,
    'tier', v_row.tier,
    'status', v_state,
    'stored_status', v_row.status,
    'price_naira', v_row.price_naira,
    'due_date', v_row.due_date,
    'grace_until', case when v_row.due_date is null then null
                        else v_row.due_date + make_interval(days => v_row.grace_days) end,
    'included_tokens', v_row.included_tokens,
    'grace_days', v_row.grace_days,
    'is_placeholder', v_row.is_placeholder,
    'note', v_row.note,
    'updated_at', v_row.updated_at
  );
end;
$function$;

create or replace function ops.usage_since(p_school_id uuid, p_from timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'calls', count(*),
    'tokens_in', coalesce(sum(tokens_in), 0),
    'tokens_out', coalesce(sum(tokens_out), 0),
    'cached_tokens', coalesce(sum(cached_tokens), 0),
    'tool_calls', coalesce(sum(tool_calls), 0),
    'cost_estimate', coalesce(sum(cost_estimate), 0)
  ) into v
  from ops.model_calls
  where school_id = p_school_id and created_at >= p_from;
  return v;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Usage logging (called by the assistant after every model call)
-- ---------------------------------------------------------------------------
create or replace function public.ops_usage_log(
  p_school_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_route text,
  p_provider text,
  p_model text,
  p_tokens_in integer default 0,
  p_tokens_out integer default 0,
  p_cached_tokens integer default 0,
  p_context_tokens integer default 0,
  p_tool_calls integer default 0,
  p_ok boolean default true,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_rate ops.usage_rates;
  v_cost numeric(12, 6) := 0;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'USAGE_SCHOOL_REQUIRED');
  end if;

  select * into v_rate from ops.usage_rates
   where provider = coalesce(p_provider, '') and model = coalesce(p_model, '');
  if found then
    v_cost := (
      greatest(0, coalesce(p_tokens_in, 0) - greatest(0, coalesce(p_cached_tokens, 0)))
        * v_rate.input_per_million
      + greatest(0, coalesce(p_cached_tokens, 0)) * v_rate.cached_per_million
      + greatest(0, coalesce(p_tokens_out, 0)) * v_rate.output_per_million
    ) / 1000000.0;
  end if;

  insert into ops.model_calls (
    school_id, user_id, session_id, route, provider, model,
    tokens_in, tokens_out, cached_tokens, context_tokens, tool_calls,
    ok, error_code, cost_estimate, currency
  ) values (
    p_school_id, p_user_id, p_session_id,
    case when p_route in ('primary', 'secondary', 'fallback', 'vision') then p_route else 'primary' end,
    nullif(btrim(coalesce(p_provider, '')), ''),
    nullif(btrim(coalesce(p_model, '')), ''),
    greatest(0, coalesce(p_tokens_in, 0)),
    greatest(0, coalesce(p_tokens_out, 0)),
    greatest(0, coalesce(p_cached_tokens, 0)),
    greatest(0, coalesce(p_context_tokens, 0)),
    greatest(0, coalesce(p_tool_calls, 0)),
    coalesce(p_ok, true),
    nullif(btrim(coalesce(p_error_code, '')), ''),
    v_cost,
    coalesce(v_rate.currency, 'NGN')
  );

  return jsonb_build_object('ok', true, 'cost_estimate', v_cost);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. The assistant gate.
--    Suspended stops chat, voice and in-portal help only. Nothing else asks
--    this function, so records, search, print and export keep working.
-- ---------------------------------------------------------------------------
create or replace function public.ops_assistant_gate(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_sub jsonb;
  v_used jsonb;
  v_tokens bigint;
  v_allow bigint;
  v_percent numeric;
  v_band text;
  v_banner text;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'allowed', false, 'code', 'GATE_SCHOOL_REQUIRED');
  end if;

  v_sub := ops.subscription_state(p_school_id);
  v_used := ops.usage_since(p_school_id, date_trunc('month', now()));
  v_tokens := coalesce((v_used->>'tokens_in')::bigint, 0) + coalesce((v_used->>'tokens_out')::bigint, 0);
  v_allow := greatest(1, coalesce((v_sub->>'included_tokens')::bigint, 5000000));
  v_percent := round((v_tokens::numeric / v_allow::numeric) * 100, 1);

  if v_sub->>'status' = 'suspended' then
    v_band := 'suspended';
    v_banner := 'The assistant is paused while the school''s subscription is restored. '
      || 'Recording, publishing, search and export still work.';
  elsif v_sub->>'status' = 'grace' then
    v_band := 'grace';
    v_banner := 'The subscription is in its grace period. Restore payment to keep the assistant on.';
  elsif v_percent >= 100 then
    v_band := 'over';
    v_banner := 'This month''s included usage is used up. The assistant continues on the backup route; recording is unaffected.';
  elsif v_percent >= 80 then
    v_band := 'warn';
    v_banner := 'This month''s included usage is above 80%.';
  else
    v_band := 'ok';
    v_banner := null;
  end if;

  return jsonb_build_object(
    'ok', true,
    'allowed', (v_sub->>'status') <> 'suspended',
    'status', v_sub->>'status',
    'tier', v_sub->>'tier',
    'band', v_band,
    'percent', v_percent,
    'fallback_only', v_percent >= 100,
    'banner', v_banner,
    'due_date', v_sub->'due_date',
    'grace_until', v_sub->'grace_until',
    'included_usage', v_allow,
    'included_tokens', v_allow,
    'grace_days', coalesce((v_sub->>'grace_days')::int, 7),
    'price_naira', v_sub->'price_naira',
    'tier_label', v_sub->>'tier',
    'note', v_sub->>'note',
    'is_placeholder', v_sub->'is_placeholder'
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. What the school sees: work counts for the month. Never tokens or cost.
-- ---------------------------------------------------------------------------
create or replace function public.ops_school_month_summary(
  p_school_id uuid,
  p_month date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_sub jsonb;
  v_used jsonb;
  v_gate jsonb;
  v_scores integer;
  v_batches integer;
  v_docs integer;
  v_chats integer;
  v_questions integer;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'SUMMARY_SCHOOL_REQUIRED');
  end if;
  v_from := date_trunc('month', coalesce(p_month, current_date)::timestamp)::timestamptz;
  v_to := v_from + interval '1 month';

  select count(*) into v_scores
    from ops.write_audit
   where school_id = p_school_id and created_at >= v_from and created_at < v_to
     and action in ('record_score', 'overwrite_score', 'correct_score');
  select count(*) into v_batches
    from ops.write_batches
   where school_id = p_school_id and created_at >= v_from and created_at < v_to;
  select count(*) into v_docs
    from ops.generated_documents
   where school_id = p_school_id and created_at >= v_from and created_at < v_to;
  select count(*) into v_chats
    from ops.chat_sessions
   where school_id = p_school_id and created_at >= v_from and created_at < v_to;
  select count(*) into v_questions
    from ops.chat_messages m
    join ops.chat_sessions s on s.id = m.session_id
   where s.school_id = p_school_id and m.role = 'user'
     and m.created_at >= v_from and m.created_at < v_to;

  v_sub := ops.subscription_state(p_school_id);
  v_used := ops.usage_since(p_school_id, v_from);
  v_gate := public.ops_assistant_gate(p_school_id);

  return jsonb_build_object(
    'ok', true,
    'month', to_char(v_from, 'YYYY-MM'),
    'period_start', v_from,
    'scores_recorded', v_scores,
    'write_batches', v_batches,
    'documents_prepared', v_docs,
    'chats_started', v_chats,
    'questions_answered', v_questions,
    'tier', v_sub->>'tier',
    'status', v_gate->>'status',
    'price_naira', v_sub->'price_naira',
    'usage_band', v_gate->>'band',
    'is_placeholder', v_sub->'is_placeholder',
    'note', v_sub->>'note'
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Subscription write (developer only, audited by the caller)
-- ---------------------------------------------------------------------------
create or replace function public.ops_subscription_set(
  p_school_id uuid,
  p_status text default null,
  p_tier text default null,
  p_price_naira integer default null,
  p_due_date timestamptz default null,
  p_included_tokens bigint default null,
  p_grace_days integer default null,
  p_note text default null,
  p_actor_id uuid default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.school_subscriptions;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'SUB_SCHOOL_REQUIRED');
  end if;
  if p_status is not null and p_status not in ('active', 'grace', 'suspended') then
    return jsonb_build_object('ok', false, 'code', 'SUB_STATUS_INVALID');
  end if;
  if p_tier is not null and p_tier not in ('entry', 'standard', 'large') then
    return jsonb_build_object('ok', false, 'code', 'SUB_TIER_INVALID');
  end if;

  insert into ops.school_subscriptions (school_id) values (p_school_id)
  on conflict (school_id) do nothing;

  update ops.school_subscriptions set
    status = coalesce(nullif(btrim(coalesce(p_status, '')), ''), status),
    tier = coalesce(nullif(btrim(coalesce(p_tier, '')), ''), tier),
    price_naira = coalesce(p_price_naira, price_naira),
    due_date = coalesce(p_due_date, due_date),
    included_tokens = coalesce(p_included_tokens, included_tokens),
    grace_days = coalesce(p_grace_days, grace_days),
    note = coalesce(p_note, note),
    updated_by = coalesce(p_actor_id, updated_by),
    updated_at = now()
  where school_id = p_school_id
  returning * into v_row;

  insert into ops.audit (actor_id, actor_email, action, entity, entity_id, detail)
  values (p_actor_id, p_actor_email, 'subscription_set', 'school_subscription', p_school_id,
    jsonb_build_object(
      'status', v_row.status, 'tier', v_row.tier, 'price_naira', v_row.price_naira,
      'due_date', v_row.due_date, 'included_tokens', v_row.included_tokens,
      'grace_days', v_row.grace_days, 'note', v_row.note));

  return jsonb_build_object('ok', true, 'subscription', ops.subscription_state(p_school_id));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Context trimming
--     Keep the last six turns in full. Older turns become one rolling
--     summary, updated every time a turn is dropped. Deterministic and free.
-- ---------------------------------------------------------------------------
create or replace function public.ops_chat_trim(
  p_session_id uuid,
  p_school_id uuid,
  p_owner_user_id uuid,
  p_keep integer default 12
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_session ops.chat_sessions;
  v_keep integer := greatest(2, least(coalesce(p_keep, 12), 40));
  v_cut bigint;
  v_summary text;
  v_new text;
begin
  select * into v_session
    from ops.chat_sessions
   where id = p_session_id and school_id = p_school_id and owner_user_id = p_owner_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;

  select max(ordinal) into v_cut from (
    select ordinal from ops.chat_messages
     where session_id = v_session.id
     order by ordinal desc
     offset v_keep
  ) older;

  if v_cut is null or v_cut <= coalesce(v_session.summary_through, 0) then
    return jsonb_build_object('ok', true, 'trimmed', false,
      'summary', v_session.summary, 'summary_through', v_session.summary_through);
  end if;

  select string_agg(
           case when m.role = 'user' then 'Asked: ' else 'Answered: ' end
           || left(regexp_replace(m.content, '\s+', ' ', 'g'), 180),
           E'\n' order by m.ordinal)
    into v_new
    from ops.chat_messages m
   where m.session_id = v_session.id
     and m.ordinal > coalesce(v_session.summary_through, 0)
     and m.ordinal <= v_cut
     and m.role in ('user', 'assistant')
     and btrim(m.content) <> '';

  v_summary := btrim(coalesce(v_session.summary, '') || E'\n' || coalesce(v_new, ''));
  if length(v_summary) > 2400 then
    v_summary := '…' || right(v_summary, 2400);
  end if;

  update ops.chat_sessions set
    summary = nullif(btrim(v_summary), ''),
    summary_through = v_cut,
    updated_at = now()
  where id = v_session.id;

  return jsonb_build_object('ok', true, 'trimmed', true,
    'summary', nullif(btrim(v_summary), ''), 'summary_through', v_cut,
    'kept_from', v_cut + 1);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 11. Compaction after 60 quiet days, and restore on reopen
-- ---------------------------------------------------------------------------
create or replace function public.ops_chat_compact_due(p_school_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_session ops.chat_sessions;
  v_count integer := 0;
  v_summary text;
begin
  for v_session in
    select * from ops.chat_sessions
     where status = 'active'
       and last_active_at < now() - interval '60 days'
       and (p_school_id is null or school_id = p_school_id)
       and not exists (select 1 from ops.chat_messages_cold c where c.session_id = chat_sessions.id)
     for update skip locked
  loop
    select string_agg(
             case when m.role = 'user' then 'Asked: ' else 'Answered: ' end
             || left(regexp_replace(m.content, '\s+', ' ', 'g'), 200),
             E'\n' order by m.ordinal)
      into v_summary
      from ops.chat_messages m
     where m.session_id = v_session.id and m.role in ('user', 'assistant') and btrim(m.content) <> '';

    insert into ops.chat_messages_cold (id, session_id, ordinal, role, content, tool_calls, tool_results, attachment_refs, route, created_at)
    select id, session_id, ordinal, role, content, tool_calls, tool_results, attachment_refs, route, created_at
      from ops.chat_messages
     where session_id = v_session.id
    on conflict (id) do nothing;

    delete from ops.chat_messages where session_id = v_session.id;

    update ops.chat_sessions set
      status = 'archived',
      summary = nullif(left(coalesce(v_summary, ''), 2400), ''),
      summary_through = coalesce((select max(ordinal) from ops.chat_messages_cold c where c.session_id = v_session.id), summary_through),
      compaction_notice_at = now(),
      updated_at = now()
    where id = v_session.id;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'compacted', v_count);
end;
$function$;

-- Reopening a compacted chat puts the transcript back. Owner scoped.
create or replace function public.ops_chat_session_restore_cold(
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
  v_session ops.chat_sessions;
  v_count integer;
begin
  select * into v_session
    from ops.chat_sessions
   where id = p_id and school_id = p_school_id and owner_user_id = p_owner_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CHAT_NOT_FOUND');
  end if;

  select count(*) into v_count from ops.chat_messages_cold where session_id = v_session.id;
  if v_count = 0 then
    return jsonb_build_object('ok', true, 'restored', 0);
  end if;

  insert into ops.chat_messages (id, session_id, ordinal, role, content, tool_calls, tool_results, attachment_refs, route, created_at)
  overriding system value
  select id, session_id, ordinal, role, content, tool_calls, tool_results, attachment_refs, route, created_at
    from ops.chat_messages_cold
   where session_id = v_session.id
  on conflict (id) do nothing;

  delete from ops.chat_messages_cold where session_id = v_session.id;

  update ops.chat_sessions set status = 'active', updated_at = now(), last_active_at = now()
   where id = v_session.id;

  return jsonb_build_object('ok', true, 'restored', v_count);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 12. Developer model routes
-- ---------------------------------------------------------------------------
create or replace function public.ops_model_config_list()
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'role', c.role,
      'provider', c.provider,
      'model', c.model,
      'base_url', c.base_url,
      'has_key', c.api_key_enc is not null,
      'key_last4', c.key_last4,
      'enabled', c.enabled,
      'last_error', c.last_error,
      'last_tested_at', c.last_tested_at,
      'last_test_ok', c.last_test_ok,
      'updated_at', c.updated_at
    ) order by case c.role when 'primary' then 1 when 'secondary' then 2 else 3 end), '[]'::jsonb)
    into v_rows
    from ops.model_config c;
  return jsonb_build_object('ok', true, 'routes', v_rows);
end;
$function$;

create or replace function public.ops_model_config_set(
  p_role text,
  p_provider text,
  p_model text,
  p_base_url text,
  p_api_key text,
  p_enabled boolean,
  p_secret text,
  p_actor_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_before ops.model_config;
  v_row ops.model_config;
  v_key text := nullif(btrim(coalesce(p_api_key, '')), '');
begin
  if p_role not in ('primary', 'secondary', 'vision') then
    return jsonb_build_object('ok', false, 'code', 'MODEL_ROLE_INVALID');
  end if;
  if nullif(btrim(coalesce(p_provider, '')), '') is null or nullif(btrim(coalesce(p_model, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'MODEL_REQUIRED',
      'message', 'A provider and model name are required.');
  end if;
  if v_key = '__clear__' then v_key := null; end if;
  if v_key is not null and nullif(btrim(coalesce(p_secret, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'MODEL_KEY_SECRET_MISSING',
      'message', 'Key encryption is not configured on the server, so the key was not saved.');
  end if;

  select * into v_before from ops.model_config where role = p_role;
  insert into ops.model_config (role, provider, model, base_url)
  values (p_role, btrim(p_provider), btrim(p_model), nullif(btrim(coalesce(p_base_url, '')), ''))
  on conflict (role) do nothing;

  update ops.model_config set
    provider = btrim(p_provider),
    model = btrim(p_model),
    base_url = nullif(btrim(coalesce(p_base_url, '')), ''),
    api_key_enc = case
      when p_api_key is null then api_key_enc
      when v_key is null then null
      else extensions.pgp_sym_encrypt(v_key, p_secret, 'cipher-algo=aes256')
    end,
    key_last4 = case
      when p_api_key is null then key_last4
      when v_key is null then null
      else right(v_key, 4)
    end,
    enabled = coalesce(p_enabled, enabled),
    last_error = null,
    updated_by = coalesce(p_actor_id, updated_by),
    updated_at = now()
  where role = p_role
  returning * into v_row;

  insert into ops.audit (actor_id, actor_email, action, entity, entity_id, detail)
  values (p_actor_id, p_actor_email, 'model_config_set', 'model_config', null,
    jsonb_build_object(
      'role', p_role,
      'before', case when v_before.role is null then null else jsonb_build_object(
        'provider', v_before.provider, 'model', v_before.model,
        'base_url', v_before.base_url, 'enabled', v_before.enabled) end,
      'after', jsonb_build_object(
        'provider', v_row.provider, 'model', v_row.model,
        'base_url', v_row.base_url, 'enabled', v_row.enabled),
      'key_changed', p_api_key is not null,
      'key_last4', v_row.key_last4));

  return jsonb_build_object('ok', true, 'route', jsonb_build_object(
    'role', v_row.role, 'provider', v_row.provider, 'model', v_row.model,
    'base_url', v_row.base_url, 'has_key', v_row.api_key_enc is not null,
    'key_last4', v_row.key_last4, 'enabled', v_row.enabled));
end;
$function$;

-- Server only: decrypt a route key. Never exposed to the browser.
create or replace function public.ops_model_config_secret(
  p_role text,
  p_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.model_config;
  v_key text;
begin
  select * into v_row from ops.model_config where role = p_role;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MODEL_NOT_FOUND');
  end if;
  if v_row.api_key_enc is null then
    return jsonb_build_object('ok', true, 'route', jsonb_build_object(
      'role', v_row.role, 'provider', v_row.provider, 'model', v_row.model,
      'base_url', v_row.base_url, 'enabled', v_row.enabled, 'api_key', null));
  end if;
  if nullif(btrim(coalesce(p_secret, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'MODEL_KEY_SECRET_MISSING');
  end if;
  begin
    v_key := extensions.pgp_sym_decrypt(v_row.api_key_enc, p_secret);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'MODEL_KEY_UNREADABLE',
      'message', 'The stored key could not be decrypted with the current server secret.');
  end;
  return jsonb_build_object('ok', true, 'route', jsonb_build_object(
    'role', v_row.role, 'provider', v_row.provider, 'model', v_row.model,
    'base_url', v_row.base_url, 'enabled', v_row.enabled, 'api_key', v_key));
end;
$function$;

create or replace function public.ops_model_test_record(
  p_role text,
  p_ok boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
begin
  update ops.model_config set
    last_tested_at = now(),
    last_test_ok = coalesce(p_ok, false),
    last_error = nullif(left(coalesce(p_error, ''), 300), ''),
    fail_count = case when coalesce(p_ok, false) then 0 else fail_count + 1 end
  where role = p_role;
  return jsonb_build_object('ok', true);
end;
$function$;

-- The switch is one action. The previous route is kept in the audit row so a
-- revert is a second, equally visible action.
create or replace function public.ops_model_switch(
  p_role text,
  p_actor_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_row ops.model_config;
  v_prev jsonb;
begin
  select * into v_row from ops.model_config where role = p_role;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MODEL_NOT_FOUND');
  end if;
  if not v_row.enabled then
    return jsonb_build_object('ok', false, 'code', 'MODEL_DISABLED',
      'message', 'Enable the route before making it primary.');
  end if;

  select jsonb_build_object('provider', provider, 'model', model, 'base_url', base_url)
    into v_prev
    from ops.model_config where role = 'primary';

  update ops.model_config p set
    provider = v_row.provider,
    model = v_row.model,
    base_url = v_row.base_url,
    api_key_enc = v_row.api_key_enc,
    key_last4 = v_row.key_last4,
    updated_at = now()
  where p.role = 'primary';

  insert into ops.audit (actor_id, actor_email, action, entity, entity_id, detail)
  values (p_actor_id, p_actor_email, 'model_switch', 'model_config', null,
    jsonb_build_object('role', p_role, 'previous', v_prev,
      'next', jsonb_build_object('provider', v_row.provider, 'model', v_row.model)));

  return jsonb_build_object('ok', true, 'route', jsonb_build_object(
    'role', 'primary', 'provider', v_row.provider, 'model', v_row.model));
end;
$function$;

-- A developer-console view is an audited event too, so the trail shows who
-- opened the key screen. No key, model or provider value is copied here.
create or replace function public.ops_audit_append(
  p_actor_id uuid,
  p_actor_email text,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
begin
  if nullif(btrim(coalesce(p_action, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'AUDIT_ACTION_REQUIRED');
  end if;
  insert into ops.audit (actor_id, actor_email, action, entity, entity_id, detail)
  values (p_actor_id, p_actor_email, btrim(p_action),
          nullif(btrim(coalesce(p_entity, '')), ''), p_entity_id,
          coalesce(p_detail, '{}'::jsonb));
  return jsonb_build_object('ok', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 13. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.ops_usage_log(uuid, uuid, uuid, text, text, text, integer, integer, integer, integer, integer, boolean, text) from public;
revoke all on function public.ops_assistant_gate(uuid) from public;
revoke all on function public.ops_school_month_summary(uuid, date) from public;
revoke all on function public.ops_subscription_set(uuid, text, text, integer, timestamptz, bigint, integer, text, uuid, text) from public;
revoke all on function public.ops_chat_trim(uuid, uuid, uuid, integer) from public;
revoke all on function public.ops_chat_compact_due(uuid) from public;
revoke all on function public.ops_chat_session_restore_cold(uuid, uuid, uuid) from public;
revoke all on function public.ops_model_config_list() from public;
revoke all on function public.ops_model_config_set(text, text, text, text, text, boolean, text, uuid, text) from public;
revoke all on function public.ops_model_config_secret(text, text) from public;
revoke all on function public.ops_model_test_record(text, boolean, text) from public;
revoke all on function public.ops_model_switch(text, uuid, text) from public;
revoke all on function public.ops_audit_append(uuid, text, text, text, uuid, jsonb) from public;

grant execute on function public.ops_usage_log(uuid, uuid, uuid, text, text, text, integer, integer, integer, integer, integer, boolean, text) to service_role;
grant execute on function public.ops_assistant_gate(uuid) to service_role;
grant execute on function public.ops_school_month_summary(uuid, date) to service_role;
grant execute on function public.ops_subscription_set(uuid, text, text, integer, timestamptz, bigint, integer, text, uuid, text) to service_role;
grant execute on function public.ops_chat_trim(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.ops_chat_compact_due(uuid) to service_role;
grant execute on function public.ops_chat_session_restore_cold(uuid, uuid, uuid) to service_role;
grant execute on function public.ops_model_config_list() to service_role;
grant execute on function public.ops_model_config_set(text, text, text, text, text, boolean, text, uuid, text) to service_role;
grant execute on function public.ops_model_config_secret(text, text) to service_role;
grant execute on function public.ops_model_test_record(text, boolean, text) to service_role;
grant execute on function public.ops_model_switch(text, uuid, text) to service_role;
grant execute on function public.ops_audit_append(uuid, text, text, text, uuid, jsonb) to service_role;
