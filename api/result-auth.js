'use strict';

const {
  bearerTokenFromRequest,
  clearSessionCookie,
  readJsonBody,
  requestOriginAllowed,
  refreshTokenFromRequest,
  sendJson,
  setSessionCookie,
  supabaseAuthRequest,
  supabaseRest,
} = require('./_lib');
const crypto = require('node:crypto');

const DEVELOPER_EMAIL = String(process.env.DEVELOPER_EMAIL || 'alabykhan@gmail.com').trim().toLowerCase();
const SCHOOL_ADMIN_EMAIL = String(process.env.SCHOOL_ADMIN_EMAIL || '').trim().toLowerCase();
const INITIAL_INVITE_CODE = String(process.env.INITIAL_INVITE_CODE || 'PORTAL2026').trim().toUpperCase();

function inviteHash(value) {
  return crypto.createHash('sha256').update(normalizeInvite(value)).digest('hex');
}

function fallbackProfile(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  const isDev = Boolean(DEVELOPER_EMAIL && email === DEVELOPER_EMAIL);
  const isAdmin = Boolean(SCHOOL_ADMIN_EMAIL && email === SCHOOL_ADMIN_EMAIL);
  return {
    id: user?.id,
    email: user?.email || '',
    display_name: isDev ? 'Portal Developer' : isAdmin ? 'School Administrator' : 'School Staff',
    role: isDev ? 'developer' : isAdmin ? 'admin' : 'staff',
    suspended: false,
    is_developer: isDev,
  };
}

async function enrichUser(user, accessToken) {
  const fallback = fallbackProfile(user);
  if (!user?.id || !accessToken) return { user, profile: fallback };
  try {
    const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&limit=1`, {}, accessToken);
    if (rows?.[0]) {
      if (rows[0].suspended) {
        const error = new Error('This staff account has been suspended.');
        error.status = 403;
        error.payload = { code: 'STAFF_SUSPENDED', message: error.message };
        throw error;
      }
      return { user, profile: rows[0] };
    }
    const profile = await supabaseRest('staff_profiles', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: fallback,
    }, accessToken);
    return { user, profile: profile?.[0] || fallback };
  } catch (error) {
    if (error?.payload?.code === 'STAFF_SUSPENDED') throw error;
    return { user, profile: fallback };
  }
}

async function inviteIsValid(value) {
  try {
    const rows = await supabaseRest('portal_access_config?id=eq.1&select=invite_enabled,invite_code_hash&limit=1');
    const config = rows?.[0];
    if (config) return config.invite_enabled === true && config.invite_code_hash === inviteHash(value);
  } catch (error) {
    // A new project may not have the access table yet; preserve the initial code
    // until the bootstrap SQL has been run.
  }
  return inviteHash(value) === inviteHash(INITIAL_INVITE_CODE);
}

function normalizeInvite(value) {
  return String(value || '').replace(/[\s,]+/g, '').toUpperCase();
}

function authError(res, error) {
  const payload = error?.payload || {};
  const message = String(payload.msg || payload.message || payload.error_description || '').toLowerCase();
  if (message.includes('invalid login credentials')) return sendJson(res, 401, { ok: false, code: 'INVALID_LOGIN_CREDENTIALS' });
  if (message.includes('email not confirmed')) return sendJson(res, 403, { ok: false, code: 'EMAIL_NOT_CONFIRMED' });
  if (message.includes('already registered') || message.includes('already been registered')) return sendJson(res, 409, { ok: false, code: 'EMAIL_ALREADY_REGISTERED' });
  if (message.includes('suspended')) return sendJson(res, 403, { ok: false, code: 'STAFF_SUSPENDED', message: 'This staff account has been suspended.' });
  sendJson(res, error?.status || 400, { ok: false, code: 'AUTH_REQUEST_FAILED', message: payload.msg || payload.message || 'Authentication failed.' });
}

module.exports = async function resultAuth(req, res) {
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });

  if (req.method === 'GET') {
    let token = bearerTokenFromRequest(req);
    if (!token) return sendJson(res, 200, { ok: true, auth_mode: 'local', configured: true });
    try {
      let user;
      try {
        user = await supabaseAuthRequest('user', undefined, token);
      } catch (error) {
        const refreshToken = refreshTokenFromRequest(req);
        if (!refreshToken) throw error;
        const refreshed = await supabaseAuthRequest('token?grant_type=refresh_token', { refresh_token: refreshToken });
        token = refreshed.access_token;
        if (!token) throw error;
        setSessionCookie(res, token, refreshed.refresh_token || refreshToken);
        user = refreshed.user || await supabaseAuthRequest('user', undefined, token);
      }
      const enriched = await enrichUser(user, token);
      return sendJson(res, 200, { ok: true, auth_mode: 'local', user, staff_profile: enriched.profile });
    } catch (error) {
      clearSessionCookie(res);
      return authError(res, error);
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.action !== 'string') return sendJson(res, 400, { ok: false, code: 'INVALID_JSON' });

  if (body.action === 'logout') {
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true, code: 'RESULT_LOGOUT_SUCCESS' });
  }

  try {
    if (body.action === 'login') {
      const payload = await supabaseAuthRequest('token?grant_type=password', { email: body.email, password: body.password });
      const enriched = await enrichUser(payload.user, payload.access_token);
      setSessionCookie(res, payload.access_token, payload.refresh_token);
      return sendJson(res, 200, { ok: true, auth_mode: 'local', session_created: true, user: payload.user, staff_profile: enriched.profile });
    }
    if (body.action === 'register') {
      if (!(await inviteIsValid(body.invite_code))) return sendJson(res, 403, { ok: false, code: 'INVITE_CODE_INVALID' });
      let payload = await supabaseAuthRequest('signup', { email: body.email, password: body.password, data: { portal: 'arabaaniy_result' } });
      if (!payload.access_token) {
        try {
          payload = await supabaseAuthRequest('token?grant_type=password', { email: body.email, password: body.password });
        } catch {}
      }
      const enriched = payload.access_token ? await enrichUser(payload.user, payload.access_token) : { profile: fallbackProfile(payload.user) };
      if (payload.access_token) setSessionCookie(res, payload.access_token, payload.refresh_token);
      return sendJson(res, 200, { ok: true, auth_mode: 'local', session_created: Boolean(payload.access_token), user: payload.user || null, staff_profile: enriched.profile });
    }
    if (body.action === 'forgot_password') {
      await supabaseAuthRequest('recover', { email: body.email, redirect_to: `${req.headers.origin || ''}/portal_core.html` });
      return sendJson(res, 200, { ok: true, code: 'PASSWORD_RECOVERY_SENT' });
    }
    return sendJson(res, 400, { ok: false, code: 'AUTH_ACTION_NOT_SUPPORTED' });
  } catch (error) {
    return authError(res, error);
  }
};
