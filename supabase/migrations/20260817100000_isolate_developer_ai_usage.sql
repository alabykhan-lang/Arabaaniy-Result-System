-- Developer AI work is provider/testing activity, not school activity.
-- Keep it out of the school wallet and school usage ledger even if a caller
-- reaches these RPCs directly instead of using the portal API guard.

create or replace function public.ai_reserve_credits(
  p_operation text, p_model text, p_idempotency_key text, p_estimated_credits integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := (select auth.uid());
  v_school uuid;
  v_is_developer boolean := false;
  v_free integer;
  v_paid integer;
  v_total integer;
  v_id uuid;
begin
  if v_user is null then return jsonb_build_object('ok', false, 'code', 'RESULT_SESSION_REQUIRED'); end if;
  select school_id, (role = 'developer' or is_developer = true)
    into v_school, v_is_developer
    from staff_profiles
   where id = v_user and suspended = false;
  if v_school is null then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  if coalesce(v_is_developer, false) then
    return jsonb_build_object('ok', true, 'developer_excluded', true, 'credits_charged', 0);
  end if;
  select id into v_id from ai_usage_ledger where school_id = v_school and idempotency_key = p_idempotency_key;
  if v_id is not null then return jsonb_build_object('ok', true, 'ledger_id', v_id, 'replayed', true); end if;
  if p_estimated_credits < 1 or p_estimated_credits > 100 then return jsonb_build_object('ok', false, 'code', 'AI_REQUEST_LIMIT'); end if;
  select (free_credits-free_credits_used), (paid_credits-paid_credits_used)
    into v_free, v_paid from ai_wallets where school_id = v_school for update;
  v_total := coalesce(v_free, 0) + coalesce(v_paid, 0);
  if v_total < p_estimated_credits then return jsonb_build_object('ok', false, 'code', 'AI_CREDITS_EXHAUSTED', 'remaining_credits', v_total); end if;
  insert into ai_usage_ledger(school_id,user_id,operation,model,status,credits_reserved,reserved_free,reserved_paid,idempotency_key)
    values(v_school,v_user,p_operation,p_model,'reserved',p_estimated_credits,least(v_free,p_estimated_credits),greatest(0,p_estimated_credits-v_free))
    returning id into v_id;
  update ai_wallets
     set free_credits_used = free_credits_used + least(v_free, p_estimated_credits),
         paid_credits_used = paid_credits_used + greatest(0, p_estimated_credits-v_free),
         updated_at = now()
   where school_id = v_school;
  return jsonb_build_object('ok', true, 'ledger_id', v_id, 'remaining_credits', v_total-p_estimated_credits);
end; $$;

revoke all on function public.ai_reserve_credits(text,text,text,integer) from public;
grant execute on function public.ai_reserve_credits(text,text,text,integer) to authenticated;

create or replace function public.ai_settle_credits(
  p_ledger_id uuid, p_status text, p_input_tokens integer, p_output_tokens integer,
  p_billable_tokens integer, p_credits_charged integer, p_error_code text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := (select auth.uid());
  v_school uuid;
  v_is_developer boolean := false;
  v_row ai_usage_ledger%rowtype;
  v_free integer;
  v_paid integer;
  v_charge integer;
  v_free_charge integer;
begin
  select school_id, (role = 'developer' or is_developer = true)
    into v_school, v_is_developer
    from staff_profiles
   where id = v_user and suspended = false;
  if coalesce(v_is_developer, false) then
    return jsonb_build_object('ok', true, 'developer_excluded', true, 'credits_charged', 0);
  end if;
  select * into v_row from ai_usage_ledger
   where id = p_ledger_id and school_id = v_school and user_id = v_user for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'AI_LEDGER_NOT_FOUND'); end if;
  if v_row.status <> 'reserved' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  v_charge := greatest(0, least(v_row.credits_reserved, coalesce(p_credits_charged, 0)));
  select free_credits-free_credits_used, paid_credits-paid_credits_used
    into v_free, v_paid from ai_wallets where school_id = v_school for update;
  update ai_wallets
     set free_credits_used = greatest(0, free_credits_used-v_row.reserved_free),
         paid_credits_used = greatest(0, paid_credits_used-v_row.reserved_paid),
         updated_at = now()
   where school_id = v_school;
  if p_status = 'succeeded' then
    v_free_charge := least(v_free + v_row.reserved_free, v_charge);
    update ai_wallets
       set free_credits_used = free_credits_used + v_free_charge,
           paid_credits_used = paid_credits_used + (v_charge-v_free_charge),
           updated_at = now()
     where school_id = v_school;
  end if;
  update ai_usage_ledger
     set status = case when p_status = 'succeeded' then 'succeeded' else 'failed' end,
         input_tokens = greatest(0, p_input_tokens), output_tokens = greatest(0, p_output_tokens),
         billable_tokens = greatest(0, p_billable_tokens),
         credits_charged = case when p_status = 'succeeded' then v_charge else 0 end,
         error_code = p_error_code, completed_at = now()
   where id = p_ledger_id;
  return jsonb_build_object('ok', true, 'credits_charged', case when p_status = 'succeeded' then v_charge else 0 end);
end; $$;

revoke all on function public.ai_settle_credits(uuid,text,integer,integer,integer,integer,text) from public;
grant execute on function public.ai_settle_credits(uuid,text,integer,integer,integer,integer,text) to authenticated;
