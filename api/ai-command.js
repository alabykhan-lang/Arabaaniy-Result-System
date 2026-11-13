'use strict';

const {
  bearerTokenFromRequest,
  readJsonBody,
  requestOriginAllowed,
  sendJson,
  supabaseAuthRequest,
  supabaseRest,
  supabaseRpc,
} = require('./_lib');

const MODEL = process.env.FIRST_CHOICE_GEMINI_MODEL || 'gemini-3.1-flash-lite';
// Same model, with fallbacks: a retired or busy model must not fail a question.
const MODEL_CANDIDATES = [...new Set([MODEL, 'gemini-3.1-flash-lite', 'gemini-3.5-flash'].filter(Boolean))];
const API_KEY = process.env.FIRST_CHOICE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const DEVELOPER_EMAIL = 'alabykhan@gmail.com';
const SCHOOL_ADMIN_EMAIL = 'amb.adigun001@gmail.com';

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

async function managementProfile(token) {
  const user = await supabaseAuthRequest('user', undefined, token);
  const email = String(user?.email || '').trim().toLowerCase();
  const fallback = {
    id: user?.id,
    role: email === DEVELOPER_EMAIL ? 'developer' : email === SCHOOL_ADMIN_EMAIL ? 'admin' : 'staff',
    suspended: false,
  };
  const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,school_id,role,suspended&limit=1`, {}, token);
  const profile = email === SCHOOL_ADMIN_EMAIL && !rows?.[0]?.suspended
    ? Object.assign({}, rows?.[0] || fallback, { role: 'admin' })
    : (rows?.[0] || fallback);
  if (profile.suspended || !['admin', 'developer'].includes(profile.role)) {
    fail('RESULT_PERMISSION_DENIED', 'Only school management can use the command center.', 403);
  }
  if (!profile.school_id) fail('RESULT_PERMISSION_DENIED', 'School context is unavailable.', 403);
  return { user, profile };
}

function subjectCatalog(config) {
  const byClass = {};
  const depts = config?.depts && typeof config.depts === 'object' ? config.depts : {};
  Object.entries(depts).forEach(([key, value]) => {
    if (Array.isArray(value?.subjects)) byClass[key] = value.subjects.map(String);
  });
  return byClass;
}

function compactDataset(students, scores, config, context) {
  const names = Object.fromEntries((students || []).map((student) => [student.id, student.name]));
  const classes = Object.fromEntries((students || []).map((student) => [student.class_key, student.class_key]));
  const catalog = subjectCatalog(config);
  const rows = (scores || []).map((score) => {
    const subject = catalog[score.class_key]?.[Number(score.subject_index)] || `Subject ${Number(score.subject_index) + 1}`;
    const values = [score.ca1, score.ca2, score.ca3, score.exam].map((value) => value === null || value === undefined || value === '' ? null : Number(value));
    const recorded = values.some((value) => value !== null);
    const total = values.filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
    return {
      class_key: score.class_key,
      student: names[score.student_id] || 'Unknown student',
      subject,
      ca1: values[0], ca2: values[1], ca3: values[2], exam: values[3],
      test_recorded: values.slice(0, 3).some((value) => value !== null),
      exam_recorded: values[3] !== null,
      total: recorded ? total : null,
    };
  });
  return {
    context: { academic_session: context?.academic_session || null, term: context?.term || null },
    class_keys: Object.keys(classes),
    students: (students || []).map((student) => ({ id: student.id, name: student.name, class_key: student.class_key })),
    score_records: rows,
    definitions: {
      test_recorded: 'at least one CA value (CA1, CA2 or CA3) exists',
      exam_recorded: 'an exam value exists',
      missing_test: 'no CA value exists for the student and subject',
      total: 'sum of available CA and exam values; do not treat missing values as zero',
    },
  };
}

function classLabel(config, key) {
  const depts = config?.depts && typeof config.depts === 'object' ? config.depts : {};
  return String(depts?.[key]?.label || key || '').toUpperCase();
}

/* Language models cannot count long lists reliably, so every number the
 * assistant is allowed to quote is computed here, once, in JavaScript. */
function buildFacts(students, scores, published, config, context) {
  const catalog = subjectCatalog(config);
  const studentsByClass = {};
  (students || []).forEach((student) => {
    studentsByClass[student.class_key] = (studentsByClass[student.class_key] || 0) + 1;
  });
  const scoredIds = new Set((scores || []).map((score) => score.student_id));
  const combos = new Map();
  let recordsWithAnything = 0;
  (scores || []).forEach((score) => {
    const values = [score.ca1, score.ca2, score.ca3, score.exam].map((value) => value === null || value === undefined || value === '' ? null : Number(value));
    if (values.every((value) => value === null)) return;
    recordsWithAnything += 1;
    const key = `${score.class_key}|${score.subject_index}`;
    const entry = combos.get(key) || {
      class_key: score.class_key,
      class_label: classLabel(config, score.class_key),
      subject: catalog[score.class_key]?.[Number(score.subject_index)] || `Subject ${Number(score.subject_index) + 1}`,
      recorded: 0, with_ca: 0, with_exam: 0, total_sum: 0, total_count: 0,
    };
    entry.recorded += 1;
    if (values.slice(0, 3).some((value) => value !== null)) entry.with_ca += 1;
    if (values[3] !== null) entry.with_exam += 1;
    const total = values.filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
    entry.total_sum += total;
    entry.total_count += 1;
    combos.set(key, entry);
  });
  const publishedByClass = {};
  (published || []).forEach((row) => { publishedByClass[row.class_key] = (publishedByClass[row.class_key] || 0) + 1; });
  return {
    academic_session: context?.academic_session || null,
    term: context?.term || null,
    total_students: (students || []).length,
    students_by_class: Object.entries(studentsByClass)
      .map(([class_key, count]) => ({ class_key, class_label: classLabel(config, class_key), students: count }))
      .sort((a, b) => String(a.class_label).localeCompare(String(b.class_label))),
    total_score_records: recordsWithAnything,
    students_with_any_score: scoredIds.size,
    students_without_any_score: Math.max(0, (students || []).length - scoredIds.size),
    score_summary_by_subject: [...combos.values()].map((entry) => Object.assign({}, entry, {
      average_total: entry.total_count ? Number((entry.total_sum / entry.total_count).toFixed(1)) : null,
      total_sum: undefined, total_count: undefined,
    })),
    published_subjects: {
      total: (published || []).length,
      by_class: Object.entries(publishedByClass).map(([class_key, count]) => ({ class_key, class_label: classLabel(config, class_key), subjects: count })),
    },
    class_subject_catalog: Object.fromEntries(Object.entries(catalog).map(([key, subjects]) => [classLabel(config, key), subjects])),
  };
}

module.exports = async function aiCommand(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  let ledgerId = null;
  try {
    if (!API_KEY) fail('AI_PROVIDER_NOT_CONFIGURED', 'The admin command center is not configured on the server.', 503);
    const body = await readJsonBody(req);
    const question = String(body?.question || '').trim();
    if (!question || question.length > 500) fail('AI_COMMAND_INVALID', 'Ask a short question of up to 500 characters.');
    const { profile } = await managementProfile(token);
    const developerExcluded = profile.role === 'developer' || profile.is_developer === true;
    const schoolId = profile.school_id;
    const [configRows, contextRows, students, scores, published] = await Promise.all([
      supabaseRest('app_config?id=eq.1&select=config&limit=1', {}, token),
      supabaseRest('academic_context?id=eq.1&select=academic_session,term&limit=1', {}, token),
      // The result tables are school-scoped by RLS through staff_profiles;
      // they intentionally do not duplicate school_id on every row.
      supabaseRest('students?academic_session=not.is.null&archived=eq.false&select=id,name,class_key,academic_session&limit=5000', {}, token),
      supabaseRest(`scores?academic_session=not.is.null&select=student_id,class_key,subject_index,term,academic_session,ca1,ca2,ca3,exam&limit=10000`, {}, token),
      supabaseRest('published_subjects?select=class_key,subject_index,term,academic_session&limit=5000', {}, token),
    ]);
    const context = contextRows?.[0] || {};
    const session = context.academic_session;
    const term = context.term;
    const scopedStudents = (students || []).filter((row) => !session || row.academic_session === session);
    const scopedIds = new Set(scopedStudents.map((row) => row.id));
    const scopedScores = (scores || []).filter((row) => scopedIds.has(row.student_id) && (!session || row.academic_session === session) && (!term || row.term === term));
    const scopedPublished = (published || []).filter((row) => (!session || row.academic_session === session) && (!term || row.term === term));
    const config = configRows?.[0]?.config || {};
    const facts = buildFacts(scopedStudents, scopedScores, scopedPublished, config, context);
    // Raw rows are only for names and detail; they are capped so the model is
    // never tempted to count them instead of using the computed facts.
    const sample = compactDataset(scopedStudents.slice(0, 400), scopedScores.slice(0, 300), config, context);
    const prompt = [
      'You are the read-only management assistant for First Choice Standard Schools.',
      'Answer the administrator\'s question from the FACT SHEET first. Every number in it is computed exactly from the database.',
      'When a question asks how many, quote the fact sheet figure verbatim. Never count rows from the sample, and never estimate.',
      'If a fact is missing from the fact sheet, say the data does not record it — do not work it out from the sample.',
      'The sample below is partial and is only for names and per-pupil detail.',
      'Do not claim to change, delete, publish, reset, or edit anything. This assistant only reports.',
      'Use a short, direct answer, number first where possible. Mention the active term and session when relevant.',
      'Question: ' + question,
      'FACT SHEET (exact): ' + JSON.stringify(facts).slice(0, 60000),
      'PARTIAL SAMPLE (do not count): ' + JSON.stringify(sample).slice(0, 60000),
    ].join('\n');
    const idempotency = String(body?.idempotency_key || `command-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 120);
    let reserve = null;
    if (!developerExcluded) {
      reserve = await supabaseRpc('ai_reserve_credits', { p_operation: 'admin_command_center', p_model: MODEL, p_idempotency_key: idempotency, p_estimated_credits: 1 }, token);
      if (!reserve?.ok) return sendJson(res, reserve?.code === 'AI_CREDITS_EXHAUSTED' ? 402 : 400, reserve);
      if (reserve.replayed) return sendJson(res, 200, { ok: true, replayed: true, ledger_id: reserve.ledger_id });
      ledgerId = reserve.ledger_id;
    }
    let upstream; let data = {};
    for (const model of MODEL_CANDIDATES) {
      upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 700 } }),
      });
      data = await upstream.json().catch(() => ({}));
      if (upstream.ok && !data.error) break;
    }
    const usage = data.usageMetadata || {};
    const inputTokens = Number(usage.promptTokenCount || 0);
    const outputTokens = Number(usage.candidatesTokenCount || 0);
    const totalTokens = inputTokens + outputTokens;
    if (!upstream.ok || data.error) {
      if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'failed', p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_billable_tokens: totalTokens, p_credits_charged: 0, p_error_code: 'GEMINI_REQUEST_FAILED' }, token);
      return sendJson(res, 502, { ok: false, code: 'AI_PROVIDER_REQUEST_FAILED', message: data.error?.message || 'AI provider request failed.' });
    }
    const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || 'No answer was returned for that question.';
    if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'succeeded', p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_billable_tokens: totalTokens, p_credits_charged: 1 }, token);
    return sendJson(res, 200, { ok: true, answer, ledger_id: ledgerId, usage: { input_tokens: inputTokens, output_tokens: outputTokens, billable_tokens: totalTokens, credits_charged: developerExcluded ? 0 : 1, developer_usage_excluded: developerExcluded } });
  } catch (error) {
    if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'failed', p_input_tokens: 0, p_output_tokens: 0, p_billable_tokens: 0, p_credits_charged: 0, p_error_code: 'AI_COMMAND_FAILED' }, token).catch(() => {});
    return sendJson(res, error.status || 500, { ok: false, code: error.code || error.payload?.code || 'AI_COMMAND_FAILED', message: error.message || 'Admin command failed.' });
  }
};
