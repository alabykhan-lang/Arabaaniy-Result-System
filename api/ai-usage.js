'use strict';
const { bearerTokenFromRequest, requestOriginAllowed, sendJson, supabaseAuthRequest, supabaseRest } = require('./_lib');

module.exports = async function aiUsage(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  try {
    const user = await supabaseAuthRequest('user', undefined, token);
    const profiles = await supabaseRest('staff_profiles?select=school_id&id=eq.' + encodeURIComponent(user.id) + '&limit=1', {}, token);
    let schoolId = profiles?.[0]?.school_id;
    if (!schoolId) {
      const schools = await supabaseRest('school_accounts?select=id&limit=1', {}, token);
      schoolId = schools?.[0]?.id;
    }
    if (!schoolId) return sendJson(res, 403, { ok: false, code: 'RESULT_PERMISSION_DENIED' });

    const [wallet, usage, staff, requests] = await Promise.all([
      supabaseRest('ai_wallets?school_id=eq.' + encodeURIComponent(schoolId) + '&limit=1', {}, token).catch(() => []),
      supabaseRest('ai_usage_ledger?school_id=eq.' + encodeURIComponent(schoolId) + '&select=id,user_id,operation,status,input_tokens,output_tokens,billable_tokens,credits_charged,created_at,completed_at&order=created_at.desc&limit=100', {}, token).catch(() => []),
      supabaseRest('staff_profiles?school_id=eq.' + encodeURIComponent(schoolId) + '&select=id,display_name,email', {}, token).catch(() => []),
      supabaseRest('ai_credit_pack_requests?school_id=eq.' + encodeURIComponent(schoolId) + '&select=id,amount_naira,credits_requested,status,created_at,reviewed_at,review_note&order=created_at.desc&limit=10', {}, token).catch(() => []),
    ]);

    const rows = usage || [];
    const names = Object.fromEntries((staff || []).map((person) => [person.id, person.display_name || person.email || 'Staff member']));
    const byStaff = {};
    rows.forEach((row) => {
      const key = row.user_id || 'unknown';
      if (!byStaff[key]) byStaff[key] = { user_id: key, name: names[key] || 'Staff member', scans: 0, failed: 0, credits: 0 };
      if (row.status === 'succeeded') {
        byStaff[key].scans += 1;
        byStaff[key].credits += Number(row.credits_charged || 0);
      }
      if (row.status === 'failed') {
        byStaff[key].failed += 1;
      }
    });

    return sendJson(res, 200, {
      ok: true,
      wallet: wallet?.[0] || null,
      usage: rows,
      requests: requests || [],
      summary: {
        total_scans: rows.filter((row) => row.status === 'succeeded').length,
        failed_scans: rows.filter((row) => row.status === 'failed').length,
        by_staff: Object.values(byStaff)
      }
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { ok: false, code: error.payload?.code || 'AI_USAGE_UNAVAILABLE', message: error.message });
  }
};
