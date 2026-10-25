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
const SCHOOL_ADMIN_EMAIL = String(process.env.SCHOOL_ADMIN_EMAIL || 'waliyusodiq31@gmail.com').trim().toLowerCase();

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
  const staff = await currentStaff(token);
  if (staff.profile?.suspended) {
    const error = new Error('This staff account has been suspended.');
    error.status = 403;
    error.payload = { code: 'RESULT_ACCOUNT_SUSPENDED', message: error.message };
    throw error;
  }

  if (NON_PERSISTENT_ACTIONS.has(action)) return { ok: true, read_only: true };

  if (action === 'management.staff.list') {
    await requireManagement(token);
    const rows = await supabaseRest('staff_profiles?is_developer=eq.false&order=last_seen_at.desc.nullslast,created_at.asc', {}, token);
    return { ok: true, staff: rows || [] };
  }
  if (action === 'management.staff.create') {
    const manager = await requireManagement(token);
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '');
    const displayName = String(payload.display_name || '').trim();
    const role = String(payload.role || 'staff') === 'admin' ? 'admin' : 'staff';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw Object.assign(new Error('Enter a valid email address.'), { payload: { code: 'RESULT_STAFF_EMAIL_INVALID' } });
    }
    if (!displayName) {
      throw Object.assign(new Error('Enter the staff member\'s full name.'), { payload: { code: 'RESULT_STAFF_NAME_REQUIRED' } });
    }
    if (password.length < 8) {
      throw Object.assign(new Error('The temporary password must be at least 8 characters.'), { payload: { code: 'RESULT_STAFF_PASSWORD_SHORT' } });
    }
    const existing = await supabaseRest(`staff_profiles?email=eq.${encodeURIComponent(email)}&limit=1`, {}, token);
    if (existing?.[0]) {
      throw Object.assign(new Error('An account with that email already exists.'), { payload: { code: 'RESULT_STAFF_EXISTS' } });
    }
    let created = null;
    let alreadyRegistered = false;
    try {
      created = await supabaseAuthRequest('signup', {
        email,
        password,
        data: { portal: 'arabaaniy_result', display_name: displayName },
      });
    } catch (error) {
      const msg = String(error?.message || '');
      if (/already registered|already exists/i.test(msg)) {
        alreadyRegistered = true;
      } else {
        throw Object.assign(new Error('The account could not be created. Please try again.'), { payload: { code: 'RESULT_STAFF_CREATE_FAILED' } });
      }
    }
    const authUser = created?.user || created;
    // Supabase answers a taken email with an obfuscated user that carries no identities,
    // and its id is not a real row in auth.users — a profile written against it breaks the FK.
    if (Array.isArray(authUser?.identities) && authUser.identities.length === 0) {
      alreadyRegistered = true;
    }
    if (alreadyRegistered) {
      // The login already exists (they registered before), so attach a profile to the real user.
      const attached = await supabaseRest('rpc/portal_attach_staff', {
        method: 'POST',
        body: {
          p_email: email,
          p_display_name: displayName,
          p_role: role,
          p_school_id: manager.profile.school_id || null,
        },
      }, token);
      if (!attached) {
        throw Object.assign(new Error('The account could not be created. Please try again.'), { payload: { code: 'RESULT_STAFF_CREATE_FAILED' } });
      }
      return { ok: true, staff: attached, existing_login: true };
    }
    if (!authUser?.id) {
      throw Object.assign(new Error('The account could not be created. Please try again.'), { payload: { code: 'RESULT_STAFF_CREATE_FAILED' } });
    }
    const profile = {
      id: authUser.id,
      email,
      display_name: displayName,
      role,
      suspended: false,
      is_developer: false,
      school_id: manager.profile.school_id || null,
    };
    let saved = null;
    try {
      saved = await supabaseRest('staff_profiles', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: profile,
      }, token);
    } catch (error) {
      if (!/foreign key|duplicate key/i.test(String(error?.message || ''))) throw error;
      saved = [await supabaseRest('rpc/portal_attach_staff', {
        method: 'POST',
        body: { p_email: email, p_display_name: displayName, p_role: role, p_school_id: manager.profile.school_id || null },
      }, token)];
    }
    return { ok: true, staff: saved?.[0] || profile };
  }
  if (action === 'management.staff.update') {
    const manager = await requireManagement(token);
    if (!payload.id) throw Object.assign(new Error('Staff member is required.'), { payload: { code: 'RESULT_STAFF_REQUIRED' } });
    if ((String(payload.id) === String(manager.profile.id) || String(payload.id) === String(manager.user?.id)) && payload.suspended === true) {
      throw Object.assign(new Error('You cannot suspend your own account.'), { payload: { code: 'RESULT_SELF_SUSPEND_DENIED' } });
    }
    if ((String(payload.id) === String(manager.profile.id) || String(payload.id) === String(manager.user?.id)) && payload.role === 'staff') {
      throw Object.assign(new Error('You cannot demote your own account.'), { payload: { code: 'RESULT_SELF_DEMOTE_DENIED' } });
    }
    const target = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}&limit=1`, {}, token);
    if (target?.[0]?.is_developer) throw Object.assign(new Error('The developer account cannot be changed here.'), { payload: { code: 'RESULT_DEVELOPER_PROTECTED' } });
    const update = { updated_at: new Date().toISOString() };
    if (['staff', 'admin'].includes(payload.role)) update.role = payload.role;
    if (typeof payload.suspended === 'boolean') update.suspended = payload.suspended;
    const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}`, { method: 'PATCH', body: update }, token);
    return { ok: true, staff: rows?.[0] || null };
  }
  if (action === 'management.staff.delete') {
    const manager = await requireManagement(token);
    if (!payload.id) throw Object.assign(new Error('Staff member is required.'), { payload: { code: 'RESULT_STAFF_REQUIRED' } });
    if (String(payload.id) === String(manager.profile.id) || String(payload.id) === String(manager.user?.id)) {
      throw Object.assign(new Error('You cannot remove your own account.'), { payload: { code: 'RESULT_SELF_DELETE_DENIED' } });
    }
    const target = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}&limit=1`, {}, token);
    if (target?.[0]?.is_developer) throw Object.assign(new Error('The developer account cannot be removed.'), { payload: { code: 'RESULT_DEVELOPER_PROTECTED' } });
    await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(payload.id)}`, { method: 'DELETE' }, token);
    return { ok: true, removed: true, id: payload.id };
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
    const existing = await supabaseRest('portal_access_config?id=eq.1&select=invite_code_hash,invite_hint&limit=1', {}, token);
    const current = existing?.[0] || null;
    if (current) {
      // invite_code_hash / invite_hint are NOT NULL: keep the stored ones when the
      // manager saves the switch without retyping the code.
      update.invite_code_hash = current.invite_code_hash;
      update.invite_hint = current.invite_hint;
    } else if (!code) {
      throw Object.assign(new Error('Enter an invite code to turn registration on.'), { payload: { code: 'RESULT_INVITE_INVALID' } });
    }
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
      // Any signed-in staff account may unpublish. Publishing is already open to teachers,
      // so requiring management to undo it trapped them: they could mark a subject published
      // by mistake and then had no way back to the marks themselves.
      return unpublishResult(payload, token);
    }
    return { ok: true, published_subject: await upsert('published_subjects', payload, token) };
  }
  if (action === 'results.unpublish') {
    return unpublishResult(payload, token);
  }
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
