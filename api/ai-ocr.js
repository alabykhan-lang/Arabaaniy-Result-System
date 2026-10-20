'use strict';



const { bearerTokenFromRequest, readJsonBody, requestOriginAllowed, sendJson, supabaseRpc, supabaseRest } = require('./_lib');

const MODEL = process.env.GEMINI_MODEL || process.env.FIRST_CHOICE_GEMINI_MODEL || 'gemini-2.5-flash';

async function resolveApiKey(token) {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.FIRST_CHOICE_GEMINI_API_KEY) return process.env.FIRST_CHOICE_GEMINI_API_KEY;
  const rows = await supabaseRest('app_config?select=config&limit=1', {}, token).catch(() => []);
  const cfg = rows?.[0]?.config;
  const parsed = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
  return parsed?.gemini_key || parsed?.geminiKey || '';
}

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

module.exports = async function aiOcr(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  let reservedLedger = null;
  try {
    const apiKey = await resolveApiKey(token);
    if (!apiKey) fail('AI_PROVIDER_NOT_CONFIGURED', 'AI scanning is not configured on the server. Please set GEMINI_API_KEY on Vercel or in Settings.', 503);
    const body = await readJsonBody(req);
    const operation = body.operation === 'ocr_student_names' ? 'ocr_student_names' : 'ocr_scores';
    if (!body.image_base64 || !body.mime_type || !body.prompt) fail('AI_REQUEST_INVALID', 'Image and prompt are required.');
    if (String(body.image_base64).length > 8_000_000) fail('AI_IMAGE_TOO_LARGE', 'Image is too large.');
    const idempotency = String(body.idempotency_key || '').trim();
    if (!idempotency || idempotency.length > 120) fail('AI_IDEMPOTENCY_REQUIRED', 'A request id is required.');
    const reserve = await supabaseRpc('ai_reserve_credits', { p_operation: operation, p_model: MODEL, p_idempotency_key: idempotency, p_estimated_credits: 1 }, token);
    if (!reserve?.ok) return sendJson(res, reserve?.code === 'AI_CREDITS_EXHAUSTED' ? 402 : 400, reserve);
    if (reserve.replayed) return sendJson(res, 200, { ok: true, replayed: true, ledger_id: reserve.ledger_id });
    reservedLedger = reserve.ledger_id;
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: body.prompt }, { inline_data: { mime_type: body.mime_type, data: body.image_base64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    const usage = data.usageMetadata || {};
    const inputTokens = Number(usage.promptTokenCount || 0);
    const outputTokens = Number(usage.candidatesTokenCount || 0);
    const total = inputTokens + outputTokens;
    if (!upstream.ok || data.error) {
      await supabaseRpc('ai_settle_credits', { p_ledger_id: reserve.ledger_id, p_status: 'failed', p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_billable_tokens: total, p_credits_charged: 0, p_error_code: 'GEMINI_REQUEST_FAILED' }, token);
      return sendJson(res, 502, { ok: false, code: 'AI_PROVIDER_REQUEST_FAILED', message: data.error?.message || 'AI provider request failed.' });
    }
    const credits = 1;
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    return sendJson(res, 200, { ok: true, text, ledger_id: reserve.ledger_id, usage: { input_tokens: inputTokens, output_tokens: outputTokens, billable_tokens: total, credits_pending: credits } });
  } catch (error) {
    if (reservedLedger) {
      await supabaseRpc('ai_settle_credits', { p_ledger_id: reservedLedger, p_status: 'failed', p_input_tokens: 0, p_output_tokens: 0, p_billable_tokens: 0, p_credits_charged: 0, p_error_code: 'AI_REQUEST_FAILED' }, token).catch(() => {});
    }
    return sendJson(res, error.status || 500, { ok: false, code: error.code || 'AI_REQUEST_FAILED', message: error.message || 'AI request failed.' });
  }
};
