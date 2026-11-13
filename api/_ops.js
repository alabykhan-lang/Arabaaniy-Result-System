'use strict';

// Developer-only gate + client for the private "ops" schema.
//
// This module is new and self-contained on purpose: no school-loaded file is
// edited for the pilot. It talks to the ops schema with the service role and
// an explicit Accept-Profile / Content-Profile header, because ops is not in
// PostgREST's exposed schema list.

const {
  bearerTokenFromRequest,
  refreshTokenFromRequest,
  sendJson,
  setSessionCookie,
  supabaseAuthRequest,
  supabaseRest,
} = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bbseogjqgsvsovrluiov.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPS_SCHEMA = 'ops';
const DEVELOPER_ROLE = 'developer';

const OPS_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow, noarchive' };

function deny(res, status, code, message) {
  res.setHeader('X-Robots-Tag', OPS_HEADERS['X-Robots-Tag']);
  sendJson(res, status, { ok: false, code, message });
}

function opsConfigured() {
  return Boolean(SERVICE_ROLE_KEY);
}

async function opsRpc(name, body) {
  if (!SERVICE_ROLE_KEY) {
    const error = new Error('The ops service key is not configured.');
    error.status = 503;
    error.code = 'OPS_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body || {}),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.hint || 'Ops request failed');
    error.status = response.status;
    error.code = payload?.code || 'OPS_REQUEST_FAILED';
    error.payload = payload;
    throw error;
  }
  return payload;
}

// Resolve the caller from their access token (Authorization header or the
// existing portal session cookie), then require staff_profiles.role = developer.
// Anonymous -> 401. Signed in but not a developer -> 403. Suspended -> 403.
async function resolveDeveloper(req, res) {
  let token = bearerTokenFromRequest(req);
  if (!token) {
    return { ok: false, status: 401, code: 'OPS_SESSION_REQUIRED', message: 'Sign in with a developer account.' };
  }

  let user;
  try {
    user = await supabaseAuthRequest('user', undefined, token);
  } catch {
    // An access token lasts one hour. The portal keeps a refresh token in a
    // HttpOnly cookie, so a long-open page renews itself here instead of
    // telling the developer to sign in again in the middle of a conversation.
    const refreshToken = refreshTokenFromRequest(req);
    if (!refreshToken) {
      return { ok: false, status: 401, code: 'OPS_SESSION_INVALID', message: 'The session is not valid. Sign in again.' };
    }
    try {
      const refreshed = await supabaseAuthRequest('token?grant_type=refresh_token', { refresh_token: refreshToken });
      token = refreshed?.access_token || '';
      if (!token) throw new Error('no access token');
      if (res) setSessionCookie(res, token, refreshed.refresh_token || refreshToken);
      user = refreshed.user || await supabaseAuthRequest('user', undefined, token);
    } catch {
      return { ok: false, status: 401, code: 'OPS_SESSION_INVALID', message: 'The session is not valid. Sign in again.' };
    }
  }
  if (!user?.id) {
    return { ok: false, status: 401, code: 'OPS_SESSION_INVALID', message: 'The session is not valid. Sign in again.' };
  }

  let profile = null;
  try {
    const rows = await supabaseRest(
      `staff_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,role,suspended,school_id&limit=1`,
      {},
      token,
    );
    profile = rows?.[0] || null;
  } catch {
    return { ok: false, status: 403, code: 'OPS_PROFILE_UNAVAILABLE', message: 'The staff profile could not be checked.' };
  }

  if (!profile) {
    return { ok: false, status: 403, code: 'OPS_DEVELOPER_ONLY', message: 'This area is limited to the portal developer.' };
  }
  if (profile.suspended) {
    return { ok: false, status: 403, code: 'OPS_ACCOUNT_SUSPENDED', message: 'This account is suspended.' };
  }
  if (profile.role !== DEVELOPER_ROLE) {
    return { ok: false, status: 403, code: 'OPS_DEVELOPER_ONLY', message: 'This area is limited to the portal developer.' };
  }

  return {
    ok: true,
    token,
    actor: {
      id: profile.id,
      email: profile.email || user.email || '',
      role: profile.role,
      school_id: profile.school_id || null,
    },
  };
}

async function requireDeveloper(req, res) {
  const result = await resolveDeveloper(req, res);
  if (!result.ok) {
    deny(res, result.status, result.code, result.message);
    return null;
  }
  return { token: result.token, actor: result.actor };
}

module.exports = {
  OPS_HEADERS,
  deny,
  opsConfigured,
  opsRpc,
  requireDeveloper,
  resolveDeveloper,
};
