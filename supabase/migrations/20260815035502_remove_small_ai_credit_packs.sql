-- Keep the credit request catalogue aligned with the portal: the smallest
-- available request is now ₦5,000 for 1,000 credits.
alter table public.ai_credit_pack_requests
  drop constraint if exists ai_credit_pack_requests_amount_naira_check,
  drop constraint if exists ai_credit_pack_requests_credits_requested_check;

alter table public.ai_credit_pack_requests
  add constraint ai_credit_pack_requests_amount_naira_check
    check (amount_naira in (5000, 10000, 15000, 20000) or status = 'rejected'),
  add constraint ai_credit_pack_requests_credits_requested_check
    check (credits_requested in (1000, 2000, 3000, 4000) or status = 'rejected');

create or replace function public.ai_request_credit_pack(
  p_amount_naira integer, p_credits integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := (select auth.uid()); v_school uuid; v_id uuid;
begin
  if v_user is null then return jsonb_build_object('ok', false, 'code', 'RESULT_SESSION_REQUIRED'); end if;
  if not ((p_amount_naira=5000 and p_credits=1000) or (p_amount_naira=10000 and p_credits=2000) or (p_amount_naira=15000 and p_credits=3000) or (p_amount_naira=20000 and p_credits=4000)) then
    return jsonb_build_object('ok', false, 'code', 'AI_PACK_INVALID');
  end if;
  select school_id into v_school from staff_profiles where id=v_user and suspended=false;
  if v_school is null then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  if exists (select 1 from ai_credit_pack_requests where school_id=v_school and status='pending') then
    return jsonb_build_object('ok', false, 'code', 'AI_PACK_REQUEST_PENDING');
  end if;
  insert into ai_credit_pack_requests(school_id,user_id,amount_naira,credits_requested) values(v_school,v_user,p_amount_naira,p_credits) returning id into v_id;
  return jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'pending');
end $$;
revoke all on function public.ai_request_credit_pack(integer,integer) from public;
grant execute on function public.ai_request_credit_pack(integer,integer) to authenticated;

-- Only the School Administrator may reset the shared wallet.
create or replace function public.ai_reset_wallet(p_free_credits integer, p_paid_credits integer, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_school uuid; v_wallet ai_wallets%rowtype;
begin
  if p_free_credits < 0 or p_paid_credits < 0 or p_free_credits > 1000000 or p_paid_credits > 1000000 then return jsonb_build_object('ok', false, 'code', 'AI_WALLET_AMOUNT_INVALID'); end if;
  if p_actor_user_id is null or p_actor_user_id <> (select auth.uid()) then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  select school_id into v_school from staff_profiles where id = (select auth.uid()) and suspended = false and role = 'admin';
  if v_school is null then return jsonb_build_object('ok', false, 'code', 'RESULT_PERMISSION_DENIED'); end if;
  update ai_wallets set free_credits=p_free_credits, free_credits_used=0, paid_credits=p_paid_credits, paid_credits_used=0, updated_at=now() where school_id=v_school returning * into v_wallet;
  if not found then return jsonb_build_object('ok', false, 'code', 'AI_WALLET_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'school_id', v_school, 'free_credits', v_wallet.free_credits, 'paid_credits', v_wallet.paid_credits, 'remaining_credits', v_wallet.free_credits + v_wallet.paid_credits);
end; $$;
revoke all on function public.ai_reset_wallet(integer, integer, uuid) from public;
grant execute on function public.ai_reset_wallet(integer, integer, uuid) to authenticated;
