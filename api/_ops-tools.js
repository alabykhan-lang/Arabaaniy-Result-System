'use strict';

// Tool layer for the developer Command Center agent. Every tool runs through
// the same handlers the portal itself uses (api/result-data.js) or the same
// ops RPCs, with the signed-in developer's own token, so the agent can only do
// what that account could already do on the portal and RLS still applies.
//
// Destructive calls need a confirmation: the first call returns a token, the
// browser posts it back, and only then is the write made.

const crypto = require('node:crypto');
const { supabaseRest } = require('./_lib');
const { opsRpc } = require('./_ops');
const { renderDocuments } = require('./_ops-documents');
const { handleAction } = require('./result-data');
const { findSubject, findClass, findColumn, findTerm, normalise } = require('./_ops-instruction');
const {
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
  loadSheetState,
  applySheetAnswers,
  commitSheetReview,
  sheetReviewText,
} = require('./_school-actions');

function tokenFor(schoolId, tool, args) {
  return crypto.createHash('sha256')
    .update(`${schoolId}|${tool}|${JSON.stringify(args || {})}`)
    .digest('hex')
    .slice(0, 24);
}

function clean(value, max = 400) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// The same column is called "CA" by a teacher and "CLASS EXERCISE" on a card.
function normalizeColumn(value) {
  const found = findColumn(String(value || ''));
  return normalise(found || value);
}

function classEntry(context, keyOrLabel) {
  const raw = String(keyOrLabel == null ? '' : keyOrLabel).trim();
  if (!raw) return null;
  const classes = Array.isArray(context?.classes) ? context.classes : [];
  const want = normalise(raw);
  const exact = classes.find((c) => normalise(c.key) === want || normalise(c.label) === want);
  if (exact) return exact;
  // Everyday short forms: "nur 1" is Nursery 1, "pri 5" is Primary 5.
  const found = findClass(raw, { ...(context || {}), classes });
  return found || null;
}

function subjectIndex(context, classKey, subjectName) {
  const cls = (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === classKey);
  if (!cls || !Array.isArray(cls.subjects)) return -1;
  const want = normalise(subjectName);
  if (!want) return -1;
  const exact = cls.subjects.findIndex((s) => normalise(s) === want);
  if (exact >= 0) return exact;
  const found = findSubject(subjectName, cls, context);
  if (found) return cls.subjects.findIndex((s) => normalise(s) === normalise(found));
  return -1;
}

async function activeContext(ctx, context) {
  return {
    session: clean(context?.academic_session, 30),
    term: clean(context?.term, 30),
  };
}

async function listStudents(ctx, classKey) {
  const scope = classKey ? `&class_key=eq.${encodeURIComponent(classKey)}` : '';
  return await supabaseRest(
    `students?archived=eq.false${scope}&select=id,name,class_key,admno,gender&order=name.asc&limit=4000`,
    {},
    ctx.token,
  ) || [];
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const next = [i];
    for (let j = 1; j < cols; j += 1) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[cols - 1];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  return longest ? Math.max(0, 1 - editDistance(a, b) / longest) : 0;
}

function scoreName(name, want) {
  const a = normalise(name);
  const b = normalise(want);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const at = a.split(/\s+/).filter(Boolean);
  const bt = b.split(/\s+/).filter(Boolean);
  if (!at.length || !bt.length) return 0;
  let score = 0;
  // A shared surname carries the most weight, then given-name similarity.
  if (at[0] === bt[0]) score += 30;
  for (let i = 0; i < bt.length; i += 1) {
    let best = 0;
    for (const token of at) best = Math.max(best, similarity(token, bt[i]));
    score += best * (i === 0 ? 18 : 14);
  }
  score -= Math.max(0, at.length - bt.length) * 2;
  return score > 3 ? score : 0;
}

async function resolvePupil(ctx, args, context) {
  const id = clean(args.student_id, 40);
  if (id) {
    const rows = await supabaseRest(`students?id=eq.${encodeURIComponent(id)}&limit=1`, {}, ctx.token);
    if (rows?.[0]) return { pupil: rows[0] };
    return { error: 'That pupil id was not found.' };
  }
  const name = clean(args.name || args.pupil, 120);
  if (!name) return { error: 'A pupil name is required.' };
  const cls = args.class ? classEntry(context, args.class) : null;
  if (args.class && !cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const rows = await listStudents(ctx, cls?.key || null);
  const exactLive = rows.filter((row) => normalise(row.name) === normalise(name));
  if (exactLive.length === 1) return { pupil: exactLive[0] };
  if (exactLive.length > 1) {
    return {
      candidates: exactLive.slice(0, 8).map((item) => ({ name: item.name, class: item.class_key, admno: item.admno, student_id: item.id })),
      error: `More than one pupil is called ${name}. Which class or admission number?`,
    };
  }

  const archived = await supabaseRest(
    `students?archived=eq.true${cls ? `&class_key=eq.${encodeURIComponent(cls.key)}` : ''}&select=id,name,class_key,admno,gender,archived,academic_session&order=name.asc&limit=4000`,
    {},
    ctx.token,
  ).catch(() => []);
  const exactOld = (Array.isArray(archived) ? archived : []).filter((row) => normalise(row.name) === normalise(name));
  if (exactOld.length === 1) return { pupil: exactOld[0] };

  const ranked = rows
    .map((row) => ({ row, score: scoreName(row.name, name) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { error: `No pupil called "${name}" is on the class list.` };
  const best = ranked[0].score;
  const close = ranked.filter((item) => item.score >= best - 4).slice(0, 6);
  if (close.length === 1) return { pupil: close[0].row };
  return {
    candidates: close.map((item) => ({ name: item.row.name, class: item.row.class_key, admno: item.row.admno, student_id: item.row.id })),
    error: `I found ${close.length} pupils like "${name}". Which one?`,
  };
}

async function pupilSummary(row, context) {
  const cls = (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === row.class_key);
  return {
    student_id: row.id,
    name: row.name,
    class: cls?.label || row.class_key,
    class_key: row.class_key,
    admno: row.admno || null,
    gender: row.gender || null,
    ...(row.archived ? { archived: true } : {}),
  };
}

async function settingsRow(ctx) {
  const read = await handleAction('settings.read', {}, ctx.token);
  return read?.settings || { app_config: {}, academic_context: {} };
}

function cleanKeys(value) {
  if (Array.isArray(value)) return value.map(cleanKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[String(key).replace(/^["'\s]+|["'\s]+$/g, '')] = cleanKeys(item);
  }
  return out;
}

function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base?.[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') return 'The settings patch must be an object.';
  if (config.term && !['1st Term', '2nd Term', '3rd Term'].includes(config.term)) {
    return 'The term must be 1st Term, 2nd Term or 3rd Term.';
  }
  if (config.session && !/^\d{4}\/\d{4}$/.test(String(config.session))) {
    return 'The session must look like 2026/2027.';
  }
  if (config.assessment) {
    const a = config.assessment;
    if (a.caCount != null && ![1, 2, 3].includes(Number(a.caCount))) return 'CA count must be 1, 2 or 3.';
    if (a.examMark != null && !(Number(a.examMark) > 0 && Number(a.examMark) <= 100)) return 'Exam mark must be between 1 and 100.';
    if (Array.isArray(a.caMarks) && a.caMarks.some((m) => !(Number(m) > 0 && Number(m) <= 100))) return 'CA marks must be between 1 and 100.';
  }
  if (config.depts && typeof config.depts === 'object') {
    for (const [key, dept] of Object.entries(config.depts)) {
      if (!dept || typeof dept !== 'object') return `The ${key} department must be an object.`;
      if (dept.subjects && (!Array.isArray(dept.subjects) || dept.subjects.some((s) => !clean(s, 80)))) {
        return `The ${key} subject list must be a list of names.`;
      }
    }
  }
  return null;
}

async function schoolOverview(ctx, context) {
  const { session, term } = await activeContext(ctx, context);
  const [students, scores] = await Promise.all([
    supabaseRest(`students?archived=eq.false${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}&select=class_key,gender&limit=20000`, {}, ctx.token).catch(() => []),
    session && term
      ? supabaseRest(`scores?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&select=class_key,subject_index,ca1,ca2,ca3,exam&limit=20000`, {}, ctx.token).catch(() => [])
      : Promise.resolve([]),
  ]);
  const rows = Array.isArray(students) ? students : [];
  const scoreRows = Array.isArray(scores) ? scores : [];
  const classes = (Array.isArray(context?.classes) ? context.classes : []).map((cls) => {
    const pupils = rows.filter((row) => row.class_key === cls.key);
    const filled = scoreRows.filter((row) => row.class_key === cls.key
      && (row.ca1 != null || row.ca2 != null || row.ca3 != null || row.exam != null));
    const subjectsFilled = new Set(filled.map((row) => Number(row.subject_index)));
    return {
      class: cls.label,
      class_key: cls.key,
      pupils: pupils.length,
      boys: pupils.filter((p) => p.gender === 'M' || p.gender === 'Male').length,
      girls: pupils.filter((p) => p.gender === 'F' || p.gender === 'Female').length,
      subjects: (cls.subjects || []).length,
      subjects_with_marks: subjectsFilled.size,
    };
  }).filter((cls) => cls.pupils > 0 || cls.subjects > 0);
  return {
    academic_session: session,
    term,
    total_pupils: rows.length,
    classes,
  };
}

async function classResults(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const { session, term } = await activeContext(ctx, context);
  const students = await listStudents(ctx, cls.key);
  const scores = await supabaseRest(
    `scores?class_key=eq.${encodeURIComponent(cls.key)}&academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&select=student_id,subject_index,ca1,ca2,ca3,exam&limit=20000`,
    {},
    ctx.token,
  ).catch(() => []);
  const wantedIndex = args.subject ? subjectIndex(context, cls.key, args.subject) : -1;
  if (args.subject && wantedIndex < 0) return { error: `"${clean(args.subject, 80)}" is not a subject in ${cls.label}.` };
  const rows = (Array.isArray(scores) ? scores : []).filter((row) => wantedIndex < 0 || Number(row.subject_index) === wantedIndex);
  const byId = Object.fromEntries(students.map((s) => [s.id, s]));
  const totals = {};
  const coverage = {};
  for (const row of rows) {
    // A pupil taken off the class list keeps their old score rows; they must
    // not count towards this class, or a removed name can still top the list.
    if (!byId[row.student_id]) continue;
    if (!coverage[row.subject_index]) coverage[row.subject_index] = new Set();
    coverage[row.subject_index].add(row.student_id);
    const has = row.ca1 != null || row.ca2 != null || row.ca3 != null || row.exam != null;
    if (!has) continue;
    totals[row.student_id] = (totals[row.student_id] || 0)
      + Number(row.ca1 || 0) + Number(row.ca2 || 0) + Number(row.ca3 || 0) + Number(row.exam || 0);
  }
  const ranked = Object.entries(totals)
    .map(([id, total]) => ({ name: byId[id]?.name || 'Pupil', total: Number(total.toFixed(1)) }))
    .sort((a, b) => b.total - a.total);
  const missing = students.filter((s) => !totals[s.id]).map((s) => s.name);
  return {
    class: cls.label,
    class_key: cls.key,
    term,
    academic_session: session,
    subject: args.subject ? cls.subjects[wantedIndex] : null,
    pupils: students.length,
    pupils_with_marks: ranked.length,
    average_total: ranked.length ? Number((ranked.reduce((sum, r) => sum + r.total, 0) / ranked.length).toFixed(1)) : null,
    highest: ranked[0] || null,
    lowest: ranked.length ? ranked[ranked.length - 1] : null,
    top_5: ranked.slice(0, 5),
    bottom_5: ranked.slice(-5).reverse(),
    pupils_without_marks: missing.slice(0, 40),
    subjects_with_marks: Object.keys(coverage).length,
    subject_count: (cls.subjects || []).length,
  };
}

async function pupilResults(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const cls = (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === pupil.class_key);
  const { session, term } = await activeContext(ctx, context);
  const rows = await supabaseRest(
    `scores?student_id=eq.${encodeURIComponent(pupil.id)}&academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&select=subject_index,ca1,ca2,ca3,exam&limit=100`,
    {},
    ctx.token,
  ).catch(() => []);
  const subjects = (Array.isArray(rows) ? rows : []).map((row) => {
    const total = Number(row.ca1 || 0) + Number(row.ca2 || 0) + Number(row.ca3 || 0) + Number(row.exam || 0);
    return {
      subject: (cls?.subjects || [])[Number(row.subject_index)] || `Subject ${Number(row.subject_index) + 1}`,
      ca1: row.ca1, ca2: row.ca2, ca3: row.ca3, exam: row.exam,
      total: Number(total.toFixed(1)),
    };
  });
  return {
    ...(await pupilSummary(pupil, context)),
    term,
    academic_session: session,
    subjects_recorded: subjects.length,
    subjects_with_marks: subjects.filter((s) => s.ca1 != null || s.ca2 != null || s.ca3 != null || s.exam != null).length,
    total_points: Number(subjects.reduce((sum, s) => sum + s.total, 0).toFixed(1)),
    subjects,
  };
}

function classNames(context) {
  return (Array.isArray(context?.classes) ? context.classes : []).map((c) => c.label).filter(Boolean);
}

// The pupil form in the portal gives every new pupil the next free STU/####
// in that class. The column is required downstream, so the assistant must
// assign one too instead of leaving it empty.
async function admissionNumbersInUse(ctx, classKey) {
  const rows = await supabaseRest(
    `students?class_key=eq.${encodeURIComponent(classKey)}&select=admno&limit=10000`, {}, ctx.token,
  ).catch(() => []);
  return new Set(rows.map((row) => String(row.admno || '').toUpperCase()).filter(Boolean));
}

function nextAdmissionNumber(used) {
  for (let i = 1; i < 10000; i += 1) {
    const candidate = `STU/${String(i).padStart(4, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  return `STU/${String(Date.now()).slice(-6)}`;
}

async function addPupil(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) {
    const names = classNames(context);
    return {
      error: `"${clean(args.class, 60)}" is not one of the school's classes, so no pupil was added. `
        + `The school has ${names.length} classes: ${names.join(', ')}. `
        + 'A new class has to be added to the school class list first; I can add it and its subjects, then the pupils.',
      known_classes: names,
    };
  }
  const name = clean(args.name, 120).replace(/\s+/g, ' ');
  if (name.length < 3) return { error: 'A full pupil name is required.' };
  const gender = /^(m|male|boy)$/i.test(clean(args.gender, 20)) ? 'Male'
    : /^(f|female|girl)$/i.test(clean(args.gender, 20)) ? 'Female' : '';
  if (!gender) return { error: 'A gender of male or female is required.' };
  const { session } = await activeContext(ctx, context);
  const existing = (await listStudents(ctx, cls.key)).find((s) => normalise(s.name) === normalise(name));
  if (existing) return { error: `${existing.name} is already on the ${cls.label} list (${existing.admno || 'no admission number'}).` };
  const admno = clean(args.admno, 60) || nextAdmissionNumber(await admissionNumbersInUse(ctx, cls.key));
  const saved = await handleAction('students.upsert', {
    class_key: cls.key,
    name,
    gender,
    admno,
    academic_session: session || undefined,
  }, ctx.token);
  return {
    added: true,
    pupil: await pupilSummary(saved.student, context),
    admission_number: saved.student?.admno || null,
  };
}

async function editPupil(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  // PostgREST upserts the whole row, so carry the required columns forward.
  const body = {
    id: pupil.id,
    class_key: pupil.class_key,
    name: pupil.name,
    gender: pupil.gender,
    admno: pupil.admno,
    academic_session: pupil.academic_session,
    archived: Boolean(pupil.archived),
  };
  if (args.new_name) body.name = clean(args.new_name, 120).replace(/\s+/g, ' ');
  if (args.gender) body.gender = /^(m|male|boy)$/i.test(args.gender) ? 'Male' : /^(f|female|girl)$/i.test(args.gender) ? 'Female' : pupil.gender;
  if (args.admno) body.admno = clean(args.admno, 60);
  if (args.new_class) {
    const cls = classEntry(context, args.new_class);
    if (!cls) return { error: `There is no class called "${clean(args.new_class, 60)}".` };
    body.class_key = cls.key;
  }
  const saved = await handleAction('students.upsert', body, ctx.token);
  return {
    updated: true,
    before: await pupilSummary(pupil, context),
    after: await pupilSummary(saved.student || pupil, context),
  };
}

async function archivePupil(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const saved = await handleAction('students.archive', {
    student_id: found.pupil.id,
    reason: clean(args.reason, 200) || 'Removed through the Command Center',
  }, ctx.token);
  return { archived: true, pupil: await pupilSummary(saved.student || found.pupil, context) };
}

// A class roster often starts as placeholder entries ("Bbj", "Fcgh") and the
// teacher wants them gone in one go, not one confirmation per name. "all" with
// an optional keep list covers that; explicit names cover a picked handful.
async function archivePupils(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) {
    return { error: `There is no class called "${clean(args.class, 60)}".`, next: 'Call get_school_snapshot for the real class list.' };
  }
  const roster = await listStudents(ctx, cls.key);
  if (!roster.length) return { error: `${cls.label} has no pupils on the live list.` };
  let chosen = [];
  if (args.all === true) {
    const keep = new Set((Array.isArray(args.keep) ? args.keep : []).map((n) => normalise(n)));
    chosen = roster.filter((row) => !keep.has(normalise(row.name)));
  } else {
    const wanted = (Array.isArray(args.names) ? args.names : []).map((n) => normalise(n)).filter(Boolean);
    if (!wanted.length) {
      return {
        error: 'Name the pupils to remove, or pass all=true to remove the whole class.',
        roster: roster.map((row) => row.name),
      };
    }
    const missing = [];
    for (const want of wanted) {
      const hit = roster.find((row) => normalise(row.name) === want)
        || roster.find((row) => similarity(row.name, want) >= 0.82);
      if (hit && !chosen.includes(hit)) chosen.push(hit);
      else if (!hit) missing.push(want);
    }
    if (missing.length && !chosen.length) {
      return {
        error: `None of those names is on the ${cls.label} list.`,
        roster: roster.map((row) => row.name),
      };
    }
    if (missing.length) return { error: `These names are not on the ${cls.label} list: ${missing.join(', ')}. Nothing was removed.`, roster: roster.map((row) => row.name) };
  }
  if (!chosen.length) return { error: `Every pupil in ${cls.label} is on the keep list, so nothing was removed.` };
  const reason = clean(args.reason, 200) || 'Removed through the Command Center';
  const removed = [];
  for (const row of chosen) {
    await handleAction('students.archive', { student_id: row.id, reason }, ctx.token);
    removed.push(row.name);
  }
  return {
    archived: true,
    class: cls.label,
    count: removed.length,
    pupils: removed,
    summary: `Removed ${removed.length} from ${cls.label}: ${removed.join(', ')}. The records are kept and can be restored.`,
    restored: 'Use action "restore" with a name to bring one back; the records are kept.',
  };
}

// Duplicate or blank admission numbers cannot be repaired one edit per pupil
// inside the tool-call budget (14 pupils would take 14 calls). This fixes a
// whole class in one call: the first holder of a number keeps it and every
// blank or repeated one moves to the next free number in join order.
async function repairAdmissionNumbers(ctx, args, context) {
  const targets = args.class
    ? [classEntry(context, args.class)].filter(Boolean)
    : (context?.classes || []).map((entry) => ({ key: entry.key, label: entry.label }));
  if (args.class && !targets.length) {
    return { error: `There is no class called "${clean(args.class, 60)}".`, next: 'Call get_school_snapshot for the real class list.' };
  }
  const report = [];
  for (const cls of targets) {
    const rows = await supabaseRest(
      `students?archived=eq.false&class_key=eq.${encodeURIComponent(cls.key)}&select=id,name,admno,created_at&order=created_at.asc&limit=4000`,
      {}, ctx.token,
    ) || [];
    const used = new Set(args.sequential ? [] : rows.map((row) => String(row.admno || '').trim().toUpperCase()).filter(Boolean));
    const seen = new Set();
    const moves = [];
    for (const row of rows) {
      const current = String(row.admno || '').trim().toUpperCase();
      // sequential renumbers the whole class so gaps and odd high numbers go
      // away too; otherwise the first holder of a number keeps it.
      if (!args.sequential && current && !seen.has(current)) { seen.add(current); continue; }
      const next = nextAdmissionNumber(used);
      used.add(next);
      if (next !== current) moves.push({ id: row.id, name: row.name, admno: next });
      else seen.add(current);
    }
    for (const move of moves) {
      await supabaseRest(`students?id=eq.${encodeURIComponent(move.id)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { admno: move.admno, updated_at: new Date().toISOString() },
      }, ctx.token);
    }
    if (moves.length) report.push({ class: cls.label, fixed: moves.length, pupils: moves.map((m) => `${m.name} ${m.admno}`) });
  }
  if (!report.length) return { ok: true, summary: 'Every pupil already has their own admission number, so nothing changed.' };
  const total = report.reduce((n, item) => n + item.fixed, 0);
  return {
    ok: true,
    fixed: report,
    summary: `Repaired ${total} admission number${total === 1 ? '' : 's'} across ${report.length} class${report.length === 1 ? '' : 'es'}: ${report.map((item) => `${item.class} (${item.fixed})`).join(', ')}.`,
  };
}

async function enterMarks(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const cls = (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === pupil.class_key);
  const index = subjectIndex(context, pupil.class_key, args.subject);
  if (index < 0) return { error: `"${clean(args.subject, 80)}" is not a subject in ${cls?.label || pupil.class_key}.` };
  const { session, term } = await activeContext(ctx, {
    ...context,
    academic_session: args.academic_session || context?.academic_session,
    term: args.term || context?.term,
  });
  const settings = await settingsRow(ctx);
  const assessment = settings.app_config?.assessment || {};
  const caMarks = Array.isArray(assessment.caMarks) ? assessment.caMarks : [30];
  const examMark = Number(assessment.examMark || 70);
  const limits = { ca1: Number(caMarks[0] || 30), ca2: Number(caMarks[1] || 30), ca3: Number(caMarks[2] || 30), exam: examMark };
  const body = {
    student_id: pupil.id,
    class_key: pupil.class_key,
    subject_index: index,
    term,
    academic_session: session,
    allow_correction: true,
  };
  for (const field of ['ca1', 'ca2', 'ca3', 'exam']) {
    if (args[field] == null || args[field] === '') continue;
    const value = Number(args[field]);
    if (!Number.isFinite(value) || value < 0 || value > limits[field]) {
      return { error: `${field.toUpperCase()} must be between 0 and ${limits[field]}.` };
    }
    body[field] = value;
  }
  if (body.ca1 == null && body.ca2 == null && body.ca3 == null && body.exam == null) {
    return { error: 'Give at least one mark to save.' };
  }
  const saved = await handleAction('scores.enter', body, ctx.token);
  return {
    saved: true,
    pupil: pupil.name,
    class: cls?.label || pupil.class_key,
    subject: cls?.subjects[index],
    term,
    mark: {
      ca1: saved.score?.ca1 ?? null,
      ca2: saved.score?.ca2 ?? null,
      ca3: saved.score?.ca3 ?? null,
      exam: saved.score?.exam ?? null,
    },
  };
}

async function pupilRecords(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const { session, term } = await activeContext(ctx, context);
  const scope = `student_id=eq.${encodeURIComponent(pupil.id)}&academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}`;
  const [fee, remark, traits] = await Promise.all([
    supabaseRest(`fees?${scope}&select=total,paid,debt&limit=1`, {}, ctx.token).catch(() => []),
    supabaseRest(`remarks?${scope}&select=academic,form_master,principal&limit=1`, {}, ctx.token).catch(() => []),
    supabaseRest(`traits?${scope}&select=trait_type,trait_name,rating&limit=100`, {}, ctx.token).catch(() => []),
  ]);
  const ratings = Array.isArray(traits) ? traits : [];
  return {
    pupil: await pupilSummary(pupil, context),
    term,
    fees: fee?.[0] || null,
    remarks: remark?.[0] || null,
    affective: Object.fromEntries(ratings.filter((t) => t.trait_type === 'affective').map((t) => [t.trait_name, t.rating])),
    psychomotor: Object.fromEntries(ratings.filter((t) => t.trait_type === 'psychomotor').map((t) => [t.trait_name, t.rating])),
  };
}

async function updateFee(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const { session, term } = await activeContext(ctx, context);
  const total = args.total != null ? Number(args.total) : null;
  const paid = args.paid != null ? Number(args.paid) : null;
  if (total != null && (!Number.isFinite(total) || total < 0)) return { error: 'The fee total must be a positive number.' };
  if (paid != null && (!Number.isFinite(paid) || paid < 0)) return { error: 'The amount paid must be a positive number.' };
  if (total == null && paid == null) return { error: 'Give a fee total or an amount paid.' };
  const existing = (await supabaseRest(`fees?student_id=eq.${encodeURIComponent(pupil.id)}&academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&limit=1`, {}, ctx.token))?.[0] || {};
  const nextTotal = total != null ? total : Number(existing.total || 0);
  const nextPaid = paid != null ? paid : Number(existing.paid || 0);
  const saved = await handleAction('fees.update', {
    student_id: pupil.id,
    class_key: pupil.class_key,
    term,
    academic_session: session,
    total: nextTotal,
    paid: nextPaid,
    debt: Math.max(0, nextTotal - nextPaid),
  }, ctx.token);
  return { saved: true, pupil: pupil.name, fees: saved.fee };
}

async function saveRemarks(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const { session, term } = await activeContext(ctx, context);
  const body = { student_id: pupil.id, class_key: pupil.class_key, term, academic_session: session };
  for (const field of ['academic', 'form_master', 'principal']) {
    if (args[field] != null) body[field] = clean(args[field], 600);
  }
  const saved = await handleAction('remarks.enter', body, ctx.token);
  return { saved: true, pupil: pupil.name, remark: saved.remark };
}

async function saveTraits(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const type = args.type === 'psychomotor' ? 'psychomotor' : 'affective';
  const ratings = args.ratings && typeof args.ratings === 'object' ? args.ratings : {};
  const entries = Object.entries(ratings).filter(([name, value]) => clean(name) && Number(value) >= 1 && Number(value) <= 5);
  if (!entries.length) return { error: 'Give at least one trait rating from 1 to 5.' };
  const { session, term } = await activeContext(ctx, context);
  for (const [name, value] of entries) {
    await handleAction('traits.enter', {
      student_id: pupil.id,
      class_key: pupil.class_key,
      trait_type: type,
      trait_name: clean(name, 80),
      rating: String(Number(value)),
      term,
      academic_session: session,
    }, ctx.token);
  }
  return { saved: true, pupil: pupil.name, type, count: entries.length };
}

async function publishSubject(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const { session, term } = await activeContext(ctx, context);
  const publish = args.published !== false;
  const raw = clean(args.subject, 80);
  const all = /^(all|every( subject)?|everything)$/i.test(raw);
  const indexes = all
    ? (cls.subjects || []).map((_, index) => index)
    : [subjectIndex(context, cls.key, raw)];
  if (!indexes.length || indexes[0] < 0) {
    return { error: `"${raw}" is not a subject in ${cls.label}.`, subjects: cls.subjects || [] };
  }
  const done = [];
  const failed = [];
  for (const index of indexes) {
    try {
      const result = publish
        ? await handleAction('results.publish', {
          class_key: cls.key, subject_index: index, term, academic_session: session, published: true,
        }, ctx.token)
        : await handleAction('results.unpublish', {
          class_key: cls.key, subject_index: index, term, academic_session: session,
        }, ctx.token);
      done.push({ subject: cls.subjects[index], published: publish ? Boolean(result.published_subject) : false });
    } catch (error) {
      failed.push({ subject: cls.subjects[index], reason: error?.payload?.message || error?.message || 'not changed' });
    }
  }
  return {
    ok: true,
    class: cls.label,
    subject: all ? 'all subjects' : cls.subjects[indexes[0]],
    term,
    published: publish,
    changed: done.length,
    subjects: done,
    failed,
  };
}


const PAGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classLabelFor(context, key) {
  const hit = (Array.isArray(context?.classes) ? context.classes : []).find((c) => c.key === key);
  return hit?.label || key || '';
}

function genderOf(value) {
  return /^(m|male|boy)$/i.test(clean(value, 20)) ? 'Male'
    : /^(f|female|girl)$/i.test(clean(value, 20)) ? 'Female' : '';
}

function assessmentLimits(settings) {
  const assessment = settings?.app_config?.assessment || {};
  const caMarks = Array.isArray(assessment.caMarks) ? assessment.caMarks : [30];
  return {
    ca1: Number(caMarks[0] || 30),
    ca2: Number(caMarks[1] || 30),
    ca3: Number(caMarks[2] || 30),
    exam: Number(assessment.examMark || 70),
  };
}

// A name typed by a person, matched against a roster already in memory. Exact
// first, then a unique close spelling, so one small typo does not stop a job.
function matchRosterPupil(roster, want) {
  const key = clean(want, 120);
  if (!key) return { error: 'A pupil name is required.' };
  const exact = roster.filter((row) => normalise(row.name) === normalise(key));
  if (exact.length === 1) return { pupil: exact[0] };
  if (exact.length > 1) {
    return { error: `More than one pupil is called ${key}. Give the admission number or the class.`, candidates: exact.map((p) => ({ name: p.name, admno: p.admno })) };
  }
  const ranked = roster.map((row) => ({ row, score: scoreName(row.name, key) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { error: `No pupil called "${key}" is on that class list.` };
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 5) {
    return {
      error: `I found ${Math.min(6, ranked.length)} pupils like "${key}". Which one?`,
      candidates: ranked.slice(0, 6).map((item) => ({ name: item.row.name, admno: item.row.admno })),
    };
  }
  return { pupil: ranked[0].row };
}

async function searchPupils(ctx, args, context) {
  const term = clean(args.name || args.query, 120);
  if (!term) return { error: 'Give a name, or part of a name, to search for.' };
  const cls = args.class ? classEntry(context, args.class) : null;
  if (args.class && !cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const scope = cls ? `&class_key=eq.${encodeURIComponent(cls.key)}` : '';
  const archived = args.include_archived === false ? '&archived=eq.false' : '';
  const rows = await supabaseRest(
    `students?select=id,name,class_key,admno,gender,archived,archived_reason&name=ilike.*${encodeURIComponent(term)}*${scope}${archived}&order=name.asc&limit=40`,
    {},
    ctx.token,
  ).catch(() => []) || [];
  return {
    count: rows.length,
    pupils: rows.map((row) => ({
      student_id: row.id,
      name: row.name,
      class: classLabelFor(context, row.class_key),
      admno: row.admno || null,
      gender: row.gender || null,
      archived: Boolean(row.archived),
      ...(row.archived_reason ? { removed_because: row.archived_reason } : {}),
    })),
  };
}

async function archivedPupils(ctx, args, context) {
  const cls = args.class ? classEntry(context, args.class) : null;
  if (args.class && !cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const scope = cls ? `&class_key=eq.${encodeURIComponent(cls.key)}` : '';
  const rows = await supabaseRest(
    `students?archived=eq.true${scope}&select=id,name,class_key,admno,gender,archived_reason,created_at&order=created_at.desc&limit=200`,
    {},
    ctx.token,
  ).catch(() => []) || [];
  return {
    count: rows.length,
    pupils: rows.map((row) => ({
      student_id: row.id,
      name: row.name,
      class: classLabelFor(context, row.class_key),
      admno: row.admno || null,
      reason: row.archived_reason || null,
      added_at: row.created_at || null,
    })),
  };
}

async function restorePupil(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  if (!found.pupil.archived) {
    return { error: `${found.pupil.name} is already on the live ${classLabelFor(context, found.pupil.class_key)} list.` };
  }
  const rows = await supabaseRest(`students?id=eq.${encodeURIComponent(found.pupil.id)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { archived: false, archived_reason: null },
  }, ctx.token);
  const saved = rows?.[0] || { ...found.pupil, archived: false };
  return { restored: true, pupil: await pupilSummary(saved, context) };
}

// A permanent deletion only works on a pupil already taken off the live list,
// so it always takes two deliberate steps. Their marks and other term records
// go with them; nothing else in the school is touched.
async function deletePupil(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  if (!pupil.archived) {
    return {
      error: `${pupil.name} is still on the live list. Archive the pupil first, then delete the record.`,
      pupil: await pupilSummary(pupil, context),
    };
  }
  const removed = {};
  for (const table of ['scores', 'traits', 'fees', 'remarks']) {
    const rows = await supabaseRest(`${table}?student_id=eq.${encodeURIComponent(pupil.id)}&select=id`, {}, ctx.token).catch(() => []);
    removed[table] = Array.isArray(rows) ? rows.length : 0;
    await supabaseRest(`${table}?student_id=eq.${encodeURIComponent(pupil.id)}`, {
      method: 'DELETE', prefer: 'return=minimal',
    }, ctx.token).catch(() => null);
  }
  await supabaseRest(`students?id=eq.${encodeURIComponent(pupil.id)}`, {
    method: 'DELETE', prefer: 'return=minimal',
  }, ctx.token);
  return { deleted: true, pupil: await pupilSummary(pupil, context), records_removed: removed };
}

async function addPupils(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) {
    return {
      error: `"${clean(args.class, 60)}" is not one of the school's classes, so nothing was added.`,
      known_classes: classNames(context),
    };
  }
  const list = Array.isArray(args.pupils) ? args.pupils : [];
  if (!list.length) return { error: 'Give the pupils to add: names, and a gender for each.' };
  const { session } = await activeContext(ctx, context);
  const roster = await listStudents(ctx, cls.key);
  const usedNumbers = await admissionNumbersInUse(ctx, cls.key);
  const added = [];
  const skipped = [];
  for (const item of list.slice(0, 100)) {
    const name = clean(typeof item === 'string' ? item : item?.name, 120).replace(/\s+/g, ' ');
    if (name.length < 3) { skipped.push({ name, reason: 'name is too short' }); continue; }
    if (roster.some((row) => normalise(row.name) === normalise(name))) {
      skipped.push({ name, reason: 'already on the list' });
      continue;
    }
    const gender = genderOf(typeof item === 'string' ? '' : item?.gender || args.gender);
    if (!gender) { skipped.push({ name, reason: 'no gender given' }); continue; }
    try {
      const admno = clean(typeof item === 'string' ? '' : item?.admno, 60) || nextAdmissionNumber(usedNumbers);
      usedNumbers.add(admno.toUpperCase());
      const saved = await handleAction('students.upsert', {
        class_key: cls.key,
        name,
        gender,
        admno,
        academic_session: session || undefined,
      }, ctx.token);
      added.push({ name: saved.student?.name || name, student_id: saved.student?.id || null, admno: saved.student?.admno || null });
      if (saved.student) roster.push(saved.student);
    } catch (error) {
      skipped.push({ name, reason: error?.payload?.message || error?.message || 'not saved' });
    }
  }
  return {
    added: added.length, failed: skipped.length, class: cls.label,
    pupils: added.slice(0, 60), more_added: Math.max(0, added.length - 60),
    skipped: skipped.slice(0, 30), more_skipped: Math.max(0, skipped.length - 30),
  };
}

async function movePupils(ctx, args, context) {
  const from = classEntry(context, args.from || args.class);
  const to = classEntry(context, args.to || args.new_class);
  if (!from) return { error: `There is no class called "${clean(args.from || args.class, 60)}".` };
  if (!to) return { error: `There is no class called "${clean(args.to || args.new_class, 60)}".` };
  if (from.key === to.key) return { error: 'The pupil is already in that class.' };
  const roster = await listStudents(ctx, from.key);
  let targets;
  if (args.all === true) {
    targets = roster;
  } else {
    const names = Array.isArray(args.names) ? args.names
      : (Array.isArray(args.pupils) ? args.pupils : [args.name].filter(Boolean));
    if (!names.length) return { error: 'Name the pupils to move, or say the whole class.' };
    targets = [];
    for (const name of names) {
      const hit = matchRosterPupil(roster, typeof name === 'string' ? name : name?.name);
      if (hit.pupil) targets.push(hit.pupil);
    }
    if (!targets.length) return { error: `None of those names are on the ${from.label} list.`, pupils: roster.map((p) => p.name).slice(0, 60) };
  }
  const moved = [];
  const failed = [];
  for (const pupil of targets) {
    try {
      await handleAction('students.upsert', {
        id: pupil.id,
        class_key: to.key,
        name: pupil.name,
        gender: pupil.gender,
        admno: pupil.admno,
        academic_session: pupil.academic_session,
        archived: Boolean(pupil.archived),
      }, ctx.token);
      moved.push(pupil.name);
    } catch (error) {
      failed.push({ name: pupil.name, reason: error?.payload?.message || error?.message || 'not moved' });
    }
  }
  return {
    moved: moved.length, failed: failed.length, from: from.label, to: to.label,
    pupils: moved.slice(0, 60), more_moved: Math.max(0, moved.length - 60),
    errors: failed.slice(0, 20),
  };
}

async function bulkEnterMarks(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) return { error: `There is no class called "${clean(args.class, 60)}".` };
  const index = subjectIndex(context, cls.key, args.subject);
  if (index < 0) return { error: `"${clean(args.subject, 80)}" is not a subject in ${cls.label}.` };
  const list = Array.isArray(args.marks) ? args.marks : [];
  if (!list.length) return { error: 'Give the marks to save, one entry for each pupil.' };
  const { session, term } = await activeContext(ctx, {
    ...context,
    academic_session: args.academic_session || context?.academic_session,
    term: args.term || context?.term,
  });
  const limits = assessmentLimits(await settingsRow(ctx));
  const roster = await listStudents(ctx, cls.key);
  const saved = [];
  const failed = [];
  for (const entry of list.slice(0, 150)) {
    const id = clean(entry?.student_id, 40);
    const hit = id ? { pupil: roster.find((row) => row.id === id) } : matchRosterPupil(roster, entry?.name);
    if (!hit.pupil) { failed.push({ name: clean(entry?.name, 120), reason: hit.error || 'pupil not found' }); continue; }
    const body = {
      student_id: hit.pupil.id,
      class_key: cls.key,
      subject_index: index,
      term,
      academic_session: session,
      allow_correction: true,
    };
    let valid = true;
    for (const field of ['ca1', 'ca2', 'ca3', 'exam']) {
      if (entry?.[field] == null || entry?.[field] === '') continue;
      const value = Number(entry[field]);
      if (!Number.isFinite(value) || value < 0 || value > limits[field]) {
        failed.push({ name: hit.pupil.name, reason: `${field.toUpperCase()} must be between 0 and ${limits[field]}` });
        valid = false;
        break;
      }
      body[field] = value;
    }
    if (!valid) continue;
    if (body.ca1 == null && body.ca2 == null && body.ca3 == null && body.exam == null) {
      failed.push({ name: hit.pupil.name, reason: 'no marks given' });
      continue;
    }
    try {
      const result = await handleAction('scores.enter', body, ctx.token);
      saved.push({ name: hit.pupil.name, ca1: result.score?.ca1 ?? null, ca2: result.score?.ca2 ?? null, ca3: result.score?.ca3 ?? null, exam: result.score?.exam ?? null });
    } catch (error) {
      failed.push({ name: hit.pupil.name, reason: error?.payload?.message || error?.message || 'not saved' });
    }
  }
  return {
    saved: saved.length,
    failed: failed.length,
    class: cls.label,
    subject: cls.subjects[index],
    term,
    marks: saved.slice(0, 60),
    more_marks: Math.max(0, saved.length - 60),
    errors: failed.slice(0, 20),
  };
}

async function clearMarks(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const pupil = found.pupil;
  const index = subjectIndex(context, pupil.class_key, args.subject);
  if (index < 0) return { error: `"${clean(args.subject, 80)}" is not a subject in ${classLabelFor(context, pupil.class_key)}.` };
  const { session, term } = await activeContext(ctx, {
    ...context,
    academic_session: args.academic_session || context?.academic_session,
    term: args.term || context?.term,
  });
  const scope = `student_id=eq.${encodeURIComponent(pupil.id)}&subject_index=eq.${index}&term=eq.${encodeURIComponent(term)}${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}`;
  const rows = await supabaseRest(`scores?${scope}&select=ca1,ca2,ca3,exam`, {}, ctx.token).catch(() => []);
  if (!rows?.length) return { error: `${pupil.name} has no saved ${args.subject} marks for ${term}.` };
  await supabaseRest(`scores?${scope}`, { method: 'DELETE', prefer: 'return=minimal' }, ctx.token);
  return {
    cleared: true,
    pupil: pupil.name,
    class: classLabelFor(context, pupil.class_key),
    subject: (context?.classes || []).find((c) => c.key === pupil.class_key)?.subjects?.[index] || args.subject,
    term,
    removed: rows[0],
  };
}

async function clearFee(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const { session, term } = await activeContext(ctx, context);
  const scope = `student_id=eq.${encodeURIComponent(found.pupil.id)}&term=eq.${encodeURIComponent(term)}${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}`;
  const rows = await supabaseRest(`fees?${scope}&limit=1`, {}, ctx.token).catch(() => []);
  if (!rows?.length) return { error: `${found.pupil.name} has no fee record for ${term}.` };
  await supabaseRest(`fees?${scope}`, { method: 'DELETE', prefer: 'return=minimal' }, ctx.token);
  return { cleared: true, pupil: found.pupil.name, term, removed: rows[0] };
}

async function clearRemarks(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const { session, term } = await activeContext(ctx, context);
  const scope = `student_id=eq.${encodeURIComponent(found.pupil.id)}&term=eq.${encodeURIComponent(term)}${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}`;
  const fields = (Array.isArray(args.fields) ? args.fields : [])
    .filter((field) => ['academic', 'form_master', 'principal'].includes(field));
  if (fields.length) {
    const body = {};
    fields.forEach((field) => { body[field] = null; });
    await supabaseRest(`remarks?${scope}`, { method: 'PATCH', prefer: 'return=minimal', body }, ctx.token);
    return { cleared: true, pupil: found.pupil.name, term, fields };
  }
  const rows = await supabaseRest(`remarks?${scope}&limit=1`, {}, ctx.token).catch(() => []);
  if (!rows?.length) return { error: `${found.pupil.name} has no remarks for ${term}.` };
  await supabaseRest(`remarks?${scope}`, { method: 'DELETE', prefer: 'return=minimal' }, ctx.token);
  return { cleared: true, pupil: found.pupil.name, term, fields: ['academic', 'form_master', 'principal'] };
}

async function clearTraits(ctx, args, context) {
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const { session, term } = await activeContext(ctx, context);
  const type = args.type === 'psychomotor' ? 'psychomotor' : args.type === 'affective' ? 'affective' : null;
  const scope = `student_id=eq.${encodeURIComponent(found.pupil.id)}&term=eq.${encodeURIComponent(term)}${session ? `&academic_session=eq.${encodeURIComponent(session)}` : ''}${type ? `&trait_type=eq.${type}` : ''}`;
  const rows = await supabaseRest(`traits?${scope}&select=id`, {}, ctx.token).catch(() => []);
  if (!rows?.length) return { error: `${found.pupil.name} has no ${type || ''} trait ratings for ${term}.`.replace('  ', ' ') };
  await supabaseRest(`traits?${scope}`, { method: 'DELETE', prefer: 'return=minimal' }, ctx.token);
  return { cleared: true, pupil: found.pupil.name, term, type: type || 'all', removed: rows.length };
}

async function listPages(ctx, args, context) {
  const listed = await opsRpc('ops_jobs_list', {}).catch(() => ({}));
  const jobs = Array.isArray(listed?.jobs) ? listed.jobs : [];
  const limit = Math.max(1, Math.min(60, Number(args.limit || 25)));
  return {
    count: jobs.length,
    pages: jobs.slice(0, limit).map((job) => ({
      page_id: job.id,
      class: classLabelFor(context, job.class_key),
      subject: (Array.isArray(job.subject_set) ? job.subject_set : []).map((s) => s.label).join(' + ') || null,
      term: job.term || null,
      column: job.column_label || null,
      status: job.status || null,
      lines: job.counts?.read ?? null,
      accepted: job.counts?.accepted ?? null,
      need_a_person: job.counts?.need_eye ?? null,
      created_at: job.created_at || null,
      finished_at: job.applied_at || job.approved_at || null,
    })),
  };
}

async function pageRows(ctx, args, context, jobId) {
  const id = clean(args.job_id, 40) || jobId;
  if (!PAGE_UUID_RE.test(id)) return { error: 'No page is open in this chat.' };
  const detail = await opsRpc('ops_jobs_get', { p_id: id }).catch(() => null);
  if (!detail?.job) return { error: 'That page was not found.' };
  const rows = Array.isArray(detail.staged_rows) ? detail.staged_rows : [];
  const marks = Array.isArray(detail.marks) ? detail.marks : [];
  const roster = Array.isArray(detail.roster) ? detail.roster : [];
  const byId = Object.fromEntries(roster.map((p) => [p.id, p]));
  const marksByRow = {};
  for (const mark of marks) {
    if (!mark?.staged_row_id) continue;
    const current = marksByRow[mark.staged_row_id];
    if (!current || mark.column_label === detail.job.column_label) marksByRow[mark.staged_row_id] = mark;
  }
  return {
    page_id: detail.job.id,
    class: classLabelFor(context, detail.job.class_key),
    subject: (Array.isArray(detail.job.subject_set) ? detail.job.subject_set : []).map((s) => s.label).join(' + ') || null,
    term: detail.job.term || null,
    column: detail.job.column_label || null,
    status: detail.job.status || null,
    rows: rows.map((row) => {
      const pupil = row.student_id ? byId[row.student_id] : null;
      const mark = marksByRow[row.id] || null;
      return {
        line: row.row_no,
        row_id: row.id,
        on_page: row.student_name_raw || '',
        pupil: pupil?.name || null,
        student_id: pupil?.id || null,
        admno: pupil?.admno || null,
        row_status: row.status || 'pending',
        mark_id: mark?.id || null,
        mark: mark?.status === 'read' ? mark.value : null,
        mark_status: mark?.status || 'none',
      };
    }),
  };
}

async function setPageMark(ctx, args, context, jobId) {
  const id = clean(args.job_id, 40) || jobId;
  if (!PAGE_UUID_RE.test(id)) return { error: 'No page is open in this chat.' };
  const value = args.value == null || args.value === '' ? null : Number(args.value);
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) {
    return { error: 'The mark must be a number between 0 and 100.' };
  }
  const detail = await opsRpc('ops_jobs_get', { p_id: id }).catch(() => null);
  if (!detail?.job) return { error: 'That page was not found.' };
  if (['approved', 'applied', 'cancelled'].includes(detail.job.status)) {
    return { error: 'That page is finished, so its marks can no longer be changed here. Correct the saved score instead.' };
  }
  const roster = Array.isArray(detail.roster) ? detail.roster : [];
  const byId = Object.fromEntries(roster.map((p) => [p.id, p]));
  const rows = Array.isArray(detail.staged_rows) ? detail.staged_rows : [];
  const wanted = clean(args.name || args.on_page, 120);
  const studentId = clean(args.student_id, 40);
  let line = null;
  if (studentId) line = rows.find((row) => row.student_id === studentId);
  if (!line && wanted) {
    line = rows.find((row) => normalise(row.student_name_raw) === normalise(wanted))
      || rows.find((row) => normalise(byId[row.student_id]?.name) === normalise(wanted));
  }
  if (!line && wanted) {
    const close = rows.filter((row) => scoreName(row.student_name_raw || byId[row.student_id]?.name, wanted) > 0);
    if (close.length === 1) line = close[0];
    else if (close.length > 1) {
      return { error: `More than one line looks like "${wanted}". Which pupil?`, lines: close.slice(0, 8).map((row) => ({ line: row.row_no, on_page: row.student_name_raw, pupil: byId[row.student_id]?.name || null })) };
    }
  }
  if (!line) return { error: `"${wanted || 'that pupil'}" is not on the open page.`, lines: rows.slice(0, 60).map((row) => ({ line: row.row_no, on_page: row.student_name_raw, pupil: byId[row.student_id]?.name || null })) };
  const saved = await opsRpc('ops_set_mark', {
    p_job_id: id,
    p_staged_row_id: line.id,
    p_value: value,
    p_status: 'read',
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
    p_note: clean(args.note, 300) || 'Corrected in the Command Center chat',
  });
  return {
    saved: Boolean(saved?.ok),
    line: line.row_no,
    on_page: line.student_name_raw || null,
    pupil: byId[line.student_id]?.name || null,
    mark: value,
    column: detail.job.column_label || null,
  };
}

async function mapPageRow(ctx, args, context, jobId) {
  const id = clean(args.job_id, 40) || jobId;
  if (!PAGE_UUID_RE.test(id)) return { error: 'No page is open in this chat.' };
  const detail = await opsRpc('ops_jobs_get', { p_id: id }).catch(() => null);
  if (!detail?.job) return { error: 'That page was not found.' };
  if (['approved', 'applied', 'cancelled'].includes(detail.job.status)) {
    return { error: 'That page is finished, so its names can no longer be changed here.' };
  }
  const rows = Array.isArray(detail.staged_rows) ? detail.staged_rows : [];
  const wanted = clean(args.on_page || args.name, 120);
  let row = rows.find((item) => normalise(item.student_name_raw) === normalise(wanted));
  if (!row) {
    const ranked = rows.map((item) => ({ item, score: scoreName(item.student_name_raw, wanted) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 5)) row = ranked[0].item;
    else if (ranked.length > 1) {
      return {
        error: `More than one line looks like "${wanted}". Which line?`,
        lines: ranked.slice(0, 8).map((entry) => ({ line: entry.item.row_no, on_page: entry.item.student_name_raw })),
      };
    }
  }
  if (!row) return { error: `"${wanted}" is not one of the lines on this page.`, lines: rows.map((item) => item.student_name_raw).slice(0, 60) };
  const decision = clean(args.decision, 20);
  if (decision === 'reject' || decision === 'hold' || decision === 'approve') {
    const saved = await opsRpc('ops_jobs_decide', {
      p_job_id: id,
      p_staged_row_id: row.id,
      p_decision: decision,
      p_actor: ctx.actor.id,
      p_actor_email: ctx.actor.email,
      p_note: clean(args.note, 300) || `Set to ${decision} in the Command Center chat`,
    });
    return { saved: Boolean(saved?.ok), line: row.row_no, on_page: row.student_name_raw, decision };
  }
  const found = await resolvePupil(ctx, args, context);
  if (!found.pupil) return found;
  const saved = await opsRpc('ops_attach_row', {
    p_job_id: id,
    p_staged_row_id: row.id,
    p_student_id: found.pupil.id,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  });
  return {
    saved: Boolean(saved?.ok),
    line: row.row_no,
    on_page: row.student_name_raw,
    linked_to: found.pupil.name,
    admission_number: found.pupil.admno || null,
  };
}

async function retryPage(ctx, args, context, jobId) {
  const id = clean(args.job_id, 40) || jobId;
  if (!PAGE_UUID_RE.test(id)) return { error: 'No page is open in this chat.' };
  const saved = await opsRpc('ops_retry_job', {
    p_job_id: id,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  }).catch((error) => ({ ok: false, message: error?.message }));
  if (!saved?.ok) return { error: saved?.message || 'That page could not be sent back to the reader.' };
  try {
    const { runOnePass } = require('./_ops-worker-core');
    await runOnePass({ worker: 'ops-agent' });
  } catch (_) { /* the hosted worker will pick it up */ }
  return { queued: true, page_id: id };
}

async function jobReadiness(ctx, jobId) {
  if (!jobId) return { error: 'No record-book page is attached to this chat. Attach the page photo, or start a new read from the scan screen, then ask me again.' };
  // A page the chat can see but nobody is reading gets read here, on the
  // portal's own host. This is the safety net when the tab closed early.
  try {
    const detail = await opsRpc('ops_jobs_get', { p_id: jobId });
    const page = detail?.job;
    if (page && page.status === 'queued' && !page.claimed_by) {
      const { runOnePass } = require('./_ops-worker-core');
      await runOnePass({ worker: 'ops-agent' });
    }
  } catch (_) {
    // A failed start is reported by the readiness check below.
  }
  const readiness = await opsRpc('ops_document_readiness', { p_job_id: jobId }).catch(() => null);
  if (!readiness) return { error: 'The page could not be checked.' };
  // The reader's own reason matters: "the page shows 11 lines but the class
  // has 50" is the answer, not "still waiting".
  let page = null;
  try {
    const after = await opsRpc('ops_jobs_get', { p_id: jobId });
    page = after?.job || null;
  } catch (_) {
    page = null;
  }
  const stopReason = page?.last_error || null;
  if (readiness.ok === true) {
    return {
      ready: true,
      page_status: page?.status || null,
      class_size: readiness.data?.class_size,
      subject: (readiness.data?.subject_set || []).map((s) => s.label).join(' + '),
      column: readiness.data?.column_label,
    };
  }
  return {
    ready: false,
    page_status: page?.status || null,
    reader_stopped_because: stopReason,
    refusals: (readiness.refusals || []).map((r) => r.message),
    code: readiness.code || null,
  };
}

async function approveJob(ctx, jobId) {
  if (!jobId) return { error: 'No record-book page is attached to this chat. Attach the page photo, or start a new read from the scan screen, then ask me again.' };
  const readiness = await jobReadiness(ctx, jobId);
  if (!readiness.ready) {
    return { approved: false, error: 'The page is not ready yet.', readiness };
  }
  const before = await opsRpc('ops_credit_balance', { p_school_id: ctx.actor.school_id }).catch(() => null);
  const saved = await opsRpc('ops_jobs_confirm', {
    p_job_id: jobId,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  }).catch((error) => ({ ok: false, message: error?.message }));
  if (!saved?.ok) {
    const readiness = await jobReadiness(ctx, jobId);
    return { approved: false, error: saved?.message || 'The page was not approved.', readiness };
  }
  const after = await opsRpc('ops_credit_balance', { p_school_id: ctx.actor.school_id }).catch(() => null);
  return {
    approved: true,
    live_write: false,
    credits_before: before?.remaining ?? null,
    credits_after: after?.remaining ?? null,
  };
}

async function generateJobDocuments(ctx, jobId) {
  if (!jobId) return { error: 'No record-book page is attached to this chat. Attach the page photo, or start a new read from the scan screen, then ask me again.' };
  const readiness = await opsRpc('ops_document_readiness', { p_job_id: jobId }).catch(() => null);
  if (!readiness || readiness.ok !== true) {
    const refusal = readiness?.refusals?.[0];
    return { refused: true, error: refusal?.message || 'The page is not ready for documents.' };
  }
  const rendered = await renderDocuments(readiness.data);
  await opsRpc('ops_clear_documents', { p_job_id: jobId, p_actor: ctx.actor.id, p_actor_email: ctx.actor.email });
  const files = [];
  for (const document of [rendered.broadsheet, rendered.cards]) {
    const sha256 = crypto.createHash('sha256').update(document.buffer).digest('hex');
    const attached = await opsRpc('ops_attach_document', {
      p_job_id: jobId,
      p_filename: document.filename,
      p_mime: document.mime,
      p_content_b64: document.buffer.toString('base64'),
      p_sha256: sha256,
      p_page_count: document.pageCount,
      p_document_type: document.type,
      p_uploaded_by: ctx.actor.id,
      p_uploaded_by_email: ctx.actor.email,
      p_max_bytes: 12000000,
    });
    if (attached?.ok !== true) return { error: attached?.message || 'A document could not be stored.' };
    files.push({ id: attached.file.id, filename: attached.file.filename, type: document.type, url: `/api/ops-jobs?file=${attached.file.id}` });
  }
  await opsRpc('ops_record_documents', {
    p_job_id: jobId,
    p_document_set: {
      template_version: readiness.data.template_version,
      generated_at: new Date().toISOString(),
      published: false,
      files: files.map((f) => ({ id: f.id, filename: f.filename })),
      numbers: rendered.numbers,
      class_size: rendered.numbers.class_size,
      average: rendered.numbers.average,
      highest: rendered.numbers.highest,
      lowest: rendered.numbers.lowest,
      subject_labels: (readiness.data.subject_set || []).map((s) => s.label),
      column_label: readiness.data.column_label,
    },
  });
  return { documents: files };
}

async function staffList(ctx) {
  const payload = await handleAction('management.staff.list', {}, ctx.token);
  return {
    staff: (payload.staff || []).map((s) => ({
      display_name: s.display_name, email: s.email, role: s.role,
      suspended: Boolean(s.suspended), last_seen_at: s.last_seen_at,
    })),
  };
}

async function resolveStaff(ctx, args) {
  const email = clean(args.email, 120).toLowerCase();
  const list = (await handleAction('management.staff.list', {}, ctx.token)).staff || [];
  if (email) {
    const hit = list.find((s) => String(s.email || '').toLowerCase() === email);
    return { staff: hit, list };
  }
  const wanted = normalise(args.name);
  const hits = list.filter((s) => normalise(s.display_name) === wanted);
  if (hits.length === 1) return { staff: hits[0], list };
  if (hits.length > 1) return { error: 'More than one staff member has that name. Use the email.', list };
  return { error: `No staff member called "${clean(args.name, 80)}" was found.`, list };
}

// Start (or reuse) a record-book page. The model supplies the class, subject,
// term and column in everyday words; this resolves them against the school's
// own list and creates the page the same way the form does. Starting a page is
// free and reversible: a credit is only taken when the page is approved.
async function startPage(ctx, args, context) {
  const cls = classEntry(context, args.class);
  if (!cls) {
    return {
      error: `There is no class called "${clean(args.class, 60)}".`,
      classes: (Array.isArray(context?.classes) ? context.classes : []).map((c) => c.label),
    };
  }

  const subjectName = clean(args.subject, 120);
  if (!subjectName) {
    return { error: `I need the subject for the ${cls.label} page.`, subjects: cls.subjects || [] };
  }

  const index = subjectIndex(context, cls.key, subjectName);
  if (index < 0) {
    return {
      error: `"${subjectName}" is not one of the subjects set up for ${cls.label}.`,
      subjects: cls.subjects || [],
    };
  }

  const subject = cls.subjects[index];
  const term = findTerm(clean(args.term, 30), context?.term) || context?.term || null;
  const column = findColumn(clean(args.column, 40)) || 'CLASS EXERCISE';

  // Continue the page already open for the same class, subject, term and
  // column. Anything else is a new page, so a later sentence never half-
  // switches a page that already has rows.
  const listed = await opsRpc('ops_jobs_list', {}).catch(() => ({}));
  const openStatus = new Set(['draft', 'queued', 'processing', 'needs_review']);
  const same = (Array.isArray(listed?.jobs) ? listed.jobs : []).find((job) => {
    if (!openStatus.has(job.status)) return false;
    if (job.class_key !== cls.key) return false;
    // A blank field on the stored page is not a disagreement; only two known
    // values that differ make it a different page.
    if (job.term && term && normalise(job.term) !== normalise(term)) return false;
    const jobSubject = Array.isArray(job.subject_set) ? job.subject_set[0] : null;
    if (jobSubject?.label && normalise(jobSubject.label) !== normalise(subject)) return false;
    if (job.column_label && normalizeColumn(job.column_label) !== normalizeColumn(column)) return false;
    return true;
  });

  if (same) {
    return {
      started: true,
      reused: true,
      job_id: same.id,
      class_key: cls.key,
      class_label: cls.label,
      subject,
      subject_key: `${cls.key}:${index + 1}`,
      term,
      column,
      rows: same?.counts?.read || 0,
    };
  }

  const raw = clean(args.instruction, 1200)
    || [cls.label, subject, term, column].filter(Boolean).join(' · ');
  const parsed = {
    ok: true,
    raw,
    intent: 'context',
    scope: 'assessment',
    class_key: cls.key,
    class_label: cls.label,
    section: cls.section || null,
    subject,
    subject_key: `${cls.key}:${index + 1}`,
    column_group: String(term || '1ST TERM').toUpperCase(),
    column_label: column,
    term,
    academic_session: context?.academic_session || null,
    needs: [],
  };

  const created = await opsRpc('ops_jobs_create', {
    p_school_id: ctx.actor.school_id,
    p_class_key: cls.key,
    p_academic_session: context?.academic_session || null,
    p_term: term,
    p_service: 'scores',
    p_submitted_by: ctx.actor.id,
    p_submitted_by_email: ctx.actor.email,
    p_instruction: raw,
    p_file_refs: [],
    p_instruction_parsed: parsed,
  });

  if (!created || created.ok !== true || !created.job?.id) {
    return { error: created?.message || 'The page could not be started. Nothing was saved.' };
  }

  await opsRpc('ops_record_assistant', { p_job_id: created.job.id }).catch(() => null);
  await opsRpc('ops_save_instruction', { p_job_id: created.job.id, p_raw: raw, p_parsed: parsed })
    .catch(() => null);

  return {
    started: true,
    reused: false,
    job_id: created.job.id,
    class_key: cls.key,
    class_label: cls.label,
    subject,
    subject_key: `${cls.key}:${index + 1}`,
    term,
    column,
    rows: 0,
  };
}

const TOOLS = {
  // -------------------------------------------------------------------------
  // Tier 0: read and preview. These never write and never need approval.
  // -------------------------------------------------------------------------
  get_school_snapshot: async (ctx, args, context) => getSchoolSnapshot(ctx, args, context),
  resolve_students: async (ctx, args, context) => resolveStudents(ctx, args, context),
  resolve_subject: async (ctx, args, context) => resolveSubject(ctx, args, context),
  get_scores: async (ctx, args, context) => getScores(ctx, args, context),
  completeness_report: async (ctx, args, context) => completenessReport(ctx, args, context),
  rank_students: async (ctx, args, context) => rankStudents(ctx, args, context),
  compare_with_existing: async (ctx, args, context) => compareWithExisting(ctx, args, context),
  review_page: async (ctx, args, context, jobId) => reviewPage(ctx, args, context, jobId),
  get_attachment: async (ctx, args) => {
    const chatId = clean(ctx.chat_id, 40);
    if (!chatId) {
      return {
        error: 'No chat is open.',
        next: 'Ask the user to send the photo again in this chat.',
      };
    }
    const scope = {
      p_session_id: chatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
    };
    const fileId = clean(args.file_id, 40);
    const found = fileId
      ? await opsRpc('ops_sheet_attachment_meta', { ...scope, p_file_id: fileId })
      : await opsRpc('ops_sheet_attachment_latest', scope);
    const attachment = found?.attachment || null;
    if (!attachment) {
      return {
        ok: true,
        attachment: null,
        next: 'No stored photo in this chat. Ask the user to send it again.',
      };
    }
    const state = await loadSheetState(ctx, chatId, fileId || null);
    const stored = await opsRpc('ops_sheet_draft_list', {
      p_session_id: chatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_file_id: attachment.id,
    }).catch(() => null);
    const savedLines = Array.isArray(stored?.lines) ? stored.lines : state.lines;
    const lines = savedLines
      .filter((line) => !fileId || String(line.file_id) === fileId)
      .map((line) => ({
        line: line.sheet_line,
        column: line.column_title,
        sheet_name: line.raw_name,
        pupil: line.match_name || null,
        score: line.score_value,
        flags: line.flags,
        status: line.match_status,
      }));
    return {
      ok: true,
      file_id: attachment.id,
      description: attachment.description || null,
      sheet_type: attachment.sheet_type || null,
      class: attachment.class_key || null,
      subject: attachment.subject_label || null,
      term: attachment.term || null,
      lines,
      review: state.review || null,
      text: attachment.description || 'Photo attached.',
      next: 'The photo is stored. Describe it from this record; do not ask the user to send it again.',
    };
  },
  sheet_review: async (ctx, args) => {
    const chatId = clean(ctx.chat_id, 40);
    if (!chatId) {
      return {
        error: 'No chat is open for the sheet review.',
        next: 'Ask the user to send the photo in this chat again.',
      };
    }
    const action = clean(args.action, 20).toLowerCase() || 'status';
    if (action === 'status') {
      const state = await loadSheetState(ctx, chatId);
      if (!state.review) {
        return { ok: true, review: null, next: 'There is no open sheet review in this chat.' };
      }
      return {
        ok: true,
        review: state.review,
        lines: state.lines.map((line) => ({
          item: line.item_no,
          line: line.sheet_line,
          column: line.column_title,
          sheet_name: line.raw_name,
          pupil: line.match_name || null,
          score: line.score_value,
          status: line.match_status,
          flags: line.flags,
          written: Boolean(line.written_at),
        })),
        text: sheetReviewText(state.review),
      };
    }
    if (action === 'answer') {
      const result = await applySheetAnswers(ctx, args, null, chatId);
      if (result.error) return result;
      return {
        ...result,
        text: sheetReviewText(result.review),
        next: result.review?.needs_answer?.length
          ? 'Show the remaining numbered items once, then wait for the user.'
          : 'Every item is settled. Say record to write the ready lines.',
      };
    }
    if (action === 'commit') {
      const result = await commitSheetReview(ctx, args, null, chatId);
      if (result.error && !result.committed) return result;
      return {
        ...result,
        text: sheetReviewText(result.review),
        next: 'Report recorded, already there, held and blank counts, name the batch id and offer undo.',
      };
    }
    return {
      error: `There is no sheet review action called "${clean(args.action, 20)}".`,
      next: 'Use action status, answer or commit.',
    };
  },

  // -------------------------------------------------------------------------
  // Tier 1: reversible writes. One audited batch, undo available.
  // -------------------------------------------------------------------------
  start_page: startPage,
  record_scores: async (ctx, args, context) => recordScores(ctx, args, context),
  correct_score: async (ctx, args, context) => correctScore(ctx, args, context),
  remember_alias: async (ctx, args, context) => rememberAlias(ctx, args, context),
  undo_batch: async (ctx, args, context) => undoBatch(ctx, args, context),

  // -------------------------------------------------------------------------
  // Tier 2: consequential. One confirmation showing exactly what changes.
  // -------------------------------------------------------------------------
  approve_batch: async (ctx, args, context) => approveBatch(ctx, args, context),
  publish_results: async (ctx, args, context) => publishResults(ctx, args, context),
  update_subject_catalog: async (ctx, args, context) => updateSubjectCatalog(ctx, args, context),
  generate_documents: async (ctx, args, context, jobId, confirmed) => generateDocuments(ctx, args, context, confirmed === true),
  update_settings: async (ctx, args) => {
    if (!canAdmin(ctx)) return { error: 'Only a school admin can change settings from this chat.', next: 'Ask an admin account to make this change.' };
    const current = await settingsRow(ctx);
    const patch = args.patch && typeof args.patch === 'object' ? cleanKeys(args.patch) : {};
    if (!Object.keys(patch).length) return { error: 'There is nothing to change.', next: 'Send the settings keys to change.' };
    const next = deepMerge(current.app_config, patch);
    // The class list is a complete map, not a set of additions: a class is
    // removed by leaving it out. Everything else stays a merge.
    if (patch.depts && typeof patch.depts === 'object') next.depts = patch.depts;
    const invalid = validateConfig(next);
    if (invalid) return { error: invalid, next: 'Correct that value and call update_settings again.' };
    const keys = Object.keys(patch);
    if (patch.term || patch.session) {
      const saved = await handleAction('settings.activate_next_term', {
        config: next,
        academic_session: next.session,
        term: next.term,
      }, ctx.token);
      return { saved: true, changed: keys, term: saved.context?.term, session: saved.context?.academic_session };
    }
    await handleAction('settings.app_config.update', { config: next }, ctx.token);
    return { saved: true, changed: keys, next: 'Read the setting back with get_school_snapshot if the change affects a class.' };
  },

  // -------------------------------------------------------------------------
  // Grouped everyday actions. One verb each, with an action argument.
  // -------------------------------------------------------------------------
  manage_students: async (ctx, args, context) => manageStudents(ctx, args, context),
  update_pupil_records: async (ctx, args, context) => updatePupilRecords(ctx, args, context),
  manage_staff: async (ctx, args, context) => manageStaff(ctx, args, context),
};

// ---------------------------------------------------------------------------
// Grouped handlers
// ---------------------------------------------------------------------------
function actionOf(args) {
  return clean(args?.action, 30).toLowerCase().replace(/[\s-]+/g, '_');
}

function canAdmin(ctx) {
  const role = String(ctx?.actor?.role || '').toLowerCase();
  return !role || role === 'developer' || role === 'admin';
}

async function manageStudents(ctx, args, context) {
  const action = actionOf(args) || 'list';
  if (action === 'list') {
    const cls = classEntry(context, args.class);
    if (!cls) return { error: `There is no class called "${clean(args.class, 60)}".`, next: 'Call get_school_snapshot for the real class list.' };
    const rows = await listStudents(ctx, cls.key);
    return {
      class: cls.label,
      class_key: cls.key,
      count: rows.length,
      pupils: rows.map((row) => ({ name: row.name, admno: row.admno, gender: row.gender, student_id: row.id })),
      next: 'Use action "find" for one name, or "search" to look across the school.',
    };
  }
  if (action === 'find') {
    const found = await resolvePupil(ctx, args, context);
    if (found.pupil) return { found: true, pupil: await pupilSummary(found.pupil, context) };
    return { ...found, next: 'Use resolve_students for a sheet name, or give the class and admission number.' };
  }
  if (action === 'search') return searchPupils(ctx, args, context);
  if (action === 'archived') return archivedPupils(ctx, args, context);
  if (action === 'add') {
    if (Array.isArray(args.pupils) && args.pupils.length) return addPupils(ctx, args, context);
    return addPupil(ctx, args, context);
  }
  if (action === 'edit') return editPupil(ctx, args, context);
  if (action === 'archive') return archivePupil(ctx, args, context);
  if (action === 'archive_many') return archivePupils(ctx, args, context);
  if (action === 'fix_admission_numbers') return repairAdmissionNumbers(ctx, args, context);
  if (action === 'restore') return restorePupil(ctx, args, context);
  if (action === 'delete') return deletePupil(ctx, args, context);
  if (action === 'move') return movePupils(ctx, args, context);
  return {
    error: `I do not know the pupil action "${action}".`,
    next: 'Use one of: list, find, search, archived, add, edit, archive, restore, delete, move.',
  };
}

async function updatePupilRecords(ctx, args, context) {
  const action = actionOf(args) || 'read';
  if (action === 'read' || action === 'records') return pupilRecords(ctx, args, context);
  if (action === 'fees' || action === 'update_fee') return updateFee(ctx, args, context);
  if (action === 'remarks' || action === 'save_remarks') return saveRemarks(ctx, args, context);
  if (action === 'traits' || action === 'save_traits') return saveTraits(ctx, args, context);
  if (action === 'clear_marks') return clearMarks(ctx, args, context);
  if (action === 'clear_fee') return clearFee(ctx, args, context);
  if (action === 'clear_remarks') return clearRemarks(ctx, args, context);
  if (action === 'clear_traits') return clearTraits(ctx, args, context);
  return {
    error: `I do not know the record action "${action}".`,
    next: 'Use read, fees, remarks, traits, clear_marks, clear_fee, clear_remarks or clear_traits.',
  };
}

async function manageStaff(ctx, args, context) {
  const action = actionOf(args) || 'list';
  if (action === 'list') return staffList(ctx);
  if (action === 'create') {
    if (!canAdmin(ctx)) return { error: 'Only a school admin can create staff logins.', next: 'Ask an admin account to do this.' };
    const payload = await handleAction('management.staff.create', {
      display_name: clean(args.name, 120),
      email: clean(args.email, 120),
      password: clean(args.password, 120),
      role: args.role === 'admin' ? 'admin' : 'staff',
    }, ctx.token);
    return { created: true, staff: payload.staff };
  }
  if (action === 'update') {
    if (!canAdmin(ctx)) return { error: 'Only a school admin can change staff accounts.', next: 'Ask an admin account to do this.' };
    const found = await resolveStaff(ctx, args);
    if (!found.staff) return { ...found, next: 'Use the staff email to identify the account.' };
    const payload = await handleAction('management.staff.update', {
      id: found.staff.id,
      role: args.role,
      suspended: typeof args.suspended === 'boolean' ? args.suspended : undefined,
    }, ctx.token);
    return { updated: true, staff: payload.staff };
  }
  if (action === 'delete') {
    if (!canAdmin(ctx)) return { error: 'Only a school admin can delete staff logins.', next: 'Ask an admin account to do this.' };
    const found = await resolveStaff(ctx, args);
    if (!found.staff) return { ...found, next: 'Use the staff email to identify the account.' };
    await handleAction('management.staff.delete', { id: found.staff.id }, ctx.token);
    return { deleted: true, staff: found.staff };
  }
  if (action === 'invite_read' || action === 'read_invite') {
    const payload = await handleAction('management.invite.read', {}, ctx.token);
    return { invite: payload.invite };
  }
  if (action === 'invite_update' || action === 'update_invite') {
    if (!canAdmin(ctx)) return { error: 'Only a school admin can change the invite code.', next: 'Ask an admin account to do this.' };
    const payload = await handleAction('management.invite.update', {
      invite_code: clean(args.code, 60) || undefined,
      invite_enabled: args.enabled !== false,
    }, ctx.token);
    return { saved: true, invite: payload.invite };
  }
  return {
    error: `I do not know the staff action "${action}".`,
    next: 'Use one of: list, create, update, delete, invite_read, invite_update.',
  };
}

// ---------------------------------------------------------------------------
// Page review: one call gives readiness and every line.
// ---------------------------------------------------------------------------
async function reviewPage(ctx, args, context, jobId) {
  const id = clean(args?.job_id || args?.page_id, 40) || clean(jobId, 40);
  if (!id) {
    const listed = await listPages(ctx, { limit: args?.limit }, context);
    return {
      ...listed,
      next: 'Give a page id with review_page to read its lines, or attach the page photo to start one.',
    };
  }
  const readiness = await jobReadiness(ctx, id);
  if (readiness.error) return readiness;
  const rows = await pageRows(ctx, { job_id: id }, context, id);
  return {
    ...readiness,
    page: rows,
    next: 'Use record_scores to put these lines into the school result. If the reader found no lines but the photo has marks, use the lines you read yourself with record_scores; do not stop.',
  };
}

// ---------------------------------------------------------------------------
// Which calls need one confirmation
// ---------------------------------------------------------------------------
const ALWAYS_CONFIRM = new Set([
  'update_settings',
  'approve_batch',
  'publish_results',
]);

function requiresConfirmation(name, args) {
  if (ALWAYS_CONFIRM.has(name)) return true;
  const action = actionOf(args);
  if (name === 'update_subject_catalog') return action !== 'list';
  if (name === 'manage_students') return ['archive', 'archive_many', 'delete', 'move'].includes(action);
  if (name === 'update_pupil_records') return action.startsWith('clear_');
  if (name === 'manage_staff') return ['create', 'update', 'delete', 'invite_update', 'update_invite'].includes(action);
  // generate_documents decides for itself: samples run free, finals ask once.
  return false;
}

const FUNCTION_DECLARATIONS = [
  {
    name: 'get_school_snapshot',
    description: 'Read the school before acting: session, term, every class, pupil counts, every subject with its stored index, which subjects have no marks or partial marks, recent write batches and approvals. The first call in a session and whenever a class, subject or term is unclear.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING', description: 'Optional class to focus on, in the school\'s own wording.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
    },
  },
  {
    name: 'resolve_students',
    description: 'Match names written on a sheet to real pupils in one class. Returns confidence, the accepted pupil, alternatives to ask about, and anything to hold. Use this before recording a sheet; never guess a pupil.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING', description: 'The class on the sheet.' },
        names: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Each name exactly as written, in sheet order.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class', 'names'],
    },
  },
  {
    name: 'resolve_subject',
    description: 'Find a subject\'s permanent stored index in a class. Handles short forms, initials and remembered aliases. Always use the returned index; never use a position in a list.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING', description: 'The subject as the user or sheet says it.' },
      },
      required: ['class', 'subject'],
    },
  },
  {
    name: 'get_scores',
    description: 'Read saved marks for a class, optionally one subject, one component or one pupil. Use before a correction and to re-read after a write.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING' },
        component: { type: 'STRING', description: 'ca1, ca2, ca3 or exam. Omit for every component.' },
        student: { type: 'STRING' },
        student_id: { type: 'STRING' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
    },
  },
  {
    name: 'completeness_report',
    description: 'Say exactly which subjects are not started, partly recorded or complete, per class and section, and optionally name the pupils still missing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING', description: 'One class. Omit for the whole school or a section.' },
        section: { type: 'STRING', description: 'nursery, primary, junior or senior.' },
        include_students: { type: 'BOOLEAN', description: 'true to name the missing pupils.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
    },
  },
  {
    name: 'rank_students',
    description: 'Rank a class by overall average, or by one component, with positions and subject counts.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        component: { type: 'STRING', description: 'overall, ca1, ca2, ca3 or exam.' },
        top_n: { type: 'NUMBER', description: 'How many to return. 0 returns the whole class.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class'],
    },
  },
  {
    name: 'compare_with_existing',
    description: 'Check whether a sheet duplicates another subject\'s saved scores for the same pupils. Use before recording a new subject.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING', description: 'The subject the sheet is for.' },
        entries: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              line: { type: 'NUMBER' },
              name: { type: 'STRING' },
              student_id: { type: 'STRING' },
              value: { type: 'NUMBER' },
            },
          },
        },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class', 'subject', 'entries'],
    },
  },
  {
    name: 'review_page',
    description: 'Read a record-book page: readiness, every line, the pupil each line points to and the mark read. With no page id, list recent pages.',
    parameters: {
      type: 'OBJECT',
      properties: {
        job_id: { type: 'STRING', description: 'Page id. Defaults to the page open in this chat.' },
        limit: { type: 'NUMBER' },
      },
    },
  },
  {
    name: 'start_page',
    description: 'Start or reuse a record-book page for a class and subject when the user attaches a blank page or asks to read a page. Do not use this for a sheet that already has scores; record that directly.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING' },
        term: { type: 'STRING' },
        column: { type: 'STRING', description: 'EXAM or CLASS EXERCISE (CA).' },
        instruction: { type: 'STRING' },
      },
      required: ['class', 'subject'],
    },
  },
  {
    name: 'get_attachment',
    description: 'Read the photo stored with this chat: its description, sheet type, class, subject, term and the lines already read. Omit file_id for the most recent photo. Use this on a later turn instead of asking the user to send the page again.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_id: { type: 'STRING', description: 'The stored photo id. Omit for the most recent photo.' },
      },
    },
  },
  {
    name: 'sheet_review',
    description: 'Work the one open photo-sheet review for this chat. action status reads it, answer saves the user\'s numbered answers, commit writes every ready line in one audited batch per component. The server also prepares the review from a photo and applies a later answer by itself, so use this tool to read the saved state, not to re-extract the photo.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'status, answer or commit.' },
        text: { type: 'STRING', description: 'The user\'s answers in one message, e.g. "1: Chidi Okeke, 2: skip, 3: 14". Only for answer.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'record_scores',
    description: 'Put a score sheet into the school result. First call without commit: it returns a diff and holds uncertain lines. After the user answers, call again with commit true and the decisions. Skips existing values unless allow_overwrite is true. One audited batch with undo.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING' },
        component: { type: 'STRING', description: 'ca1, ca2, ca3 or exam. Defaults to the first class exercise.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
        entries: {
          type: 'ARRAY',
          description: 'One entry per sheet line, keeping the sheet line number.',
          items: {
            type: 'OBJECT',
            properties: {
              line: { type: 'NUMBER' },
              name: { type: 'STRING', description: 'The name exactly as written on the sheet.' },
              student_id: { type: 'STRING', description: 'Use when resolve_students already gave the id.' },
              value: { type: 'NUMBER' },
              flags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'crossed_out, unreadable, overwritten, extra_mark, missing, ambiguous.' },
              decision: { type: 'STRING', description: 'use, skip or hold. Use when the user has answered a review question.' },
              overwrite: { type: 'BOOLEAN' },
            },
          },
        },
        commit: { type: 'BOOLEAN', description: 'false or omitted for a preview; true to write.' },
        allow_overwrite: { type: 'BOOLEAN', description: 'Only after the user confirms the shown difference.' },
        confirm_duplicate: { type: 'BOOLEAN', description: 'Set only after the user confirms a copied-sheet warning.' },
        confirm_large: { type: 'BOOLEAN', description: 'Set after the user confirms a batch over the size guard.' },
        reason: { type: 'STRING' },
      },
      required: ['class', 'subject', 'entries'],
    },
  },
  {
    name: 'correct_score',
    description: 'Change one saved mark. Shows the old value, writes the new one with a reason, verifies and returns an undo id.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subject: { type: 'STRING' },
        component: { type: 'STRING', description: 'ca1, ca2, ca3 or exam.' },
        student: { type: 'STRING' },
        student_id: { type: 'STRING' },
        new_value: { type: 'NUMBER' },
        reason: { type: 'STRING' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class', 'subject', 'new_value'],
    },
  },
  {
    name: 'remember_alias',
    description: 'Store a confirmed sheet-name to pupil match so the same spelling never asks again.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        sheet_name: { type: 'STRING', description: 'The name exactly as written on the sheet.' },
        student: { type: 'STRING' },
        student_id: { type: 'STRING' },
      },
      required: ['sheet_name'],
    },
  },
  {
    name: 'undo_batch',
    description: 'Reverse one audited write batch, restoring every old value. With no batch id, undo the most recent batch.',
    parameters: {
      type: 'OBJECT',
      properties: { batch_id: { type: 'STRING' } },
    },
  },
  {
    name: 'approve_batch',
    description: 'Approve results for a whole class in one action so final documents can be made. Subjects default to all. Needs one confirmation. Nothing is published.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subjects: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Subject names or indexes. Omit or ["all"] for every subject.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class'],
    },
  },
  {
    name: 'publish_results',
    description: 'Publish or unpublish a class\'s results to the parent portal. Needs one confirmation showing the class, term and subjects.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        subjects: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Subject names or indexes. Omit for all.' },
        published: { type: 'BOOLEAN', description: 'true to publish, false to unpublish.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class'],
    },
  },
  {
    name: 'update_subject_catalog',
    description: 'List or change a class subject catalog. add, rename, activate, deactivate and remove. A removed subject is hidden and keeps its index; nothing is renumbered. Changes ask once.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        action: { type: 'STRING', description: 'list, add, rename, activate, deactivate or remove.' },
        subject: { type: 'STRING', description: 'Subject name or index.' },
        subject_index: { type: 'NUMBER' },
        new_name: { type: 'STRING' },
      },
      required: ['class', 'action'],
    },
  },
  {
    name: 'generate_documents',
    description: 'Make broadsheets or report cards from the parameters given. mode sample prints the same real card with a small corner sample mark and needs no approval; every subject is listed and anything not entered yet stays blank. mode final asks once, and may approve the whole class in the same confirmed action. Pass pupil (or pupils) to print one learner\'s report card instead of the whole class batch.',
    parameters: {
      type: 'OBJECT',
      properties: {
        class: { type: 'STRING' },
        kind: { type: 'STRING', description: 'cards, broadsheet or both.' },
        template: { type: 'STRING', description: 'modern, classic, compact or premium.' },
        templates: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Render the same document in several templates.' },
        mode: { type: 'STRING', description: 'sample or final.' },
        pupil: { type: 'STRING', description: 'One pupil name, for a single report card instead of the class batch.' },
        term: { type: 'STRING' },
        session: { type: 'STRING' },
      },
      required: ['class'],
    },
  },
  {
    name: 'update_settings',
    description: 'Change school settings, with a before and after summary. Send only the keys to change as a nested patch. The class map depts is complete: every class that should stay must be included. Needs one confirmation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        patch: { type: 'OBJECT', description: 'Partial settings object. Nested objects are merged, except depts which replaces the class map.' },
        note: { type: 'STRING', description: 'One-line summary for the confirmation card.' },
      },
      required: ['patch'],
    },
  },
  {
    name: 'manage_students',
    description: 'Every pupil action: list a class, find one pupil, search the school, list archived pupils, add one or many, edit, archive one or many, restore, permanently delete an archived record, move pupils to another class, or repair admission numbers. Archive, delete and move ask once. On add, a gender is required for every pupil and the admission number is filled in automatically when omitted. "archive_many" takes names, or all=true with an optional keep list, and is the way to clear placeholder names off an untidy roster. "fix_admission_numbers" gives every pupil in a class their own number in one call.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'list, find, search, archived, add, edit, archive, archive_many, restore, delete, move or fix_admission_numbers.' },
        class: { type: 'STRING' },
        name: { type: 'STRING' },
        student_id: { type: 'STRING' },
        gender: { type: 'STRING', description: 'Required on add: male or female.' },
        admno: { type: 'STRING', description: 'Optional. The next class number is used when omitted.' },
        new_name: { type: 'STRING' },
        new_class: { type: 'STRING' },
        keep: { type: 'ARRAY', items: { type: 'STRING' }, description: 'With archive_many all=true: names to leave on the list.' },
        sequential: { type: 'BOOLEAN', description: 'With fix_admission_numbers: renumber the whole class from STU/0001 in join order, closing gaps and odd high numbers. Without it only the blanks and duplicates move.' },
        from: { type: 'STRING' },
        to: { type: 'STRING' },
        names: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Pupils to move.' },
        pupils: {
          type: 'ARRAY',
          description: 'Pupils to add.',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              gender: { type: 'STRING', description: 'Required: male or female.' },
              admno: { type: 'STRING', description: 'Optional. The next class number is used when omitted.' },
            },
            required: ['name'],
          },
        },
        all: { type: 'BOOLEAN', description: 'Move the whole class.' },
        reason: { type: 'STRING' },
        include_archived: { type: 'BOOLEAN' },
      },
      required: ['action'],
    },
  },
  {
    name: 'update_pupil_records',
    description: 'Read or change one pupil\'s other records: fees, remarks, trait ratings. clear_ actions remove a term record and ask once. read shows fees, remarks and traits.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'read, fees, remarks, traits, clear_marks, clear_fee, clear_remarks or clear_traits.' },
        class: { type: 'STRING' },
        name: { type: 'STRING' },
        student_id: { type: 'STRING' },
        total: { type: 'NUMBER' },
        paid: { type: 'NUMBER' },
        academic: { type: 'STRING' },
        form_master: { type: 'STRING' },
        principal: { type: 'STRING' },
        type: { type: 'STRING', description: 'affective or psychomotor.' },
        ratings: { type: 'OBJECT', description: 'Trait name to rating 1-5.' },
        fields: { type: 'ARRAY', items: { type: 'STRING' } },
        subject: { type: 'STRING', description: 'For clear_marks.' },
        term: { type: 'STRING' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_staff',
    description: 'List, create, change or delete staff logins, and read or set the invite code. Create, update, delete and invite changes ask once.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'list, create, update, delete, invite_read or invite_update.' },
        name: { type: 'STRING' },
        email: { type: 'STRING' },
        password: { type: 'STRING' },
        role: { type: 'STRING', description: 'staff or admin.' },
        suspended: { type: 'BOOLEAN' },
        code: { type: 'STRING' },
        enabled: { type: 'BOOLEAN' },
      },
      required: ['action'],
    },
  },
];

const DONE_LABELS = {
  get_school_snapshot: 'Read the school snapshot',
  resolve_students: 'Matched the sheet names',
  resolve_subject: 'Found the subject',
  get_scores: 'Read the saved marks',
  completeness_report: 'Checked what is missing',
  rank_students: 'Ranked the class',
  compare_with_existing: 'Checked for a copied sheet',
  review_page: 'Read the page',
  get_attachment: 'Read the stored photo',
  sheet_review: 'Worked the score sheet review',
  start_page: 'Started the page',
  record_scores: 'Recorded the scores',
  correct_score: 'Corrected the score',
  remember_alias: 'Remembered the sheet name',
  undo_batch: 'Undid the batch',
  approve_batch: 'Approved the class results',
  publish_results: 'Changed publication',
  update_subject_catalog: 'Updated the subject catalog',
  generate_documents: 'Made the documents',
  update_settings: 'Saved the settings',
  manage_students: 'Updated the pupil records',
  update_pupil_records: 'Updated the pupil records',
  manage_staff: 'Updated the staff records',
};

function labelFor(tool, args, context) {
  const cls = args?.class ? classEntry(context, args.class)?.label || args.class : '';
  const action = actionOf(args);
  if (tool === 'manage_students') {
    const map = {
      list: 'Read the class list', find: 'Found the pupil', search: 'Searched the pupils',
      archived: 'Read the removed pupils', add: 'Added the pupil', edit: 'Updated the pupil',
      archive: 'Removed the pupil', archive_many: 'Removed the pupils',
      fix_admission_numbers: 'Repaired the admission numbers',
      restore: 'Restored the pupil', delete: 'Deleted the pupil record',
      move: `Moved the pupils${args?.to ? ` to ${args.to}` : ''}`,
    };
    return `${map[action] || 'Updated the pupils'}${cls ? ` (${cls})` : ''}`;
  }
  if (tool === 'update_pupil_records') {
    const map = {
      read: 'Read the pupil records', records: 'Read the pupil records', fees: 'Updated fees',
      update_fee: 'Updated fees', remarks: 'Saved remarks', save_remarks: 'Saved remarks',
      traits: 'Saved trait ratings', save_traits: 'Saved trait ratings',
      clear_marks: 'Deleted the marks', clear_fee: 'Deleted the fee record',
      clear_remarks: 'Cleared the remarks', clear_traits: 'Cleared the trait ratings',
    };
    return map[action] || 'Updated the pupil records';
  }
  if (tool === 'manage_staff') {
    const map = {
      list: 'Read the staff list', create: 'Created the staff login', update: 'Updated the staff account',
      delete: 'Deleted the staff login', invite_read: 'Read the invite code state',
      update_invite: 'Updated the invite code', invite_update: 'Updated the invite code',
    };
    return map[action] || 'Updated the staff records';
  }
  if (tool === 'record_scores') {
    return `${args?.commit === true ? 'Recorded' : 'Previewed'} ${args?.subject || 'the'} scores${cls ? ` for ${cls}` : ''}`;
  }
  if (tool === 'generate_documents') return `${args?.mode === 'final' ? 'Made final' : 'Made sample'} documents${cls ? ` for ${cls}` : ''}`;
  return DONE_LABELS[tool] || tool;
}

function describePending(tool, args, context) {
  const cls = args?.class ? classEntry(context, args.class)?.label || args.class : '';
  const action = actionOf(args);
  switch (tool) {
    case 'update_settings':
      return `Save settings: ${String(args?.note || Object.keys(args?.patch || {}).join(', ')).replace(/[.?!]+$/, '')}?`;
    case 'approve_batch':
      return `Approve every subject for ${cls || 'this class'}${args?.term ? ` in ${args.term}` : ''} so final documents can be made? Nothing is published and every score stays as it is.`;
    case 'publish_results':
      return `${args?.published === false ? 'Unpublish' : 'Publish'} ${cls || 'this class'}${args?.term ? ` for ${args.term}` : ''} to the parent portal?`;
    case 'update_subject_catalog': {
      const subject = args?.new_name || args?.subject || 'the subject';
      if (action === 'add') return `Add ${subject} to ${cls || 'the class'}?`;
      if (action === 'rename') return `Rename ${args?.subject || 'the subject'} to ${args?.new_name || subject} in ${cls || 'the class'}?`;
      if (action === 'remove' || action === 'deactivate') return `Hide ${subject} in ${cls || 'the class'}? Its index and saved scores are kept.`;
      if (action === 'activate') return `Show ${subject} in ${cls || 'the class'} again?`;
      return `Change the subject catalog for ${cls || 'the class'}?`;
    }
    case 'manage_students':
      if (action === 'archive') return `Remove ${args?.name || 'this pupil'}${cls ? ` from ${cls}` : ''}? The record is kept and can be restored.`;
      if (action === 'archive_many') {
        const names = Array.isArray(args?.names) ? args.names : [];
        if (args?.all === true) {
          const keep = Array.isArray(args?.keep) ? args.keep : [];
          return `Remove every pupil in ${cls || 'the class'}${keep.length ? ` except ${keep.join(', ')}` : ''}? The records are kept and can be restored.`;
        }
        return `Remove ${names.join(', ') || 'these pupils'}${cls ? ` from ${cls}` : ''}? The records are kept and can be restored.`;
      }
      if (action === 'delete') return `Erase ${args?.name || 'this pupil'}'s archived record and their marks, fees, remarks and traits for good?`;
      if (action === 'move') {
        return args?.all === true
          ? `Move every pupil from ${args?.from || args?.class || 'one class'} to ${args?.to || 'another class'}?`
          : `Move ${(Array.isArray(args?.names) ? args.names : []).join(', ') || args?.name || 'these pupils'} to ${args?.to || 'another class'}?`;
      }
      return `Change the pupil records${cls ? ` in ${cls}` : ''}?`;
    case 'update_pupil_records':
      if (action === 'clear_marks') return `Delete ${args?.name ? `${args.name}'s` : 'the'} ${args?.subject || ''} marks?`;
      if (action === 'clear_fee') return `Delete ${args?.name || 'this pupil'}'s fee record for the term?`;
      if (action === 'clear_remarks') return `Clear ${args?.name || 'this pupil'}'s remarks for the term?`;
      if (action === 'clear_traits') return `Clear ${args?.name || 'this pupil'}'s ${args?.type || 'trait'} ratings for the term?`;
      return `Change ${args?.name || 'this pupil'}'s records?`;
    case 'manage_staff':
      if (action === 'create') return `Create a ${args?.role || 'staff'} login for ${args?.email}?`;
      if (action === 'delete') return `Delete the login for ${args?.email || args?.name || 'this staff member'}?`;
      if (action === 'update') return `Change ${args?.email || args?.name || 'this staff account'}${typeof args?.suspended === 'boolean' ? (args.suspended ? ' to suspended' : ' to active') : ''}${args?.role ? ` to ${args.role}` : ''}?`;
      return `Update the staff invite ${args?.code ? 'code' : 'setting'}?`;
    default:
      return `Run ${tool}?`;
  }
}

async function executeTool(name, args, ctx, context, jobId, confirmed) {
  const runner = TOOLS[name];
  if (!runner) {
    return {
      error: `There is no action called ${name}.`,
      next: 'Call get_school_snapshot first, then use one of the school actions it describes.',
    };
  }
  const safeArgs = args && typeof args === 'object' ? args : {};
  if (!confirmed && requiresConfirmation(name, safeArgs)) {
    return {
      needs_confirmation: true,
      summary: describePending(name, safeArgs, context),
      tool: name,
      args: safeArgs,
      token: tokenFor(ctx.actor.school_id, name, safeArgs),
    };
  }
  try {
    const result = await runner(ctx, safeArgs, context, jobId, confirmed);
    return result || { ok: true };
  } catch (error) {
    const payload = error?.payload || {};
    return {
      error: payload.message || error?.message || `${name} failed.`,
      next: 'Nothing was changed. Read the record again with get_school_snapshot or get_scores, then retry.',
    };
  }
}

module.exports = {
  FUNCTION_DECLARATIONS,
  CONFIRM_TOOLS: ALWAYS_CONFIRM,
  executeTool,
  tokenFor,
  describePending,
  labelFor,
  classEntry,
  subjectIndex,
  schoolOverview,
};
