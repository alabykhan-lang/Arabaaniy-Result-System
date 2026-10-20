'use strict';

const { bearerTokenFromRequest, readJsonBody, requestOriginAllowed, sendJson, supabaseAuthRequest, supabaseRpc, supabaseRest } = require('./_lib');
const DEVELOPER_EMAIL = (process.env.DEVELOPER_EMAIL || 'alabykhan@gmail.com').trim().toLowerCase();

async function requireDeveloper(token) {
  const user = await supabaseAuthRequest('user', undefined, token);
  const email = String(user?.email || '').trim().toLowerCase();
  const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&select=role,suspended,is_developer&limit=1`, {}, token);
  const profile = rows?.[0] || { role: email === DEVELOPER_EMAIL ? 'developer' : 'staff', suspended: false, is_developer: email === DEVELOPER_EMAIL };
  if (profile.suspended || (profile.role !== 'developer' && !profile.is_developer && email !== DEVELOPER_EMAIL)) {
    const error = new Error('Developer access is required.');
    error.status = 403;
    error.payload = { code: 'RESULT_PERMISSION_DENIED' };
    throw error;
  }
  return user;
}

module.exports = async function aiCreditReset(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  try {
    const user = await requireDeveloper(token);
    const body = await readJsonBody(req);
    const free = Number(body?.free_credits);
    const paid = Number(body?.paid_credits);
    if (!Number.isInteger(free) || !Number.isInteger(paid) || free < 0 || paid < 0 || free > 1000000 || paid > 1000000) {
      return sendJson(res, 400, { ok: false, code: 'AI_WALLET_AMOUNT_INVALID' });
    }
    const result = await supabaseRpc('ai_reset_wallet', { p_free_credits: free, p_paid_credits: paid, p_actor_user_id: user.id }, token);
    return sendJson(res, result?.ok === false ? 400 : 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, { ok: false, code: error.payload?.code || 'AI_WALLET_RESET_FAILED', message: error.message });
  }
};
