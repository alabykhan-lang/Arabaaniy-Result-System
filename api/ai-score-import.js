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
const { matchPupil } = require('./_score-names');

// Newest practical reading models first; the configured name wins, then fallbacks.
// gemini-2.5-flash is retired for this key ("no longer available to new users").
const MODEL_CANDIDATES = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
].filter(Boolean))];
const MODEL = MODEL_CANDIDATES[0] || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const DEVELOPER_EMAIL = 'alabykhan@gmail.com';
const SCHOOL_ADMIN_EMAIL = 'alabykhan@gmail.com';
const SCORE_FIELDS = new Set(['ca1', 'ca2', 'ca3', 'exam']);

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

async function managementProfile(token) {
  const user = await supabaseAuthRequest('user', undefined, token);
  const email = String(user?.email || '').trim().toLowerCase();
  const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,school_id,role,is_developer,suspended&limit=1`, {}, token);
  const fallback = { id: user.id, school_id: null, role: email === DEVELOPER_EMAIL ? 'developer' : email === SCHOOL_ADMIN_EMAIL ? 'admin' : 'staff', is_developer: email === DEVELOPER_EMAIL, suspended: false };
  const profile = rows?.[0] || fallback;
  if (email === SCHOOL_ADMIN_EMAIL && !profile.suspended) profile.role = 'admin';
  if (profile.suspended || !['admin', 'developer'].includes(profile.role)) fail('RESULT_PERMISSION_DENIED', 'Only school management can use the AI score scanner.', 403);
  return { user, profile, developerExcluded: profile.role === 'developer' || profile.is_developer === true || email === DEVELOPER_EMAIL };
}

// The portal ships every class, but app_config only stores the ones a school has
// edited. Mirror the built-in list so a class missing from config (Nursery 1/2,
// all SS arms) can still be scanned instead of failing on "Which class?".
const DEFAULT_SIMPLE = ['English Language', 'Mathematics', 'Phonics', 'Handwriting', 'Quantitative Reasoning', 'Verbal Reasoning', 'Basic Science', 'Social Studies', 'Cultural & Creative Arts', 'Computer Studies', 'Religious & National Values'];
const DEFAULT_JSS = ['English Language', 'Mathematics', 'Basic Science', 'Basic Technology', 'Social Studies', 'Civic Education', 'Cultural & Creative Arts', 'Agricultural Science', 'Computer Studies', 'French', 'Yoruba', 'Christian Religious Studies', 'Home Economics', 'Physical & Health Education', 'Business Studies'];
const DEFAULT_CORE = ['English Language', 'Mathematics', 'Digital Technology', 'Economics', 'Citizenship & Heritage Studies'];
const DEFAULT_DEPTS = {
  creche: { label: 'Creche', subjects: ['English Language', 'Numeracy', 'Phonics', 'Handwriting', 'Creative Play', 'Social Skills'] },
  kg1: { label: 'KG 1', subjects: DEFAULT_SIMPLE },
  kg2: { label: 'KG 2', subjects: DEFAULT_SIMPLE },
  nursery1: { label: 'Nursery 1', subjects: DEFAULT_SIMPLE },
  nursery2: { label: 'Nursery 2', subjects: DEFAULT_SIMPLE },
  primary1: { label: 'Primary 1', subjects: DEFAULT_SIMPLE },
  primary2: { label: 'Primary 2', subjects: DEFAULT_SIMPLE },
  primary3: { label: 'Primary 3', subjects: DEFAULT_SIMPLE },
  primary4: { label: 'Primary 4', subjects: DEFAULT_SIMPLE },
  primary5: { label: 'Primary 5', subjects: DEFAULT_SIMPLE },
  jss1: { label: 'JSS 1', subjects: DEFAULT_JSS },
  jss2: { label: 'JSS 2', subjects: DEFAULT_JSS },
  jss3: { label: 'JSS 3', subjects: DEFAULT_JSS },
  'ss1-science': { label: 'SS1 - Science', subjects: DEFAULT_CORE.concat(['Biology', 'Physics', 'Chemistry', 'Agricultural Science', 'Geography']) },
  'ss1-arts': { label: 'SS1 - Arts', subjects: DEFAULT_CORE.concat(['Literature', 'Government', 'I.R.S', 'Yoruba']) },
  'ss1-business': { label: 'SS1 - Commercial', subjects: DEFAULT_CORE.concat(['Financial Accounting', 'Commerce', 'Government']) },
  'ss2-science': { label: 'SS2 - Science', subjects: DEFAULT_CORE.concat(['Biology', 'Physics', 'Chemistry', 'Agricultural Science', 'Livestock Farming', 'Geography']) },
  'ss2-arts': { label: 'SS2 - Arts', subjects: DEFAULT_CORE.concat(['Literature', 'Government', 'I.R.S', 'Yoruba']) },
  'ss2-business': { label: 'SS2 - Business', subjects: DEFAULT_CORE.concat(['Financial Accounting', 'Commerce', 'Government']) },
  'ss3-science': { label: 'SS3 - Science', subjects: DEFAULT_CORE.concat(['Biology', 'Physics', 'Chemistry', 'Agricultural Science', 'Livestock Farming', 'Geography']) },
  'ss3-arts': { label: 'SS3 - Arts', subjects: DEFAULT_CORE.concat(['Literature', 'Government', 'I.R.S', 'Yoruba']) },
  'ss3-business': { label: 'SS3 - Commercial', subjects: DEFAULT_CORE.concat(['Financial Accounting', 'Commerce', 'Government']) },
};

function catalogFromConfig(config) {
  const catalog = {};
  Object.entries(DEFAULT_DEPTS).forEach(([classKey, value]) => {
    catalog[classKey] = { class_key: classKey, class_label: value.label, subjects: value.subjects.slice() };
  });
  const depts = config?.depts && typeof config.depts === 'object' ? config.depts : {};
  Object.entries(depts).forEach(([classKey, value]) => {
    const subjects = Array.isArray(value?.subjects) ? value.subjects.map(String) : [];
    catalog[classKey] = { class_key: classKey, class_label: String(value?.label || classKey), subjects: subjects.length ? subjects : (catalog[classKey]?.subjects || []) };
  });
  return catalog;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function similarity(left, right) {
  const a = normalize(left).split(' ').filter(Boolean);
  const b = normalize(right).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const flatA = a.join('');
  const flatB = b.join('');
  if (flatA === flatB) return 1;
  const as = new Set(a); const bs = new Set(b);
  const overlap = a.filter((part) => bs.has(part)).length;
  const tokenScore = (2 * overlap) / (as.size + bs.size);
  // Handwriting drops, doubles and swaps letters constantly (AMINULAHI for
  // AMINULLAHI), so compare characters as well as words.
  const bigramDice = (() => {
    if (flatA.length < 2 || flatB.length < 2) return 0;
    const grams = (value) => {
      const map = new Map();
      for (let i = 0; i < value.length - 1; i += 1) {
        const gram = value.slice(i, i + 2);
        map.set(gram, (map.get(gram) || 0) + 1);
      }
      return map;
    };
    const ga = grams(flatA); const gb = grams(flatB);
    let hits = 0;
    ga.forEach((count, gram) => { if (gb.has(gram)) hits += Math.min(count, gb.get(gram)); });
    return (2 * hits) / (flatA.length - 1 + flatB.length - 1);
  })();
  return Math.max(tokenScore, bigramDice * 0.95);
}

function parseModelJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  }
  fail('AI_SCORE_RESPONSE_INVALID', 'The score sheet could not be interpreted as structured data.', 502);
}

function assessmentLabel(field) {
  return { ca1: 'First CA', ca2: 'Second CA', ca3: 'Third CA', exam: 'Exam' }[field] || field;
}

function resolveClass(value, catalog) {
  const wanted = normalize(value);
  return Object.values(catalog).find((item) => normalize(item.class_key) === wanted || normalize(item.class_label) === wanted || similarity(item.class_label, value) >= 0.85);
}

function resolveSubject(value, classInfo) {
  const wanted = normalize(value);
  return classInfo?.subjects?.map((name, index) => ({ name, index }))
    .find((item) => normalize(item.name) === wanted || similarity(item.name, value) >= 0.82);
}

function resolveAssessment(value) {
  const wanted = normalize(value);
  if (SCORE_FIELDS.has(wanted)) return wanted;
  if (wanted.includes('first') && wanted.includes('ca')) return 'ca1';
  if (wanted.includes('second') && wanted.includes('ca')) return 'ca2';
  if (wanted.includes('third') && wanted.includes('ca')) return 'ca3';
  if (wanted === 'ca' || wanted.includes('continuous assessment')) return null;
  if (wanted.includes('exam')) return 'exam';
  return null;
}

function matchRows(rows, roster, classKey) {
  const candidates = roster.filter((student) => student.class_key === classKey);
  const used = new Set();
  return rows.map((row) => {
    const name = String(row?.student_name || row?.name || '').trim();
    const decision = matchPupil(name, candidates);
    let status = decision.status;
    if (status === 'matched' && used.has(decision.pupil.id)) status = 'duplicate';
    const rawScore = row?.score === null || row?.score === undefined || row?.score === '' ? null : Number(row.score);
    const score = Number.isFinite(rawScore) ? rawScore : null;
    if (status === 'matched') used.add(decision.pupil.id);
    return {
      source_name: name,
      student_id: status === 'matched' ? decision.pupil.id : null,
      matched_name: status === 'matched' ? decision.pupil.name : null,
      candidates: decision.candidates,
      score,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : Number((decision.confidence || 0).toFixed(2)),
      status,
      reason: decision.reason || row?.reason || null,
    };
  });
}

async function loadContext(token) {
  const [configRows, contextRows, students] = await Promise.all([
    supabaseRest('app_config?id=eq.1&select=config&limit=1', {}, token),
    supabaseRest('academic_context?id=eq.1&select=academic_session,term&limit=1', {}, token),
    supabaseRest('students?academic_session=not.is.null&archived=eq.false&select=id,name,class_key,academic_session&limit=5000', {}, token),
  ]);
  const context = contextRows?.[0] || {};
  const roster = (students || []).filter((student) => !context.academic_session || student.academic_session === context.academic_session);
  return { config: configRows?.[0]?.config || {}, context, roster };
}

async function attachExistingScores(draft, token) {
  if (!draft || draft.needs_clarification || !draft.interpretation?.class_key) return draft;
  const i = draft.interpretation;
  const field = String(i.assessment_field || '');
  if (!SCORE_FIELDS.has(field)) return draft;
  const rows = await supabaseRest(`scores?class_key=eq.${encodeURIComponent(i.class_key)}&subject_index=eq.${encodeURIComponent(i.subject_index)}&term=eq.${encodeURIComponent(draft.context?.term || '')}&academic_session=eq.${encodeURIComponent(draft.context?.academic_session || '')}&select=student_id,${field}&limit=5000`, {}, token);
  const existing = new Map((rows || []).map((row) => [String(row.student_id), row[field] === null || row[field] === undefined || row[field] === '' ? null : Number(row[field])]));
  draft.rows = (draft.rows || []).map((row) => {
    const existingScore = row.student_id ? existing.get(String(row.student_id)) ?? null : null;
    const conflict = row.status === 'matched' && existingScore !== null && row.score !== null && Number(existingScore) !== Number(row.score);
    return Object.assign(row, { existing_score: existingScore, conflict });
  });
  draft.summary = Object.assign({}, draft.summary, { conflicts: draft.rows.filter((row) => row.conflict).length });
  draft.review_required = draft.review_required || draft.summary.conflicts > 0;
  return draft;
}

function validateDraft(parsed, context) {
  const catalog = catalogFromConfig(context.config);
  const interpretation = parsed?.interpretation || {};
  const classInfo = resolveClass(interpretation.class_key || interpretation.class_name || interpretation.class, catalog);
  const subject = resolveSubject(interpretation.subject_name || interpretation.subject, classInfo);
  const field = resolveAssessment(interpretation.assessment_field || interpretation.assessment || interpretation.assessment_type);
  const questions = [];
  if (!classInfo) questions.push('Which configured class is this score sheet for?');
  if (classInfo && !subject) questions.push(`Which subject in ${classInfo.class_label} is this for?`);
  if (!field) questions.push(`Is this First CA, Second CA, Third CA, or Exam?`);
  if (questions.length) return { needs_clarification: true, questions, catalog: Object.values(catalog).map((item) => ({ class_key: item.class_key, class_label: item.class_label, subjects: item.subjects })), interpretation: { class_key: classInfo?.class_key || null, class_label: classInfo?.class_label || null, subject_name: subject?.name || null, subject_index: subject?.index ?? null, assessment_field: field, assessment_label: field ? assessmentLabel(field) : null } };
  const maxScore = Number(interpretation.max_score || interpretation.maximum_score || 0) || null;
  const rows = matchRows(Array.isArray(parsed?.rows) ? parsed.rows : [], context.roster, classInfo.class_key).map((row) => {
    const invalid = row.score !== null && (row.score < 0 || (maxScore !== null && row.score > maxScore));
    return Object.assign(row, { status: invalid ? 'out_of_range' : row.status, reason: invalid ? `Score must be between 0 and ${maxScore}.` : row.reason });
  });
  const matchedIds = new Set(rows.filter((row) => row.status === 'matched').map((row) => row.student_id));
  const missing = context.roster.filter((student) => student.class_key === classInfo.class_key && !matchedIds.has(student.id)).map((student) => ({ id: student.id, name: student.name }));
  const issueStatuses = new Set(['ambiguous', 'unmatched', 'duplicate', 'unclear', 'out_of_range']);
  const reviewRequired = missing.length > 0 || rows.some((row) => issueStatuses.has(row.status) || row.score === null);
  return { needs_clarification: false, review_required: reviewRequired, interpretation: { class_key: classInfo.class_key, class_label: classInfo.class_label, subject_name: subject.name, subject_index: subject.index, assessment_field: field, assessment_label: assessmentLabel(field), max_score: maxScore, confidence: Number(interpretation.confidence || 0) || null }, rows, summary: { expected: context.roster.filter((student) => student.class_key === classInfo.class_key).length, extracted: rows.length, matched: matchedIds.size, missing: missing.length, issues: rows.filter((row) => issueStatuses.has(row.status) || row.score === null).length }, missing };
}

async function commitScores(body, token, context) {
  const draft = body?.draft;
  const interpretation = draft?.interpretation || {};
  const field = String(interpretation.assessment_field || '');
  if (!SCORE_FIELDS.has(field)) fail('AI_SCORE_ASSESSMENT_REQUIRED', 'A valid assessment is required before saving.');
  const catalog = catalogFromConfig(context.config);
  const classInfo = catalog[interpretation.class_key];
  if (!classInfo || Number(interpretation.subject_index) < 0 || !classInfo.subjects[Number(interpretation.subject_index)]) fail('AI_SCORE_TARGET_INVALID', 'The selected class or subject is no longer configured.');
  const maxScore = Number(interpretation.max_score || 0) || null;
  const allowed = new Map(context.roster.filter((student) => student.class_key === classInfo.class_key).map((student) => [String(student.id), student]));
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length || rows.length > 500) fail('AI_SCORE_ROWS_INVALID', 'There are no valid score rows to save.');
  let saved = 0;
  for (const row of rows) {
    if (row.status !== 'matched' || !allowed.has(String(row.student_id))) continue;
    const score = Number(row.score);
    if (!Number.isFinite(score) || score < 0 || (maxScore !== null && score > maxScore)) continue;
    const match = `scores?student_id=eq.${encodeURIComponent(row.student_id)}&subject_index=eq.${encodeURIComponent(interpretation.subject_index)}&term=eq.${encodeURIComponent(context.context.term)}&academic_session=eq.${encodeURIComponent(context.context.academic_session)}&limit=1`;
    const existing = await supabaseRest(match, {}, token);
    const currentExisting = existing?.[0]?.[field] === null || existing?.[0]?.[field] === undefined || existing?.[0]?.[field] === '' ? null : Number(existing[0][field]);
    if (Object.prototype.hasOwnProperty.call(row, 'existing_score') && currentExisting !== (row.existing_score === null || row.existing_score === undefined || row.existing_score === '' ? null : Number(row.existing_score))) {
      fail('AI_SCORE_CONFLICT', `The saved ${field.toUpperCase()} score for ${row.matched_name || 'this student'} changed while you were reviewing. Read the sheet again.`, 409);
    }
    const scoreBody = { student_id: row.student_id, class_key: classInfo.class_key, subject_index: Number(interpretation.subject_index), term: context.context.term, academic_session: context.context.academic_session, ca1: existing?.[0]?.ca1 ?? null, ca2: existing?.[0]?.ca2 ?? null, ca3: existing?.[0]?.ca3 ?? null, exam: existing?.[0]?.exam ?? null };
    scoreBody[field] = score;
    if (existing?.[0]?.id) await supabaseRest(`scores?id=eq.${encodeURIComponent(existing[0].id)}`, { method: 'PATCH', body: scoreBody, prefer: 'return=representation' }, token);
    else await supabaseRest('scores', { method: 'POST', body: scoreBody, prefer: 'return=representation' }, token);
    saved += 1;
  }
  return { saved, skipped: rows.length - saved, field, class_key: classInfo.class_key, subject_index: Number(interpretation.subject_index) };
}

/* ------------------------------------------------------------------
 * Whole-sheet mode: one photo of a record-book page is read into every
 * scored column at once (each CA plus Exam), matched against the class
 * roster, checked against the configured maxima, and saved in one go.
 * ------------------------------------------------------------------ */

async function sheetProfile(token) {
  const user = await supabaseAuthRequest('user', undefined, token);
  const email = String(user?.email || '').trim().toLowerCase();
  const rows = await supabaseRest(`staff_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,school_id,role,is_developer,suspended&limit=1`, {}, token);
  const profile = rows?.[0] || { id: user.id, school_id: null, role: 'staff', is_developer: false, suspended: false };
  if (profile.suspended) fail('STAFF_SUSPENDED', 'This staff account has been suspended.', 403);
  return { user, profile, developerExcluded: profile.role === 'developer' || profile.is_developer === true || email === DEVELOPER_EMAIL };
}

function assessmentMarks(config) {
  const a = config?.assessment || {};
  const caCount = Math.max(1, Math.min(3, Number(a.caCount || 2)));
  const marks = (Array.isArray(a.caMarks) ? a.caMarks.slice(0, 3) : [15, 15, 10]).map((value) => Math.max(1, Number(value) || 10));
  while (marks.length < 3) marks.push(10);
  return { caCount, caMarks: marks, examMark: Math.max(1, Number(a.examMark || 70)) };
}

function sheetFields(marks) {
  const fields = [];
  for (let i = 0; i < marks.caCount; i += 1) {
    fields.push({ field: `ca${i + 1}`, label: assessmentLabel(`ca${i + 1}`), max: marks.caMarks[i] });
  }
  fields.push({ field: 'exam', label: 'Exam', max: marks.examMark });
  return fields;
}

// Which printed column the teacher photographed. The portal asks before the
// read as three categories — C.A, EXAM, or both — because a record book prints
// CLASS EXERCISE / TEST / EXAM, never "CA", and every term block repeats the
// same headers. Without this the reader drops a class-exercise column into Exam
// and nothing can tell the difference.
const SHEET_CATEGORIES = new Set(['ca', 'exam', 'both']);

function sheetCategory(target, requested) {
  const value = String(requested || '').trim().toLowerCase();
  if (SHEET_CATEGORIES.has(value)) return value;
  if (target === 'exam') return 'exam';
  if (target === 'both') return 'both';
  return 'ca';
}

function sheetCategoryLabel(category) {
  return category === 'exam' ? 'EXAM' : category === 'both' ? 'C.A + EXAM' : 'C.A';
}

function sheetTarget(field, category) {
  const value = String(field || '').trim().toLowerCase();
  if (category === 'exam') return 'exam';
  if (category === 'both') return 'both';
  if (/^ca[123]$/.test(value)) return value;
  return 'ca1';
}

// The CA field the teacher picked, even when they also asked for Exam.
function sheetCaField(field) {
  const value = String(field || '').trim().toLowerCase();
  return /^ca[123]$/.test(value) ? value : 'ca1';
}

function sheetTargetRules(fields, category, caField, termBlock) {
  const block = termBlock || 'the active term';
  const ca = fields.find((item) => item.field === caField) || fields[0];
  const exam = fields.find((item) => item.field === 'exam') || { max: '' };
  const lines = [
    `- The page repeats its columns in three blocks: 1st Term, 2nd Term, 3rd Term. Read only the ${block} block and ignore the other two blocks.`,
    `- "CLASS EXERCISE" (also written TEST or CA) is continuous assessment: its value belongs in ${ca.label} (maximum ${ca.max}).`,
    `- "EXAM" is the examination: its value belongs in Exam (maximum ${exam.max}).`,
    '- These are two separate printed columns. Transcribe each one from its own column; never swap them and never repeat one column\'s numbers in the other.',
    '- If a column is empty, blank, or not printed on this page, every value for it must be null. An empty EXAM column must stay null even when the CLASS EXERCISE column is full.',
  ];
  if (category === 'both') {
    lines.push('- Set every other score field to null.');
    return lines;
  }
  const wanted = category === 'exam' ? 'Exam' : ca.label;
  lines.push(`- The teacher wants only the ${wanted} column. Fill both columns above exactly as printed anyway, so the server can check they are separate; the other column is then discarded.`);
  lines.push('- Set every other score field to null.');
  return lines;
}

function sheetPrompt(instruction, fields, roster, context, category, caField, termBlock) {
  const columns = fields.map((item) => `${item.label} (maximum ${item.max})`).join(', ');
  const ca = fields.find((item) => item.field === caField) || fields[0];
  const chosen = category === 'both'
    ? `C.A and EXAM together (C.A goes in ${ca.label})`
    : category === 'exam'
      ? 'EXAM only'
      : `C.A only, in ${ca.label}`;
  return [
    'You transcribe one photographed Nigerian school record-book page into JSON. Return JSON only, no markdown, no commentary.',
    `The page has a Serial Number column, a Student Name column, and these score columns: ${columns}.`,
    'Read every student row that is visible, top to bottom.',
    `The teacher chose to read: ${chosen}.`,
    ...sheetTargetRules(fields, category, caField, termBlock),
    'Rules:',
    '- The class list below is only a spelling aid for handwriting. Never copy a name from it, and never output a row you cannot actually see written on the page.',
    '- If the photo is blank, blurred, out of focus, or does not show a score sheet, return {"page_header":null,"rows":[]}. Returning no rows is always better than inventing any.',
    '- Read the name exactly as handwritten, including misspellings; never substitute a different pupil and never complete a name from the class list.',
    '- Keep the surname and the given name exactly as written, separated by " - " (for example "ADEYEMO - Sodiq").',
    '- Ignore the serial number column entirely; it is not a score.',
    '- If a score box has been crossed out and rewritten, use the final legible value.',
    '- A dash, tick, empty box, or blank means null — never zero.',
    '- Do not guess and do not copy a neighbouring value; if a digit is doubtful put your best reading and lower the confidence.',
    '- Digits are 0-9. A score cannot exceed the maximum printed above for its column.',
    `Return {"page_header":"text you can actually read at the top of the page, or null","rows":[{"student_name":"SURNAME - Given name AS WRITTEN","${fields.map((item) => item.field).join('":"number|null","')}":"number|null","confidence":0.0,"note":null}]}`,
    `Class and subject for this page: ${instruction}`,
    `Names already registered in this class (spelling aid only, never a row source): ${roster}`,
    `Term/session: ${context.term || 'unknown'} / ${context.academic_session || 'unknown'}`,
  ].join('\n');
}

/* The header the reader can see is the teacher's best chance to catch a page
 * photographed from the wrong class or term before anything is committed. */
function classAliases(classLabel) {
  const label = String(classLabel || '');
  const short = { nursery: 'NUR', primary: 'PRI', pri: 'PRI', pry: 'PRI', kg: 'KG', jss: 'JSS', ss: 'SS', creche: 'CRECHE' };
  const match = label.match(/^([A-Za-z]+)\s*(\d.*)$/);
  if (!match) return [label];
  const word = match[1].toLowerCase();
  const abbr = short[word] || match[1].slice(0, 3).toUpperCase();
  const rest = match[2];
  return [label, `${abbr} ${rest}`, `${abbr}${rest}`, `${match[1]} ${rest}`];
}

function headerWarning(pageHeader, classLabel, termBlock) {
  const header = normalize(pageHeader);
  if (!header) return null;
  const warnings = [];
  const compact = header.replace(/\s+/g, '');
  const named = classAliases(classLabel).some((alias) => {
    const wanted = normalize(alias);
    return wanted && (header.includes(wanted) || compact.includes(wanted.replace(/\s+/g, '')));
  });
  if (!named) warnings.push(`The page heading reads "${String(pageHeader).slice(0, 60)}", which does not name ${classLabel}`);
  const termPatterns = [[/1st term|first term/i, '1st Term'], [/2nd term|second term/i, '2nd Term'], [/3rd term|third term/i, '3rd Term']];
  const printedTerm = termPatterns.find(([pattern]) => pattern.test(pageHeader))?.[1];
  if (termBlock && printedTerm && normalize(termBlock) !== normalize(printedTerm)) warnings.push(`the page looks like ${printedTerm} but ${termBlock} is selected`);
  return warnings.length ? `${warnings.join('; ')}.` : null;
}

function matchSheetRows(rows, roster, classKey, fields) {
  const candidates = roster.filter((student) => student.class_key === classKey);
  const used = new Set();
  return rows.map((row) => {
    const name = String(row?.student_name || row?.name || '').trim();
    const decision = matchPupil(name, candidates);
    let status = decision.status;
    if (status === 'matched' && used.has(decision.pupil.id)) status = 'duplicate';
    const values = {}; const issues = [];
    fields.forEach((item) => {
      const raw = row?.[item.field];
      let value = raw === null || raw === undefined || raw === '' ? null : Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(value)) value = null;
      if (value !== null && (value < 0 || value > item.max)) issues.push(`${item.label} must be between 0 and ${item.max}`);
      values[item.field] = value;
    });
    const nothingRead = Object.values(values).every((value) => value === null);
    if (nothingRead) issues.push('No score could be read on this row');
    const identified = status === 'matched';
    if (issues.length && status === 'matched') status = nothingRead ? 'unclear' : 'out_of_range';
    if (identified) used.add(decision.pupil.id);
    return {
      source_name: name,
      // Keep the pupil on the row even when a value is out of range: the
      // reviewer needs to see whose sheet the bad score belongs to.
      student_id: identified ? decision.pupil.id : null,
      matched_name: identified ? decision.pupil.name : null,
      // Ranked pupils for rows the matcher will not accept on its own. The
      // teacher taps one; the scanner never saves a guessed pupil.
      candidates: decision.candidates,
      values,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : Number((decision.confidence || 0).toFixed(2)),
      status,
      reason: issues.length ? issues.join('; ') : (decision.reason || row?.note || row?.reason || null),
    };
  });
}

function validateSheetDraft(parsed, context, hints) {
  const catalog = catalogFromConfig(context.config);
  const marks = assessmentMarks(context.config);
  const fields = sheetFields(marks);
  const interpretation = parsed?.interpretation || {};
  const classInfo = hints?.class_key ? catalog[hints.class_key] : resolveClass(interpretation.class_key || interpretation.class_name || interpretation.class, catalog);
  const subject = hints?.subject_index !== undefined && hints?.subject_index !== null && hints?.subject_index !== ''
    ? (classInfo ? { name: classInfo.subjects[Number(hints.subject_index)], index: Number(hints.subject_index) } : null)
    : resolveSubject(interpretation.subject_name || interpretation.subject, classInfo);
  const questions = [];
  if (!classInfo) questions.push('Which class is this score sheet for?');
  if (classInfo && (!subject || !subject.name)) questions.push(`Which subject in ${classInfo.class_label} is this for?`);
  if (questions.length) {
    return {
      needs_clarification: true,
      questions,
      fields: fields.map((item) => ({ field: item.field, label: item.label, max: item.max })),
      catalog: Object.values(catalog).map((item) => ({ class_key: item.class_key, class_label: item.class_label, subjects: item.subjects })),
      interpretation: { class_key: classInfo?.class_key || null, class_label: classInfo?.class_label || null, subject_name: subject?.name || null, subject_index: subject?.index ?? null },
    };
  }
  const readRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const pageHeader = String(parsed?.page_header || '').trim();
  // A blank or blurred photo must never become a full set of invented scores.
  if (!readRows.length || hints?.image_blank === true) {
    fail('AI_SCORE_NOTHING_READ', 'Nothing could be read on that page. Check the whole page is in frame, well lit and not blurred, then try again. Nothing was charged.', 422);
  }
  const category = sheetCategory(hints?.target_field, hints?.category);
  const caField = sheetCaField(hints?.target_field);
  const target = sheetTarget(hints?.target_field, category);
  const termBlock = String(hints?.term_block || '').trim();
  // The reader always transcribes the CLASS EXERCISE column and the EXAM column
  // of the chosen term block. These numbers decide whether the requested column
  // was really on the page, before the other column is thrown away.
  const readNumber = (row, field) => {
    const value = row?.[field];
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const filledCount = (field) => readRows.filter((row) => readNumber(row, field) !== null).length;
  const fieldLabel = (field) => (fields.find((item) => item.field === field) || fields[0]).label;
  if (category === 'both') {
    if (!filledCount(caField) && !filledCount('exam')) {
      fail('AI_SCORE_COLUMN_EMPTY', `No ${fieldLabel(caField)} or EXAM marks could be read on that page. Check you photographed the right column and that the page is in focus. Nothing was charged.`, 422);
    }
  } else {
    if (!filledCount(target)) {
      fail('AI_SCORE_COLUMN_EMPTY', `No ${fieldLabel(target)} marks could be read on that page. Check you chose the right column and that it is not blank, then photograph the page again. Nothing was charged.`, 422);
    }
    const other = target === 'exam' ? caField : 'exam';
    // An empty EXAM column is the classic trap: the reader fills it with the
    // class-exercise numbers. Identical columns on nearly every pupil means the
    // chosen column was not actually read, so nothing is offered for saving.
    const pairs = readRows.filter((row) => readNumber(row, target) !== null && readNumber(row, other) !== null);
    const equal = pairs.filter((row) => readNumber(row, target) === readNumber(row, other)).length;
    if (pairs.length >= 5 && equal >= pairs.length * 0.9) {
      fail('AI_SCORE_COLUMN_COPIED', `The ${fieldLabel(target)} column looks blank on this page: its numbers repeat the ${fieldLabel(other)} column. Check you chose the right column and photograph the page again. Nothing was charged.`, 422);
    }
  }
  // A teacher who chose C.A or EXAM gets only that column, whatever the reader
  // put in the other boxes. "Both" keeps the chosen C.A column and Exam, and
  // drops any other CA column.
  const chosen = category === 'both' ? new Set([caField, 'exam']) : new Set([target]);
  readRows.forEach((row) => {
    if (!row) return;
    fields.forEach((item) => { if (!chosen.has(item.field)) row[item.field] = null; });
  });
  const headerNotice = headerWarning(pageHeader, classInfo.class_label, termBlock);
  const rows = matchSheetRows(readRows, context.roster, classInfo.class_key, fields);
  // The review shows only the columns the teacher asked for. That also stops a
  // stray digit in the other box from ever reaching a save: the client can only
  // send back the fields it was shown.
  const chosenFields = category === 'both'
    ? fields.filter((item) => item.field === caField || item.field === 'exam')
    : fields.filter((item) => item.field === target);
  const matchedIds = new Set(rows.filter((row) => row.status === 'matched').map((row) => row.student_id));
  const missing = context.roster.filter((student) => student.class_key === classInfo.class_key && !matchedIds.has(student.id)).map((row) => ({ id: row.id, name: row.name }));
  const issueStatuses = new Set(['ambiguous', 'unmatched', 'duplicate', 'unclear', 'out_of_range']);
  // No readable header is a hint that this may not be the right page; make the
  // reader look at it rather than accepting it silently.
  const reviewRequired = missing.length > 0 || !pageHeader || Boolean(headerNotice) || rows.some((row) => issueStatuses.has(row.status));
  return {
    needs_clarification: false,
    review_required: reviewRequired,
    mode: 'sheet',
    category,
    category_label: sheetCategoryLabel(category),
    ca_field: category === 'exam' ? null : caField,
    ca_label: category === 'exam' ? null : (fields.find((item) => item.field === caField) || fields[0]).label,
    target_field: target,
    term_block: termBlock || null,
    column_shift: null,
    header_warning: headerNotice,
    fields: chosenFields.map((item) => ({ field: item.field, label: item.label, max: item.max })),
    interpretation: {
      class_key: classInfo.class_key,
      class_label: classInfo.class_label,
      subject_name: subject.name,
      subject_index: subject.index,
      category,
      category_label: sheetCategoryLabel(category),
      max_marks: fields.reduce((acc, item) => Object.assign(acc, { [item.field]: item.max }), {}),
      confidence: Number(interpretation.confidence || 0) || null,
    },
    page_header: pageHeader || null,
    rows,
    summary: {
      expected: context.roster.filter((student) => student.class_key === classInfo.class_key).length,
      extracted: rows.length,
      matched: matchedIds.size,
      missing: missing.length,
      issues: rows.filter((row) => issueStatuses.has(row.status)).length,
      conflicts: 0,
    },
    missing,
  };
}

async function attachExistingSheetScores(draft, token) {
  if (!draft || draft.needs_clarification || !draft.interpretation?.class_key) return draft;
  const i = draft.interpretation;
  const fieldList = (draft.fields || []).map((item) => item.field).join(',');
  if (!fieldList) return draft;
  const rows = await supabaseRest(`scores?class_key=eq.${encodeURIComponent(i.class_key)}&subject_index=eq.${encodeURIComponent(i.subject_index)}&term=eq.${encodeURIComponent(draft.context?.term || '')}&academic_session=eq.${encodeURIComponent(draft.context?.academic_session || '')}&select=student_id,${fieldList}&limit=5000`, {}, token);
  const existing = new Map((rows || []).map((row) => [String(row.student_id), row]));
  draft.rows = (draft.rows || []).map((row) => {
    const saved = row.student_id ? existing.get(String(row.student_id)) : null;
    const existingValues = {}; const conflicts = [];
    (draft.fields || []).forEach((item) => {
      const value = saved ? saved[item.field] : null;
      const clean = value === null || value === undefined || value === '' ? null : Number(value);
      existingValues[item.field] = clean;
      if (row.status === 'matched' && clean !== null && row.values?.[item.field] !== null && Number(clean) !== Number(row.values[item.field])) conflicts.push(item.field);
    });
    return Object.assign(row, { existing_values: existingValues, conflict_fields: conflicts, conflict: conflicts.length > 0 });
  });
  draft.summary = Object.assign({}, draft.summary, { conflicts: draft.rows.filter((row) => row.conflict).length });
  draft.review_required = draft.review_required || draft.summary.conflicts > 0;
  return draft;
}

async function commitSheet(body, token, context) {
  const draft = body?.draft;
  const interpretation = draft?.interpretation || {};
  const catalog = catalogFromConfig(context.config);
  const classInfo = catalog[interpretation.class_key];
  if (!classInfo || !classInfo.subjects[Number(interpretation.subject_index)]) fail('AI_SCORE_TARGET_INVALID', 'The selected class or subject is no longer configured.');
  const marks = assessmentMarks(context.config);
  const fields = sheetFields(marks);
  // Save only the columns the teacher chose when reading. The draft already
  // carries just those fields, but a hand-edited request must not be able to
  // slip a value into the other column either.
  const sheetCategoryValue = sheetCategory(draft?.target_field, interpretation.category || draft?.category);
  const sheetCaFieldValue = sheetCaField(draft?.ca_field || draft?.target_field);
  const allowedFields = sheetCategoryValue === 'both'
    ? new Set([sheetCaFieldValue, 'exam'])
    : new Set([sheetCategoryValue === 'exam' ? 'exam' : sheetCaFieldValue]);
  const allowed = new Map(context.roster.filter((student) => student.class_key === classInfo.class_key).map((student) => [String(student.id), student]));
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length || rows.length > 500) fail('AI_SCORE_ROWS_INVALID', 'There are no valid score rows to save.');
  let saved = 0; let savedValues = 0; let skipped = 0;
  const savedRows = [];
  for (const row of rows) {
    if (row.status !== 'matched' || !allowed.has(String(row.student_id))) { skipped += 1; continue; }
    const values = row.values || {};
    const patch = {};
    let touched = 0;
    fields.forEach((item) => {
      if (!allowedFields.has(item.field)) return;
      const value = values[item.field];
      if (value === null || value === undefined || value === '') return;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > item.max) return;
      patch[item.field] = numeric;
      touched += 1;
    });
    if (!touched) { skipped += 1; continue; }
    const match = `scores?student_id=eq.${encodeURIComponent(row.student_id)}&subject_index=eq.${encodeURIComponent(interpretation.subject_index)}&term=eq.${encodeURIComponent(context.context.term)}&academic_session=eq.${encodeURIComponent(context.context.academic_session)}&limit=1`;
    const existing = await supabaseRest(match, {}, token);
    const review = row.existing_values || null;
    if (review) {
      fields.forEach((item) => {
        if (!Object.prototype.hasOwnProperty.call(patch, item.field)) return;
        const savedValue = existing?.[0]?.[item.field] === null || existing?.[0]?.[item.field] === undefined || existing?.[0]?.[item.field] === '' ? null : Number(existing[0][item.field]);
        const reviewed = review[item.field] === null || review[item.field] === undefined || review[item.field] === '' ? null : Number(review[item.field]);
        if (savedValue !== reviewed) fail('AI_SCORE_CONFLICT', `The saved ${item.label.toUpperCase()} score for ${row.matched_name || 'a student'} changed while you were reviewing. Read the sheet again.`, 409);
      });
    }
    const scoreBody = {
      student_id: row.student_id, class_key: classInfo.class_key, subject_index: Number(interpretation.subject_index),
      term: context.context.term, academic_session: context.context.academic_session,
      ca1: existing?.[0]?.ca1 ?? null, ca2: existing?.[0]?.ca2 ?? null, ca3: existing?.[0]?.ca3 ?? null, exam: existing?.[0]?.exam ?? null,
    };
    Object.assign(scoreBody, patch);
    if (existing?.[0]?.id) await supabaseRest(`scores?id=eq.${encodeURIComponent(existing[0].id)}`, { method: 'PATCH', body: scoreBody, prefer: 'return=representation' }, token);
    else await supabaseRest('scores', { method: 'POST', body: scoreBody, prefer: 'return=representation' }, token);
    saved += 1; savedValues += touched;
    savedRows.push({ student_id: row.student_id, values: patch });
  }
  return { saved, skipped, values_saved: savedValues, class_key: classInfo.class_key, subject_index: Number(interpretation.subject_index), fields: fields.map((item) => item.field), rows: savedRows };
}

/* One scan (one photographed page) costs 2 to 5 credits. The price follows how
 * much work the page is: a small single page is 2, a large class or a second
 * page adds a credit each, and the ceiling is 5. Failed reads are never charged. */
function scanCredits(pages, pupils) {
  const pageCount = Math.max(1, Number(pages) || 1);
  const headcount = Math.max(0, Number(pupils) || 0);
  let credits = 2;
  if (pageCount > 1) credits += 1;
  if (headcount > 40) credits += 1;
  if (headcount > 90 || pageCount > 2) credits += 1;
  return Math.min(5, credits);
}

module.exports = async function aiScoreImport(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  if (!requestOriginAllowed(req)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
  const token = bearerTokenFromRequest(req);
  if (!token) return sendJson(res, 401, { ok: false, code: 'RESULT_SESSION_REQUIRED' });
  let ledgerId = null;
  try {
    const body = await readJsonBody(req);
    const isSheetMode = body?.mode === 'sheet';
    // Score-entry scanning is for every teacher; the assistant and legacy
    // single-assessment import stay with school management.
    const { developerExcluded } = isSheetMode ? await sheetProfile(token) : await managementProfile(token);
    const context = await loadContext(token);
    if (body?.mode === 'commit') return sendJson(res, 200, Object.assign({ ok: true }, await commitScores(body, token, context)));
    if (body?.mode === 'commit_sheet') return sendJson(res, 200, Object.assign({ ok: true }, await commitSheet(body, token, context)));
    if (!API_KEY) fail('AI_PROVIDER_NOT_CONFIGURED', 'AI score scanning is not configured on the server.', 503);
    if (body?.mode === 'diag') {
      // Small admin-only check: is the key alive, and which models can it reach?
      await managementProfile(token);
      const listing = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(API_KEY)}`);
      const catalogue = await listing.json().catch(() => ({}));
      return sendJson(res, 200, {
        ok: Boolean(listing.ok),
        status: listing.status,
        configured_model: MODEL_CANDIDATES[0],
        candidates: MODEL_CANDIDATES,
        available_models: (catalogue?.models || [])
          .filter((item) => (item.supportedGenerationMethods || []).includes('generateContent'))
          .map((item) => String(item.name || '').replace(/^models\//, '')),
        error: catalogue?.error?.message || null,
      });
    }
    const instruction = String(body?.instruction || '').trim();
    if (!instruction || instruction.length > 500) fail('AI_SCORE_INSTRUCTION_INVALID', 'Write a short instruction such as “GSS1, English Language, First CA.”');
    if (!body?.image_base64 || !body?.mime_type) fail('AI_SCORE_IMAGE_REQUIRED', 'Snap or upload the score sheet first.');
    if (String(body.image_base64).length > 8_000_000) fail('AI_IMAGE_TOO_LARGE', 'Image is too large.');
    const catalog = catalogFromConfig(context.config);
    const roster = context.roster.map((student) => ({ name: student.name, class_key: student.class_key }));
    const sheetClassRoster = body?.class_key
      ? context.roster.filter((student) => student.class_key === body.class_key).map((student) => student.name).slice(0, 400).join(', ')
      : '';
    const sheetCategoryValue = sheetCategory(body?.target_field, body?.category);
    const sheetCaFieldValue = sheetCaField(body?.target_field);
    const sheetTermBlock = /^([123])(st|nd|rd) term$/i.test(String(body?.term_block || '').trim())
      ? String(body.term_block).trim()
      : String(context.context.term || '').trim();
    const prompt = isSheetMode
      ? sheetPrompt(instruction, sheetFields(assessmentMarks(context.config)), sheetClassRoster, context.context, sheetCategoryValue, sheetCaFieldValue, sheetTermBlock)
      : ['You extract school score sheets. Return JSON only; no markdown.', 'Use the typed instruction and any document header. Do not invent scores. Preserve unclear scores as null and mark them unclear.', 'Interpretation must contain class_key, subject_name, assessment_field (ca1, ca2, ca3, or exam), max_score, confidence. Rows must contain student_name, score (number or null), status, confidence, reason.', 'If a class, subject, or assessment is missing, leave that interpretation value null and return rows only when safely readable.', `Typed instruction: ${instruction}`, `Current term/session: ${context.context.term || 'unknown'} / ${context.context.academic_session || 'unknown'}`, `Configured classes and subjects: ${JSON.stringify(catalog)}`, `Current roster: ${JSON.stringify(roster).slice(0, 100000)}`].join('\n');
    const idempotency = String(body?.idempotency_key || `score-import-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 120);
    // Price the job before the call: the class roster tells us how big the page is.
    const classHeadcount = body?.class_key
      ? context.roster.filter((student) => student.class_key === body.class_key).length
      : context.roster.length;
    // A scan is priced from the class size and how many pages are being read, so a
    // big class or a multi-page book costs more per page; 2 is the floor, 5 the cap.
    const pagesInScan = Math.max(1, Math.min(10, Number(body?.page_total) || 1));
    const estimatedCredits = isSheetMode ? scanCredits(pagesInScan, classHeadcount) : 2;
    if (!developerExcluded) {
      const reserve = await supabaseRpc('ai_reserve_credits', { p_operation: 'ocr_scores', p_model: MODEL, p_idempotency_key: idempotency, p_estimated_credits: estimatedCredits }, token);
      if (!reserve?.ok) return sendJson(res, reserve?.code === 'AI_CREDITS_EXHAUSTED' ? 402 : 400, reserve);
      if (reserve.replayed) return sendJson(res, 200, { ok: true, replayed: true, ledger_id: reserve.ledger_id });
      ledgerId = reserve.ledger_id;
    }
    let upstream; let data = {}; let usedModel = MODEL_CANDIDATES[0];
    // Each model gets two tries: a provider hiccup should not cost the teacher a scan.
    for (const model of MODEL_CANDIDATES) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: body.mime_type, data: body.image_base64 } }] }], generationConfig: { temperature: 0, maxOutputTokens: isSheetMode ? 8192 : 4096 } }) });
        data = await upstream.json().catch(() => ({}));
        if (upstream.ok && !data.error) { usedModel = model; break; }
        console.log(JSON.stringify({ event: 'ai_model_retry', model, attempt, status: upstream.status, error: data?.error?.message || null }));
        // A retired model will never work; move on immediately.
        if (/no longer available|not found|invalid/i.test(String(data?.error?.message || ''))) break;
      }
      if (upstream.ok && !data.error) break;
    }
    const usage = data.usageMetadata || {}; const inputTokens = Number(usage.promptTokenCount || 0); const outputTokens = Number(usage.candidatesTokenCount || 0);
    if (!upstream.ok || data.error) { if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'failed', p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_billable_tokens: inputTokens + outputTokens, p_credits_charged: 0, p_error_code: 'GEMINI_REQUEST_FAILED' }, token); return sendJson(res, 502, { ok: false, code: 'AI_PROVIDER_REQUEST_FAILED', message: data.error?.message || 'AI provider request failed.' }); }
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const parsed = parseModelJson(text);
    const draft = isSheetMode
      ? validateSheetDraft(parsed, context, { class_key: body?.class_key, subject_index: body?.subject_index, image_blank: body?.image_blank === true, category: sheetCategoryValue, target_field: body?.target_field, term_block: sheetTermBlock })
      : validateDraft(parsed, context);
    draft.context = { academic_session: context.context.academic_session || null, term: context.context.term || null };
    if (isSheetMode) await attachExistingSheetScores(draft, token);
    else await attachExistingScores(draft, token);
    const chargedCredits = estimatedCredits;
    if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'succeeded', p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_billable_tokens: inputTokens + outputTokens, p_credits_charged: chargedCredits }, token);
    return sendJson(res, 200, { ok: true, draft, ledger_id: ledgerId, usage: { model: usedModel, input_tokens: inputTokens, output_tokens: outputTokens, credits_charged: developerExcluded ? 0 : chargedCredits, credits_min: 2, credits_max: 5, developer_usage_excluded: developerExcluded } });
  } catch (error) {
    if (ledgerId) await supabaseRpc('ai_settle_credits', { p_ledger_id: ledgerId, p_status: 'failed', p_input_tokens: 0, p_output_tokens: 0, p_billable_tokens: 0, p_credits_charged: 0, p_error_code: String(error.code || 'AI_SCORE_IMPORT_FAILED').slice(0, 64) }, token).catch(() => {});
    return sendJson(res, error.status || 500, { ok: false, code: error.code || error.payload?.code || 'AI_SCORE_IMPORT_FAILED', message: error.message || 'AI score import failed.' });
  }
};
