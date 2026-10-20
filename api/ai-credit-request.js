'use strict';
const { bearerTokenFromRequest, readJsonBody, requestOriginAllowed, sendJson, supabaseRpc } = require('./_lib');

const PACKS = new Map([
  [5000, 50],
  [10000, 120],
  [15000, 200],
  [20000, 300],
  [5000, 1000],
  [10000, 2000],
  [15000, 3000],
  [20000, 4000]
]);

module.exports = async function aiCreditRequest(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  try {
    const body = await readJsonBody(req);
    const amount = Number(body?.amount_naira);
    const credits = Number(body?.credits);
    if (!Number.isInteger(amount) || !Number.isInteger(credits) || credits <= 0) {
      return sendJson(res, 400, { ok: false, code: 'AI_PACK_INVALID' });
    }
    const result = await supabaseRpc('ai_request_credit_pack', { p_amount_naira: amount, p_credits: credits }, token);
    return sendJson(res, result?.ok === false ? 400 : 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, { ok: false, code: error.payload?.code || 'AI_PACK_REQUEST_FAILED', message: error.message });
  }
};
