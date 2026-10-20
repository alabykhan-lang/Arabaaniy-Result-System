'use strict';
const { bearerTokenFromRequest, readJsonBody, requestOriginAllowed, sendJson, supabaseRpc, supabaseRest } = require('./_lib');

module.exports = async function aiSettle(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  try {
    const body = await readJsonBody(req);
    if (!body?.ledger_id || !['succeeded', 'failed'].includes(body.status)) return sendJson(res, 400, { ok: false, code: 'AI_SETTLEMENT_INVALID' });
    const result = await supabaseRpc('ai_settle_credits', {
      p_ledger_id: body.ledger_id,
      p_status: body.status,
      p_input_tokens: 0,
      p_output_tokens: 0,
      p_billable_tokens: 0,
      p_credits_charged: body.status === 'succeeded' ? 2 : 0,
      p_error_code: body.status === 'failed' ? 'AI_RESULT_NOT_APPLIED' : null,
    }, token);
    return sendJson(res, result?.ok === false ? 400 : 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, { ok: false, code: 'AI_SETTLEMENT_FAILED', message: error.message });
  }
};
