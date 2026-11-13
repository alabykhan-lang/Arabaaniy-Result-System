-- Correct the developer-isolated reserve function while preserving the
-- zero-charge developer path and normal school billing behavior.
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
    values(v_school,v_user,p_operation,p_model,'reserved',p_estimated_credits,least(v_free,p_estimated_credits),greatest(0,p_estimated_credits-v_free),p_idempotency_key)
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
