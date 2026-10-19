'use strict';

const {
  authStatus,
  readJsonBody,
  requestOriginAllowed,
  sendJson,
  bearerTokenFromRequest,
  supabaseRpc,
} = require('./_lib');

const COMPONENTS = new Set(['ca1', 'ca2', 'ca3', 'exam']);
const SOURCES = new Set(['chatgpt_work', 'approved_management_tool']);

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isScoreValue(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

module.exports = async function resultCorrection(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!requestOriginAllowed(req)) {
    sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }

  const accessToken = bearerTokenFromRequest(req);
  if (!accessToken) {
    sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
    return;
  }

  const body = await readJsonBody(req);
  const reason = typeof body?.correction_reason === 'string'
    ? body.correction_reason.trim()
    : '';
  const source = typeof body?.source_application === 'string'
    ? body.source_application.trim().toLowerCase()
    : '';
  const component = typeof body?.component === 'string'
    ? body.component.trim().toLowerCase()
    : '';
  const subjectIndex = body?.subject_index;

  if (!body
      || typeof body.student_id !== 'string'
      || typeof body.class_key !== 'string'
      || typeof body.academic_session !== 'string'
      || typeof body.term !== 'string'
      || !Number.isInteger(subjectIndex)
      || subjectIndex < 0
      || !COMPONENTS.has(component)
      || !isScoreValue(body.old_value)
      || !isScoreValue(body.new_value)
      || !reason
      || reason.length > 1000
      || !isPlainObject(body.audit_metadata)
      || !SOURCES.has(source)
      || !hasOwn(body, 'old_value')
      || !hasOwn(body, 'new_value')) {
    sendJson(res, 400, { ok: false, code: 'RESULT_CORRECTION_PAYLOAD_INVALID' });
    return;
  }

  const payload = await supabaseRpc('school_result_external_score_correction', {
    p_session_id: null,
    p_session_secret: null,
    p_student_id: body.student_id.trim(),
    p_class_key: body.class_key.trim(),
    p_subject_index: subjectIndex,
    p_academic_session: body.academic_session.trim(),
    p_term: body.term.trim(),
    p_component: component,
    p_old_value: body.old_value,
    p_new_value: body.new_value,
    p_correction_reason: reason,
    p_audit_metadata: body.audit_metadata,
    p_source_application: source,
  }, accessToken);

  if (!payload?.ok) {
    sendJson(res, authStatus(payload?.code), payload || {
      ok: false,
      code: 'RESULT_SCORE_CORRECTION_FAILED',
    });
    return;
  }

  // This endpoint returns only the committed canonical Result row. It never
  // creates or edits a report document, so a document-only correction cannot
  // be reported as a successful Result update.
  sendJson(res, 200, payload);
};
