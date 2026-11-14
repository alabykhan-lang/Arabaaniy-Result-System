'use strict';

// Intent-level school operations for the Command Center assistant.
//
// Every function here is a verb a school operator would say, not a screen.
// Reads and previews never write. Reversible writes go through one audited
// database path (public.school_record_scores / school_correct_score), carry a
// batch id, and can be reversed with school_undo_batch. Consequential acts
// return needs_confirmation with exactly what changes.
//
// The module never reads a template, class, term or component from a global
// browser setting during generation: those are arguments.

const crypto = require('node:crypto');
const { supabaseRest } = require('./_lib');
const { opsRpc } = require('./_ops');
const { findClass, findColumn, findTerm, normalise } = require('./_ops-instruction');
const { similarity } = require('./_ops-match');
const { renderBroadsheet, renderCards } = require('./_ops-documents');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPONENTS = new Set(['ca1', 'ca2', 'ca3', 'exam']);
const COMPONENT_LABEL = { ca1: 'CA 1', ca2: 'CA 2', ca3: 'CA 3', exam: 'Exam' };
const NAME_PREFIXES = new Set([
  'mr', 'mrs', 'miss', 'ms', 'master', 'mistress', 'alhaji', 'alhaja', 'hajia', 'haji',
  'imam', 'pastor', 'rev', 'revd', 'dr', 'prof', 'chief', 'engr', 'barr', 'sir', 'madam',
]);
const TOKEN_VARIANTS = {
  aishat: 'aisha', aishah: 'aisha', aysha: 'aisha', aisat: 'aisha', aisha: 'aisha',
  rokeeb: 'rakib', rokib: 'rakib', raqeeb: 'rakib', rakib: 'rakib',
  hammed: 'hamid', hameed: 'hamid', hamid: 'hamid', hamed: 'hamid',
  mohammed: 'muhammad', mohamed: 'muhammad', muhammed: 'muhammad', muhammad: 'muhammad', moh: 'muhammad',
  ibraheem: 'ibrahim', ibrahim: 'ibrahim',
  yusuff: 'yusuf', yusup: 'yusuf', yusuf: 'yusuf',
  abdul: 'abdul', abd: 'abdul', abdur: 'abdul', abdu: 'abdul',
  folasade: 'folasade', folashade: 'folasade',
  oluwafemi: 'olufemi', olufemi: 'olufemi',
  oluwaseun: 'oluwaseun', seun: 'oluwaseun',
  oluwasegun: 'oluwasegun', segun: 'oluwasegun',
  temitope: 'temitope', tope: 'temitope',
  chukwuemeka: 'emeka', emeka: 'emeka',
  ngozi: 'ngozi', ngosi: 'ngozi',
  fatima: 'fatima', fadeela: 'fadila', fadila: 'fadila',
  khadeejah: 'khadija', khadijah: 'khadija', khadija: 'khadija',
  sulaiman: 'sulaiman', sulaimon: 'sulaiman', suleiman: 'sulaiman',
  ismail: 'ismail', ismaeel: 'ismail', ismael: 'ismail',
  habib: 'habib', habeeb: 'habib',
  rahman: 'rahman', rahman: 'rahman', ramon: 'rahman',
};
const STOPWORDS = new Set(['and', 'of', 'the', 'bin', 'binti', 'ibn']);

function clean(value, max = 400) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function requestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normaliseName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nameTokens(value) {
  return normaliseName(value)
    .split(' ')
    // A sheet line often carries its number and mark beside the name. They are
    // not part of the name and must never make a perfect match look uncertain.
    .filter((token) => token && !/^\d+$/.test(token))
    .map((token) => TOKEN_VARIANTS[token] || token)
    .filter((token) => token && !STOPWORDS.has(token));
}

function nameKey(value) {
  return nameTokens(value).join(' ');
}

function stripNamePrefix(value) {
  const tokens = normaliseName(value).split(' ').filter(Boolean);
  while (tokens.length > 1 && NAME_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

function soundex(token) {
  const value = String(token || '').toUpperCase();
  if (!value) return '';
  const map = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };
  const first = value[0];
  let last = map[first] || '';
  let code = first;
  for (let i = 1; i < value.length && code.length < 4; i += 1) {
    const digit = map[value[i]] || '';
    if (digit && digit !== last) code += digit;
    last = digit;
  }
  return code.padEnd(4, '0');
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function textSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  return Math.max(0, 1 - editDistance(left, right) / Math.max(left.length, right.length));
}

function tokenSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) {
    const initial = a.length === 1 ? a : b;
    const full = a.length === 1 ? b : a;
    return full.startsWith(initial) ? 0.8 : 0;
  }
  let score = textSimilarity(a, b);
  if (a.length >= 3 && b.length >= 3 && soundex(a) === soundex(b)) score = Math.max(score, 0.9);
  // A dropped vowel or doubled consonant is common in Yoruba spelling.
  if (a.replace(/h/g, '') === b.replace(/h/g, '')) score = Math.max(score, 0.94);
  return score;
}

function nameScore(candidate, target) {
  const aTokens = nameTokens(candidate);
  const bTokens = nameTokens(target);
  if (!aTokens.length || !bTokens.length) return 0;
  // Token order is irrelevant. Surname-first and given-name-first are the same
  // learner, and so is an exact spelling in a different order.
  const aKey = [...aTokens].sort().join(' ');
  const bKey = [...bTokens].sort().join(' ');
  if (aKey === bKey) return 1;

  // The reader's measure: 0.5 token overlap (Jaccard), 0.3 edit distance on the
  // joined name, 0.2 phonetic agreement. One name written with an extra middle
  // name is still the same learner, so a complete token superset is settled.
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const intersection = [...aSet].filter((token) => bSet.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = union ? intersection / union : 0;
  const edit = textSimilarity(aKey, bKey);

  const shorter = aTokens.length <= bTokens.length ? aTokens : bTokens;
  const longer = aTokens.length <= bTokens.length ? bTokens : aTokens;
  const bestFor = (token, pool) => pool.reduce((best, other) => Math.max(best, tokenSimilarity(token, other)), 0);
  const phonetic = shorter.length
    ? shorter.reduce((sum, token) => {
      const exactSound = longer.some((other) => soundex(token) === soundex(other));
      return sum + (exactSound ? 1 : bestFor(token, longer) >= 0.7 ? 0.6 : 0);
    }, 0) / shorter.length
    : 0;
  let score = 0.5 * jaccard + 0.3 * edit + 0.2 * phonetic;

  const shorterCoverage = shorter.length
    ? shorter.reduce((sum, token) => sum + bestFor(token, longer), 0) / shorter.length
    : 0;
  if (shorter.length >= 2 && shorterCoverage >= 0.9) {
    score = Math.max(0.97, score);
  }
  return Math.min(1, score);
}

function bandFor(confidence) {
  if (confidence >= 0.9) return 'accept';
  if (confidence >= 0.6) return 'ask';
  return 'hold';
}

function classLabel(context, key) {
  return (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === key)?.label || key;
}

function classEntry(context, keyOrLabel) {
  const raw = clean(keyOrLabel, 80);
  if (!raw) return null;
  const classes = Array.isArray(context?.classes) ? context.classes : [];
  const want = normalise(raw);
  const exact = classes.find((c) => normalise(c.key) === want || normalise(c.label) === want);
  if (exact) return exact;
  return findClass(raw, { ...(context || {}), classes }) || null;
}

function subjectEntries(config, classKey) {
  const raw = config?.depts?.[classKey]?.subjects;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        index,
        label: clean(item.label || item.name || item.subject || `Subject ${index + 1}`, 120),
        active: item.active !== false && item.hidden !== true,
      };
    }
    return { index, label: clean(item, 120), active: true };
  }).filter((item) => item.label);
}

function subjectAliasesFor(config, classKey) {
  const aliases = config?.subjectAliases || config?.subject_aliases;
  return aliases && typeof aliases === 'object' && aliases[classKey] && typeof aliases[classKey] === 'object'
    ? aliases[classKey]
    : {};
}

function subjectLabel(config, classKey, index) {
  return subjectEntries(config, classKey).find((s) => s.index === Number(index))?.label || `Subject ${Number(index) + 1}`;
}

async function loadConfig(ctx) {
  const rows = await supabaseRest('app_config?id=eq.1&select=config&limit=1', {}, ctx.token);
  return rows?.[0]?.config || {};
}

async function loadContextRows(ctx) {
  const rows = await supabaseRest('academic_context?id=eq.1&select=academic_session,term,class_key,term_status&limit=1', {}, ctx.token);
  return rows?.[0] || {};
}

async function loadStudents(ctx, session, classKey = null) {
  const scope = classKey ? `&class_key=eq.${encodeURIComponent(classKey)}` : '';
  const rows = await supabaseRest(
    `students?archived=eq.false${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}${scope}&select=id,name,class_key,admno,gender,age,photo&order=name.asc&limit=20000`,
    {},
    ctx.token,
  );
  return rows || [];
}

async function loadScores(ctx, session, term, classKey = null, subjectIndex = null) {
  const scope = classKey ? `&class_key=eq.${encodeURIComponent(classKey)}` : '';
  const subject = subjectIndex == null ? '' : `&subject_index=eq.${encodeURIComponent(subjectIndex)}`;
  const rows = await supabaseRest(
    `scores?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}${scope}${subject}&select=id,student_id,class_key,subject_index,ca1,ca2,ca3,exam&limit=50000`,
    {},
    ctx.token,
  );
  return rows || [];
}

async function loadRemarks(ctx, session, term, classKey) {
  const rows = await supabaseRest(
    `remarks?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&class_key=eq.${encodeURIComponent(classKey)}&select=student_id,academic,form_master,principal,days_opened,days_present&limit=5000`,
    {},
    ctx.token,
  ).catch(() => []);
  return rows || [];
}

// Affective and psychomotor ratings are printed on the card exactly as the
// school entered them, so a pupil with none just keeps blank rows.
async function loadTraits(ctx, session, term, classKey) {
  const rows = await supabaseRest(
    `traits?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&class_key=eq.${encodeURIComponent(classKey)}&select=student_id,trait_type,trait_name,rating&limit=5000`,
    {},
    ctx.token,
  ).catch(() => []);
  return rows || [];
}

async function loadNameAliases(ctx) {
  const rows = await opsRpc('school_name_aliases', { p_school_id: ctx.actor.school_id });
  return Array.isArray(rows) ? rows : [];
}

async function loadSubjectAliases(ctx, classKey = null) {
  const rows = await opsRpc('school_subject_aliases', {
    p_school_id: ctx.actor.school_id,
    p_class_key: classKey,
  });
  return Array.isArray(rows) ? rows : [];
}

function scoreMap(scores) {
  const map = new Map();
  for (const row of scores || []) {
    map.set(`${row.student_id}|${Number(row.subject_index)}`, row);
  }
  return map;
}

function scoreValue(row, component) {
  if (!row) return null;
  const value = row[component];
  return value == null || value === '' ? null : Number(value);
}

function subjectTotal(row) {
  if (!row) return null;
  const values = [row.ca1, row.ca2, row.ca3, row.exam].filter((v) => v != null && v !== '').map(Number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function requiredComponents(config) {
  const caCount = Math.max(1, Math.min(3, Number(config?.assessment?.caCount) || 1));
  const list = [];
  for (let i = 1; i <= caCount; i += 1) list.push(`ca${i}`);
  list.push('exam');
  return list;
}

function componentMax(config, component) {
  const assessment = config?.assessment || {};
  if (component === 'exam') return Number(assessment.examMark || 100);
  const index = Number(String(component).replace('ca', '')) - 1;
  const marks = Array.isArray(assessment.caMarks) ? assessment.caMarks : [];
  return Number(marks[index] || 100);
}

function resolveComponent(config, args) {
  const explicit = clean(args.component, 12).toLowerCase();
  if (COMPONENTS.has(explicit)) return { component: explicit };
  const column = clean(args.column, 40);
  const found = column ? findColumn(column) : null;
  if (found && /exam/i.test(found)) return { component: 'exam' };
  if (found && /class exercise|^ca$/i.test(found)) {
    const caCount = Math.max(1, Math.min(3, Number(config?.assessment?.caCount) || 1));
    if (caCount === 1) return { component: 'ca1' };
    return {
      error: 'This school has more than one class exercise. Which one is on the sheet?',
      choices: Array.from({ length: caCount }, (_, i) => `ca${i + 1}`),
      next: `Call record_scores again with component "${'ca1'}" or the CA number the sheet shows.`,
    };
  }
  if (clean(args.column, 40)) {
    return {
      error: `I could not tell which column "${clean(args.column, 40)}" is.`,
      choices: ['ca1', 'ca2', 'ca3', 'exam'],
      next: 'Call record_scores with component "ca1", "ca2", "ca3" or "exam".',
    };
  }
  // No column at all: the school's default column is the first class exercise.
  const caCount = Math.max(1, Math.min(3, Number(config?.assessment?.caCount) || 1));
  return { component: caCount === 1 ? 'ca1' : 'ca1', defaulted: true };
}

function resolveTerm(args, context) {
  return clean(args.term, 30) || findTerm(clean(args.term, 60), context?.term) || context?.term || '1st Term';
}

function resolveSession(args, context) {
  return clean(args.session || args.academic_session, 30) || context?.academic_session || '';
}

// ---------------------------------------------------------------------------
// Subject resolution: stored index first, aliases second, fuzzy last.
// ---------------------------------------------------------------------------
function subjectFuzzy(entries, name) {
  const want = normalise(name);
  if (!want) return [];
  const compact = want.replace(/\s+/g, '');
  return entries.map((entry) => {
    const label = normalise(entry.label);
    const labelCompact = label.replace(/\s+/g, '');
    const initials = label.split(' ').filter(Boolean).map((word) => word[0]).join('');
    let score = textSimilarity(want, label);
    if (want === label) score = 1;
    else if (compact === labelCompact) score = 0.98;
    else if (initials.length >= 2 && compact === initials) score = 0.96;
    else if (initials.length >= 2 && compact.startsWith(initials)) score = Math.max(score, 0.8);
    else {
      const wantTokens = want.split(' ');
      const labelTokens = label.split(' ');
      const matched = wantTokens.filter((token) => labelTokens.some((other) => tokenSimilarity(token, other) >= 0.82)).length;
      if (matched) score = Math.max(score, matched / Math.max(wantTokens.length, labelTokens.length));
    }
    return { ...entry, confidence: Math.min(1, score) };
  }).filter((entry) => entry.confidence >= 0.55)
    .sort((a, b) => b.confidence - a.confidence);
}

async function resolveSubjectFor(ctx, config, context, classKey, name) {
  const entries = subjectEntries(config, classKey);
  if (!entries.length) {
    return {
      ok: false,
      code: 'SCHOOL_SUBJECTS_EMPTY',
      error: 'That class has no subjects in the catalog.',
      next: 'Call update_subject_catalog to add a subject, or get_school_snapshot to choose a class that has subjects.',
    };
  }
  const raw = clean(name, 120);
  const want = normalise(raw);
  const aliases = subjectAliasesFor(config, classKey);
  const stored = await loadSubjectAliases(ctx, classKey);
  if (want) {
    const aliasHit = stored.find((row) => row.alias_norm === want || row.alias_norm === want.replace(/\s+/g, ''));
    if (aliasHit) {
      const entry = entries.find((item) => item.index === Number(aliasHit.subject_index));
      if (entry) {
        return { ok: true, ...entry, confidence: 1, method: 'alias', alternatives: [] };
      }
    }
    const exact = entries.find((entry) => normalise(entry.label) === want);
    if (exact) return { ok: true, ...exact, confidence: 1, method: 'exact', alternatives: [] };
    const configAlias = Object.keys(aliases).find((key) => normalise(key) === want);
    if (configAlias != null) {
      const index = Number(aliases[configAlias]);
      const entry = entries.find((item) => item.index === index);
      if (entry) return { ok: true, ...entry, confidence: 0.99, method: 'alias', alternatives: [] };
    }
  }
  const scored = subjectFuzzy(entries, raw);
  if (!scored.length) {
    return {
      ok: false,
      code: 'SCHOOL_SUBJECT_NOT_FOUND',
      error: `There is no subject called "${raw}" in ${classLabel(context, classKey)}.`,
      catalog: entries.map(({ index, label, active }) => ({ index, label, active })),
      next: 'Call resolve_subject with one of the catalog names, or update_subject_catalog to add the real subject.',
    };
  }
  const best = scored[0];
  const alternatives = scored.slice(1, 4).map(({ index, label, confidence }) => ({ index, label, confidence: Number(confidence.toFixed(2)) }));
  if (best.confidence >= 0.9) {
    return { ok: true, index: best.index, label: best.label, active: best.active, confidence: Number(best.confidence.toFixed(2)), method: 'fuzzy', alternatives };
  }
  return {
    ok: false,
    code: 'SCHOOL_SUBJECT_AMBIGUOUS',
    error: `Is the subject ${best.label}${alternatives[0] ? ` or ${alternatives[0].label}` : ''}?`,
    best: { index: best.index, label: best.label, confidence: Number(best.confidence.toFixed(2)) },
    alternatives,
    next: 'Ask once, then call resolve_subject with the chosen name and remember it with remember_subject_alias.',
  };
}

// ---------------------------------------------------------------------------
// Student resolution: normalise, reorder, variants, phonetics, aliases.
// ---------------------------------------------------------------------------
function resolveOneName(roster, aliases, rawName, options = {}) {
  const raw = stripNamePrefix(rawName);
  const norm = nameKey(raw) || normaliseName(raw);
  if (!norm) return { name: rawName, band: 'hold', confidence: 0, candidates: [], reason: 'empty name' };
  const alias = aliases.find((item) => item.alias_norm === norm
    || item.alias_norm === normaliseName(raw)
    || nameKey(item.alias_norm) === norm);
  if (alias) {
    const hit = roster.find((student) => student.id === alias.student_id);
    if (hit) {
      return {
        name: rawName, normalised: norm, band: 'accept', confidence: 1, method: 'alias',
        student: describeStudent(hit), candidates: [], exact: true,
      };
    }
  }

  const scored = roster.map((student) => ({
    student,
    confidence: nameScore(student.name, raw),
  })).sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  if (!best || best.confidence < 0.45) {
    return {
      name: rawName, normalised: norm, band: 'hold', confidence: best ? Number(best.confidence.toFixed(2)) : 0,
      method: 'none', candidates: scored.slice(0, 4).map(candidateView), reason: 'no close name',
    };
  }
  const close = scored.filter((item) => item.confidence >= best.confidence - 0.04);
  const confidence = Number(best.confidence.toFixed(3));
  // A name already written exactly is settled. A fuzzy near-perfect name is
  // settled too, unless the class holds two pupils whose own names are almost
  // the same (AWWAL and AWWAL O). Then only the exact spelling is safe.
  const exactKey = nameKey(best.student.name) === norm;
  const twin = scored[1] && nameScore(scored[1].student.name, best.student.name) >= 0.97;
  const settled = exactKey || (confidence >= 0.97 && !twin);
  let band = settled ? 'accept' : bandFor(confidence);
  if (!settled && close.length > 1 && confidence >= 0.9) band = 'ask';
  return {
    name: rawName, normalised: norm, band, confidence: Number(confidence.toFixed(2)),
    method: 'name', student: band === 'accept' ? describeStudent(best.student) : null,
    best: describeStudent(best.student),
    candidates: scored.slice(0, 5).map(candidateView),
    exact: Boolean(settled),
    reason: band === 'ask' ? 'more than one close name' : (band === 'hold' ? 'no confident match' : null),
  };
}

function describeStudent(student) {
  return {
    student_id: student.id,
    name: student.name,
    class_key: student.class_key,
    class: student.class_label || student.class_key,
    admno: student.admno || null,
  };
}

function candidateView(item) {
  return {
    ...describeStudent(item.student),
    confidence: Number(item.confidence.toFixed(2)),
    band: bandFor(item.confidence),
  };
}

// ---------------------------------------------------------------------------
// get_school_snapshot
// ---------------------------------------------------------------------------
async function getSchoolSnapshot(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const classes = Array.isArray(active.classes) && active.classes.length
    ? active.classes
    : Object.keys(config.depts || {}).map((key) => ({ key, label: config.depts[key]?.label || key, subjects: config.depts[key]?.subjects || [] }));
  const focus = clean(args.class, 80) ? classEntry({ classes }, args.class) : null;
  if (clean(args.class, 80) && !focus) {
    return { error: `There is no class called "${clean(args.class, 80)}".`, classes: classes.map((c) => c.label), next: 'Call get_school_snapshot again with one of those class names.' };
  }

  const [students, scores, published] = await Promise.all([
    loadStudents(ctx, session, focus?.key || null),
    loadScores(ctx, session, term, focus?.key || null),
    supabaseRest(
      `published_subjects?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}${focus ? `&class_key=eq.${encodeURIComponent(focus.key)}` : ''}&select=class_key,subject_index,published&limit=2000`,
      {}, ctx.token,
    ).catch(() => []),
  ]);
  const scoreByCell = scoreMap(scores);
  const publishedSet = new Set((published || []).filter((row) => row.published !== false).map((row) => `${row.class_key}|${row.subject_index}`));
  const required = requiredComponents(config);
  const byClass = new Map();
  for (const student of students) {
    if (!byClass.has(student.class_key)) byClass.set(student.class_key, []);
    byClass.get(student.class_key).push(student);
  }

  const matrix = [];
  for (const cls of classes) {
    if (focus && cls.key !== focus.key) continue;
    const roster = byClass.get(cls.key) || [];
    const subjects = subjectEntries(config, cls.key);
    for (const subject of subjects) {
      let withAny = 0;
      let full = 0;
      for (const student of roster) {
        const row = scoreByCell.get(`${student.id}|${subject.index}`);
        if (!row) continue;
        if ([row.ca1, row.ca2, row.ca3, row.exam].some((value) => value != null)) withAny += 1;
        if (required.every((component) => scoreValue(row, component) != null)) full += 1;
      }
      matrix.push({
        class_key: cls.key,
        class: cls.label,
        subject_index: subject.index,
        subject: subject.label,
        active: subject.active,
        roster: roster.length,
        with_any: withAny,
        complete: full,
        status: !withAny ? 'not_started' : full >= roster.length && roster.length > 0 ? 'complete' : 'partial',
        published: publishedSet.has(`${cls.key}|${subject.index}`),
      });
    }
  }

  const batches = await opsRpc('school_batches', { p_school_id: ctx.actor.school_id, p_limit: 5 }).catch(() => []);
  const missingCells = matrix.filter((row) => row.status !== 'complete');
  const approval = focus
    ? await opsRpc('school_result_approval', {
      p_school_id: ctx.actor.school_id,
      p_class_key: focus.key,
      p_term: term,
      p_academic_session: session,
    }).catch(() => null)
    : null;

  return {
    session,
    term,
    term_status: active.term_status || 'open',
    school: config.school || null,
    card_templates: ['modern', 'classic', 'compact', 'premium'],
    assessment: config.assessment || { caCount: 1, caMarks: [30], examMark: 70 },
    grade_scale: config.gradeScale || [],
    classes: classes.filter((cls) => !focus || cls.key === focus.key).map((cls) => ({
      key: cls.key,
      label: cls.label,
      pupils: (byClass.get(cls.key) || []).length,
      subjects: subjectEntries(config, cls.key).map(({ index, label, active: isActive }) => ({ index, label, active: isActive })),
      roster: focus ? (byClass.get(cls.key) || []).map(describeStudent) : undefined,
    })),
    completeness_matrix: matrix,
    missing_summary: {
      subjects_not_started: missingCells.filter((row) => row.status === 'not_started').length,
      subjects_partial: missingCells.filter((row) => row.status === 'partial').length,
      classes: [...new Set(missingCells.map((row) => row.class))],
    },
    approval,
    recent_batches: batches,
    pending: {
      pages_waiting: 0,
      batches_to_check: Array.isArray(batches) ? batches.filter((batch) => batch.status === 'committed').length : 0,
    },
    next: 'For a question about one class, call completeness_report or rank_students with that class.',
  };
}

// ---------------------------------------------------------------------------
// resolve_students / resolve_subject
// ---------------------------------------------------------------------------
async function resolveStudents(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const classRaw = clean(args.class, 80);
  const cls = classRaw ? classEntry({ ...active, classes: (active.classes || []) }, classRaw) : null;
  if (classRaw && !cls) {
    return {
      error: `There is no class called "${classRaw}".`,
      classes: Object.values(config.depts || {}).map((dept) => dept.label),
      next: 'Call resolve_students again with one of the real class names.',
    };
  }
  const names = Array.isArray(args.names) ? args.names.map((name) => clean(name, 120)).filter(Boolean) : [];
  if (!names.length) {
    return { error: 'Give the names written on the sheet.', next: 'Call resolve_students with names: ["...", "..."] and the class.' };
  }
  const session = resolveSession(args, active);
  const allRoster = await loadStudents(ctx, session, cls?.key || null);
  const roster = allRoster.map((student) => ({ ...student, class_label: classLabel({ classes: active.classes }, student.class_key) }));
  const aliases = await loadNameAliases(ctx);
  const scopedAliases = aliases.filter((alias) => !cls || alias.class_key === cls.key);
  const resolved = names.map((name) => {
    const hit = resolveOneName(roster, scopedAliases, name);
    if (hit.student && hit.student.class_key !== cls?.key && cls) {
      hit.band = 'ask';
      hit.student = null;
      hit.reason = 'that name is in another class';
    }
    return hit;
  });
  const accepted = resolved.filter((item) => item.band === 'accept');
  const seen = new Map();
  for (const item of accepted) {
    const id = item.student.student_id;
    if (seen.has(id)) item.band = 'ask', item.reason = 'two sheet lines name one pupil', item.duplicate = true;
    else seen.set(id, item);
  }
  return {
    class_key: cls?.key || null,
    class: cls?.label || 'whole school',
    count: resolved.length,
    accepted: resolved.filter((item) => item.band === 'accept').length,
    ask: resolved.filter((item) => item.band === 'ask').length,
    hold: resolved.filter((item) => item.band === 'hold').length,
    results: resolved,
    next: 'Accept every 0.90+ name and write it. Ask once only for 0.60–0.90 names where two different pupils are close, and hold anything below 0.60.',
  };
}

async function resolveSubject(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const cls = classEntry(active, args.class);
  if (!cls) {
    return {
      error: `There is no class called "${clean(args.class, 80)}".`,
      classes: Object.values(config.depts || {}).map((dept) => dept.label),
      next: 'Call resolve_subject again with a real class name.',
    };
  }
  const found = await resolveSubjectFor(ctx, config, active, cls.key, args.subject || args.name);
  if (found.ok) {
    return {
      class_key: cls.key,
      class: cls.label,
      ...found,
      next: `Use subject_index ${found.index}. If the school calls it something else, remember_subject_alias will stop the question next time.`,
    };
  }
  return { class_key: cls.key, class: cls.label, ...found };
}

// ---------------------------------------------------------------------------
// get_scores
// ---------------------------------------------------------------------------
async function getScores(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const cls = clean(args.class, 80) ? classEntry(active, args.class) : null;
  if (clean(args.class, 80) && !cls) {
    return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot to see the class list.' };
  }
  let subjectIndex = null;
  let subjectName = null;
  if (clean(args.subject, 120)) {
    if (!cls) {
      return { error: 'A subject needs a class, because each class has its own catalog.', next: 'Call get_scores again with the class and subject.' };
    }
    const subject = await resolveSubjectFor(ctx, config, active, cls.key, args.subject);
    if (!subject.ok) return subject;
    subjectIndex = subject.index;
    subjectName = subject.label;
  }
  const component = clean(args.component, 12).toLowerCase();
  if (component && !COMPONENTS.has(component)) {
    return { error: 'The component must be ca1, ca2, ca3 or exam.', next: 'Call get_scores with one of those components, or leave it out for all.' };
  }

  const [students, scores] = await Promise.all([
    loadStudents(ctx, session, cls?.key || null),
    loadScores(ctx, session, term, cls?.key || null, subjectIndex),
  ]);
  const byId = new Map(students.map((student) => [student.id, student]));
  let rows = scores.map((row) => ({
    student_id: row.student_id,
    name: byId.get(row.student_id)?.name || null,
    class_key: row.class_key,
    class: classLabel(active, row.class_key),
    subject_index: Number(row.subject_index),
    subject: subjectLabel(config, row.class_key, row.subject_index),
    ca1: scoreValue(row, 'ca1'), ca2: scoreValue(row, 'ca2'), ca3: scoreValue(row, 'ca3'), exam: scoreValue(row, 'exam'),
    total: subjectTotal(row),
  }));
  if (component) {
    rows = rows.filter((row) => row[component] != null).map((row) => ({
      ...row, value: row[component], component,
    }));
  }
  if (clean(args.student, 120) || clean(args.student_id, 60)) {
    const studentRow = clean(args.student_id, 60)
      ? students.find((student) => student.id === clean(args.student_id, 60))
      : resolveOneName(students, [], args.student).student;
    const target = studentRow?.student_id || studentRow?.id;
    if (!target) return { error: `I could not find "${clean(args.student || args.student_id, 120)}" in that class.`, next: 'Call resolve_students with the name to see the close matches.' };
    rows = rows.filter((row) => row.student_id === target);
  }
  const ordered = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || a.subject_index - b.subject_index);
  return {
    session, term,
    class_key: cls?.key || null,
    class: cls?.label || 'school',
    subject_index: subjectIndex,
    subject: subjectName,
    component: component || null,
    count: ordered.length,
    rows: ordered.slice(0, 400),
    truncated: ordered.length > 400,
    next: ordered.length ? 'Use correct_score to change one value, or record_scores to fill a sheet.' : 'No saved marks for that filter. Use record_scores to add them.',
  };
}

// ---------------------------------------------------------------------------
// completeness_report
// ---------------------------------------------------------------------------
async function completenessReport(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const classRaw = clean(args.class, 80);
  const cls = classRaw ? classEntry(active, classRaw) : null;
  if (classRaw && !cls) {
    return { error: `There is no class called "${classRaw}".`, classes: Object.values(config.depts || {}).map((dept) => dept.label), next: 'Call completeness_report with one of the real class names.' };
  }
  const includeStudents = args.include_students === true;
  const section = clean(args.section, 30).toLowerCase();
  const classKeys = cls ? [cls.key] : Object.keys(config.depts || {}).filter((key) => {
    if (!section) return true;
    const label = normalise(config.depts[key]?.label || key);
    if (section === 'senior') return /(^|\s)(ss|jss)\s*[1-3]/.test(label) || label.startsWith('ss');
    if (section === 'junior') return label.startsWith('jss');
    if (['primary', 'nursery', 'creche', 'kg'].includes(section)) return label.includes(section);
    return label.includes(section);
  });
  if (!classKeys.length) {
    return {
      section: section || null,
      classes: [],
      message: section ? `There are no ${section} classes in the catalog.` : 'No classes match.',
      catalog: Object.values(config.depts || {}).map((dept) => dept.label),
      next: 'Call get_school_snapshot to see the real class list.',
    };
  }
  const [students, scores] = await Promise.all([
    loadStudents(ctx, session, cls?.key || null),
    loadScores(ctx, session, term, cls?.key || null),
  ]);
  const scoreByCell = scoreMap(scores);
  const required = requiredComponents(config);
  const rosterByClass = new Map();
  for (const student of students) {
    if (!rosterByClass.has(student.class_key)) rosterByClass.set(student.class_key, []);
    rosterByClass.get(student.class_key).push(student);
  }
  const report = [];
  for (const classKey of classKeys) {
    const roster = rosterByClass.get(classKey) || [];
    const subjects = subjectEntries(config, classKey);
    const subjectsOut = [];
    for (const subject of subjects) {
      const missing = [];
      let withAny = 0;
      let full = 0;
      for (const student of roster) {
        const row = scoreByCell.get(`${student.id}|${subject.index}`);
        const any = row && [row.ca1, row.ca2, row.ca3, row.exam].some((value) => value != null);
        const complete = row && required.every((item) => scoreValue(row, item) != null);
        if (any) withAny += 1;
        if (complete) full += 1;
        if (!complete) missing.push(student.name);
      }
      subjectsOut.push({
        subject_index: subject.index,
        subject: subject.label,
        active: subject.active,
        roster: roster.length,
        with_any: withAny,
        complete: full,
        status: !withAny ? 'not_started' : full >= roster.length && roster.length > 0 ? 'complete' : 'partial',
        missing_count: missing.length,
        missing_students: includeStudents ? missing.slice(0, 60) : undefined,
      });
    }
    const missingSubjects = subjectsOut.filter((subject) => subject.status !== 'complete');
    report.push({
      class_key: classKey,
      class: config.depts?.[classKey]?.label || classKey,
      section:
        /(^|\s)ss\s*[1-3]/.test(normalise(config.depts?.[classKey]?.label || '')) ? 'senior'
          : /(^|\s)jss\s*[1-3]/.test(normalise(config.depts?.[classKey]?.label || '')) ? 'junior'
            : /primary/.test(normalise(config.depts?.[classKey]?.label || '')) ? 'primary'
              : /nursery/.test(normalise(config.depts?.[classKey]?.label || '')) ? 'nursery' : 'other',
      pupils: roster.length,
      subjects_not_started: missingSubjects.filter((subject) => subject.status === 'not_started').length,
      subjects_partial: missingSubjects.filter((subject) => subject.status === 'partial').length,
      subjects_complete: subjectsOut.length - missingSubjects.length,
      subjects: subjectsOut,
    });
  }
  return {
    session, term,
    scope: cls ? cls.label : (section ? `${section} classes` : 'whole school'),
    classes: report,
    totals: {
      classes: report.length,
      subjects_not_started: report.reduce((sum, item) => sum + item.subjects_not_started, 0),
      subjects_partial: report.reduce((sum, item) => sum + item.subjects_partial, 0),
    },
    next: includeStudents
      ? 'Name the missing pupils from the missing_students lists.'
      : 'Ask again with include_students true to name the missing pupils.',
  };
}

// ---------------------------------------------------------------------------
// rank_students
// ---------------------------------------------------------------------------
async function rankStudents(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const cls = classEntry(active, args.class);
  if (!cls) {
    return { error: `There is no class called "${clean(args.class, 80)}".`, classes: Object.values(config.depts || {}).map((dept) => dept.label), next: 'Call rank_students with a real class name.' };
  }
  const component = clean(args.component, 12).toLowerCase();
  if (component && !COMPONENTS.has(component) && !['overall', 'total', 'average'].includes(component)) {
    return { error: 'The component must be overall, ca1, ca2, ca3 or exam.', next: 'Call rank_students with component "overall", "ca1", "ca2", "ca3" or "exam".' };
  }
  const [students, scores] = await Promise.all([
    loadStudents(ctx, session, cls.key),
    loadScores(ctx, session, term, cls.key),
  ]);
  const subjects = subjectEntries(config, cls.key);
  const byStudent = new Map();
  for (const student of students) byStudent.set(student.id, { student, scores: [] });
  for (const row of scores) {
    const bucket = byStudent.get(row.student_id);
    if (bucket) bucket.scores.push(row);
  }
  const ranking = [...byStudent.values()].map(({ student, scores: rows }) => {
    const counted = rows.filter((row) => (component && COMPONENTS.has(component))
      ? scoreValue(row, component) != null
      : subjectTotal(row) != null);
    const values = counted.map((row) => (component && COMPONENTS.has(component) ? scoreValue(row, component) : subjectTotal(row)));
    const total = values.reduce((sum, value) => sum + Number(value), 0);
    const average = values.length ? total / values.length : null;
    return {
      student_id: student.id,
      name: student.name,
      class_key: student.class_key,
      admno: student.admno || null,
      subjects_counted: values.length,
      subjects_total: subjects.length,
      total: Number(total.toFixed(2)),
      average: average == null ? null : Number(average.toFixed(2)),
    };
  }).filter((row) => row.average != null)
    .sort((a, b) => b.average - a.average || String(a.name).localeCompare(String(b.name)));
  let position = 0;
  let previous = null;
  let seen = 0;
  for (const row of ranking) {
    seen += 1;
    if (previous == null || row.average !== previous) position = seen;
    row.position = position;
    previous = row.average;
  }
  const topN = Number(args.top_n) > 0 ? Math.min(Number(args.top_n), 200) : 10;
  return {
    session, term,
    class_key: cls.key,
    class: cls.label,
    component: component || 'overall',
    count: ranking.length,
    top_n: topN,
    ranking: ranking.slice(0, topN),
    next: args.top_n === 0 ? 'Use the full ranking above.' : `Ask for top_n ${ranking.length} to see every pupil.`,
  };
}

// ---------------------------------------------------------------------------
// compare_with_existing: catch a sheet copied from another subject
// ---------------------------------------------------------------------------
async function compareWithExisting(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call compare_with_existing with the class on the sheet.' };
  const target = await resolveSubjectFor(ctx, config, active, cls.key, args.subject);
  if (!target.ok) return target;
  const entries = Array.isArray(args.entries) ? args.entries : [];
  if (!entries.length) return { error: 'Give the sheet lines to compare.', next: 'Call compare_with_existing with the same entries you will record.' };

  const [students, scores] = await Promise.all([
    loadStudents(ctx, session, cls.key),
    loadScores(ctx, session, term, cls.key),
  ]);
  const aliases = await loadNameAliases(ctx);
  const roster = students.map((student) => ({ ...student, class_label: cls.label }));
  const byId = new Map(students.map((student) => [student.id, student]));
  const resolved = [];
  for (const entry of entries) {
    const value = Number(entry.value ?? entry.mark);
    if (!Number.isFinite(value)) continue;
    let studentId = clean(entry.student_id, 40) || null;
    if (!studentId) {
      const hit = resolveOneName(roster, aliases.filter((alias) => alias.class_key === cls.key), entry.name);
      studentId = hit.band === 'accept' ? hit.student.student_id : null;
    }
    if (studentId) resolved.push({ student_id: studentId, value });
  }
  if (resolved.length < 3) {
    return { comparable: false, reason: 'Fewer than three lines could be matched, so a copy check would be guesswork.', next: 'Resolve the names first, then compare.' };
  }
  const subjects = subjectEntries(config, cls.key);
  const checks = [];
  for (const subject of subjects) {
    if (subject.index === target.index) continue;
    const rows = scores.filter((row) => Number(row.subject_index) === subject.index);
    if (!rows.length) continue;
    const map = new Map(rows.map((row) => [row.student_id, subjectTotal(row)]));
    let matches = 0;
    let compared = 0;
    for (const entry of resolved) {
      const value = map.get(entry.student_id);
      if (value == null) continue;
      compared += 1;
      if (Math.abs(Number(value) - entry.value) <= 0.01) matches += 1;
    }
    if (!compared) continue;
    checks.push({
      subject_index: subject.index,
      subject: subject.label,
      compared,
      matches,
      ratio: Number((matches / compared).toFixed(2)),
    });
  }
  checks.sort((a, b) => b.ratio - a.ratio || b.matches - a.matches);
  const top = checks[0] || null;
  const warn = top && top.matches >= 5 && top.ratio >= 0.85;
  return {
    class_key: cls.key,
    class: cls.label,
    subject_index: target.index,
    subject: target.label,
    compared: resolved.length,
    possible_copy: Boolean(warn),
    warning: warn
      ? `${top.matches} of ${top.compared} lines are identical to ${top.subject} for the same pupils. That looks like a copied sheet.`
      : null,
    closest: checks.slice(0, 3),
    next: warn
      ? 'Show the warning once. Do not record until the user confirms this is really a new subject.'
      : 'No copied sheet found. Continue with record_scores.',
  };
}

// ---------------------------------------------------------------------------
// record_scores: preview first, then one audited batch on commit.
// ---------------------------------------------------------------------------
const HOLD_FLAGS = /(cross|strike|unread|unclear|overwrit|doubt|ambig|smudge|tear|missing|wrong|extra)/i;

function flagList(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 40)).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;|]+/).map((item) => clean(item, 40)).filter(Boolean);
  return [];
}

function flagsNeedReview(flags) {
  return flags.some((flag) => HOLD_FLAGS.test(flag));
}

async function recordScores(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const cls = classEntry(active, args.class);
  if (!cls) {
    return {
      error: `There is no class called "${clean(args.class, 80)}".`,
      classes: Object.values(config.depts || {}).map((dept) => dept.label),
      next: 'Call get_school_snapshot for the real class list, then send the sheet again.',
    };
  }
  const subject = await resolveSubjectFor(ctx, config, active, cls.key, args.subject);
  if (!subject.ok) return { ...subject, class_key: cls.key, class: cls.label };
  const component = resolveComponent(config, args);
  if (component.error) return { class_key: cls.key, class: cls.label, subject: subject.label, ...component };

  const entries = Array.isArray(args.entries) ? args.entries : [];
  if (!entries.length) {
    return {
      error: 'There are no sheet lines to record.',
      next: 'Send the lines with line, name (as written), value and flags.',
    };
  }

  const [students, allScores, aliases] = await Promise.all([
    loadStudents(ctx, session, cls.key),
    loadScores(ctx, session, term, cls.key),
    loadNameAliases(ctx),
  ]);
  const roster = students.map((student) => ({ ...student, class_label: cls.label }));
  const rosterById = new Map(roster.map((student) => [student.id, student]));
  const scopedAliases = aliases.filter((alias) => alias.class_key === cls.key);
  const existingRows = allScores.filter((row) => Number(row.subject_index) === subject.index);
  const existingByStudent = new Map(existingRows.map((row) => [row.student_id, row]));
  const max = componentMax(config, component.component);

  const seen = new Map();
  const preview = [];
  const safe = [];
  let recorded = 0;
  let overwritten = 0;
  let skippedExisting = 0;
  let blank = 0;
  let held = 0;
  let duplicates = 0;
  let outOfRange = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const line = entry.line != null ? Number(entry.line) : i + 1;
    const rawName = clean(entry.name || entry.on_page || entry.raw_name, 120);
    const flags = flagList(entry.flags || entry.flag);
    const decision = clean(entry.decision, 20).toLowerCase();
    let student = null;
    let method = 'explicit';
    let confidence = 1;
    let candidates = [];

    if (clean(entry.student_id, 40)) {
      student = rosterById.get(clean(entry.student_id, 40)) || null;
      if (!student) {
        held += 1;
        preview.push({ line, on_sheet: rawName, value: entry.value, status: 'held', reason: 'that pupil is not active in this class' });
        continue;
      }
    } else if (rawName) {
      const hit = resolveOneName(roster, scopedAliases, rawName);
      method = hit.method;
      confidence = hit.confidence;
      candidates = hit.candidates || [];
      if (hit.band === 'accept') {
        student = rosterById.get(hit.student.student_id) || null;
      } else {
        held += 1;
        preview.push({
          line, on_sheet: rawName, value: entry.value,
          status: hit.band === 'ask' ? 'ask' : 'held',
          confidence: hit.confidence,
          reason: hit.reason || 'not certain enough to write',
          candidates: candidates.slice(0, 4),
        });
        continue;
      }
    } else {
      held += 1;
      preview.push({ line, value: entry.value, status: 'held', reason: 'no name or pupil id' });
      continue;
    }

    if (seen.has(student.id)) {
      duplicates += 1;
      held += 1;
      preview.push({
        line, on_sheet: rawName, pupil: student.name, value: entry.value, status: 'held',
        reason: 'another line already names this pupil; never write the same pupil twice',
      });
      continue;
    }
    seen.set(student.id, line);

    if (decision === 'skip') {
      preview.push({ line, on_sheet: rawName, pupil: student.name, value: entry.value, status: 'skipped', reason: 'skipped on your instruction' });
      continue;
    }
    if (flagsNeedReview(flags) && entry.decision !== 'use') {
      held += 1;
      preview.push({
        line, on_sheet: rawName, pupil: student.name, value: entry.value, status: 'held',
        reason: `the sheet marks this line: ${flags.join(', ')}`,
        candidates: candidates.slice(0, 3),
      });
      continue;
    }

    const rawValue = entry.value ?? entry.mark ?? entry.score;
    if (rawValue == null || String(rawValue).trim() === '') {
      blank += 1;
      preview.push({ line, on_sheet: rawName, pupil: student.name, value: null, status: 'blank', reason: 'no score written' });
      continue;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      held += 1;
      preview.push({ line, on_sheet: rawName, pupil: student.name, value: rawValue, status: 'held', reason: 'the score is not a number' });
      continue;
    }
    if (value < 0 || value > max) {
      outOfRange += 1;
      held += 1;
      preview.push({ line, on_sheet: rawName, pupil: student.name, value, status: 'held', reason: `outside 0 to ${max} for ${COMPONENT_LABEL[component.component]}` });
      continue;
    }

    const existing = existingByStudent.get(student.id) || null;
    const oldValue = scoreValue(existing, component.component);
    const mayOverwrite = entry.overwrite === true || args.allow_overwrite === true;
    if (oldValue != null && !mayOverwrite) {
      skippedExisting += 1;
      preview.push({
        line, on_sheet: rawName, pupil: student.name, value, old_value: oldValue,
        status: 'existing', reason: 'already saved; left alone unless you confirm a change',
      });
      continue;
    }
    if (oldValue != null) overwritten += 1;
    else recorded += 1;

    preview.push({
      line, on_sheet: rawName, pupil: student.name, student_id: student.id, value,
      old_value: oldValue, status: oldValue == null ? 'record' : 'overwrite',
      confidence: method === 'explicit' ? undefined : confidence,
      method: method === 'explicit' ? undefined : method,
    });
    safe.push({
      line, name: rawName, student_id: student.id, value, flags,
      ...(oldValue != null ? { overwrite: true } : {}),
    });
  }

  const onSheet = new Set(safe.map((entry) => entry.student_id));
  for (const item of preview) {
    if (item.student_id) onSheet.add(item.student_id);
  }
  const missingFromSheet = roster.filter((student) => !onSheet.has(student.id)).map((student) => student.name);

  let duplicateWarning = null;
  if (safe.length >= 3) {
    const comparison = await compareWithExisting(ctx, {
      class: cls.label,
      subject: subject.label,
      entries: safe,
      term,
      session,
    }, active).catch(() => null);
    if (comparison?.possible_copy) {
      duplicateWarning = comparison;
    }
  }

  const commit = args.commit === true;
  const requiresDuplicateConfirm = Boolean(duplicateWarning) && args.confirm_duplicate !== true;
  const requiresOverwriteConfirm = overwritten > 0 && args.allow_overwrite !== true;
  const review = {
    class_key: cls.key,
    class: cls.label,
    subject_index: subject.index,
    subject: subject.label,
    component: component.component,
    component_label: COMPONENT_LABEL[component.component],
    term,
    session,
    sheet_lines: entries.length,
    recorded,
    overwritten,
    skipped_existing: skippedExisting,
    held_back: held,
    blank,
    out_of_range: outOfRange,
    duplicates,
    class_size: roster.length,
    missing_from_sheet: missingFromSheet.slice(0, 60),
    missing_from_sheet_count: missingFromSheet.length,
    lines: preview,
    possible_copy: duplicateWarning,
    can_commit: safe.length > 0 && !requiresDuplicateConfirm,
    next: requiresDuplicateConfirm
      ? 'Show the copied-sheet warning once. Do not write until the user confirms this is a new subject.'
      : held > 0 || skippedExisting > 0
        ? 'Show one short review: only the uncertain lines, existing values and blank lines. Ask once, then call record_scores again with commit true and the answers.'
        : 'Call record_scores again with commit true to write this sheet in one audited batch.',
  };

  if (!commit || !safe.length || requiresDuplicateConfirm) {
    return { ok: true, preview: true, committed: false, ...review };
  }
  if (requiresOverwriteConfirm) {
    return { ok: true, preview: true, committed: false, ...review };
  }

  const request = requestId();
  const written = await opsRpc('school_record_scores', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_class_key: cls.key,
    p_term: term,
    p_academic_session: session,
    p_subject_index: subject.index,
    p_component: component.component,
    p_entries: safe.map((entry) => ({
      line: entry.line,
      name: entry.name,
      student_id: entry.student_id,
      value: entry.value,
      flags: entry.flags,
    })),
    p_request_id: request,
    p_dry_run: false,
    p_allow_overwrite: args.allow_overwrite === true,
    p_reason: clean(args.reason, 300) || null,
  });

  if (!written?.ok) {
    return {
      ...review,
      committed: false,
      error: written?.error || 'The database refused the write.',
      code: written?.code || 'SCHOOL_WRITE_FAILED',
      next: written?.next || 'Nothing was written. Re-read the class with get_scores, then send the sheet again.',
    };
  }

  return {
    ...review,
    preview: false,
    committed: true,
    batch_id: written.batch_id,
    recorded: written.recorded,
    overwritten: written.overwritten,
    skipped_existing: written.skipped_existing,
    held_back: written.held_back,
    blank: written.blank,
    verify: written.verify,
    undo: written.undo,
    next: `Tell the user what was recorded, what was held back and what is blank. Offer undo_batch ${written.batch_id} and the follow-ups that remain.`,
  };
}

// ---------------------------------------------------------------------------
// Sheet reader: attachment, draft lines, one batch review and one write.
// ---------------------------------------------------------------------------
const COMPONENT_TITLES = /\b(ca\s*1|ca\s*2|ca\s*3|class\s*(?:exercise|work)|test|exam|examination)\b/i;

function componentFromTitle(value) {
  const text = normaliseName(value);
  if (!text) return null;
  if (/\bexam|examination\b/.test(text)) return 'exam';
  const ca = text.match(/\bca\s*([123])\b/);
  if (ca) return `ca${ca[1]}`;
  if (/\bclass\s*(?:exercise|work)|\bca\b/.test(text)) return 'ca1';
  return null;
}

function parseSheetScore(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const half = text
    .replace(/[½]/g, '.5')
    .replace(/[¼]/g, '.25')
    .replace(/[¾]/g, '.75')
    .replace(/\b(\d+)\s+1\s*\/\s*2\b/g, '$1.5')
    .replace(/\b(\d+)\s+1\s*\/\s*4\b/g, '$1.25')
    .replace(/\b(\d+)\s+3\s*\/\s*4\b/g, '$1.75');
  const match = half.replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function sheetColumns(sheetRead) {
  const raw = Array.isArray(sheetRead?.columns) && sheetRead.columns.length
    ? sheetRead.columns
    : [{
      column_key: 'primary',
      title: sheetRead?.column_title || null,
      component: sheetRead?.component || null,
      readable: true,
      lines: Array.isArray(sheetRead?.lines) ? sheetRead.lines : [],
    }];
  return raw.map((column, index) => {
    const key = clean(column.column_key || column.key, 40) || `c${index + 1}`;
    const title = clean(column.title || column.column_title, 80)
      || (index === 0 ? clean(sheetRead?.column_title, 80) : '')
      || `Column ${index + 1}`;
    const declared = String(column.component || '').toLowerCase();
    return {
      key,
      title,
      component: COMPONENTS.has(declared) ? declared : componentFromTitle(title),
      readable: column.readable !== false,
      error: clean(column.error, 160) || null,
      lines: Array.isArray(column.lines) ? column.lines : [],
    };
  });
}

function lineNeedsAnswer(line) {
  if (!line || line.written_at) return false;
  if (line.match_status === 'rejected') return false;
  if (line.match_status === 'existing') return false;
  const flags = Array.isArray(line.flags) ? line.flags : [];
  const blank = flags.some((flag) => /^(blank|empty)$/i.test(String(flag)));
  if (blank) return false;
  if (line.match_status === 'held' || line.match_status === 'unmatched') return true;
  return line.score_value == null;
}

function itemQuestion(line) {
  const nameNeeded = line.match_status === 'held' || line.match_status === 'unmatched';
  const scoreNeeded = line.score_value == null;
  if (nameNeeded && scoreNeeded) return 'name_score';
  if (nameNeeded) return 'name';
  return 'score';
}

function buildSheetReview(meta, lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const columns = Array.isArray(meta?.columns) ? meta.columns : [];
  const rosterSize = Number(meta?.class_size) || 0;
  const ready = [];
  const needs = [];
  const blankLines = [];
  const existing = [];
  const rejected = [];
  const written = [];
  const onSheet = new Set();

  for (const line of rows) {
    if (line.match_student_id) onSheet.add(line.match_student_id);
    if (line.written_at) {
      written.push(line);
      continue;
    }
    if (line.match_status === 'rejected') {
      rejected.push(line);
      continue;
    }
    if (line.match_status === 'existing') {
      existing.push(line);
      continue;
    }
    const flags = Array.isArray(line.flags) ? line.flags : [];
    if (flags.some((flag) => /^(blank|empty)$/i.test(String(flag)))) {
      blankLines.push(line);
      continue;
    }
    if (lineNeedsAnswer(line)) {
      needs.push(line);
      continue;
    }
    if ((line.match_status === 'auto' || line.match_status === 'confirmed') && line.score_value != null) {
      ready.push(line);
      continue;
    }
    needs.push(line);
  }

  // Numbers stay stable across answers and refreshes. A line keeps the number
  // the user already saw; only a new item gets the next free number.
  let nextItem = rows.reduce((max, line) => Math.max(max, Number(line.item_no) || 0), 0);
  for (const line of needs) {
    if (!Number(line.item_no)) {
      nextItem += 1;
      line.item_no = nextItem;
    }
  }

  const missing = Array.isArray(meta?.roster)
    ? meta.roster.filter((student) => !onSheet.has(student.id)).map((student) => ({
      student_id: student.id,
      name: student.name,
    }))
    : [];

  needs.sort((a, b) => Number(a.item_no || 0) - Number(b.item_no || 0));
  const review = {
    id: meta.file_id || null,
    file_id: meta.file_id || null,
    class_key: meta.class_key || null,
    class: meta.class || meta.class_key || null,
    subject_index: meta.subject_index == null ? null : Number(meta.subject_index),
    subject: meta.subject || null,
    term: meta.term || null,
    session: meta.academic_session || meta.session || null,
    class_size: rosterSize,
    columns: columns.map((column) => ({
      key: column.key,
      title: column.title,
      component: column.component || null,
      readable: column.readable !== false,
      error: column.error || null,
    })),
    components: [...new Set(rows.map((line) => line.component).filter(Boolean))],
    summary: {
      total_lines: rows.length,
      ready: ready.length,
      needs_answer: needs.length,
      blank: missing.length,
      blank_lines: blankLines.length,
      already_recorded: existing.length,
      rejected: rejected.length,
      written: written.length,
      failed_columns: columns.filter((column) => column.readable === false).length,
      class_size: rosterSize,
    },
    ready: ready.map((line) => ({
      item: line.item_no || null,
      line: line.sheet_line,
      sheet_name: line.raw_name,
      pupil: line.match_name || null,
      student_id: line.match_student_id,
      score: line.score_value,
      component: line.component,
      column: line.column_title,
    })),
    needs_answer: needs.map((line) => ({
      item: line.item_no,
      line: line.sheet_line,
      sheet_name: line.raw_name,
      score: line.score_value,
      flags: Array.isArray(line.flags) ? line.flags : [],
      column: line.column_title,
      component: line.component,
      question: itemQuestion(line),
      reason: line.note || null,
      candidates: (Array.isArray(line.candidates) ? line.candidates : []).slice(0, 3).map((candidate, index) => ({
        number: index + 1,
        student_id: candidate.student_id,
        name: candidate.name,
        confidence: candidate.confidence,
      })),
    })),
    blank: missing.slice(0, 80),
    blank_count: missing.length,
    blank_lines: blankLines.map((line) => ({
      line: line.sheet_line,
      sheet_name: line.raw_name,
      column: line.column_title,
    })),
    already_recorded: existing.map((line) => ({
      line: line.sheet_line,
      sheet_name: line.raw_name,
      pupil: line.match_name || null,
      value: line.score_value,
      note: line.note,
      component: line.component,
    })),
    rejected: rejected.length,
    failed_columns: columns.filter((column) => column.readable === false).map((column) => ({
      title: column.title,
      error: column.error || 'could not be read',
    })),
    can_commit: ready.length > 0,
    question: needs.length
      ? 'Reply to every numbered item in one message, for example: 1: the right name, 2: skip, 3: 14. Then say record.'
      : (ready.length ? 'Say record when you want these lines written.' : 'There is nothing ready to write yet.'),
  };
  return review;
}

async function loadSheetState(ctx, sessionId, fileId = null) {
  if (!sessionId || !UUID_RE.test(String(sessionId))) {
    return { attachment: null, review: null, lines: [] };
  }
  const scope = {
    p_session_id: sessionId,
    p_school_id: ctx.actor.school_id,
    p_owner_user_id: ctx.actor.id,
  };
  const [latest, reviewRow] = await Promise.all([
    opsRpc('ops_sheet_attachment_latest', scope).catch(() => null),
    opsRpc('ops_sheet_review_get', scope).catch(() => null),
  ]);
  const attachment = latest?.attachment || null;
  const review = reviewRow?.review || null;
  if (!review) return { attachment, review: null, lines: [] };
  const list = await opsRpc('ops_sheet_draft_list', {
    ...scope,
    p_file_id: fileId || review.file_id || attachment?.id || null,
  }).catch(() => null);
  const meta = review.meta || review;
  const roster = Array.isArray(meta?.roster) ? meta.roster : [];
  const lines = (Array.isArray(list?.lines) ? list.lines : []).map((line) => {
    if (line.match_student_id && !line.match_name) {
      const hit = roster.find((student) => String(student.id) === String(line.match_student_id));
      if (hit) line.match_name = hit.name;
    }
    return line;
  });
  return {
    attachment,
    review,
    lines,
  };
}

// One photo in, one review out. The class and subject are resolved from the
// sheet and the message. Every line is saved before the answer is written, so
// a refresh cannot lose it.
async function prepareSheetReview(ctx, args, context, sheetRead, fileId) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm({ term: sheetRead?.term || args.term }, active);
  const classRaw = clean(args.class || sheetRead?.class, 80);
  const cls = classEntry(active, classRaw);
  if (!cls) {
    return {
      ok: false,
      code: 'SHEET_CLASS_NEEDED',
      needs: ['class'],
      error: classRaw
        ? `There is no class called "${classRaw}" in the school.`
        : 'The class is not clear from the sheet.',
      classes: (Array.isArray(active.classes) ? active.classes : []).map((item) => item.label),
      next: 'Ask one short question for the class, then call sheet_review again.',
    };
  }

  const subjectRaw = clean(args.subject || sheetRead?.subject, 120);
  const fallbackSubject = await resolveSubjectFor(ctx, config, active, cls.key, subjectRaw);
  const columns = sheetColumns(sheetRead);

  // One photo often carries two subjects side by side, with the subject name
  // written over each column. Read the subject from the column heading first,
  // so each column's marks land in its own subject. A column that cannot be
  // given a subject is reported back, never written into the wrong subject.
  const columnSubject = new Map();
  for (const column of columns) {
    const title = clean(column?.title, 120);
    if (!title) continue;
    const hit = await resolveSubjectFor(ctx, config, active, cls.key, title);
    if (hit.ok) columnSubject.set(column.key, hit);
    // A printed column heading is strong evidence even when the catalog name
    // is longer ("English" over a column, "English Language" in the catalog),
    // so a confident best guess is taken instead of holding the whole column.
    else {
      const want = normalise(title);
      const entry = subjectEntries(config, cls.key).find((item) => {
        const label = normalise(item.label);
        return label === want || label.startsWith(`${want} `) || want.startsWith(`${label} `);
      }) || (hit.best
        ? subjectEntries(config, cls.key).find((item) => item.index === Number(hit.best.index))
        : null);
      if (entry) columnSubject.set(column.key, { ok: true, ...entry, confidence: 0.9, method: 'column title' });
    }
  }
  const subject = fallbackSubject.ok
    ? fallbackSubject
    : columnSubject.values().next().value || null;
  if (!subject) {
    return {
      ...fallbackSubject,
      ok: false,
      code: fallbackSubject.code || 'SHEET_SUBJECT_NEEDED',
      needs: ['subject'],
      class_key: cls.key,
      class: cls.label,
      next: 'Ask one short question for the subject, then call sheet_review again.',
    };
  }

  const defaultComponent = resolveComponent(config, {
    component: args.component || sheetRead?.component,
    column: args.column || sheetRead?.column_title,
  });
  const defaultKey = defaultComponent.component || 'ca1';
  const [students, allScores, aliases] = await Promise.all([
    loadStudents(ctx, session, cls.key),
    loadScores(ctx, session, term, cls.key),
    loadNameAliases(ctx),
  ]);
  const roster = students.map((student) => ({ ...student, class_label: cls.label }));
  const scopedAliases = aliases.filter((alias) => alias.class_key === cls.key);
  const existingByKey = new Map(allScores.map((row) => [`${Number(row.subject_index)}|${row.student_id}`, row]));

  const draftLines = [];
  const seen = new Map();
  const failedColumns = [];

  for (const column of columns) {
    if (!column.readable) {
      failedColumns.push({ key: column.key, title: column.title, error: column.error || 'could not be read' });
      continue;
    }
    const lineSubject = columnSubject.get(column.key) || (fallbackSubject.ok ? fallbackSubject : null);
    if (!lineSubject) {
      failedColumns.push({ key: column.key, title: column.title, error: 'the subject over this column was not clear' });
      continue;
    }
    const component = column.component || defaultKey;
    const max = componentMax(config, component);
    // A teacher's book often carries a whole column out of 30 while the
    // portal's column is out of 15. When most of the column is over the
    // portal maximum, the column is read as being out of its own top mark and
    // each mark is converted, so the sheet records instead of holding every
    // line. One stray high mark does not trigger it.
    const columnValues = column.lines
      .map((raw) => (raw?.score == null || raw?.score === ''
        ? parseSheetScore(raw?.score_text)
        : Number(raw.score)))
      .filter((num) => Number.isFinite(num));
    const columnTop = columnValues.length ? Math.max(...columnValues) : 0;
    const overCount = columnValues.filter((num) => num > max).length;
    const columnScale = columnTop > max && overCount > columnValues.length / 2 ? max / columnTop : 1;
    for (let index = 0; index < column.lines.length; index += 1) {
      const raw = column.lines[index] || {};
      const sheetLine = Number(raw.line) || index + 1;
      const rawName = clean(raw.raw_name || raw.name, 120);
      const flags = Array.isArray(raw.flags) ? raw.flags.map((flag) => clean(flag, 30)).filter(Boolean) : [];
      const directScore = raw.score == null || raw.score === '' ? NaN : Number(raw.score);
      const readScore = Number.isFinite(directScore) ? directScore : parseSheetScore(raw.score_text ?? raw.score);
      let value = Number.isFinite(readScore) ? readScore : null;
      const readValue = value;
      const scaledFrom = value != null && columnScale < 1 ? columnTop : null;
      if (value != null && columnScale < 1) value = Math.max(0, Math.min(max, Math.round(value * columnScale)));
      const hit = rawName ? resolveOneName(roster, scopedAliases, rawName) : null;
      let status = hit && hit.band === 'accept' && hit.student ? 'auto' : (hit && hit.band === 'ask' ? 'held' : 'unmatched');
      let studentId = status === 'auto' ? hit.student.student_id : null;
      let note = hit?.reason || null;
      const candidates = (hit?.candidates || []).slice(0, 3);
      // A row with no name and no mark is a ruled line, not a learner.
      if (!rawName && value == null) continue;

      if (status === 'auto' && studentId) {
        const old = scoreValue(existingByKey.get(`${Number(lineSubject.index)}|${studentId}`) || null, component);
        if (old != null) {
          status = 'existing';
          note = `already recorded: ${old}`;
        }
      }
      if (value != null && (value < 0 || value > max)) {
        status = 'held';
        note = `outside 0 to ${max} for ${COMPONENT_LABEL[component] || component}`;
      } else if (scaledFrom != null && value != null) {
        note = `read ${readValue} of ${scaledFrom}; scaled to ${value} of ${max}`;
      }
      // A mark the sheet itself calls crossed out or unclear is never written
      // until the user says what it should be.
      const riskyFlags = flags.filter((flag) => /cross|unread|overwrit|ambig|smudge|tear|extra/i.test(flag));
      if (riskyFlags.length && status === 'auto') {
        status = 'held';
        note = `the sheet marks this line: ${flags.join(', ')}`;
      }
      if (status === 'auto' && value == null) {
        const blankFlag = flags.some((flag) => /^(blank|empty)$/i.test(flag));
        if (!blankFlag) note = 'the score was not read, so it is held';
      }
      // Two lines naming one learner are never both written. The earlier line
      // is held back as well, so the user answers them together in one review.
      if (studentId && status !== 'existing') {
        const key = `${lineSubject.index}|${component}|${studentId}`;
        const prior = seen.get(key);
        if (prior) {
          prior.match_status = 'held';
          prior.note = 'another line already names this learner; both are held';
          status = 'held';
          studentId = null;
          note = 'another line already names this learner; both are held';
        }
      }

      const line = {
        item_no: null,
        class_key: cls.key,
        subject_index: lineSubject.index,
        subject_label: lineSubject.label,
        term,
        academic_session: session,
        component,
        column_key: column.key,
        column_title: column.title,
        sheet_line: sheetLine,
        raw_name: rawName,
        raw_score: clean(raw.score_text ?? raw.score ?? '', 20) || null,
        score_value: value,
        flags,
        note,
        confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : (hit?.confidence ?? null),
        match_student_id: studentId,
        match_name: studentId ? (hit?.student?.name || null) : (hit?.best?.name || null),
        match_confidence: hit?.confidence ?? null,
        match_status: status,
        candidates,
      };
      draftLines.push(line);
      if (line.match_student_id && line.match_status !== 'existing') {
        seen.set(`${lineSubject.index}|${component}|${line.match_student_id}`, line);
      }
    }
  }

  // Number the lines that need an answer before anything is stored, so the
  // number the user sees is the number saved and it survives a refresh.
  draftLines.forEach((line) => {
    if (line.match_student_id && !line.match_name) {
      const hit = roster.find((student) => student.id === line.match_student_id);
      line.match_name = hit?.name || null;
    }
  });
  const needsNumber = draftLines.filter((line) => (
    !line.written_at
    && line.match_status !== 'rejected'
    && line.match_status !== 'existing'
    && (line.match_status === 'held' || line.match_status === 'unmatched' || line.score_value == null)
  ));
  needsNumber.forEach((line, index) => { line.item_no = index + 1; });

  // Store every line before the review is shown. A failed column is recorded
  // as a column error; it never stops the other columns.
  if (fileId) {
    const saved = await opsRpc('ops_sheet_draft_put', {
      p_session_id: args.chat_id,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_file_id: fileId,
      p_lines: draftLines,
    }).catch(() => null);
    if (!saved || saved.ok === false) {
      return { ok: false, error: saved?.message || 'The read lines could not be saved yet.' };
    }
  }

  const usedSubjects = [...new Map(draftLines.map((line) => [Number(line.subject_index), line.subject_label])).entries()]
    .map(([index, label]) => ({ index, label }));
  const meta = {
    file_id: fileId || null,
    class_key: cls.key,
    class: cls.label,
    subject_index: subject.index,
    subject: usedSubjects.length === 1 ? usedSubjects[0].label : usedSubjects.map((item) => item.label).join(' + '),
    subject_set: usedSubjects,
    term,
    academic_session: session,
    class_size: roster.length,
    roster: roster.map((student) => ({ id: student.id, name: student.name })),
    columns: columns.map((column) => ({
      key: column.key,
      title: column.title,
      component: column.component || defaultKey,
      readable: column.readable,
      error: column.error,
    })),
  };
  // Candidate names are kept on every line so a later answer can name the
  // right learner without reading the photo again.
  const review = buildSheetReview(meta, draftLines);
  if (fileId) {
    await opsRpc('ops_sheet_review_put', {
      p_session_id: args.chat_id,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_file_id: fileId,
      p_review: { ...review, meta },
      p_status: review.needs_answer.length ? 'open' : 'ready',
    }).catch(() => null);
  }
  return { ok: true, review: { ...review, meta }, saved_lines: draftLines.length, failed_columns: failedColumns };
}

function parseSheetAnswers(text, review) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const items = new Map((Array.isArray(review?.needs_answer) ? review.needs_answer : [])
    .map((item) => [Number(item.item), item]));
  const marks = [...source.matchAll(/(?:^|[\s,;])(\d{1,3})\s*[:.=)]\s*/g)];
  const answers = [];
  for (let index = 0; index < marks.length; index += 1) {
    const number = Number(marks[index][1]);
    if (!items.has(number)) continue;
    const start = marks[index].index + marks[index][0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : source.length;
    let answer = source.slice(start, end).replace(/^[,;.\s]+|[,;.\s]+$/g, '').trim();
    if (!answer) continue;
    const item = items.get(number);
    const lower = answer.toLowerCase();
    const entry = { item: number };
    if (/^(skip|leave|omit|omit it|don't|do not|no)\b/.test(lower)) {
      entry.decision = 'skip';
      answers.push(entry);
      continue;
    }
    if (/^(hold|wait|later|unsure|not sure)\b/.test(lower)) {
      entry.decision = 'hold';
      answers.push(entry);
      continue;
    }
    if (/^(use|yes|correct|confirm|ok|okay)\b/.test(lower)) {
      entry.decision = 'use';
      const first = item.candidates?.[0];
      if (first) entry.student_id = first.student_id;
      answers.push(entry);
      continue;
    }

    const candidate = (Array.isArray(item.candidates) ? item.candidates : [])
      .map((option) => ({ ...option, match: nameScore(option.name, answer) }))
      .sort((a, b) => b.match - a.match)[0];
    if (candidate && candidate.match >= 0.6) {
      entry.student_id = candidate.student_id;
      entry.name = candidate.name;
      answer = answer.replace(candidate.name, '').replace(/^[,;.\s]+/, '').trim();
    } else if (/^\d+$/.test(answer) && item.candidates?.[Number(answer) - 1]) {
      const option = item.candidates[Number(answer) - 1];
      entry.student_id = option.student_id;
      entry.name = option.name;
      answer = '';
    } else {
      // The user may name any learner in the class, not only one of the three
      // candidates. Keep the letters and resolve against the full roster later.
      const letters = answer
        .replace(/\b(?:score|marks?|is|the|should be|please)\b/gi, ' ')
        .replace(/[^A-Za-z' -]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (letters.length >= 2) entry.name = letters;
    }
    const value = parseSheetScore(answer);
    if (value != null && (item.score == null || item.question === 'score' || /score|mark/i.test(answer))) {
      entry.value = value;
    }
    if (entry.student_id || entry.value != null || entry.name) answers.push(entry);
  }
  return answers;
}

async function applySheetAnswers(ctx, args, context, sessionId, answersOverride) {
  const state = await loadSheetState(ctx, sessionId);
  if (!state.review || !state.lines.length) {
    return { ok: false, code: 'SHEET_REVIEW_NOT_FOUND', error: 'There is no open sheet review in this chat.' };
  }
  const meta = state.review.meta || state.review;
  const lines = state.lines.slice();
  const answers = Array.isArray(answersOverride)
    ? answersOverride
    : parseSheetAnswers(args.text, state.review);
  if (!answers.length) {
    return { ok: true, applied: 0, review: state.review, lines };
  }
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const [students, allScores, aliases] = await Promise.all([
    loadStudents(ctx, meta.session || meta.academic_session, meta.class_key),
    loadScores(ctx, meta.session || meta.academic_session, meta.term, meta.class_key, meta.subject_index),
    loadNameAliases(ctx),
  ]);
  const roster = students.map((student) => ({ ...student, class_label: meta.class }));
  const scopedAliases = aliases.filter((alias) => alias.class_key === meta.class_key);
  const existingByStudent = new Map(
    allScores.filter((row) => Number(row.subject_index) === Number(meta.subject_index))
      .map((row) => [row.student_id, row]),
  );
  const byItem = new Map(lines.map((line) => [Number(line.item_no), line]));

  for (const answer of answers) {
    const line = byItem.get(Number(answer.item));
    if (!line) continue;
    if (answer.decision === 'skip') {
      line.match_status = 'rejected';
      line.note = 'skipped by the user';
      continue;
    }
    if (answer.decision === 'hold') {
      line.match_status = 'held';
      line.note = 'held for a later answer';
      continue;
    }
    if (answer.student_id || answer.name) {
      let pupil = answer.student_id
        ? roster.find((student) => student.id === answer.student_id)
        : null;
      let hit = null;
      if (!pupil) {
        hit = resolveOneName(roster, scopedAliases, answer.name || line.raw_name);
        pupil = hit.student ? roster.find((student) => student.id === hit.student.student_id) : null;
      }
      if (pupil) {
        line.match_student_id = pupil.id;
        line.match_name = pupil.name;
        line.match_confidence = 1;
        line.match_status = 'confirmed';
        line.candidates = [];
        line.note = 'confirmed by the user';
        const old = scoreValue(existingByStudent.get(pupil.id) || null, line.component);
        if (old != null) {
          line.match_status = 'existing';
          line.note = `already recorded: ${old}`;
          line.score_value = old;
        }
        await rememberAlias(ctx, {
          class: meta.class,
          sheet_name: line.raw_name,
          student_id: pupil.id,
        }, active).catch(() => null);
      }
    }
    if (answer.value != null && line.match_status !== 'existing') {
      const value = Number(answer.value);
      const max = componentMax(config, line.component || 'ca1');
      if (!Number.isFinite(value) || value < 0 || value > max) {
        line.score_value = null;
        line.match_status = 'held';
        line.note = `outside 0 to ${max} for ${COMPONENT_LABEL[line.component] || line.component || 'this column'}`;
      } else {
        line.score_value = value;
        line.raw_score = String(value);
        // The user has now read the mark for us; the sheet's doubt is settled.
        line.flags = [];
        if (line.match_student_id && line.match_status === 'held') {
          // The user has answered for this line, so a duplicate-name hold is
          // settled too and does not come back on the next pass.
          line.match_status = 'confirmed';
          line.note = 'confirmed by the user';
        }
      }
    }
    if (answer.decision === 'use' && !line.match_student_id) {
      const best = (line.candidates || [])[0];
      if (best) {
        line.match_student_id = best.student_id;
        line.match_name = best.name;
        line.match_status = 'confirmed';
        line.match_confidence = 1;
      }
    }
  }

  // Two lines for one learner are never both written.
  const seen = new Map();
  for (const line of lines) {
    if (!line.match_student_id || line.match_status === 'rejected') continue;
    const key = `${line.subject_index}|${line.component}|${line.match_student_id}`;
    if (seen.has(key)) {
      const prior = seen.get(key);
      prior.match_status = 'held';
      prior.note = 'another line already names this learner; both are held';
      line.match_status = 'held';
      line.note = 'another line already names this learner; both are held';
    } else {
      seen.set(key, line);
    }
  }

  const saved = await opsRpc('ops_sheet_draft_put', {
    p_session_id: sessionId,
    p_school_id: ctx.actor.school_id,
    p_owner_user_id: ctx.actor.id,
    p_file_id: state.review.file_id || state.attachment?.id,
    p_lines: lines,
  }).catch(() => null);
  if (!saved || saved.ok === false) {
    return { ok: false, error: saved?.message || 'The answers could not be saved.' };
  }
  const review = buildSheetReview(meta, lines);
  await opsRpc('ops_sheet_review_put', {
    p_session_id: sessionId,
    p_school_id: ctx.actor.school_id,
    p_owner_user_id: ctx.actor.id,
    p_file_id: state.review.file_id || state.attachment?.id,
    p_review: { ...review, meta },
    p_status: review.needs_answer.length ? 'open' : 'ready',
  }).catch(() => null);
  return { ok: true, applied: answers.length, review: { ...review, meta }, lines };
}

// Writes every ready line in the open review. It uses the audited score path,
// so existing values are skipped and the whole write can be undone.
async function commitSheetReview(ctx, args, context, sessionId) {
  const state = await loadSheetState(ctx, sessionId);
  if (!state.review || !state.lines.length) {
    return { ok: false, code: 'SHEET_REVIEW_NOT_FOUND', error: 'There is no open sheet review in this chat.' };
  }
  const meta = state.review.meta || state.review;
  const writable = state.lines.filter((line) => (
    !line.written_at
    && (line.match_status === 'auto' || line.match_status === 'confirmed')
    && line.score_value != null
    && line.match_student_id
  ));
  if (!writable.length) {
    return {
      ok: true,
      committed: false,
      review: state.review,
      error: 'There is no line ready to write. Answer the held lines first.',
    };
  }

  const groups = new Map();
  for (const line of writable) {
    const key = `${line.component || 'ca1'}|${line.subject_index || meta.subject_index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }

  const batches = [];
  let recorded = 0;
  let skipped = 0;
  let held = 0;
  let lastVerify = null;
  for (const [key, lines] of groups) {
    const [component, subjectIndex] = key.split('|');
    const result = await recordScores(ctx, {
      class: meta.class,
      // The subject of this batch's own column, not the review header, so a
      // photo carrying two subjects writes each column into its own subject.
      subject: lines[0]?.subject_label || meta.subject,
      component,
      term: meta.term,
      session: meta.session || meta.academic_session,
      entries: lines.map((line) => ({
        line: line.sheet_line,
        name: line.raw_name,
        student_id: line.match_student_id,
        value: line.score_value,
        flags: line.flags,
        ...(line.match_status === 'confirmed' ? { decision: 'use' } : {}),
      })),
      commit: true,
      confirm_duplicate: true,
      confirm_large: true,
      reason: 'Photo sheet batch',
    }, context);
    if (result?.error) {
      return { ok: false, error: result.error, review: state.review, batches };
    }
    batches.push({
      component,
      subject_index: Number(subjectIndex),
      batch_id: result.batch_id || null,
      recorded: result.recorded || 0,
      skipped_existing: result.skipped_existing || 0,
      held_back: result.held_back || 0,
    });
    recorded += Number(result.recorded) || 0;
    skipped += Number(result.skipped_existing) || 0;
    held += Number(result.held_back) || 0;
    lastVerify = result.verify || lastVerify;
    const writtenHere = lines.filter((line) => (
      (Array.isArray(result.lines) ? result.lines : []).some((item) => (
        Number(item.line) === Number(line.sheet_line)
        && String(item.student_id || '') === String(line.match_student_id)
        && ['record', 'overwrite'].includes(String(item.status || ''))
      ))
    ));
    for (const line of writtenHere) {
      line.written_at = new Date().toISOString();
      line.batch_id = result.batch_id || null;
    }
    if (result.batch_id && writtenHere.length) {
      await opsRpc('ops_sheet_draft_mark_written', {
        p_session_id: sessionId,
        p_school_id: ctx.actor.school_id,
        p_owner_user_id: ctx.actor.id,
        p_file_id: meta.file_id || state.review.file_id || state.attachment?.id,
        p_batch_id: result.batch_id,
        p_items: writtenHere.map((line) => ({
          column_key: line.column_key || 'primary',
          sheet_line: Number(line.sheet_line) || 0,
        })),
      }).catch(() => null);
    }
  }

  const refreshed = await loadSheetState(ctx, sessionId);
  const linesAfter = refreshed.lines.length ? refreshed.lines : state.lines;
  // Rebuild and save the review, so a refresh shows what is still open and the
  // verified counts instead of the stale pre-write review.
  const reviewAfter = buildSheetReview(meta, linesAfter);
  const fileId = meta.file_id || state.review.file_id || state.attachment?.id;
  if (fileId) {
    await opsRpc('ops_sheet_review_put', {
      p_session_id: sessionId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_file_id: fileId,
      p_review: { ...reviewAfter, meta },
      p_status: (reviewAfter.needs_answer.length || reviewAfter.ready.length) ? 'open' : 'written',
    }).catch(() => null);
  }
  const review = { ...reviewAfter, meta };
  const classSize = Number(meta.class_size) || 0;
  const heldIds = new Set(linesAfter
    .filter((line) => lineNeedsAnswer(line) && line.match_student_id)
    .map((line) => line.match_student_id));
  const existingIds = new Set(linesAfter
    .filter((line) => line.match_status === 'existing' && line.match_student_id)
    .map((line) => line.match_student_id));
  const writtenIds = new Set(linesAfter
    .filter((line) => line.written_at && line.match_student_id)
    .map((line) => line.match_student_id));
  const allIds = new Set([...heldIds, ...existingIds, ...writtenIds]);
  const rosterSize = classSize || allIds.size;
  const blank = Math.max(0, rosterSize - allIds.size);
  const total = writtenIds.size + existingIds.size + heldIds.size + blank;
  const verify = {
    class_size: rosterSize,
    recorded_now: writtenIds.size,
    skipped_existing: existingIds.size,
    held: heldIds.size,
    blank,
    total,
    difference: rosterSize - total,
    ...(lastVerify ? { database: lastVerify } : {}),
  };

  return {
    ok: true,
    committed: true,
    batches,
    recorded,
    skipped_existing: skipped,
    held_back: held,
    verify,
    review,
  };
}

function sheetReviewText(review) {
  if (!review) return '';
  const head = [review.class, review.subject, review.term].filter(Boolean).join(' · ');
  const lines = [`Sheet read${head ? `: ${head}` : ''}.`];
  const summary = review.summary || {};
  const statusBits = [];
  if (summary.written) statusBits.push(`${summary.written} written`);
  if (summary.ready) statusBits.push(`${summary.ready} ready with names matched`);
  if (summary.already_recorded) statusBits.push(`${summary.already_recorded} already recorded and left alone`);
  if (statusBits.length) lines.push(`${statusBits.join(' · ')}.`);
  else if (!review.needs_answer?.length) lines.push('No line is ready to write yet.');
  if (review.failed_columns?.length) {
    lines.push(`Column not read: ${review.failed_columns.map((column) => `${column.title} (${column.error})`).join('; ')}.`);
  }
  if (review.needs_answer?.length) {
    lines.push('', `Needs your answer (${review.needs_answer.length}):`);
    for (const item of review.needs_answer) {
      const bits = [`${item.item}. Line ${item.line} “${item.sheet_name}”`];
      if (item.score != null) bits.push(`score ${item.score}`);
      else bits.push('score not read');
      if (item.reason) bits.push(item.reason);
      lines.push(`- ${bits.join(' — ')}`);
      if (item.candidates?.length) {
        lines.push(`  Closest: ${item.candidates.map((candidate) => `${candidate.number}) ${candidate.name}`).join(', ')}.`);
      }
    }
    lines.push('', 'Reply with all answers in one message, for example: 1: the right name, 2: skip, 3: 14.');
  } else if (summary.ready && !summary.written) {
    lines.push('', 'Every line that can be written is ready. Say record and I will write them.');
  }
  if (summary.blank) lines.push(`Not on the sheet: ${summary.blank} learner${summary.blank === 1 ? '' : 's'} from the class list.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// correct_score
// ---------------------------------------------------------------------------
async function correctScore(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const session = resolveSession(args, active);
  const term = resolveTerm(args, active);
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot for the real class list.' };
  const subject = await resolveSubjectFor(ctx, config, active, cls.key, args.subject);
  if (!subject.ok) return subject;
  const component = resolveComponent(config, args);
  if (component.error) return component;
  const value = Number(args.new_value ?? args.value);
  if (!Number.isFinite(value)) return { error: 'The new value must be a number.', next: 'Call correct_score with the new number.' };
  const max = componentMax(config, component.component);
  if (value < 0 || value > max) return { error: `The value must be between 0 and ${max}.`, next: `Call correct_score with a value from 0 to ${max}.` };

  const students = await loadStudents(ctx, session, cls.key);
  let student = clean(args.student_id, 40) ? students.find((item) => item.id === clean(args.student_id, 40)) : null;
  if (!student) {
    const hit = resolveOneName(students.map((item) => ({ ...item, class_label: cls.label })), await loadNameAliases(ctx), args.student || args.name);
    if (!hit.student) return { ...hit, error: `I could not place "${clean(args.student || args.name, 120)}" in ${cls.label}.`, next: 'Call resolve_students with the name and class first.' };
    student = students.find((item) => item.id === hit.student.student_id);
  }

  const request = requestId();
  const written = await opsRpc('school_correct_score', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_class_key: cls.key,
    p_term: term,
    p_academic_session: session,
    p_subject_index: subject.index,
    p_component: component.component,
    p_student_id: student.id,
    p_new_value: value,
    p_reason: clean(args.reason, 300) || 'Correction requested in chat',
    p_request_id: request,
  });
  if (!written?.ok) return { ...written, next: written?.next || 'Nothing was changed. Re-read the score with get_scores, then retry.' };
  return {
    corrected: true,
    pupil: student.name,
    class: cls.label,
    subject: subject.label,
    subject_index: subject.index,
    component: COMPONENT_LABEL[component.component],
    old_value: written.old_value,
    new_value: written.new_value,
    reason: written.reason,
    batch_id: written.batch_id,
    verify: written.verify,
    undo: written.undo,
    next: 'Report the old value, the new value and the verified count.',
  };
}

// ---------------------------------------------------------------------------
// undo_batch
// ---------------------------------------------------------------------------
async function undoBatch(ctx, args, context) {
  let batchId = clean(args.batch_id, 40);
  if (!batchId) {
    const last = await opsRpc('school_last_batch', { p_school_id: ctx.actor.school_id });
    batchId = last?.id || last?.batch_id || '';
  }
  if (!batchId) return { error: 'There is no batch to undo.', next: 'Nothing has been written in this school yet.' };
  const written = await opsRpc('school_undo_batch', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_batch_id: batchId,
    p_request_id: requestId(),
  });
  if (!written?.ok) return { ...written, next: written?.next || 'Nothing was changed. Check the batch id, then retry.' };
  return {
    undone: true,
    batch_id: batchId,
    action: written.action,
    restored: written.restored,
    removed_rows: written.removed_rows,
    already_undone: written.already_undone === true,
    next: 'Re-read the class with completeness_report and report the verified counts.',
  };
}

// ---------------------------------------------------------------------------
// remember_alias / approve_batch / publish_results
// ---------------------------------------------------------------------------
async function rememberAlias(ctx, args, context) {
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const classRaw = clean(args.class, 80);
  const cls = classRaw ? classEntry(active, classRaw) : null;
  const students = await loadStudents(ctx, resolveSession(args, active), cls?.key || null);
  let student = clean(args.student_id, 40) ? students.find((item) => item.id === clean(args.student_id, 40)) : null;
  if (!student) {
    const hit = resolveOneName(students, [], args.student || args.name);
    if (!hit.student) return { error: `I could not place "${clean(args.student || args.name, 120)}".`, next: 'Call resolve_students with the class and both names first.' };
    student = students.find((item) => item.id === hit.student.student_id);
  }
  const alias = clean(args.sheet_name || args.alias, 120);
  if (!alias) return { error: 'Give the name exactly as it appears on the sheet.', next: 'Call remember_alias with sheet_name and the pupil.' };
  const saved = await opsRpc('school_remember_alias', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_class_key: student.class_key,
    p_alias: alias,
    p_alias_norm: normaliseName(alias),
    p_student_id: student.id,
    p_request_id: requestId(),
  });
  return { ...saved, pupil: student.name, class: student.class_key, next: 'The same sheet name will now match without asking again.' };
}

async function approveBatch(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot for the real class list.' };
  const term = resolveTerm(args, active);
  const session = resolveSession(args, active);
  let subjects = args.subjects;
  if (subjects == null || subjects === 'all' || (Array.isArray(subjects) && !subjects.length)) subjects = ['all'];
  if (Array.isArray(subjects)) {
    subjects = subjects.map((item) => {
      if (typeof item === 'number') return item;
      const text = clean(item, 120);
      if (!text || /^all$/i.test(text)) return 'all';
      if (/^\d+$/.test(text)) return Number(text);
      const entry = subjectEntries(config, cls.key).find((subject) => normalise(subject.label) === normalise(text));
      return entry ? entry.index : text;
    });
  }
  const written = await opsRpc('school_approve_batch', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_class_key: cls.key,
    p_term: term,
    p_academic_session: session,
    p_subjects: subjects,
    p_request_id: requestId(),
  });
  return { ...written, class: cls.label, term, session, next: written?.next || 'Call generate_documents with mode "final" now.' };
}

async function publishResults(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot for the real class list.' };
  const term = resolveTerm(args, active);
  const session = resolveSession(args, active);
  let subjects = args.subjects;
  if (subjects == null || subjects === 'all' || (Array.isArray(subjects) && !subjects.length)) subjects = ['all'];
  if (Array.isArray(subjects)) {
    subjects = subjects.map((item) => {
      if (typeof item === 'number') return item;
      const text = clean(item, 120);
      if (!text || /^all$/i.test(text)) return 'all';
      if (/^\d+$/.test(text)) return Number(text);
      const entry = subjectEntries(config, cls.key).find((subject) => normalise(subject.label) === normalise(text));
      return entry ? entry.index : text;
    });
  }
  const written = await opsRpc('school_set_published', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_class_key: cls.key,
    p_term: term,
    p_academic_session: session,
    p_subject_indexes: subjects,
    p_published: args.published !== false,
    p_request_id: requestId(),
  });
  return { ...written, class: cls.label, term, session };
}

// ---------------------------------------------------------------------------
// update_subject_catalog: stable indexes, hidden subjects keep their place.
// ---------------------------------------------------------------------------
async function updateSubjectCatalog(ctx, args, context) {
  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot for the real class list.' };
  const action = clean(args.action, 20).toLowerCase() || 'list';
  const current = config.depts?.[cls.key]?.subjects;
  if (!Array.isArray(current)) return { error: `The catalog has no subject list for ${cls.label}.`, next: 'Call get_school_snapshot to check the class catalog.' };
  const next = JSON.parse(JSON.stringify(current));
  const status = JSON.parse(JSON.stringify(config.subjectStatus || {}));
  const classStatus = status[cls.key] && typeof status[cls.key] === 'object' ? { ...status[cls.key] } : {};

  if (action === 'list') {
    return {
      class_key: cls.key,
      class: cls.label,
      subjects: subjectEntries(config, cls.key).map((subject) => ({
        ...subject,
        hidden: classStatus[subject.index] === false,
      })),
      next: 'Use action add, rename, activate, deactivate or remove with an index.',
    };
  }
  if (action === 'add') {
    const label = clean(args.subject || args.name, 120);
    if (!label) return { error: 'Give the new subject name.', next: 'Call update_subject_catalog with action "add" and subject.' };
    if (subjectEntries(config, cls.key).some((subject) => normalise(subject.label) === normalise(label))) {
      return { error: `${label} is already in ${cls.label}.`, next: 'Use action rename if the spelling should change.' };
    }
    next.push(label);
  } else {
    let index = Number(args.subject_index);
    if (!Number.isInteger(index)) {
      const found = await resolveSubjectFor(ctx, config, active, cls.key, args.subject || args.name);
      if (!found.ok) return found;
      index = found.index;
    }
    if (index < 0 || index >= next.length) {
      return { error: `There is no subject at index ${index} in ${cls.label}.`, next: 'Call update_subject_catalog with action "list" to see the stored indexes.' };
    }
    if (action === 'rename') {
      const label = clean(args.new_name || args.subject || args.name, 120);
      if (!label) return { error: 'Give the new subject name.', next: 'Call update_subject_catalog with action "rename" and new_name.' };
      next[index] = label;
    } else if (action === 'activate' || action === 'deactivate') {
      classStatus[index] = action === 'activate';
    } else if (action === 'remove') {
      // Never splice: an index is the subject's permanent identity. A removed
      // subject is hidden and its index stays reserved.
      classStatus[index] = false;
    } else {
      return { error: `Unknown catalog action "${action}".`, next: 'Use list, add, rename, activate, deactivate or remove.' };
    }
  }

  const nextConfig = { ...config, depts: { ...config.depts, [cls.key]: { ...config.depts[cls.key], subjects: next } } };
  if (Object.keys(classStatus).length) {
    nextConfig.subjectStatus = { ...status, [cls.key]: classStatus };
  }
  await require('./result-data').handleAction('settings.app_config.update', { config: nextConfig }, ctx.token);
  const logged = await opsRpc('school_log_batch', {
    p_school_id: ctx.actor.school_id,
    p_actor_id: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_action: `subject_catalog_${action}`,
    p_request_id: requestId(),
    p_class_key: cls.key,
    p_summary: { action, subject: clean(args.subject || args.name || args.new_name, 120), index: Number(args.subject_index) || null },
    p_detail: { before: current, after: next, status: classStatus },
  }).catch(() => null);
  return {
    ok: true,
    class_key: cls.key,
    class: cls.label,
    action,
    subjects: subjectEntries(nextConfig, cls.key).map((subject) => ({
      ...subject,
      hidden: classStatus[subject.index] === false,
    })),
    batch_id: logged?.batch_id || null,
    next: 'Hidden subjects keep their index and their saved scores. Entry screens hide them; nothing is renumbered.',
  };
}

// ---------------------------------------------------------------------------
// Documents: sample never needs approval; final uses approved subjects and one
// confirmation that can approve the whole class in the same action.
// ---------------------------------------------------------------------------
function confirmationToken(ctx, tool, args) {
  // Same shape as tokenFor in _ops-tools.js: the browser posts this back and
  // ops-jobs recomputes it before the action runs.
  return crypto.createHash('sha256')
    .update(`${ctx.actor.school_id}|${tool}|${JSON.stringify(args || {})}`)
    .digest('hex')
    .slice(0, 24);
}

async function approvalFor(ctx, classKey, term, session) {
  return await opsRpc('school_result_approval', {
    p_school_id: ctx.actor.school_id,
    p_class_key: classKey,
    p_term: term,
    p_academic_session: session,
  }).catch(() => null);
}

function approvalCovers(approval, subjects) {
  if (!approval) return false;
  if (approval.approved_all) return true;
  const approved = new Set((approval.subjects || []).map(Number));
  return subjects.every((subject) => approved.has(subject.index));
}

function gradeFor(config, percent) {
  const scale = Array.isArray(config.gradeScale) ? config.gradeScale : [];
  const hit = scale.find((row) => percent >= Number(row.min) && percent <= Number(row.max));
  return hit ? clean(hit.g, 10) : '—';
}

// The card's Remark column is one narrow cell. Use the grade scale's short
// label there ("Very Good"), not the long term remark that belongs at the foot
// of the card.
function gradeRemarkFor(config, percent) {
  const scale = Array.isArray(config.gradeScale) ? config.gradeScale : [];
  const hit = scale.find((row) => percent >= Number(row.min) && percent <= Number(row.max));
  return hit ? clean(hit.r || hit.remark, 40) : '';
}

function remarkFor(config, percent) {
  const bands = Array.isArray(config.remarks) ? config.remarks : [];
  const hit = bands.find((row) => percent >= Number(row.min) && percent <= Number(row.max));
  return hit ? clean(hit.text, 300) : '';
}

// The portal's card ends with the next-term fee schedule of the class fee
// group. It comes from the same saved bill settings the portal uses, so the
// download shows the school's own figures and never an invented amount.
const FEE_CATS = {
  kg1: 'early_childhood', kg2: 'early_childhood', nursery1: 'early_childhood', nursery2: 'early_childhood',
  primary1: 'primary', primary2: 'primary', primary3: 'primary', primary4: 'primary', primary5: 'primary',
  jss1: 'junior_secondary', jss2: 'junior_secondary', jss3: 'junior_secondary',
  'ss1-general': 'senior_secondary', 'ss1-science': 'senior_secondary', 'ss1-arts': 'senior_secondary', 'ss1-business': 'senior_secondary',
  'ss2-science': 'senior_secondary', 'ss2-arts': 'senior_secondary', 'ss2-business': 'senior_secondary',
  'ss3-science': 'senior_secondary', 'ss3-arts': 'senior_secondary', 'ss3-business': 'senior_secondary',
};
const BILL_LINES = ['Tuition', 'P.T.A. Subscription', 'Sport Wear', 'Exam Fee', 'Lesson Fee'];

function nextTermFees(config, classKey) {
  const sessionCfg = config.sessionCfg || {};
  const category = FEE_CATS[classKey] || 'primary';
  const custom = (sessionCfg.customBillLines && sessionCfg.customBillLines[category]) || [];
  const gone = (sessionCfg.removedBillLines && sessionCfg.removedBillLines[category]) || [];
  const enabled = sessionCfg.billLineEnabled && sessionCfg.billLineEnabled[category];
  const labels = [...BILL_LINES, ...(Array.isArray(custom) ? custom : [])]
    .filter((label, i, all) => label && all.indexOf(label) === i && gone.indexOf(label) < 0);
  const matrix = (sessionCfg.bills && sessionCfg.bills[category]) || {};
  return labels
    .filter((label) => !(enabled && enabled[label] === false))
    .map((label) => ({ label, amount: Number(matrix[label] || 0) }))
    .filter((row) => row.amount > 0);
}

async function buildDocumentData(ctx, config, active, args, options = {}) {
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".` };
  const term = resolveTerm(args, active);
  const session = resolveSession(args, active);
  let subjects = subjectEntries(config, cls.key).filter((subject) => subject.active);
  if (options.approval && !options.approval.approved_all) {
    const approved = new Set((options.approval.subjects || []).map(Number));
    subjects = subjects.filter((subject) => approved.has(subject.index));
  }
  if (!subjects.length) {
    return { error: `No ${options.mode === 'final' ? 'approved ' : ''}subjects have marks in ${cls.label}.`, next: options.mode === 'final' ? 'Call approve_batch for the class, then generate again.' : 'Record some marks first, then preview again.' };
  }
  const [students, scores, remarks, traits] = await Promise.all([
    loadStudents(ctx, session, cls.key),
    loadScores(ctx, session, term, cls.key),
    loadRemarks(ctx, session, term, cls.key),
    loadTraits(ctx, session, term, cls.key),
  ]);
  if (!students.length) return { error: `${cls.label} has no active pupils.`, next: 'Check the class list with get_school_snapshot.' };
  const remarkById = new Map((remarks || []).map((row) => [row.student_id, row]));
  const traitsById = new Map();
  for (const row of traits) {
    if (!traitsById.has(row.student_id)) traitsById.set(row.student_id, { affective: {}, psychomotor: {} });
    const bucket = traitsById.get(row.student_id);
    const kind = String(row.trait_type || '').toLowerCase().startsWith('psych') ? 'psychomotor' : 'affective';
    if (row.trait_name) bucket[kind][row.trait_name] = row.rating;
  }
  const rowsByStudent = new Map();
  for (const row of scores) {
    if (!rowsByStudent.has(row.student_id)) rowsByStudent.set(row.student_id, []);
    rowsByStudent.get(row.student_id).push(row);
  }
  const subjectMax = subjects.reduce((sum, subject) => {
    const assessment = config.assessment || {};
    const caCount = Math.max(1, Math.min(3, Number(assessment.caCount) || 1));
    const caMarks = Array.isArray(assessment.caMarks) ? assessment.caMarks : [];
    let max = Number(assessment.examMark || 100);
    for (let i = 0; i < caCount; i += 1) max += Number(caMarks[i] || 0);
    return sum + max;
  }, 0) / Math.max(1, subjects.length);

  const pupils = students.map((student) => {
    const bySubject = new Map((rowsByStudent.get(student.id) || []).map((row) => [Number(row.subject_index), row]));
    const marks = {};
    const parts = {};
    const grades = {};
    const gradeRemarks = {};
    let total = 0;
    let counted = 0;
    const missing = [];
    for (const subject of subjects) {
      const row = bySubject.get(subject.index);
      const value = subjectTotal(row);
      if (value == null) {
        missing.push(String(subject.index));
        continue;
      }
      marks[String(subject.index)] = Number(value.toFixed(2));
      // The card prints CA1, CA2 and the exam as columns, so the split is kept
      // beside the total. A blank part stays blank.
      parts[String(subject.index)] = {
        ca1: row.ca1, ca2: row.ca2, ca3: row.ca3, exam: row.exam,
      };
      const percent = subjectMax ? (Number(value) / subjectMax) * 100 : Number(value);
      grades[String(subject.index)] = gradeFor(config, percent);
      gradeRemarks[String(subject.index)] = gradeRemarkFor(config, percent);
      total += Number(value);
      counted += 1;
    }
    const average = counted ? total / counted : null;
    const remarkRow = remarkById.get(student.id);
    const averagePercent = average != null && subjectMax ? (average / subjectMax) * 100 : null;
    const teacherRemark = clean(remarkRow?.academic || remarkRow?.form_master, 400);
    return {
      student_id: student.id,
      name: student.name,
      admno: student.admno || null,
      gender: student.gender || null,
      age: student.age || null,
      photo: student.photo || null,
      traits: traitsById.get(student.id) || null,
      marks,
      parts,
      grades,
      grade_remarks: gradeRemarks,
      total: counted ? Number(total.toFixed(2)) : null,
      average: average == null ? null : Number(average.toFixed(2)),
      overall_grade: averagePercent != null ? gradeFor(config, averagePercent) : null,
      counted_subjects: counted,
      max_total: counted ? Number((subjectMax * counted).toFixed(2)) : null,
      missing_subjects: missing,
      asterisk: missing.length > 0,
      remark: teacherRemark || (averagePercent != null ? remarkFor(config, averagePercent) : null) || null,
      general_remark: teacherRemark || (average != null ? remarkFor(config, averagePercent) : null) || null,
    };
  // Every pupil keeps their card even before marks are entered: the card is the
  // school's real form, so a blank subject simply prints empty.
  });

  if (!pupils.length) {
    return { error: `${cls.label} has no active pupils for ${term}.`, next: 'Check the class list with get_school_snapshot.' };
  }

  const ranked = [...pupils].sort((a, b) => b.average - a.average || String(a.name).localeCompare(String(b.name)));
  let position = 0;
  let previous = null;
  ranked.forEach((pupil, index) => {
    if (previous == null || pupil.average !== previous) position = index + 1;
    pupil.position = position;
    previous = pupil.average;
  });

  const withAverage = pupils.filter((pupil) => pupil.average != null);
  const classAverage = withAverage.length
    ? withAverage.reduce((sum, pupil) => sum + pupil.average, 0) / withAverage.length
    : null;
  const averageValues = withAverage.map((pupil) => pupil.average);
  const totals = pupils.map((pupil) => pupil.total).filter((value) => value != null);
  const subjectStats = subjects.map((subject) => {
    const values = pupils.map((pupil) => pupil.marks[String(subject.index)]).filter((value) => value != null);
    return {
      key: String(subject.index),
      label: subject.label,
      count: values.length,
      average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      highest: values.length ? Math.max(...values) : null,
      lowest: values.length ? Math.min(...values) : null,
    };
  });
  const school = config.school || {};
  return {
    fees_next_term: nextTermFees(config, cls.key),
    // Card presentation the school has chosen: the same section toggles and
    // assessment split the portal card uses.
    sections: config.sections || {},
    traits: {
      affective: (Array.isArray((config.traits || {}).affective) && config.traits.affective.length)
        ? config.traits.affective : null,
      psychomotor: (Array.isArray((config.traits || {}).psychomotor) && config.traits.psychomotor.length)
        ? config.traits.psychomotor : null,
    },
    assessment: {
      caCount: Math.max(1, Math.min(3, Number((config.assessment || {}).caCount) || 1)),
      caMarks: Array.isArray((config.assessment || {}).caMarks) ? config.assessment.caMarks : [],
      examMark: Number((config.assessment || {}).examMark) || 100,
    },
    class_key: cls.key,
    class_label: cls.label,
    term,
    academic_session: session,
    school_name: school.name || 'FIRST CHOICE STANDARD SCHOOLS',
    school_address: school.addr || '',
    school_phone: school.phone || '',
    school_email: school.email || '',
    signature_title: clean((config.signature || {}).title, 60) || 'School Proprietor',
    subject_set: subjects.map((subject) => ({ key: String(subject.index), label: subject.label })),
    pupils: pupils.sort((a, b) => String(a.admno || '').localeCompare(String(b.admno || '')) || String(a.name).localeCompare(String(b.name))),
    column_label: 'ALL SUBJECTS',
    template_version: `${clean(args.template, 40) || 'modern'}-v1`,
    template: clean(args.template, 40) || 'modern',
    sample: options.mode === 'sample',
    stats: {
      class_size: pupils.length,
      average: classAverage == null ? null : Number(classAverage.toFixed(2)),
      highest: totals.length ? Math.max(...totals) : null,
      lowest: totals.length ? Math.min(...totals) : null,
      highest_average: averageValues.length ? Math.max(...averageValues) : null,
      lowest_average: averageValues.length ? Math.min(...averageValues) : null,
      subjects: subjectStats,
      order_rule: 'Ordered by admission number.',
      position_rule: 'Positions use the average of subjects with a mark. A missing mark is never filled with zero.',
    },
  };
}

async function generateDocuments(ctx, args, context, confirmed = false) {  const config = await loadConfig(ctx);
  const active = { ...(await loadContextRows(ctx)), ...(context || {}) };
  const cls = classEntry(active, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 80)}".`, next: 'Call get_school_snapshot for the real class list.' };
  const term = resolveTerm(args, active);
  const session = resolveSession(args, active);
  const mode = clean(args.mode, 12).toLowerCase() === 'final' ? 'final' : 'sample';
  const kindArg = clean(args.kind, 20).toLowerCase() || 'cards';
  const kinds = kindArg === 'both' ? ['broadsheet', 'cards'] : (kindArg === 'broadsheet' ? ['broadsheet'] : ['cards']);
  const templatesIn = Array.isArray(args.templates) && args.templates.length
    ? args.templates.map((item) => clean(item, 40)).filter(Boolean)
    : [clean(args.template, 40) || 'modern'];
  const templates = [...new Set(templatesIn)].slice(0, 4);
  const unknown = templates.find((template) => !['modern', 'classic', 'compact', 'premium'].includes(template));
  if (unknown) {
    return { error: `There is no template called "${unknown}".`, templates: ['modern', 'classic', 'compact', 'premium'], next: 'Call generate_documents with one of those template names.' };
  }

  const subjects = subjectEntries(config, cls.key).filter((subject) => subject.active);
  const onePupil = clean(args.pupil || (Array.isArray(args.pupils) ? args.pupils[0] : ''), 120);
  let approval = mode === 'final' ? await approvalFor(ctx, cls.key, term, session) : null;
  if (mode === 'final' && !approvalCovers(approval, subjects)) {
    if (!confirmed) {
      return {
        needs_confirmation: true,
        summary: `Approve all ${subjects.length} subjects for ${cls.label}, ${term} and generate final ${kinds.join(' and ')} for${onePupil ? ` ${onePupil}` : ' the whole class'}${templates.length > 1 ? ` in ${templates.length} templates` : ` in the ${templates[0]} template`}? Nothing is published, and every score stays as it is.`,
        tool: 'generate_documents',
        args,
        token: confirmationToken(ctx, 'generate_documents', args),
        next: 'Tap Confirm once; the same action approves the class and renders the documents.',
      };
    }
    const approved = await opsRpc('school_approve_batch', {
      p_school_id: ctx.actor.school_id,
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email,
      p_class_key: cls.key,
      p_term: term,
      p_academic_session: session,
      p_subjects: ['all'],
      p_request_id: requestId(),
    });
    if (!approved?.ok) return { ...approved, error: approved?.error || 'The class approval did not save.' };
    approval = await approvalFor(ctx, cls.key, term, session);
  }

  const documents = [];
  for (const template of templates) {
    const data = await buildDocumentData(ctx, config, active, { ...args, class: cls.label, template }, { mode, approval, single: !!onePupil });
    if (data.error) return data;
    // One learner on request: the card set becomes that pupil's single card,
    // while the class statistics behind the position line stay the whole class.
    if (onePupil) {
      const list = Array.isArray(data.pupils) ? data.pupils : [];
      const want = normalise(onePupil);
      const hit = list.find((pupil) => normalise(pupil.name) === want)
        || list.find((pupil) => similarity(pupil.name, want) >= 0.82);
      if (!hit) {
        return {
          error: `No pupil called "${onePupil}" is on ${cls.label} for ${term}.`,
          pupils: list.map((pupil) => pupil.name).slice(0, 40),
          next: 'Name one of those pupils, or leave pupil empty for the whole class.',
        };
      }
      data.pupils = [hit];
      data.single_pupil = hit.name;
    }
    for (const kind of kinds) {
      const rendered = kind === 'broadsheet' ? await renderBroadsheet(data) : await renderCards(data);
      if (onePupil && kind === 'cards') {
        const slug = String(onePupil).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pupil';
        rendered.filename = String(rendered.filename || 'card.pdf').replace(/\.pdf$/i, '') + '-' + slug + '.pdf';
      }
      const stored = await opsRpc('school_store_document', {
        p_school_id: ctx.actor.school_id,
        p_actor_id: ctx.actor.id,
        p_actor_email: ctx.actor.email,
        p_class_key: cls.key,
        p_term: term,
        p_academic_session: session,
        p_template: template,
        p_kind: kind,
        p_mode: mode,
        p_filename: rendered.filename,
        p_mime: rendered.mime,
        p_content_b64: rendered.buffer.toString('base64'),
        p_sha256: crypto.createHash('sha256').update(rendered.buffer).digest('hex'),
        p_page_count: rendered.pageCount,
        p_summary: {
          class: cls.label,
          pupils: data.stats.class_size,
          average: data.stats.average,
          sample: mode === 'sample',
          subjects: data.subject_set.length,
          approved: mode === 'final',
        },
      });
      if (!stored?.ok) return { ...stored, error: stored?.error || 'The document could not be stored.' };
      documents.push({
        id: stored.document_id,
        url: stored.url,
        filename: stored.filename,
        type: kind,
        kind,
        class: cls.label,
        class_key: cls.key,
        term,
        academic_session: session,
        template,
        mode,
        pupil: data.single_pupil || null,
        page_count: rendered.pageCount,
        sample: mode === 'sample',
      });
    }
  }
  return {
    generated: true,
    mode,
    class: cls.label,
    class_key: cls.key,
    term,
    session,
    templates,
    documents,
    approved_all: approval ? approval.approved_all === true : false,
    next: mode === 'sample'
      ? `These are samples, clearly marked. Each has a download button and a Print button; Print opens the school's own coloured card for that pupil and sends it to the normal print sheet. No approval was used and the school theme did not change.`
      : `Final cards/broadsheets are ready. ${documents.length} document${documents.length === 1 ? '' : 's'} stored and ready to download.`,
  };
}

module.exports = {
  getSchoolSnapshot,
  resolveStudents,
  resolveSubject,
  getScores,
  completenessReport,
  rankStudents,
  compareWithExisting,
  recordScores,
  correctScore,
  undoBatch,
  rememberAlias,
  approveBatch,
  publishResults,
  updateSubjectCatalog,
  generateDocuments,
  // sheet reader
  prepareSheetReview,
  resolveSubjectFor,
  loadSheetState,
  applySheetAnswers,
  commitSheetReview,
  sheetReviewText,
  parseSheetAnswers,
  buildSheetReview,
  nameScore,
  // shared helpers used by the tool layer
  loadConfig,
  loadContextRows,
  classEntry,
  subjectEntries,
  resolveSubjectFor,
  normaliseName,
  requestId,
  COMPONENT_LABEL,
  COMPONENTS,
};
