-- Assistant usage is measured in work units, and reaching the included units
-- pauses the assistant for admins and staff. The developer is never blocked.
-- The action that crosses the line finishes; the next one sees the lock.

alter table ops.school_subscriptions
  add column if not exists unit_price_naira integer not null default 25,
  add column if not exists included_units integer not null default 400,
  add column if not exists answer_units integer not null default 1,
  add column if not exists tool_answer_units integer not null default 2,
  add column if not exists vision_page_units integer not null default 12,
  add column if not exists record_batch_units integer not null default 3,
  add column if not exists report_card_units integer not null default 3,
  add column if not exists print_page_units integer not null default 12,
  add column if not exists usage_paused boolean not null default false,
  add column if not exists usage_paused_at timestamptz,
  add column if not exists usage_reset_at timestamptz,
  add column if not exists usage_reset_by uuid,
  add column if not exists usage_offset_units numeric not null default 0,
  add column if not exists usage_offset_set_at timestamptz,
  add column if not exists usage_offset_set_by uuid;

alter table ops.school_subscriptions alter column price_naira set default 10000;

-- One row per paid action. Old rows stay for audit.
create table if not exists ops.usage_units (
  id bigserial primary key,
  school_id uuid not null,
  actor_id uuid,
  kind text not null,
  units integer not null check (units > 0),
  developer_excluded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists usage_units_school_time_idx
  on ops.usage_units (school_id, created_at desc);

alter table ops.usage_units enable row level security;

-- The window starts at the month boundary, unless the developer reset it or
-- moved the reading more recently.
create or replace function ops.usage_window_start(p_school_id uuid)
returns timestamptz
language sql
security definer
set search_path = ops, public, pg_temp
as $function$
  select greatest(
    date_trunc('month', now()),
    coalesce((select s.usage_reset_at from ops.school_subscriptions s where s.school_id = p_school_id), 'epoch'::timestamptz),
    coalesce((select s.period_start from ops.school_subscriptions s where s.school_id = p_school_id), 'epoch'::timestamptz)
  );
$function$;

create or replace function ops.subscription_row(p_school_id uuid)
returns ops.school_subscriptions
language sql
security definer
set search_path = ops, public, pg_temp
as $function$
  select * from ops.school_subscriptions where school_id = p_school_id;
$function$;

create or replace function ops.usage_real_units(p_school_id uuid)
returns numeric
language sql
security definer
set search_path = ops, public, pg_temp
as $function$
  select coalesce(sum(u.units), 0)::numeric
    from ops.usage_units u
   where u.school_id = p_school_id
     and u.developer_excluded = false
     and u.created_at >= ops.usage_window_start(p_school_id);
$function$;

-- The school reading: percentage, pause flag and the per-admin split. It holds
-- no naira, units or cost of its own; the caller decides what to show.
create or replace function public.ops_school_usage(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  s ops.school_subscriptions;
  v_from timestamptz;
  v_used jsonb;
  v_tokens bigint;
  v_real numeric;
  v_reference numeric;
  v_used_units numeric;
  v_percent_used numeric;
  v_percent_left numeric;
  v_admins jsonb;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'USAGE_SCHOOL_REQUIRED');
  end if;

  select * into s from ops.subscription_row(p_school_id);
  v_reference := greatest(1, coalesce(s.included_units, 400));
  v_from := ops.usage_window_start(p_school_id);
  v_used := ops.usage_since(p_school_id, date_trunc('month', now()));
  v_tokens := coalesce((v_used->>'tokens_in')::bigint, 0) + coalesce((v_used->>'tokens_out')::bigint, 0);

  select coalesce(jsonb_agg(jsonb_build_object('user_id', t.actor_id, 'units', t.units) order by t.units desc), '[]'::jsonb)
    into v_admins
    from (
      select u.actor_id, sum(u.units)::numeric as units
        from ops.usage_units u
       where u.school_id = p_school_id
         and u.developer_excluded = false
         and u.created_at >= v_from
         and u.actor_id is not null
       group by u.actor_id
    ) t;

  if coalesce(s.usage_paused, false) then
    return jsonb_build_object(
      'ok', true,
      'started_at', v_from,
      'used_units', v_reference,
      'reference_units', v_reference,
      'percent_used', 100,
      'percent_left', 0,
      'paused', true,
      'paused_at', s.usage_paused_at,
      'used_tokens', v_tokens,
      'admins', v_admins
    );
  end if;

  v_real := ops.usage_real_units(p_school_id);
  v_used_units := greatest(0, v_real + coalesce(s.usage_offset_units, 0));
  v_percent_used := round((v_used_units / v_reference) * 100, 1);
  v_percent_left := greatest(0, round(100 - v_percent_used, 1));

  return jsonb_build_object(
    'ok', true,
    'started_at', v_from,
    'used_units', v_used_units,
    'reference_units', v_reference,
    'percent_used', v_percent_used,
    'percent_left', v_percent_left,
    'paused', false,
    'paused_at', null,
    'used_tokens', v_tokens,
    'admins', v_admins
  );
end;
$function$;

-- The gate. A paused school is closed to admins and staff, never the developer.
create or replace function public.ops_assistant_gate(p_school_id uuid, p_is_developer boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_sub jsonb;
  v_usage jsonb;
  v_reference numeric;
  v_used numeric;
  v_percent numeric;
  v_percent_left numeric;
  v_paused boolean;
  v_allowed boolean;
  v_band text;
  v_banner text;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'allowed', false, 'code', 'GATE_SCHOOL_REQUIRED');
  end if;

  v_sub := ops.subscription_state(p_school_id);
  v_usage := public.ops_school_usage(p_school_id);
  v_reference := coalesce((v_usage->>'reference_units')::numeric, 400);
  v_used := coalesce((v_usage->>'used_units')::numeric, 0);
  v_percent := coalesce((v_usage->>'percent_used')::numeric, 0);
  v_percent_left := greatest(0, round(100 - v_percent, 1));
  v_paused := coalesce((v_usage->>'paused')::boolean, false) or v_used >= v_reference;

  v_allowed := (v_sub->>'status' <> 'suspended') and (p_is_developer or not v_paused);

  v_band := case
    when v_sub->>'status' = 'suspended' then 'suspended'
    when v_paused then 'paused'
    when v_sub->>'status' = 'grace' then 'grace'
    else 'ok'
  end;

  v_banner := case
    when v_sub->>'status' = 'suspended' then
      'The assistant is paused while the subscription is restored.'
    when v_paused then
      'This month''s assistant usage is finished. The assistant is paused until the developer resets it.'
    when v_sub->>'status' = 'grace' then
      'The subscription is in its grace period. Restore payment to keep the assistant on.'
    else null
  end;

  return jsonb_build_object(
    'ok', true,
    'allowed', v_allowed,
    'paused', v_paused,
    'paused_at', v_usage->'paused_at',
    'status', v_sub->>'status',
    'tier', v_sub->>'tier',
    'band', v_band,
    'percent', v_percent,
    'percent_used', v_percent,
    'percent_left', v_percent_left,
    'fallback_only', v_percent_left <= 0,
    'banner', v_banner,
    'due_date', v_sub->'due_date',
    'grace_until', v_sub->'grace_until',
    'included_units', v_reference,
    'grace_days', coalesce((v_sub->>'grace_days')::int, 7),
    'price_naira', v_sub->'price_naira',
    'unit_price_naira', v_sub->'unit_price_naira',
    'tier_label', v_sub->>'tier',
    'note', v_sub->>'note',
    'is_placeholder', v_sub->'is_placeholder',
    'developer', p_is_developer
  );
end;
$function$;

-- Setting a percentage moves the reading. 0, or below, pauses at once.
create or replace function public.ops_usage_set_percent(
  p_school_id uuid,
  p_pct numeric,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_pct numeric;
  v_reference numeric;
  v_real numeric;
  v_target numeric;
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'USAGE_SCHOOL_REQUIRED');
  end if;
  v_pct := greatest(0, least(100, round(coalesce(p_pct, 100), 1)));

  insert into ops.school_subscriptions (school_id) values (p_school_id)
  on conflict (school_id) do nothing;

  select greatest(1, included_units) into v_reference
    from ops.school_subscriptions where school_id = p_school_id;

  if v_pct <= 0 then
    update ops.school_subscriptions
       set usage_paused = true,
           usage_paused_at = now(),
           usage_offset_units = greatest(0, v_reference),
           usage_offset_set_at = now(),
           usage_offset_set_by = p_actor_id,
           updated_at = now()
     where school_id = p_school_id;
  else
    v_real := ops.usage_real_units(p_school_id);
    v_target := v_reference * (100 - v_pct) / 100.0;
    update ops.school_subscriptions
       set usage_paused = false,
           usage_paused_at = null,
           usage_offset_units = v_target - v_real,
           usage_offset_set_at = now(),
           usage_offset_set_by = p_actor_id,
           updated_at = now()
     where school_id = p_school_id;
  end if;

  return public.ops_school_usage(p_school_id);
end;
$function$;

create or replace function public.ops_usage_reset(
  p_school_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'USAGE_SCHOOL_REQUIRED');
  end if;

  insert into ops.school_subscriptions (school_id) values (p_school_id)
  on conflict (school_id) do nothing;

  update ops.school_subscriptions
     set usage_reset_at = now(),
         usage_reset_by = p_actor_id,
         usage_offset_units = 0,
         usage_offset_set_at = null,
         usage_offset_set_by = null,
         usage_paused = false,
         usage_paused_at = null,
         updated_at = now()
   where school_id = p_school_id;

  return public.ops_school_usage(p_school_id);
end;
$function$;

-- Write the units of one finished action, then close the gate if the reference
-- has been reached. The turn that crosses the line still completes.
create or replace function public.ops_usage_charge(
  p_school_id uuid,
  p_actor_id uuid,
  p_kind text,
  p_units integer,
  p_developer_excluded boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
declare
  v_reference numeric;
  v_used numeric;
begin
  if p_school_id is null or coalesce(p_units, 0) <= 0 then
    return public.ops_school_usage(p_school_id);
  end if;

  insert into ops.usage_units (school_id, actor_id, kind, units, developer_excluded)
  values (p_school_id, p_actor_id, coalesce(nullif(p_kind, ''), 'answer'), p_units, coalesce(p_developer_excluded, false));

  if coalesce(p_developer_excluded, false) then
    return public.ops_school_usage(p_school_id);
  end if;

  select greatest(1, included_units) into v_reference
    from ops.school_subscriptions where school_id = p_school_id;
  v_used := ops.usage_real_units(p_school_id) + coalesce(
    (select usage_offset_units from ops.school_subscriptions where school_id = p_school_id), 0);

  if v_used >= v_reference then
    update ops.school_subscriptions
       set usage_paused = true,
           usage_paused_at = now(),
           updated_at = now()
     where school_id = p_school_id
       and usage_paused = false;
  end if;

  return public.ops_school_usage(p_school_id);
end;
$function$;

-- The developer-only subscription write moves the plain columns only.
create or replace function public.ops_subscription_usage_set(
  p_school_id uuid,
  p_included_units integer default null,
  p_price_naira integer default null,
  p_unit_price_naira integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops, public, pg_temp
as $function$
begin
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'code', 'USAGE_SCHOOL_REQUIRED');
  end if;
  insert into ops.school_subscriptions (school_id) values (p_school_id)
  on conflict (school_id) do nothing;
  update ops.school_subscriptions
     set included_units = coalesce(p_included_units, included_units),
         price_naira = coalesce(p_price_naira, price_naira),
         unit_price_naira = coalesce(p_unit_price_naira, unit_price_naira),
         updated_at = now()
   where school_id = p_school_id;
  return public.ops_school_usage(p_school_id);
end;
$function$;

-- The subscription state now also carries the unit price and allowance.
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
      'grace_until', null, 'note', 'No subscription row yet; the assistant stays on.',
      'included_units', 400, 'unit_price_naira', 25, 'usage_paused', false);
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
    'unit_price_naira', v_row.unit_price_naira,
    'included_units', v_row.included_units,
    'due_date', v_row.due_date,
    'grace_until', case when v_row.due_date is null then null
                        else v_row.due_date + make_interval(days => v_row.grace_days) end,
    'included_tokens', v_row.included_tokens,
    'grace_days', v_row.grace_days,
    'is_placeholder', v_row.is_placeholder,
    'note', v_row.note,
    'usage_paused', v_row.usage_paused,
    'updated_at', v_row.updated_at
  );
end;
$function$;

-- The one-argument gate is replaced by the two-argument form.
drop function if exists public.ops_assistant_gate(uuid);

revoke all on function ops.usage_window_start(uuid) from public, anon, authenticated;
revoke all on function ops.subscription_row(uuid) from public, anon, authenticated;
revoke all on function ops.usage_real_units(uuid) from public, anon, authenticated;
revoke all on function ops.subscription_state(uuid) from public, anon, authenticated;
revoke all on function public.ops_school_usage(uuid) from public, anon, authenticated;
revoke all on function public.ops_assistant_gate(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ops_usage_set_percent(uuid, numeric, uuid) from public, anon, authenticated;
revoke all on function public.ops_usage_reset(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ops_usage_charge(uuid, uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.ops_subscription_usage_set(uuid, integer, integer, integer) from public, anon, authenticated;

grant execute on function ops.usage_window_start(uuid) to service_role;
grant execute on function ops.subscription_row(uuid) to service_role;
grant execute on function ops.usage_real_units(uuid) to service_role;
grant execute on function public.ops_school_usage(uuid) to service_role;
grant execute on function public.ops_assistant_gate(uuid, boolean) to service_role;
grant execute on function public.ops_usage_set_percent(uuid, numeric, uuid) to service_role;
grant execute on function public.ops_usage_reset(uuid, uuid) to service_role;
grant execute on function public.ops_usage_charge(uuid, uuid, text, integer, boolean) to service_role;
grant execute on function public.ops_subscription_usage_set(uuid, integer, integer, integer) to service_role;
