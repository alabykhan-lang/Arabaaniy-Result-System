'use strict';

const {
  authStatus,
  bearerTokenFromRequest,
  readJsonBody,
  requestOriginAllowed,
  sendJson,
  supabaseAuthRequest,
  supabaseRest,
} = require('./_lib');
const crypto = require('node:crypto');

const READ_RESOURCES = new Set([
  'classes', 'subjects', 'students', 'scores', 'traits', 'remarks', 'fees', 'published_subjects',
]);
const NON_PERSISTENT_ACTIONS = new Set([
  'report_cards.generate',
  'results.export',
]);
const DEVELOPER_EMAIL = String(process.env.DEVELOPER_EMAIL || 'alabykhan@gmail.com').trim().toLowerCase();
const SCHOOL_ADMIN_EMAIL = String(process.env.SCHOOL_ADMIN_EMAIL || '').trim().toLowerCase();

function inviteHash(value) {
  return crypto.createHash('sha256').update(String(value || '').replace(/[\s,]+/g, '').toUpperCase()).digest('hex');
}

async function currentStaff(token) {
  const user = await supabaseAuthRequest('user', undefined, token);
  const email = String(user?.email || '').trim().toLowerCase();
  const isDev = Boolean(DEVELOPER_EMAIL && email === DEVELOPER_EMAIL);
  const isAdmin = Boolean(SCHOOL_ADMIN_EMAIL && email === SCHOOL_ADMIN_EMAIL);
  const fallback = { id: user?.id, email: user?.email || '', role: isDev ? 'developer' : isAdmin ? 'admin' : 'staff', suspended: false, is_developer: isDev };
  try {
    const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&limit=1`, {}, token);
    if (rows?.[0]) return { user, profile: rows[0] };
    // Existing developer/admin sessions may have been created before the
    // profile bootstrap was installed. Establish the protected profile before
    // running management queries so RLS can recognise the manager.
    if (['developer', 'admin'].includes(fallback.role)) {
      const created = await supabaseRest('staff_profiles', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: fallback,
      }, token);
      return { user, profile: created?.[0] || fallback };
    }
    return { user, profile: fallback };
  } catch (error) {
    return { user, profile: fallback };
  }
}

async function requireManagement(token) {
  const staff = await currentStaff(token);
  if (staff.profile.suspended || !['developer', 'admin'].includes(staff.profile.role)) {
    const error = new Error('Management access is required.');
    error.status = 403;
    error.payload = { code: 'RESULT_PERMISSION_DENIED', message: error.message };
    throw error;
  }
  return staff;
}

async function touchStaff(token) {
  try {
    const staff = await currentStaff(token);
    if (staff.user?.id) await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(staff.user.id)}`, { method: 'PATCH', body: { last_seen_at: new Date().toISOString() } }, token);
  } catch (error) {
    // Activity tracking must never prevent normal portal use.
  }
}

function errorPayload(error) {
  const payload = error?.payload || {};
  return {
    ok: false,
    code: payload.code || 'RESULT_DATA_UNAVAILABLE',
    message: payload.message || payload.msg || error?.message || 'Result data is unavailable.',
  };
}

function filterParams(payload = {}) {
  const allowed = ['class_key', 'student_id', 'subject_index', 'term', 'academic_session', 'archived'];
  return allowed.reduce((query, key) => {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      query.set(key, `eq.${payload[key]}`);
    }
    return query;
  }, new URLSearchParams());
}

async function readResource(resource, payload, token) {
  if (!READ_RESOURCES.has(resource)) {
    const error = new Error('Result action is not supported.');
    error.payload = { code: 'RESULT_ACTION_NOT_SUPPORTED', message: error.message };
    throw error;
  }
  const query = filterParams(payload);
  if (resource === 'students' && payload.archived === undefined) query.set('archived', 'eq.false');
  query.set('order', resource === 'students' ? 'created_at.asc' : 'created_at.asc');
  return supabaseRest(`${resource}?${query.toString()}`, {}, token);
}

async function readSettings(token) {
  const [configRows, contextRows] = await Promise.all([
    supabaseRest('app_config?id=eq.1&limit=1', {}, token),
    supabaseRest('academic_context?id=eq.1&limit=1', {}, token),
  ]);
  return {
    app_config: configRows?.[0]?.config || {},
    academic_context: contextRows?.[0] || {},
  };
}

async function upsert(table, body, token) {
  const conflictKeys = {
    scores: 'student_id,subject_index,term,academic_session',
    traits: 'student_id,trait_type,trait_name,term,academic_session',
    remarks: 'student_id,term,academic_session',
    fees: 'student_id,term,academic_session',
    published_subjects: 'class_key,subject_index,term,academic_session',
  };
  // Keep composite conflict targets comma-separated for PostgREST. Encoding
  // the commas can make the hosted Supabase REST endpoint ignore the target.
  const conflict = conflictKeys[table] ? `?on_conflict=${conflictKeys[table]}` : '';
  const rows = await supabaseRest(`${table}${conflict}`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body,
  }, token);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function unpublishResult(payload, token) {
  await supabaseRest(`published_subjects?class_key=eq.${encodeURIComponent(payload.class_key)}&term=eq.${encodeURIComponent(payload.term)}&subject_index=eq.${encodeURIComponent(payload.subject_index)}&academic_session=eq.${encodeURIComponent(payload.academic_session)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  }, token);
  return { ok: true, published: false };
}

function unsupportedAction() {
  const error = new Error('Result action is not supported.');
  error.payload = { code: 'RESULT_ACTION_NOT_SUPPORTED', message: error.message };
  throw error;
}

async function handleAction(action, payload, token) {
  if (NON_PERSISTENT_ACTIONS.has(action)) return { ok: true, read_only: true };
  if (action === 'management.staff.list') {
    await requireManagement(token);
    const rows = await supabaseRest('staff_profiles?is_developer=eq.false&order=last_seen_at.desc.nullslast,created_at.asc', {}, token);
    return { ok: true, staff: rows || [] };
  }
  if (action === 'management.staff.update') {
    const manager = await requireManagement(token);
    if (!payload.id) throw Object.assign(new Error('Staff member is required.'), { payload: { code: 'RESULT_STAFF_REQUIRED' } });
    if (String(payload.id) === String(manager.profile.id) && payload.suspended === true) throw Object.assign(new Error('You cannot suspend your own account.'), { payload: { code: 'RESULT_SELF_SUSPEND_DENIED' } });
    const target = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}&limit=1`, {}, token);
    if (target?.[0]?.is_developer) throw Object.assign(new Error('The developer account cannot be changed here.'), { payload: { code: 'RESULT_DEVELOPER_PROTECTED' } });
    const update = {};
    if (['staff', 'admin'].includes(payload.role)) update.role = payload.role;
    if (typeof payload.suspended === 'boolean') update.suspended = payload.suspended;
    const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}`, { method: 'PATCH', body: update }, token);
    return { ok: true, staff: rows?.[0] || null };
  }
  if (action === 'management.invite.read') {
    await requireManagement(token);
    const rows = await supabaseRest('portal_access_config?id=eq.1&select=id,invite_enabled,invite_hint,updated_at&limit=1', {}, token);
    return { ok: true, invite: rows?.[0] || { id: 1, invite_enabled: true, invite_hint: 'POR••••26' } };
  }
  if (action === 'management.invite.update') {
    await requireManagement(token);
    const code = String(payload.invite_code || '').replace(/[\s,]+/g, '').toUpperCase();
    if (code && code.length < 6) throw Object.assign(new Error('Invite code must contain at least 6 characters.'), { payload: { code: 'RESULT_INVITE_INVALID' } });
    const update = { id: 1, invite_enabled: payload.invite_enabled !== false };
    if (code) { update.invite_code_hash = inviteHash(code); update.invite_hint = `${code.slice(0, 3)}••••${code.slice(-2)}`; }
    const row = await upsert('portal_access_config', update, token);
    return { ok: true, invite: row };
  }
  if (action.startsWith('read.')) {
    return { ok: true, rows: await readResource(action.slice(5), payload, token) };
  }
  if (action.startsWith('history.')) {
    if (action === 'history.context.set') return { ok: true, read_only: true };
    const historyResource = action.slice('history.'.length);
    if (['read', 'students', 'graduates'].includes(historyResource) || READ_RESOURCES.has(historyResource)) return { ok: true, rows: [] };
    return unsupportedAction();
  }
  if (action === 'context.set') {
    await requireManagement(token);
    const context = await upsert('academic_context', {
      id: 1,
      class_key: payload.class_key || null,
      academic_session: payload.academic_session || null,
      term: payload.term || null,
      term_status: 'open',
    }, token);
    return { ok: true, context };
  }
  if (action === 'context.read') return { ok: true, context: (await readSettings(token)).academic_context };
  if (action === 'settings.read') return { ok: true, settings: await readSettings(token) };
  if (action === 'settings.app_config.update') {
    await requireManagement(token);
    const config = await upsert('app_config', { id: 1, config: payload.config || {} }, token);
    return { ok: true, config };
  }
  if (action === 'settings.activate_next_term') {
    await requireManagement(token);
    const previous = await readSettings(token);
    const nextConfig = payload.config || {};
    const nextContext = {
      id: 1,
      class_key: null,
      academic_session: payload.academic_session || nextConfig.session || previous.academic_context?.academic_session,
      term: payload.term || nextConfig.term || previous.academic_context?.term,
      term_status: 'open',
    };
    const config = await upsert('app_config', { id: 1, config: nextConfig }, token);
    try {
      const context = await upsert('academic_context', nextContext, token);
      return { ok: true, config, context };
    } catch (error) {
      // Do not leave app_config and academic_context pointing at different terms.
      if (previous.app_config && Object.keys(previous.app_config).length) {
        try { await upsert('app_config', { id: 1, config: previous.app_config }, token); } catch (_) { /* preserve original error */ }
      }
      throw error;
    }
  }
  if (action === 'students.upsert') {
    const student = await upsert('students', payload, token);
    return { ok: true, student };
  }
  if (action === 'students.archive') {
    const rows = await supabaseRest(`students?id=eq.${encodeURIComponent(payload.student_id)}`, {
      method: 'PATCH',
      body: { archived: true, archived_reason: payload.reason || null },
    }, token);
    return { ok: true, student: rows?.[0] || null };
  }
  if (action === 'demo.clear') {
    await requireManagement(token);
    const prefix = String(payload.prefix || 'Demo Pupil -').trim() || 'Demo Pupil -';
    const rows = await supabaseRest(`students?name=like.${encodeURIComponent(`${prefix}%`)}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    }, token);
    return { ok: true, removed: Array.isArray(rows) ? rows.length : 0 };
  }
  if (action === 'scores.enter') {
    const publication = await supabaseRest(`published_subjects?class_key=eq.${encodeURIComponent(payload.class_key)}&subject_index=eq.${encodeURIComponent(payload.subject_index)}&term=eq.${encodeURIComponent(payload.term)}&academic_session=eq.${encodeURIComponent(payload.academic_session)}&published=eq.true&limit=1`, {}, token);
    if (publication?.[0]) {
      const manager = await currentStaff(token);
      if (!manager.profile.suspended && !['developer', 'admin'].includes(manager.profile.role)) {
        const error = new Error('This subject is published and locked. Unpublish it before making corrections.');
        error.status = 403;
        error.payload = { code: 'RESULT_SCORE_LOCKED', message: error.message };
        throw error;
      }
    }
    // Update the exact score row when it already exists, otherwise insert it.
    // This is deliberately explicit so score entry remains reliable even when
    // PostgREST's composite upsert handling differs between deployments.
    const match = `scores?student_id=eq.${encodeURIComponent(payload.student_id)}&subject_index=eq.${encodeURIComponent(payload.subject_index)}&term=eq.${encodeURIComponent(payload.term)}&academic_session=eq.${encodeURIComponent(payload.academic_session)}&limit=1`;
    const existing = await supabaseRest(match, {}, token);
    const scoreBody = {
      student_id: payload.student_id,
      class_key: payload.class_key,
      subject_index: payload.subject_index,
      term: payload.term,
      academic_session: payload.academic_session,
      ca1: payload.ca1 ?? null,
      ca2: payload.ca2 ?? null,
      ca3: payload.ca3 ?? null,
      exam: payload.exam ?? null,
    };
    if (existing?.[0]?.id) {
      const rows = await supabaseRest(`scores?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: scoreBody,
      }, token);
      if (!rows?.[0]) {
        const error = new Error('The score update was not recorded.');
        error.payload = { code: 'RESULT_SCORE_SAVE_FAILED', message: error.message };
        throw error;
      }
      return { ok: true, persisted: true, score: rows[0] };
    }
    const score = await upsert('scores', scoreBody, token);
    if (!score) {
      const error = new Error('The score was not recorded.');
      error.payload = { code: 'RESULT_SCORE_SAVE_FAILED', message: error.message };
      throw error;
    }
    return { ok: true, persisted: true, score };
  }
  if (action === 'traits.enter') {
    return { ok: true, trait: await upsert('traits', payload, token) };
  }
  if (action === 'remarks.enter') {
    return { ok: true, remark: await upsert('remarks', payload, token) };
  }
  if (action === 'fees.update') {
    return { ok: true, fee: await upsert('fees', payload, token) };
  }
  if (action === 'results.publish') {
    if (payload.published === false) {
      return unpublishResult(payload, token);
    }
    return { ok: true, published_subject: await upsert('published_subjects', payload, token) };
  }
  if (action === 'results.unpublish') return unpublishResult(payload, token);
  return unsupportedAction();
}

module.exports = async function resultData(req, res) {
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
  if (!body || typeof body.action !== 'string' || !body.action.trim()) {
    sendJson(res, 400, { ok: false, code: 'RESULT_ACTION_REQUIRED' });
    return;
  }
  try {
    await touchStaff(accessToken);
    const payload = await handleAction(body.action.trim(), body.payload || {}, accessToken);
    sendJson(res, 200, payload);
  } catch (error) {
    const payload = errorPayload(error);
    sendJson(res, authStatus(payload.code), payload);
  }
};
