create or replace function public.ai_reset_wallet(p_free_credits integer, p_paid_credits integer, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid; v_wallet ai_wallets%rowtype;
begin
  if p_free_credits < 0 or p_paid_credits < 0 or p_free_credits > 1000000 or p_paid_credits > 1000000 then return jsonb_build_object('ok', false, 'code', 'AI_WALLET_AMOUNT_INVALID'); end if;
  if p_actor_user_id is null or p_actor_user_id <> (select auth.uid()) then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  select school_id into v_school from staff_profiles where id = (select auth.uid()) and suspended = false and role in ('admin', 'developer');
  if v_school is null then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  update ai_wallets set free_credits=p_free_credits, free_credits_used=0, paid_credits=p_paid_credits, paid_credits_used=0, updated_at=now() where school_id=v_school returning * into v_wallet;
  if not found then return jsonb_build_object('ok', false, 'code', 'AI_WALLET_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'school_id', v_school, 'free_credits', v_wallet.free_credits, 'paid_credits', v_wallet.paid_credits, 'remaining_credits', v_wallet.free_credits + v_wallet.paid_credits);
end; $$;
revoke all on function public.ai_reset_wallet(integer, integer, uuid) from public;
grant execute on function public.ai_reset_wallet(integer, integer, uuid) to authenticated;
