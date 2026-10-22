'use strict';

const { bearerTokenFromRequest, readJsonBody, requestOriginAllowed, sendJson, supabaseRpc, supabaseRest } = require('./_lib');

// Verified against the live Gemini catalogue (ListModels + real calls, 22 Oct 2026):
//   gemini-3.5-flash      -> answers in <1s
//   gemini-3.8-flash      -> exists, but returns 503 "high demand" under load
//   gemini-3.1-flash-lite -> answers, ~5s
//   gemini-2.5-flash / gemini-2.0-flash / gemini-1.5-* -> retired ("no longer available to new users")
// Fastest first, with the env override still winning.
const CANDIDATE_MODELS = Array.from(new Set([
  process.env.GEMINI_MODEL,
  process.env.FIRST_CHOICE_GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
].filter(Boolean)));

const API_VERSIONS = ['v1beta', 'v1'];
const ATTEMPT_TIMEOUT_MS = 20000;  // one provider call can never hang a request
const TOTAL_BUDGET_MS = 45000;     // the whole request stays inside the function limit

async function resolveApiKey(bodyKey, token) {
  if (bodyKey && typeof bodyKey === 'string' && bodyKey.trim().length > 10) return bodyKey.trim();
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

async function aiOcr(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });

  let reservedLedger = null;
  try {
    const body = await readJsonBody(req);
    const apiKey = await resolveApiKey(body?.gemini_key, token);
    if (!apiKey) fail('AI_PROVIDER_NOT_CONFIGURED', 'Gemini API key is not configured. Please enter your Gemini API key in Settings.', 503);
    const operation = body.operation === 'ocr_student_names' ? 'ocr_student_names' : 'ocr_scores';
    if (!body.image_base64 || !body.mime_type || !body.prompt) fail('AI_REQUEST_INVALID', 'Image and prompt are required.');
    if (String(body.image_base64).length > 8_000_000) fail('AI_IMAGE_TOO_LARGE', 'Image is too large.');
    const idempotency = String(body.idempotency_key || '').trim();
    if (!idempotency || idempotency.length > 120) fail('AI_IDEMPOTENCY_REQUIRED', 'A request id is required.');

    const primaryModel = CANDIDATE_MODELS[0] || 'gemini-3.5-flash';
    const reserve = await supabaseRpc('ai_reserve_credits', { p_operation: operation, p_model: primaryModel, p_idempotency_key: idempotency, p_estimated_credits: 2 }, token);
    if (!reserve?.ok) return sendJson(res, reserve?.code === 'AI_CREDITS_EXHAUSTED' ? 402 : 400, reserve);
    if (reserve.replayed) return sendJson(res, 200, { ok: true, replayed: true, ledger_id: reserve.ledger_id });
    reservedLedger = reserve.ledger_id;

    const settleFailed = async (code) => {
      await supabaseRpc('ai_settle_credits', { p_ledger_id: reserve.ledger_id, p_status: 'failed', p_input_tokens: 0, p_output_tokens: 0, p_billable_tokens: 0, p_credits_charged: 0, p_error_code: code }, token).catch(() => {});
      reservedLedger = null;
    };

    let successfulData = null;
    let successfulModel = primaryModel;
    let successfulVersion = API_VERSIONS[0];
    let lastError = null;
    let keyRejected = false;
    const tried = [];
    const startedAt = Date.now();

    outer:
    for (const model of CANDIDATE_MODELS) {
      for (const version of API_VERSIONS) {
        if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
          lastError = { message: 'Time budget exceeded while waiting for the AI provider.' };
          break outer;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
        try {
          const upstream = await fetch(`https://generativelanguage.googleapis.com/${version}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: body.prompt }, { inline_data: { mime_type: body.mime_type, data: body.image_base64 } }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' }
            }),
            signal: controller.signal,
          });
          const data = await upstream.json().catch(() => ({}));
          clearTimeout(timer);
          if (upstream.ok && !data.error && data.candidates?.[0]?.content) {
            successfulData = data;
            successfulModel = model;
            successfulVersion = version;
            break outer;
          }
          lastError = data.error || { message: `Model ${model} (${version}) returned HTTP ${upstream.status}` };
          tried.push(`${model}@${version}: ${String(lastError?.message || '').slice(0, 120)}`);
          const msg = String(lastError?.message || '').toLowerCase();
          if (msg.includes('api key not valid') || msg.includes('api_key_invalid')) {
            keyRejected = true;
            break outer;
          }
        } catch (err) {
          clearTimeout(timer);
          const aborted = err && (err.name === 'AbortError');
          lastError = { message: aborted ? `Model ${model} (${version}) timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s` : String(err?.message || err) };
          tried.push(`${model}@${version}: ${String(lastError.message).slice(0, 120)}`);
        }
      }
    }

    if (!successfulData) {
      await settleFailed(keyRejected ? 'GEMINI_KEY_REJECTED' : 'GEMINI_REQUEST_FAILED');
      return sendJson(res, 502, {
        ok: false,
        code: keyRejected ? 'AI_PROVIDER_KEY_REJECTED' : 'AI_PROVIDER_REQUEST_FAILED',
        message: 'AI scanning failed' + (lastError?.message ? ` (${lastError.message})` : ''),
        details: lastError?.message || 'Upstream provider error',
        models_tried: tried.slice(0, 12)
      });
    }

    const usage = successfulData.usageMetadata || {};
    const inputTokens = Number(usage.promptTokenCount || 0);
    const outputTokens = Number(usage.candidatesTokenCount || 0);
    const total = inputTokens + outputTokens;
    const credits = 2;
    const text = successfulData.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';

    return sendJson(res, 200, {
      ok: true,
      text,
      model: successfulModel,
      api_version: successfulVersion,
      ledger_id: reserve.ledger_id,
      elapsed_ms: Date.now() - startedAt,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, billable_tokens: total, credits_pending: credits }
    });
  } catch (error) {
    if (reservedLedger) {
      await supabaseRpc('ai_settle_credits', { p_ledger_id: reservedLedger, p_status: 'failed', p_input_tokens: 0, p_output_tokens: 0, p_billable_tokens: 0, p_credits_charged: 0, p_error_code: 'AI_REQUEST_FAILED' }, token).catch(() => {});
    }
    return sendJson(res, error.status || 500, { ok: false, code: error.code || 'AI_REQUEST_FAILED', message: error.message || 'AI request failed.' });
  }
}

module.exports = aiOcr;
// Hobby allows up to 60s. Without this the platform kills the request at 10s and
// the reserved credits are never released.
module.exports.config = { maxDuration: 60 };
