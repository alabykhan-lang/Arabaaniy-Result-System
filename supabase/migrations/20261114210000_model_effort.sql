-- Optional reasoning effort per model route.
--
-- Providers expose different names for this. The portal keeps one neutral
-- value and maps it: OpenAI-compatible gateways take reasoning_effort
-- (low, high, xhigh, max) and Gemini takes thinkingLevel (low, high).

alter table ops.model_config
  add column if not exists effort text;

alter table ops.model_config
  drop constraint if exists model_config_effort_check;
alter table ops.model_config
  add constraint model_config_effort_check
  check (effort is null or effort in ('low', 'high', 'xhigh', 'max'));

-- The extra argument makes a new signature, so the old one has to go or a
-- nine-argument call would match both.
drop function if exists public.ops_model_config_set(text, text, text, text, text, boolean, text, uuid, text);

create or replace function public.ops_model_config_set(
  p_role text,
  p_provider text,
  p_model text,
  p_base_url text,
  p_api_key text,
  p_enabled boolean,
  p_secret text,
  p_actor_id uuid,
  p_actor_email text,
  p_effort text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'public', 'pg_temp'
as $function$
declare
  v_before ops.model_config;
  v_row ops.model_config;
  v_key text := nullif(btrim(coalesce(p_api_key, '')), '');
  v_effort text := nullif(btrim(coalesce(p_effort, '')), '');
begin
  if p_role not in ('primary', 'secondary', 'vision') then
    return jsonb_build_object('ok', false, 'code', 'MODEL_ROLE_INVALID');
  end if;
  if nullif(btrim(coalesce(p_provider, '')), '') is null or nullif(btrim(coalesce(p_model, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'MODEL_REQUIRED',
      'message', 'A provider and model name are required.');
  end if;
  if v_effort is not null and v_effort not in ('low', 'high', 'xhigh', 'max') then
    return jsonb_build_object('ok', false, 'code', 'MODEL_EFFORT_INVALID',
      'message', 'Effort must be low, high, xhigh or max.');
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
    effort = v_effort,
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
        'base_url', v_before.base_url, 'enabled', v_before.enabled,
        'effort', v_before.effort) end,
      'after', jsonb_build_object(
        'provider', v_row.provider, 'model', v_row.model,
        'base_url', v_row.base_url, 'enabled', v_row.enabled,
        'effort', v_row.effort),
      'key_changed', p_api_key is not null,
      'key_last4', v_row.key_last4));

  return jsonb_build_object('ok', true, 'route', jsonb_build_object(
    'role', v_row.role, 'provider', v_row.provider, 'model', v_row.model,
    'base_url', v_row.base_url, 'has_key', v_row.api_key_enc is not null,
    'key_last4', v_row.key_last4, 'enabled', v_row.enabled,
    'effort', v_row.effort));
end;
$function$;

create or replace function public.ops_model_config_list()
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'public', 'pg_temp'
as $function$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'role', c.role,
      'provider', c.provider,
      'model', c.model,
      'base_url', c.base_url,
      'effort', c.effort,
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

create or replace function public.ops_model_config_secret(p_role text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'public', 'pg_temp'
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
      'base_url', v_row.base_url, 'enabled', v_row.enabled, 'effort', v_row.effort,
      'api_key', null));
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
    'base_url', v_row.base_url, 'enabled', v_row.enabled, 'effort', v_row.effort,
    'api_key', v_key));
end;
$function$;

create or replace function public.ops_model_switch(p_role text, p_actor_id uuid, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'public', 'pg_temp'
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

  select jsonb_build_object('provider', provider, 'model', model, 'base_url', base_url, 'effort', effort)
    into v_prev
    from ops.model_config where role = 'primary';

  update ops.model_config p set
    provider = v_row.provider,
    model = v_row.model,
    base_url = v_row.base_url,
    effort = v_row.effort,
    api_key_enc = v_row.api_key_enc,
    key_last4 = v_row.key_last4,
    updated_at = now()
  where p.role = 'primary';

  insert into ops.audit (actor_id, actor_email, action, entity, entity_id, detail)
  values (p_actor_id, p_actor_email, 'model_switch', 'model_config', null,
    jsonb_build_object('role', p_role, 'previous', v_prev,
      'next', jsonb_build_object('provider', v_row.provider, 'model', v_row.model, 'effort', v_row.effort)));

  return jsonb_build_object('ok', true, 'route', jsonb_build_object(
    'role', 'primary', 'provider', v_row.provider, 'model', v_row.model, 'effort', v_row.effort));
end;
$function$;
