'use strict';

// Conversational agent brain for /api/ops (routed via POST /api/ops-jobs
// with action: "chat"). Prefixing with "_" keeps this helper out of Vercel's
// serverless function count while giving the assistant full LLM power over
// the school's active context and the current uploaded staging job.

const { supabaseRest } = require('./_lib');
const crypto = require('node:crypto');
const {
  FUNCTION_DECLARATIONS,
  executeTool,
  describePending,
  labelFor,
  tokenFor,
} = require('./_ops-tools');
const {
  prepareSheetReview,
  loadSheetState,
  applySheetAnswers,
  commitSheetReview,
  sheetReviewText,
  parseSheetAnswers,
} = require('./_school-actions');
const { opsRpc } = require('./_ops');
const {
  COLUMN_LABELS,
  findClass,
  findColumn,
  findSubject,
  findTerm,
  normalise,
  parseInstruction,
} = require('./_ops-instruction');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
].filter(Boolean))];

const RIVER_API_KEY = process.env.RIVER_API_KEY || '';
const RIVER_BASE_URL = String(process.env.RIVER_BASE_URL || '').trim().replace(/\/+$/, '');
const RIVER_MODEL = process.env.RIVER_READER_MODEL || process.env.RIVER_SECOND_OPINION_MODEL || '';
// One assistant model for the whole portal, the same one the reader uses. An
// env value overrides it without a deploy, and Gemini stays as the emergency
// backup only.
const ASSISTANT_MODEL = String(
  process.env.ASSISTANT_MODEL || RIVER_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
).trim();

// The developer console can switch routes without a deploy. The server reads
// the rows below, decrypts a stored key only in memory, and falls back to the
// env values when a route is missing or disabled. A route that fails is tried
// for 60 seconds before the next request re-reads it.
const OPS_SECRET_KEY = process.env.OPS_SECRET_KEY || '';
const MAX_TOOL_CALLS = 12;
const MAX_REPLY_TOKENS = 4000;
const CONTEXT_KEEP_MESSAGES = 12;
const TOOL_RESULT_CAP = 6000;
let ROUTE_CACHE = { at: 0, routes: null };

async function loadModelRoutes(force = false) {
  if (!force && ROUTE_CACHE.routes && Date.now() - ROUTE_CACHE.at < 60000) {
    return ROUTE_CACHE.routes;
  }
  const list = await opsRpc('ops_model_config_list', {}).catch(() => null);
  const routes = {};
  for (const role of ['primary', 'secondary', 'vision']) {
    const row = Array.isArray(list?.routes) ? list.routes.find((item) => item.role === role) : null;
    if (!row || row.enabled === false) continue;
    let apiKey = null;
    if (row.has_key && OPS_SECRET_KEY) {
      const secret = await opsRpc('ops_model_config_secret', {
        p_role: role,
        p_secret: OPS_SECRET_KEY,
      }).catch(() => null);
      apiKey = secret?.ok && secret.route?.api_key ? String(secret.route.api_key) : null;
    }
    routes[role] = { ...row, api_key: apiKey };
  }
  ROUTE_CACHE = { at: Date.now(), routes };
  return routes;
}

function estimateTokens(value) {
  try {
    return Math.max(1, Math.round(JSON.stringify(value).length / 4));
  } catch {
    return 1;
  }
}

// A plain log line per model call. It is awaited because it is one fast insert,
// but a failure can never change the answer or block a write.
async function logModelCall(meter, entry) {
  if (!meter || !meter.schoolId) return;
  const usage = entry.usage || {};
  const tokensIn = Number(usage.tokens_in || usage.prompt_tokens || 0) || 0;
  const tokensOut = Number(usage.tokens_out || usage.completion_tokens || 0) || 0;
  const cached = Number(usage.cached_tokens || 0) || 0;
  await opsRpc('ops_usage_log', {
    p_school_id: meter.schoolId,
    p_user_id: meter.userId || null,
    p_session_id: meter.sessionId || null,
    p_route: entry.route || 'primary',
    p_provider: entry.provider || null,
    p_model: entry.model || null,
    p_tokens_in: tokensIn,
    p_tokens_out: tokensOut,
    p_cached_tokens: cached,
    p_context_tokens: meter.contextTokens || 0,
    p_tool_calls: Number(entry.toolCalls || 0),
    p_ok: entry.ok !== false,
    p_error_code: entry.error || null,
  }).catch(() => null);
}


function cleanStr(value, max = 4000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function parseRowHints(flagRaw, rawName) {
  const flag = String(flagRaw || '');
  let secondRead = null;
  let readerHintPupil = null;
  if (flag.startsWith('name_hint|')) {
    const parts = flag.slice('name_hint|'.length).split('|');
    readerHintPupil = parts.shift() || null;
    const lit = parts.join('|');
    if (lit && lit !== rawName) secondRead = lit;
  } else if (flag.startsWith('name_disputed|')) {
    const lit = flag.slice('name_disputed|'.length);
    if (lit && lit !== rawName) secondRead = lit;
  }
  return { secondRead, readerHintPupil };
}

function buildJobDigest(detail, context) {
  if (!detail || !detail.job) return null;
  const job = detail.job;
  const rows = Array.isArray(detail.staged_rows) ? detail.staged_rows : [];
  const marks = Array.isArray(detail.marks) ? detail.marks : [];
  const roster = Array.isArray(detail.roster) ? detail.roster : [];
  const files = Array.isArray(detail.files) ? detail.files : [];
  const proposals = Array.isArray(detail.pupil_proposals) ? detail.pupil_proposals : [];

  const rosterById = Object.fromEntries(roster.map((p) => [p.id, p]));
  // One page can carry more than one column's marks. The digest must read the
  // same column the page is fixed to, never whichever row happened to be last.
  const marksByRow = {};
  for (const m of marks) {
    if (!m || !m.staged_row_id) continue;
    const existing = marksByRow[m.staged_row_id];
    if (!existing || (m.column_label === job.column_label && existing.column_label !== job.column_label)) {
      marksByRow[m.staged_row_id] = m;
    }
  }

  const classList = Array.isArray(context?.classes) ? context.classes : [];
  const clsEntry = classList.find((c) => c.key === job.class_key) || null;
  const classLabel = clsEntry?.label || job.class_key || null;
  const subjectLabel = (Array.isArray(job.subject_set) && job.subject_set[0]?.label) || null;

  const lines = rows.map((r) => {
    const pupil = r.student_id ? rosterById[r.student_id] : null;
    const m = marksByRow[r.id] || null;
    const hints = parseRowHints(r.flag, r.student_name_raw);
    const flags = [];
    const flagText = String(r.flag || '');
    if (/cross|strike/i.test(flagText)) flags.push('crossed_out');
    if (/unread|unclear|smudge|torn|illegible/i.test(flagText)) flags.push('unreadable');
    if (/overwrit|written over/i.test(flagText)) flags.push('overwritten');
    if (/extra/i.test(flagText)) flags.push('extra_mark');
    if (!String(r.student_name_raw || '').trim()) flags.push('missing_name');
    if (hints.secondRead) flags.push('name_uncertain');
    if (m && (m.status === 'ambiguous' || m.status === 'rejected')) flags.push('unreadable_score');
    if (m && m.status === 'blank') flags.push('missing_score');
    return {
      line: r.row_no,
      row_id: r.id,
      on_page: r.student_name_raw || '',
      second_read: hints.secondRead,
      flags,
      portal_pupil: pupil?.name || null,
      portal_pupil_id: pupil?.id || null,
      admno: pupil?.admno || null,
      suggested_candidates: Array.isArray(r.candidate_names) && r.candidate_names.length ? r.candidate_names : undefined,
      match_group: r.match_list || null, // A=exact, B=suggested one-tap, C=unmatched on sheet
      match_method: r.match_method || null,
      match_confidence: r.match_confidence != null ? Math.round(Number(r.match_confidence) * 100) : null,
      decision: r.status || 'pending', // accepted, pending, rejected
      mark_id: m?.id || null,
      mark: m ? (m.status === 'read' ? m.value : null) : null,
      mark_status: m ? m.status : 'none', // read, ambiguous, blank, rejected
      mark_candidates: m && m.status === 'ambiguous' && Array.isArray(m.candidates) ? m.candidates : undefined,
    };
  });

  const numericLines = lines.filter((l) => l.mark_status === 'read' && typeof l.mark === 'number' && Number.isFinite(l.mark));
  let stats = null;
  if (numericLines.length > 0) {
    const sortedDesc = [...numericLines].sort((a, b) => b.mark - a.mark);
    const sortedAsc = [...numericLines].sort((a, b) => a.mark - b.mark);
    const maxVal = sortedDesc[0].mark;
    const minVal = sortedAsc[0].mark;
    const sum = numericLines.reduce((acc, item) => acc + item.mark, 0);
    stats = {
      scored_count: numericLines.length,
      average_mark: Number((sum / numericLines.length).toFixed(1)),
      highest_mark: maxVal,
      highest_pupils: sortedDesc.filter((l) => l.mark === maxVal).map((l) => ({
        line: l.line,
        name: l.portal_pupil || l.on_page,
        mark: l.mark,
      })),
      lowest_mark: minVal,
      lowest_pupils: sortedAsc.filter((l) => l.mark === minVal).map((l) => ({
        line: l.line,
        name: l.portal_pupil || l.on_page,
        mark: l.mark,
      })),
    };
  }

  const alignment = job.alignment || {};
  const portalOnly = Array.isArray(alignment.portal_only)
    ? alignment.portal_only.map((p) => ({ name: p.name, admno: p.admno || null }))
    : [];

  const pendingNames = lines.filter((l) => l.decision === 'pending');
  const pendingMarks = lines.filter((l) => l.mark_status === 'ambiguous' || l.mark_status === 'rejected');
  const blankMarks = lines.filter((l) => l.mark_status === 'blank');
  const docFiles = files.filter((f) => f.document_type === 'broadsheet' || f.document_type === 'cards');

  return {
    job_id: job.id,
    status: job.status, // queued, processing, needs_review, needs_input, approved, applied, failed
    class_key: job.class_key || null,
    class_label: classLabel,
    subject: subjectLabel,
    column: job.column_label || null,
    term: job.term || null,
    academic_session: job.academic_session || null,
    last_error: job.last_error || null,
    reader_alive: Boolean(detail.reader?.alive),
    roster_count: roster.length,
    summary: {
      total_lines_read: lines.length,
      exact_matches_A: lines.filter((l) => l.match_group === 'A').length,
      suggested_matches_B: lines.filter((l) => l.match_group === 'B').length,
      unmatched_on_sheet_C: lines.filter((l) => l.match_group === 'C').length,
      in_portal_not_on_sheet_D: portalOnly.length,
      names_still_needing_review: pendingNames.length,
      marks_read: numericLines.length,
      marks_needing_review: pendingMarks.length,
      marks_blank: blankMarks.length,
      flagged_lines: lines.filter((l) => (l.flags || []).length).length,
      crossed_out_lines: lines.filter((l) => (l.flags || []).includes('crossed_out')).length,
      unreadable_lines: lines.filter((l) => (l.flags || []).includes('unreadable') || (l.flags || []).includes('unreadable_score')).length,
      ready_to_approve: lines.length > 0 && pendingNames.length === 0 && pendingMarks.length === 0 && job.status !== 'approved' && job.status !== 'applied',
      already_approved: job.status === 'approved' || job.status === 'applied',
      documents_generated: docFiles.map((f) => f.document_type),
    },
    score_statistics: stats,
    names_needing_review: pendingNames,
    marks_needing_review: pendingMarks,
    blank_mark_lines: blankMarks.map((l) => ({ line: l.line, name: l.portal_pupil || l.on_page })),
    portal_pupils_missing_from_sheet: portalOnly,
    pupil_proposals: proposals,
    roster: roster
      .filter((p) => p && p.id)
      .map((p) => ({ id: p.id, name: p.name || 'Pupil', admno: p.admno || null }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    all_lines: lines,
  };
}

async function fetchSchoolSnapshotIfNeeded(ctx, context, userText, draft, jobDigest) {
  const schoolId = ctx?.actor?.school_id;
  if (!schoolId) return null;

  try {
    const session = jobDigest?.academic_session || draft?.academic_session || context?.academic_session || '';
    const term = jobDigest?.term || draft?.term || context?.term || '';
    const mentionedClass = findClass(userText, context)?.key || jobDigest?.class_key || draft?.class_key || null;

    const [students, scores] = await Promise.all([
      supabaseRest(
        `students?archived=eq.false&select=id,class_key,name,gender,admno&order=name.asc&limit=2000`,
      ).catch(() => []),
      session && term
        ? supabaseRest(
          `scores?academic_session=eq.${encodeURIComponent(session)}&term=eq.${encodeURIComponent(term)}&select=class_key,student_id,subject_index,ca1,ca2,ca3,exam&limit=6000`,
        ).catch(() => [])
        : Promise.resolve([]),
    ]);

    const stuList = Array.isArray(students) ? students : [];
    const scoreList = Array.isArray(scores) ? scores : [];
    const byId = Object.fromEntries(stuList.map((s) => [s.id, s]));
    const classesByKey = Object.fromEntries(((context && context.classes) || []).map((c) => [c.key, c]));

    const perClass = {};
    for (const s of stuList) {
      if (!perClass[s.class_key]) perClass[s.class_key] = { pupils: 0, scores_entered: 0 };
      perClass[s.class_key].pupils += 1;
    }
    for (const sc of scoreList) {
      if (!perClass[sc.class_key]) perClass[sc.class_key] = { pupils: 0, scores_entered: 0 };
      const hasAny = sc.ca1 != null || sc.ca2 != null || sc.ca3 != null || sc.exam != null;
      if (hasAny) perClass[sc.class_key].scores_entered += 1;
    }

    let focusedClass = null;
    if (mentionedClass) {
      const clsMeta = classesByKey[mentionedClass];
      const clsStudents = stuList.filter((s) => s.class_key === mentionedClass);
      const clsScores = scoreList.filter((sc) => sc.class_key === mentionedClass);
      const subjects = clsMeta?.subjects || [];

      const pupilTotals = {};
      const subjectCounts = {};
      for (const sc of clsScores) {
        const subjName = subjects[Number(sc.subject_index)] || `Subject ${Number(sc.subject_index) + 1}`;
        const hasAny = sc.ca1 != null || sc.ca2 != null || sc.ca3 != null || sc.exam != null;
        if (!hasAny) continue;
        subjectCounts[subjName] = (subjectCounts[subjName] || 0) + 1;
        const total = Number(sc.ca1 || 0) + Number(sc.ca2 || 0) + Number(sc.ca3 || 0) + Number(sc.exam || 0);
        if (!pupilTotals[sc.student_id]) pupilTotals[sc.student_id] = { sum: 0, subjects: 0 };
        pupilTotals[sc.student_id].sum += total;
        pupilTotals[sc.student_id].subjects += 1;
      }

      const leaderboard = Object.entries(pupilTotals)
        .map(([id, agg]) => ({
          name: byId[id]?.name || 'Pupil',
          subjects_recorded: agg.subjects,
          total_points: Number(agg.sum.toFixed(1)),
          average: agg.subjects ? Number((agg.sum / agg.subjects).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.average - a.average)
        .slice(0, 8);

      focusedClass = {
        class_key: mentionedClass,
        class_label: clsMeta?.label || mentionedClass,
        pupil_count: clsStudents.length,
        roster_names: clsStudents.slice(0, 60).map((s) => s.name),
        subjects_with_scores_count: subjectCounts,
        top_performers_in_portal: leaderboard,
      };
    }

    return {
      academic_session: session || null,
      term: term || null,
      total_students_in_school: stuList.length,
      total_subject_score_rows_in_term: scoreList.length,
      classes_overview: perClass,
      focused_class_portal_records: focusedClass,
    };
  } catch {
    return null;
  }
}

function normalizeValidatedUpdates(rawUpdates, context, currentClassKey) {
  if (!rawUpdates || typeof rawUpdates !== 'object') return {};
  const out = {};
  const classes = Array.isArray(context?.classes) ? context.classes : [];

  let resolvedClass = null;
  if (rawUpdates.class_key) {
    const want = String(rawUpdates.class_key).trim().toLowerCase();
    resolvedClass = classes.find(
      (c) => String(c.key).toLowerCase() === want || String(c.label).toLowerCase() === want,
    ) || findClass(String(rawUpdates.class_key), context);
    if (resolvedClass) {
      out.class_key = resolvedClass.key;
      out.class_label = resolvedClass.label;
    }
  }

  const effectiveClass = resolvedClass
    || (currentClassKey ? classes.find((c) => c.key === currentClassKey) : null);

  if (rawUpdates.subject) {
    const subjRaw = String(rawUpdates.subject).trim();
    if (effectiveClass && Array.isArray(effectiveClass.subjects)) {
      const exact = effectiveClass.subjects.find(
        (s) => normalise(s) === normalise(subjRaw),
      );
      if (exact) {
        out.subject = exact;
      } else {
        const found = findSubject(subjRaw, effectiveClass, context);
        if (found && typeof found === 'string') out.subject = found;
      }
    } else {
      for (const c of classes) {
        const hit = (c.subjects || []).find((s) => normalise(s) === normalise(subjRaw));
        if (hit) {
          out.subject = hit;
          break;
        }
      }
    }
  }

  if (rawUpdates.column) {
    const colRaw = String(rawUpdates.column).trim().toUpperCase();
    if (colRaw === 'CLASS EXERCISE' || colRaw === 'CA') {
      out.column = COLUMN_LABELS['class exercise'];
    } else if (colRaw === 'EXAM' || colRaw === 'EXAMINATION') {
      out.column = COLUMN_LABELS.exam;
    } else {
      const foundCol = findColumn(String(rawUpdates.column));
      if (foundCol) out.column = foundCol;
    }
  }

  if (rawUpdates.term) {
    const foundTerm = findTerm(String(rawUpdates.term), null);
    if (foundTerm) out.term = foundTerm;
  }

  return out;
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  return { reply: trimmed, intent: 'chat', updates: {} };
}

const SHEET_VISION_PROMPT = `You read one photo of a school score sheet or record-book page. Return ONLY a JSON object, no prose and no markdown fence.

Shape:
{
  "sheet_type": "scores" | "blank_page" | "other",
  "description": "one short plain sentence about the page, e.g. JSS1 English CA 1 with 18 lines",
  "class": "the class written on the sheet, or null",
  "subject": "the subject written on the sheet, or null",
  "term": "1st Term, 2nd Term, 3rd Term, or null",
  "component": "ca1" | "ca2" | "ca3" | "exam" | null,
  "column_title": "the main column heading exactly as written, or null",
  "columns": [
    {
      "column_key": "a short stable name, e.g. ca1 or col1",
      "title": "the column heading exactly as written",
      "component": "ca1" | "ca2" | "ca3" | "exam" | null,
      "readable": true,
      "error": null,
      "lines": [
        { "line": 1, "raw_name": "the name exactly as written", "score": 12, "score_text": "12", "confidence": 0.9, "flags": [] }
      ]
    }
  ],
  "lines": [
    { "line": 1, "raw_name": "the name exactly as written", "score": 12, "score_text": "12", "confidence": 0.9, "flags": [] }
  ]
}

Rules:
- Read each score column separately. Put every column in "columns" with its own heading and lines.
- "lines" repeats the first or main column, so a single-column page is still simple.
- If one column is cut off, blurry, folded or crossed out, set that column readable false and put the reason in error. Still return every other column in full. Never fail the whole page because one column failed.
- A column heading you can see is always listed, even when none of its marks can be read. Keep its heading as the title, set readable false and say why in error.
- Keep the sheet's own line numbers. Read every printed line, top to bottom, including blank lines.
- A score that is crossed out, written over, smudged, torn or unclear goes in score_text and gets a flag. Set score to null when you cannot read it with certainty.
- A crossed-out, overwritten or missing name gets the matching flag and score null.
- Use only these flags: crossed_out, unreadable, overwritten, extra_mark, missing, ambiguous, not_a_name, blank.
- A tick, dash or empty cell is a missing score, not zero. Give that line the "missing" flag.
- confidence is 0 to 1 and says how sure you are of the name and score together. Use below 0.6 when either is unclear.
- Do not guess a name or a number. A wrong guess is worse than a flag.
- If the page is blank or almost blank, set sheet_type to "blank_page", columns to [] and lines to [].`;

function visionKind(route) {
  const provider = String(route?.provider || '').toLowerCase();
  return provider.includes('gemini') ? 'gemini' : 'river';
}

function sheetLineRead(line, index) {
  const score = line?.score == null || line.score === '' ? null : Number(line.score);
  const confidence = line?.confidence == null || line.confidence === '' ? null : Number(line.confidence);
  return {
    line: Number(line?.line) || index + 1,
    raw_name: cleanStr(line?.raw_name || line?.name, 120),
    score: Number.isFinite(score) ? score : null,
    score_text: cleanStr(line?.score_text || line?.score, 20),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    flags: Array.isArray(line?.flags) ? line.flags.map((flag) => cleanStr(flag, 30)).filter(Boolean) : [],
  };
}

function sheetParsed(parsed) {
  const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const lines = rawLines.slice(0, 250).map(sheetLineRead);
  const rawColumns = Array.isArray(parsed?.columns) ? parsed.columns : [];
  const columns = rawColumns.slice(0, 8).map((column, index) => {
    const declared = String(column?.component || '').toLowerCase();
    const title = cleanStr(column?.title || column?.column_title, 80) || null;
    return {
      column_key: cleanStr(column?.column_key || column?.key, 40) || `c${index + 1}`,
      title,
      component: ['ca1', 'ca2', 'ca3', 'exam'].includes(declared) ? declared : null,
      readable: column?.readable !== false,
      error: cleanStr(column?.error, 160) || null,
      lines: (Array.isArray(column?.lines) ? column.lines : []).slice(0, 250).map(sheetLineRead),
    };
  });
  const type = ['scores', 'blank_page', 'other'].includes(parsed?.sheet_type)
    ? parsed.sheet_type
    : (lines.some((item) => item.score != null) ? 'scores' : 'other');
  const firstComponent = String(parsed?.component || '').toLowerCase();
  return {
    sheet_type: type,
    description: cleanStr(parsed?.description, 240) || null,
    class: cleanStr(parsed?.class, 80) || null,
    subject: cleanStr(parsed?.subject, 120) || null,
    term: cleanStr(parsed?.term, 30) || null,
    component: ['ca1', 'ca2', 'ca3', 'exam'].includes(firstComponent) ? firstComponent : null,
    column_title: cleanStr(parsed?.column_title, 60) || null,
    columns: type === 'blank_page'
      ? []
      : (columns.length ? columns : [{
        column_key: 'primary',
        title: cleanStr(parsed?.column_title, 60) || null,
        component: ['ca1', 'ca2', 'ca3', 'exam'].includes(firstComponent) ? firstComponent : null,
        readable: true,
        error: null,
        lines,
      }]),
    lines: type === 'blank_page' ? [] : lines,
  };
}

async function geminiSheetRead(base64, mime, model, apiKey, deadline) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2500, deadline - Date.now()));
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SHEET_VISION_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [
            { text: 'Read this sheet and return the JSON.' },
            { inlineData: { mimeType: mime || 'image/jpeg', data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 3000, responseMimeType: 'application/json' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) return { ok: false, error: `${model}: HTTP ${res.status}` };
    const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: `${model}: no JSON` };
    const meta = data.usageMetadata || {};
    return {
      ok: true,
      model,
      parsed: sheetParsed(parsed),
      usage: {
        tokens_in: Number(meta.promptTokenCount) || 0,
        tokens_out: Number(meta.candidatesTokenCount) || 0,
        cached_tokens: Number(meta.cachedContentTokenCount) || 0,
      },
    };
  } catch (error) {
    return { ok: false, error: `${model}: ${error?.name === 'AbortError' ? 'timed out' : (error?.message || 'failed')}` };
  } finally {
    clearTimeout(timer);
  }
}

// The same OpenAI-compatible route the assistant chats on. Some River models
// take pictures exactly like text messages; this keeps one model and one key
// for the whole school instead of a second provider for photos.
async function riverSheetRead(base64, mime, route, deadline) {
  const apiKey = route?.api_key || RIVER_API_KEY;
  const baseUrl = String(route?.base_url || RIVER_BASE_URL || '').trim().replace(/\/+$/, '');
  const model = route?.model || ASSISTANT_MODEL;
  if (!apiKey || !baseUrl) return { ok: false, error: `${model}: the route has no key or address` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2500, deadline - Date.now()));
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 3000,
        messages: [
          { role: 'system', content: SHEET_VISION_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this sheet and return the JSON.' },
              {
                type: 'image_url',
                image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64}`, detail: 'high' },
              },
            ],
          },
        ],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const detail = data?.error?.message ? ` ${String(data.error.message).slice(0, 160)}` : '';
      return { ok: false, error: `${model}: HTTP ${res.status}${detail}` };
    }
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: `${model}: no JSON` };
    const usage = data.usage || {};
    return {
      ok: true,
      model,
      parsed: sheetParsed(parsed),
      usage: {
        tokens_in: Number(usage.prompt_tokens) || 0,
        tokens_out: Number(usage.completion_tokens) || 0,
        cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
      },
    };
  } catch (error) {
    return { ok: false, error: `${model}: ${error?.name === 'AbortError' ? 'timed out' : (error?.message || 'failed')}` };
  } finally {
    clearTimeout(timer);
  }
}

async function extractSheetPhoto(base64, mime, budgetMs = 20000, meter = null) {
  if (!base64) return null;
  // Photos use the configured vision route. With no separate vision route,
  // the assistant's own route reads the picture, so one model does both jobs.
  const routes = await loadModelRoutes().catch(() => ({}));
  const route = routes.vision || routes.primary || null;
  const kind = route ? visionKind(route) : ((RIVER_API_KEY && RIVER_BASE_URL) ? 'river' : 'gemini');
  const candidates = [];
  if (kind === 'river') {
    candidates.push({ kind, model: route?.model || ASSISTANT_MODEL, route });
  } else {
    const apiKey = route?.api_key || GEMINI_API_KEY;
    if (!apiKey) return null;
    const models = route?.model ? [...new Set([route.model, ...GEMINI_MODELS])] : GEMINI_MODELS;
    models.forEach((model) => candidates.push({ kind, model, route, apiKey }));
  }
  if (!candidates.length) return null;
  const deadline = Date.now() + Math.max(6000, budgetMs);
  const failures = [];
  for (const candidate of candidates) {
    if (Date.now() > deadline - 1000) break;
    const read = candidate.kind === 'gemini'
      ? await geminiSheetRead(base64, mime, candidate.model, candidate.apiKey, deadline)
      : await riverSheetRead(base64, mime, candidate.route, deadline);
    if (!read.ok) {
      failures.push(read.error);
      continue;
    }
    await logModelCall(meter, {
      route: 'vision',
      provider: candidate.route?.provider || candidate.kind,
      model: read.model,
      usage: read.usage,
    });
    return { ok: true, model: read.model, ...read.parsed };
  }
  console.error('ops_agent_sheet_read_failed', failures.join(' | ').slice(0, 500));
  return { ok: false, error: failures.join(' | ').slice(0, 300) || 'The sheet could not be read.' };
}

// The developer console checks the picture route with a real tiny image, so a
// model that only takes text cannot be mistaken for a working reader.
async function testVisionRoute() {
  const routes = await loadModelRoutes(true);
  const route = routes.vision || routes.primary || null;
  const kind = route ? visionKind(route) : ((RIVER_API_KEY && RIVER_BASE_URL) ? 'river' : 'gemini');
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const read = kind === 'gemini'
    ? await geminiSheetRead(tinyPng, 'image/png', route?.model || GEMINI_MODELS[0], route?.api_key || GEMINI_API_KEY, Date.now() + 20000)
    : await riverSheetRead(tinyPng, 'image/png', route, Date.now() + 20000);
  if (!read.ok) {
    return { ok: false, step: 'image', model: route?.model || (kind === 'river' ? ASSISTANT_MODEL : GEMINI_MODELS[0]), message: read.error };
  }
  return {
    ok: true,
    model: read.model,
    provider: route?.provider || kind,
    sheet_type: read.parsed.sheet_type,
    lines: read.parsed.lines.length,
  };
}

const SYSTEM_PROMPT = `You are the Arrabaaniy Assistant, the school operator inside the Arrabaaniy Standard School result portal. You act on the portal itself, not beside it. You are warm, quick and exact, and you speak like a trusted colleague.

HOW YOU WORK
- You decide. Read the message, the photo and the whole conversation yourself, then act with the tools. Nobody parses the sentence for you.
- Start a session by reading the school snapshot. It gives the real session, term, classes, subject indexes, what is missing and recent batches.
- Act first, talk second. For reading and previewing, act immediately. For a change, prepare it, show one short review, and finish once the user answers.
- Chain tools freely. Most jobs need several calls: snapshot, resolve names, resolve the subject, preview, write, read back, report.
- One chat can cover many classes, subjects, terms and jobs. Use the class, subject and term in the newest message; the open screen is only context. Never tell the user to start a new chat for a different class or subject.
- When a tool has already settled something, it is settled. Do not describe your own doubt about a name, class or subject the portal has matched. Act on it.
- Never ask for what is already in the conversation, on the sheet, in the page or in a tool result. Short forms and everyday wording are enough: "nur 1" is Nursery 1, "verbal" or "VR" is Verbal Reasoning, "1st term" is 1st Term, "CA" is the class exercise column.
- Ask once, only where a wrong guess is costly: a crossed-out name, an unreadable score, an ambiguous class, stream or subject, or two real choices. A line the resolver accepted is not one of those choices.
- If a tool returns an error or a next-step hint, do what the hint says. Never refuse when the portal allows the action.
- You are not caged to one class, one subject or one pupil. If the user moves to another class or subject in the same chat, follow them and keep going.

SCORE SHEETS FROM A PHOTO OR TEXT
The server reads the photo and prepares the review before you speak. SHEET_READ_FROM_PHOTO is the structured read, OPEN_SHEET_REVIEW is the one open review, SHEET_DRAFT_LINES are the saved lines, and SHEET_ACTION_RESULT says what already happened.
1. If SHEET_ACTION_RESULT.action is "prepared", the lines are already saved and names already matched. Show that one review and stop. Do not re-extract, do not call record_scores, do not call start_page, and do not ask for the class or subject when the review has them.
2. If the review is missing because the class or subject truly is not on the sheet, ask one short question. The next turn prepares the review again.
3. A matched line is settled. Never ask about a name the review put under "ready", and never call it uncertain.
4. Use the sheet_review tool when the database state may have changed: status to read the open review, answer with the user's one message of answers, commit to write every ready line. Prefer the tool result over your own counting.
5. The review lists every unresolved item once: unclear names, scores under 0.60, crossed-out or unreadable marks, duplicates, already recorded values and the learners not on the sheet. Present them in that one list. Never raise them one per turn.
6. The user answers in one message, for example "1: Chidi Okeke, 2: skip, 3: 14". The server parses those answers into the saved lines. If a later turn still has an open review, answer it before writing.
7. "Record", "write", "save", "yes" or "do it" writes every ready line in one audited batch per component. Existing marks are skipped, never overwritten silently. Report recorded, already there, held and blank counts, name the batch id and offer undo. Answering the review never writes by itself; wait for the record word. Use the numbers in SHEET_ACTION_RESULT and the review summary exactly; never count them yourself.
8. A column the reader could not read is reported as a failed column and never blocks the other columns. Say which column failed and offer to redo that column from a new photo.
9. If the page is blank with no marks, call start_page instead.
10. The photo stays with the chat. On a later turn, "the photo" means SHEET_ATTACHMENT or get_attachment, never a lost image. Never tell the user the photo is no longer attached when it is stored.
Never invent a pupil, a mark or a match. Held is held: do not write it. But a matched name is not held.

CORRECTIONS
A correction names the learner, subject and new value. Read the old value with get_scores, then call correct_score. Report the old value, the new value, the verified count and the undo id.

MATCHING NAMES
- A name the portal has matched is settled. Use the pupil id, write the mark, and move on. Do not ask the user to confirm a name the tool already accepted.
- Surname first or given name first is the same learner. An extra middle name is the same learner. A sheet line number or mark beside the name is not part of the name.
- Ask only when two different learners are genuinely close, or when no learner in the class has that name.
- If the user confirms a spelling, call remember_alias, accept it at once, and never question it again in this chat.
- Never say you are unsure when the resolver returned an accepted match. That makes the school re-check good work.

WHAT YOU CAN DO
- School: read the snapshot, subject catalogs, completeness, rankings and saved marks.
- Learners: search anywhere, list a class, add one or many, edit, move, archive, restore, permanently delete an archived record, read fees, remarks and traits, change them or clear them. Use "pupil" for early childhood and primary classes, "student" for JSS and SS.
- Untidy rosters: when a class holds placeholder names ("Bbj", "Fcgh") or repeated or missing admission numbers, offer the cleanup yourself. "archive_many" removes a named handful, or the whole class with all=true plus a keep list, so the teacher confirms once. "fix_admission_numbers" gives every learner in a class their own number in one call; never try to do that one edit per pupil.
- Staff: list, create, change and delete logins, and set the invite code.
- Results: record a sheet, correct one mark, remember a name, undo a batch, approve a class, publish or unpublish results, and change the subject catalog.
- Documents: make report cards and broadsheets in any template, as a watermarked sample or as a final. A sample never needs approval. A final uses approved subjects; if the class is not approved, offer to approve the whole class in the same confirmation.
- Settings: change any setting with a before and after summary.

APPROVAL, PUBLICATION AND CONFIRMATION
- Reading, searching, previewing, samples and reversible writes are free and need no confirmation. Every reversible write is audited and can be undone.
- Approve, publish, settings and catalog changes return needs_confirmation. Say exactly what will change and ask the user to tap Confirm. Do not say it is done yet.
- A class is approved once for all its subjects, never subject by subject.
- A teacher's chat cannot publish results or change settings. If the signed-in role is not an admin, say that plainly and stop.
- A batch over the size guard asks once before writing.
- Never overwrite or delete silently. Show the difference, or say what will be removed, and wait.

AFTER EVERY WRITE
- Verify by reading the database back, not by trusting the preview.
- Report what was recorded, what was held back, what was blank, and what remains to do.
- Give the batch id and say it can be undone. Never say "done" before a tool confirms it.

RECORD-BOOK PAGES
- A photo with marks on it is a score sheet, even if it is a page of a record book. Use record_scores, not start_page.
- start_page is only for a blank page with no marks. If a page is already open for the same class, subject, term and column, it is reused; say that plainly.
- Review a page with review_page: readiness, every line, the learner and the mark. A suggested line is never called matched or saved.
- If review_page says zero lines but the photo clearly has marks, do not stop and do not tell the user there is nothing to write. Use the lines you read from the photo and call record_scores directly.
- If the page is still being read, say it is still being read. If readiness gives a reason the reader stopped, say the reason. Then offer the direct score route instead of a dead end.
- "Record the ones you are sure of" means write every accepted line now. Do not wait for the uncertain lines and do not refuse because a page draft is empty.
- Approving a page is the charged pilot step; in this pilot the live write to school scores stays off for that route. The score-sheet route above writes directly; do not confuse the two.

INVESTIGATION
- When something looks wrong, read the data first, explain the cause in plain words, then propose the smallest fix.
- Subject identity is the stored index, never list position. A hidden subject keeps its index and its scores.
- Two sheet lines that point at one pupil are a duplicate; never write both.
- Code or schema changes are not yours to make. Write the request for the builder and say it has been handed over.

LEARNER WORDS
- Crèche, Nursery, KG and Primary classes: say "pupil" and "pupils".
- JSS and SS classes: say "student" and "students". Never call a secondary learner a pupil.
- The class context gives each class a section and a person word. Follow it in every reply, including lists and error sentences.
- On a whole-school answer, say "learners" or "students" rather than mixing the two.

STYLE
- Plain everyday words, short sentences, phone-friendly. Use "- " bullets when listing.
- Never mention tool names, JSON, RPCs or internal codes.
- When you list learners or marks, keep each item on its own line.
- A question you ask is a normal question, never a failure or an error.
- Report what actually changed: learner, class, subject, value. If a value was rejected for range, say the allowed range.
- Put learners in alphabetical order whenever you list a class, a roster or a group.
- The broadsheet and report cards appear as download buttons under your reply, so do not paste file links; say they are ready and name them.
- Answer greetings, thanks and simple explainers naturally without tools.
`;

function toGeminiHistory(history) {
  const contents = [];
  for (const message of history) {
    const text = message.text || (message.has_photo ? '[photo attached]' : '');
    if (!text) continue;
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  return contents;
}

async function geminiTurn(contents, useTools, budgetMs = 22000, route = null) {
  const apiKey = route?.api_key || GEMINI_API_KEY;
  const models = route?.model
    ? [...new Set([route.model, ...GEMINI_MODELS])]
    : GEMINI_MODELS;
  if (!apiKey) return null;
  const failures = [];
  // The whole search must finish well inside the function's time budget, even
  // when a model hangs.
  const deadline = Date.now() + Math.max(4000, budgetMs);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  async function askModel(model) {
    const controller = new AbortController();
    const room = Math.max(1500, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), Math.min(20000, room));
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const payload = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: MAX_REPLY_TOKENS },
      };
      if (useTools) payload.tools = [{ functionDeclarations: FUNCTION_DECLARATIONS }];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) {
        const parts = data.candidates?.[0]?.content?.parts || [];
        const calls = parts.filter((part) => part.functionCall?.name)
          .map((part) => ({ name: part.functionCall.name, args: part.functionCall.args || {} }));
        const text = parts.map((part) => part.text || '').join('').trim();
        if (calls.length || text) {
          const meta = data.usageMetadata || {};
          return {
            model,
            calls,
            text,
            parts,
            provider: route?.provider || 'gemini',
            usage: {
              tokens_in: Number(meta.promptTokenCount) || 0,
              tokens_out: Number(meta.candidatesTokenCount) || 0,
              cached_tokens: Number(meta.cachedContentTokenCount) || 0,
            },
          };
        }
        return null;
      }
      failures.push(`${model}: HTTP ${res.status} ${data.error?.message || ''}`.trim());
      // 503 means a demand spike and 429 a short quota pause: a second try often lands.
      if (res.status === 503) await sleep(350);
      if (res.status === 429) await sleep(600);
      return null;
    } catch (error) {
      failures.push(`${model}: ${error?.message || String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Two passes: a demand spike is often gone a second later.
  for (let pass = 0; pass < 2; pass += 1) {
    if (Date.now() > deadline) break;
    if (pass) await sleep(1200);
    for (const model of models) {
      if (Date.now() > deadline) break;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (Date.now() > deadline) break;
        const turn = await askModel(model);
        if (turn) return turn;
      }
    }
  }
  const lastError = failures.map((line) => line.slice(0, 160)).join(' | ').slice(0, 900) || 'No model answered.';
  console.error('ops_agent_gemini_failed', lastError);
  return { error: lastError, calls: [], text: '', parts: [] };
}

// The portal standard is one assistant model: DeepSeek through River, the same
// provider and model that reads score pages. River speaks the OpenAI chat
// format, so the conversation is translated in and out around the same tool
// loop. Gemini stays behind it only as an emergency backup.
function lowerSchema(schema) {
  if (Array.isArray(schema)) return schema.map(lowerSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === 'type' && typeof value === 'string' ? value.toLowerCase() : lowerSchema(value);
  }
  return out;
}

function toOpenAiTools() {
  return FUNCTION_DECLARATIONS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: lowerSchema(tool.parameters || { type: 'object', properties: {} }),
    },
  }));
}

function toOpenAiMessages(contents, options = {}) {
  const withImages = options.images !== false;
  const messages = [];
  let lastCalls = [];
  for (const item of contents) {
    const parts = Array.isArray(item.parts) ? item.parts : [];
    if (item.role === 'model') {
      const text = parts.filter((part) => part.text).map((part) => part.text).join('').trim();
      const calls = parts.filter((part) => part.functionCall?.name);
      if (calls.length) {
        lastCalls = calls.map((part, index) => ({
          id: `call_${messages.length}_${index}`,
          name: part.functionCall.name,
        }));
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((part, index) => ({
            id: lastCalls[index].id,
            type: 'function',
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
          })),
        });
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
      continue;
    }
    const answers = parts.filter((part) => part.functionResponse?.name);
    if (answers.length) {
      for (const part of answers) {
        const name = part.functionResponse.name;
        const match = lastCalls.find((call) => call.name === name);
        const payload = part.functionResponse.response?.result;
        messages.push({
          role: 'tool',
          tool_call_id: match?.id || `call_${messages.length}`,
          content: String(payload == null ? JSON.stringify(part.functionResponse.response || {}) : payload).slice(0, 6000),
        });
      }
      continue;
    }
    const text = parts.filter((part) => part.text).map((part) => part.text).join('').trim();
    const images = withImages ? parts.filter((part) => part.inlineData?.data) : [];
    if (images.length) {
      messages.push({
        role: 'user',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...images.map((part) => ({
            type: 'image_url',
            image_url: {
              url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`,
              detail: 'high',
            },
          })),
        ],
      });
    } else if (text) {
      messages.push({ role: 'user', content: text });
    }
  }
  return messages;
}

async function riverTurn(contents, useTools, route) {
  const apiKey = route?.api_key || RIVER_API_KEY;
  const baseUrl = String(route?.base_url || RIVER_BASE_URL || '').trim().replace(/\/+$/, '');
  const modelName = route?.model || ASSISTANT_MODEL;
  if (!apiKey || !baseUrl) return null;
  const body = {
    model: modelName,
    temperature: 0.4,
    max_tokens: MAX_REPLY_TOKENS,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...toOpenAiMessages(contents)],
  };
  if (useTools) {
    body.tools = toOpenAiTools();
    body.tool_choice = 'auto';
  }
  const hasPhoto = contents.some((item) => (item.parts || []).some((part) => part.inlineData?.data));
  const send = async (payload, timeout) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  };
  try {
    let { response, data } = await send(body, hasPhoto ? 34000 : 18000);
    // If this model cannot take a picture, ask it again with the words alone so
    // the same brain still decides, instead of dropping to the backup model.
    if ((!response.ok || !data) && hasPhoto) {
      const textOnly = {
        ...body,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...toOpenAiMessages(contents, { images: false })],
      };
      ({ response, data } = await send(textOnly, 18000));
    }
    if (!response.ok || !data) {
      console.error('ops_agent_river_failed', `${modelName}: HTTP ${response.status}`);
      return { error: `${modelName}: HTTP ${response.status}`, calls: [], text: '', parts: [] };
    }
    const message = data?.choices?.[0]?.message || {};
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const calls = rawCalls
      .filter((call) => call?.function?.name)
      .map((call) => {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        return { name: call.function.name, args };
      });
    const text = String(message.content || '').trim();
    if (!calls.length && !text) {
      return { error: `${modelName}: empty answer`, calls: [], text: '', parts: [] };
    }
    const parts = [];
    if (text) parts.push({ text });
    for (const call of calls) parts.push({ functionCall: { name: call.name, args: call.args } });
    const usage = {
      tokens_in: Number(data?.usage?.prompt_tokens) || 0,
      tokens_out: Number(data?.usage?.completion_tokens) || 0,
      cached_tokens: Number(data?.usage?.prompt_tokens_details?.cached_tokens) || 0,
    };
    return { model: modelName, calls, text, parts, usage, provider: route?.provider || 'river' };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : (error?.message || 'network error');
    console.error('ops_agent_river_failed', `${modelName}: ${reason}`);
    return { error: `${modelName}: ${reason}`, calls: [], text: '', parts: [] };
  }
}

// Primary, then secondary, then the free-tier fallback. Each attempt is logged
// with the route that served it, and a failure is never allowed to change what
// the assistant may do.
async function assistantTurn(contents, useTools, meter) {
  const started = Date.now();
  if (meter) meter.contextTokens = estimateTokens({ system: SYSTEM_PROMPT, contents });
  const routes = await loadModelRoutes();
  const candidates = [];
  // Past the included allowance the backup route carries the month, so the
  // school keeps working; the reply itself says so.
  if (meter?.fallbackOnly) {
    if (routes.secondary) candidates.push({ label: 'fallback', route: routes.secondary });
    if (routes.primary) candidates.push({ label: 'primary', route: routes.primary });
  } else {
    if (routes.primary) candidates.push({ label: 'primary', route: routes.primary });
    if (routes.secondary) candidates.push({ label: 'secondary', route: routes.secondary });
  }
  // Env values are the last resort, so a broken console row cannot silence the
  // assistant while the developer is asleep.
  candidates.push({ label: 'fallback', route: null });

  const errors = [];
  for (const candidate of candidates) {
    const left = 44000 - (Date.now() - started);
    if (left < 5000) break;
    const route = candidate.route;
    const provider = String(route?.provider || '').toLowerCase();
    let turn = null;
    if (route && provider.includes('gemini')) {
      turn = await geminiTurn(contents, useTools, Math.min(20000, left), route);
    } else if (route) {
      turn = await riverTurn(contents, useTools, route);
    } else {
      turn = await riverTurn(contents, useTools, null);
      if (!turn || turn.error) turn = await geminiTurn(contents, useTools, Math.min(22000, left), null);
    }

    if (turn && !turn.error) {
      await logModelCall(meter, {
        route: candidate.label,
        provider: turn.provider,
        model: turn.model,
        usage: turn.usage,
        toolCalls: Array.isArray(turn.calls) ? turn.calls.length : 0,
      });
      turn.route = candidate.label;
      return turn;
    }

    const reason = turn?.error || (route ? `${route.model}: no answer` : 'no provider configured');
    errors.push(reason);
    await logModelCall(meter, {
      route: candidate.label,
      provider: route?.provider || turn?.provider,
      model: route?.model || turn?.model,
      ok: false,
      error: String(reason).slice(0, 120),
    });
  }

  if (errors.length) {
    // Re-read the routes on the next request so a key fixed in the console is
    // used immediately instead of after the cache window.
    ROUTE_CACHE = { at: 0, routes: null };
  }
  const error = errors.join(' | ').slice(0, 900);
  return { error, calls: [], text: '', parts: [], skipped: error };
}

function fallbackReply(mode, jobDigest, context) {
  if (mode === 'post_upload' && jobDigest) {
    const s = jobDigest.summary;
    const label = [jobDigest.class_label, jobDigest.subject].filter(Boolean).join(' · ');
    return `I finished reading ${label || 'the page'}: ${s.total_lines_read} lines and ${s.marks_read} marks. `
      + `${s.exact_matches_A} exact, ${s.suggested_matches_B} suggested, ${s.unmatched_on_sheet_C} need a person. `
      + 'The mapping is under this reply.';
  }
  return `The assistant brain is busy right now, so nothing was read. Ask me again in a few seconds. Your records are safe.`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// When the model is unreachable, common one-liners still work: this keeps the
// assistant useful under a demand spike or an exhausted quota.
function guessIntent(text, context) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const cls = findClass(raw, context);
  const classArg = cls ? (cls.label || cls.key) : null;
  const lower = raw.toLowerCase();

  const remove = raw.match(/^(?:remove|archive|delete)\s+(.+?)\s+(?:from|in)\s+(.+)$/i);
  if (remove) {
    const wantDelete = /^delete/i.test(raw);
    return { tool: 'manage_students', args: { action: wantDelete ? 'delete' : 'archive', name: remove[1].trim(), class: classArg || remove[2].trim() } };
  }

  const add = raw.match(/\badd\s+(?:a\s+)?(?:new\s+)?(?:pupil|student)\s+(?:called\s+|named\s+)?(.+?)\s+(?:to|in|into)\s+(.+)$/i);
  if (add) {
    let rest = add[2].trim();
    let gender = '';
    const g = rest.match(/[, ]\s*(male|female|boy|girl)\s*$/i);
    if (g) { gender = g[1]; rest = rest.slice(0, g.index).trim(); }
    const target = rest.replace(/^(the\s+)?/, '').replace(/\s+(class|department)$/i, '');
    return { tool: 'manage_students', args: { action: 'add', name: add[1].trim(), class: target, gender: gender || 'female' } };
  }

  if (classArg && /\b(who is leading|leader|top|highest|best pupil|class result|results)\b/i.test(lower)) {
    return { tool: 'rank_students', args: { class: classArg, component: 'overall', top_n: 10 } };
  }

  if (/\bhow many (pupils|students)\b/i.test(lower)) {
    return classArg
      ? { tool: 'manage_students', args: { action: 'list', class: classArg } }
      : { tool: 'get_school_snapshot', args: {} };
  }

  if (/\b(overview|enrollment|enrolment|how many pupils in the school|total pupils)\b/i.test(lower)) {
    return { tool: 'get_school_snapshot', args: {} };
  }

  if (/\b(settings|school details|setup)\b/i.test(lower)) return { tool: 'get_school_snapshot', args: {} };

  const marks = raw.match(/\b(?:marks?|scores?|results?)\s+(?:of|for)\s+(.+)$/i);
  if (marks) return { tool: 'get_scores', args: { student: marks[1].trim(), ...(classArg ? { class: classArg } : {}) } };

  return null;
}

function classLabelFor(key, context) {
  if (!key) return '';
  const hit = (context?.classes || []).find((c) => c.key === key || c.label === key);
  return hit?.label || String(key);
}

function describeFallback(tool, result, context) {
  if (result?.error) return result.error;
  if (tool === 'get_school_snapshot') {
    const classes = Array.isArray(result?.classes) ? result.classes : [];
    const pupils = classes.reduce((sum, cls) => sum + (Number(cls.pupils) || 0), 0);
    const missing = result?.missing_summary || {};
    return `${result?.session || 'This session'} ${result?.term || ''}: ${classes.length} classes, ${pupils} pupils. `
      + `${missing.subjects_not_started || 0} subjects not started and ${missing.subjects_partial || 0} partly recorded.`;
  }
  if (tool === 'resolve_students') {
    return `${result?.accepted || 0} of ${result?.count || 0} sheet names match. ${result?.ask || 0} need a quick answer and ${result?.hold || 0} are held.`;
  }
  if (tool === 'resolve_subject') {
    return result?.ok ? `${result.label} is subject index ${result.index} in ${result.class}.` : (result?.error || 'The subject was not found.');
  }
  if (tool === 'get_scores') {
    return `${result?.count || 0} saved mark${result?.count === 1 ? '' : 's'}${result?.class ? ` for ${result.class}` : ''}${result?.subject ? ` ${result.subject}` : ''}.`;
  }
  if (tool === 'completeness_report') {
    const totals = result?.totals || {};
    return `${result?.scope || 'The school'}: ${totals.subjects_not_started || 0} subjects not started and ${totals.subjects_partial || 0} partly recorded.`;
  }
  if (tool === 'rank_students') {
    const top = result?.ranking?.[0];
    return top ? `${result.class}: ${top.name} leads on ${top.average}.` : `${result?.class || 'That class'} has no ranking yet.`;
  }
  if (tool === 'record_scores') {
    if (result?.committed) {
      return `Recorded ${result.recorded} ${result.subject} mark${result.recorded === 1 ? '' : 's'} for ${result.class}; ${result.held_back || 0} held back, ${result.blank || 0} blank.`;
    }
    return `Preview: ${result?.recorded || 0} to record, ${result?.skipped_existing || 0} already saved, ${result?.held_back || 0} held back, ${result?.blank || 0} blank.`;
  }
  if (tool === 'correct_score') {
    return `Corrected ${result?.pupil}'s ${result?.subject} from ${result?.old_value} to ${result?.new_value}.`;
  }
  if (tool === 'generate_documents') {
    return result?.documents?.length ? `${result.documents.length} ${result.mode} document${result.documents.length === 1 ? '' : 's'} ready.` : 'The documents were not made.';
  }
  if (tool === 'manage_students' || tool === 'update_pupil_records' || tool === 'manage_staff') {
    return result?.summary || result?.next || 'Updated.';
  }
  if (tool === 'find_pupil' && Array.isArray(result?.matches) && result.matches.length) {
    const list = result.matches.slice(0, 8).map((p) => `${p.name} (${classLabelFor(p.class, context)})`);
    const more = result.matches.length > list.length ? ` and ${result.matches.length - list.length} more` : '';
    const ask = result.matches.length > 1 ? ' Which one?' : '';
    return `${result.matches.length} pupil${result.matches.length > 1 ? 's' : ''} like that: ${list.join(', ')}${more}.${ask}`;
  }
  if (result?.error) return result.error;
  if (tool === 'class_results') {
    if (!result.pupils) return `${result.class} has no pupils on the list.`;
    const top = result.highest ? ` Highest is ${result.highest.name} on ${result.highest.total}.` : '';
    return `${result.class}: ${result.pupils_with_marks} of ${result.pupils} pupils have marks this term. Average ${result.average_total || 0}.${top}`;
  }
  if (tool === 'list_pupils') return `${result.class} has ${result.count} pupils.`;
  if (tool === 'get_school_overview') {
    return `The school has ${result.total_pupils} pupils. Nursery 1 has ${(result.classes || []).find((c) => c.class_key === 'nursery1')?.pupils ?? 0}.`;
  }
  if (tool === 'add_pupil') return `Added ${result.pupil?.name} to ${result.pupil?.class}. Admission number ${result.admission_number}.`;
  if (tool === 'archive_pupil') return `Removed ${result.pupil?.name} from ${result.pupil?.class}.`;
  if (tool === 'get_settings') {
    const s = result.settings?.app_config || {};
    const classes = Object.values(s.depts || {}).map((d) => d.label).filter(Boolean);
    const who = s.school?.name ? ` The school is ${s.school.name}.` : '';
    const list = classes.length ? ` ${classes.length} classes are set up: ${classes.join(', ')}.` : '';
    return `This is ${s.term || 'the current term'} of ${s.session || 'the current session'}.${who}${list}`;
  }
  if (tool === 'list_staff') {
    const staff = result.staff || result.people || [];
    if (!staff.length) return 'No staff accounts are on the list yet.';
    const list = staff.slice(0, 8).map((p) => `${p.name || p.email} (${p.role || 'staff'})`).join(', ');
    const more = staff.length > 8 ? ` and ${staff.length - 8} more` : '';
    return `${staff.length} staff on the list: ${list}${more}.`;
  }
  if (tool === 'pupil_results') {
    return `${result.name}: ${result.subjects_with_marks} subjects with marks, total ${result.total_points}.`;
  }
  if (tool === 'search_pupils') {
    if (!result.pupils?.length) return 'No pupil matches that name.';
    return `${result.count} pupil${result.count === 1 ? '' : 's'} found: ${result.pupils.slice(0, 8).map((p) => `${p.name} (${p.class}${p.archived ? ', removed' : ''})`).join(', ')}.`;
  }
  if (tool === 'archived_pupils') {
    if (!result.pupils?.length) return 'No pupil is off the class lists.';
    return `${result.count} removed pupil${result.count === 1 ? '' : 's'}: ${result.pupils.slice(0, 8).map((p) => `${p.name} (${p.class})`).join(', ')}.`;
  }
  if (tool === 'restore_pupil') return `${result.pupil?.name} is back on the ${result.pupil?.class} list.`;
  if (tool === 'delete_pupil') return `${result.pupil?.name}'s record was erased.`;
  if (tool === 'add_pupils') {
    const skipped = result.failed ? ` ${result.failed} were skipped.` : '';
    return `Added ${result.added} pupil${result.added === 1 ? '' : 's'} to ${result.class}.${skipped}`;
  }
  if (tool === 'move_pupils') {
    return `Moved ${result.moved} pupil${result.moved === 1 ? '' : 's'} from ${result.from} to ${result.to}.`;
  }
  if (tool === 'bulk_enter_marks') {
    return `Saved ${result.saved} ${result.subject} mark${result.saved === 1 ? '' : 's'} for ${result.class}.${result.failed ? ` ${result.failed} were not saved.` : ''}`;
  }
  if (tool === 'clear_marks') return `Deleted ${result.pupil}'s ${result.subject} marks for ${result.term}.`;
  if (tool === 'clear_fee') return `Deleted ${result.pupil}'s fee record for ${result.term}.`;
  if (tool === 'clear_remarks') return `Cleared ${result.pupil}'s remarks for ${result.term}.`;
  if (tool === 'clear_traits') return `Cleared ${result.pupil}'s ${result.type} ratings for ${result.term}.`;
  if (tool === 'list_pages') {
    if (!result.pages?.length) return 'No record-book pages yet.';
    return `${result.count} page${result.count === 1 ? '' : 's'}: ${result.pages.slice(0, 6).map((p) => `${p.class} ${p.subject || ''} (${p.status})`).join(', ')}.`;
  }
  if (tool === 'page_rows') return `${result.rows?.length || 0} lines on the ${result.class} ${result.subject || ''} page.`;
  if (tool === 'set_page_mark') return `Set ${result.pupil || result.on_page} to ${result.mark} on the page.`;
  if (tool === 'map_page_row') return result.linked_to
    ? `Linked ${result.on_page} to ${result.linked_to}.`
    : `${result.on_page} is now ${result.decision}.`;
  if (tool === 'retry_page') return 'The page is back in the reader queue.';
  return 'Done.';
}

// Reads only report what they found, so they can always be described from the
// record itself when the model drops out after running the tool.
const READ_TOOLS = new Set([
  'get_school_snapshot', 'resolve_students', 'resolve_subject', 'get_scores',
  'completeness_report', 'rank_students', 'compare_with_existing', 'review_page',
  'get_attachment',
]);

// The mapping is one shape for both the chat card and the mapping refresh.
// It carries the row and mark ids the page needs to edit a score or a name.
function buildMapping(jobDigest) {
  if (!jobDigest || !Array.isArray(jobDigest.all_lines) || !jobDigest.all_lines.length) return null;
  return {
    job_id: jobDigest.job_id,
    class_label: jobDigest.class_label,
    class_key: jobDigest.class_key || null,
    subject: jobDigest.subject,
    column: jobDigest.column,
    term: jobDigest.term || null,
    academic_session: jobDigest.academic_session || null,
    status: jobDigest.status,
    counts: jobDigest.summary,
    rows: jobDigest.all_lines.map((line) => ({
      row_id: line.row_id || null,
      line: line.line,
      on_page: line.on_page,
      second_read: line.second_read || null,
      pupil: line.portal_pupil || null,
      pupil_id: line.portal_pupil_id || null,
      admno: line.admno || null,
      suggestion: !line.portal_pupil && Array.isArray(line.suggested_candidates)
        ? line.suggested_candidates[0] || null
        : null,
      group: line.match_group,
      manual: line.match_method === 'manual',
      confidence: line.match_confidence,
      mark_id: line.mark_id || null,
      mark: line.mark,
      mark_status: line.mark_status,
      mark_candidates: line.mark_candidates || null,
      decision: line.decision,
    })),
    roster: Array.isArray(jobDigest.roster) ? jobDigest.roster : [],
    portal_only: Array.isArray(jobDigest.portal_pupils_missing_from_sheet)
      ? jobDigest.portal_pupils_missing_from_sheet
      : [],
  };
}

// The model is the one that decides a page. This is only the safety net for a
// dropped tool call: when the sentence itself names a real class and subject,
// the page is created from those, so a photo is never left without a page.
async function startPageFromInstruction(ctx, context, raw) {
  const parsed = parseInstruction(raw, context || {});
  if (!parsed?.class_key || !parsed?.subject) return null;
  const cls = (Array.isArray(context?.classes) ? context.classes : [])
    .find((item) => item.key === parsed.class_key);
  if (!cls) return null;

  const column = parsed.column_label || COLUMN_LABELS.ca;
  const term = parsed.term || context?.term || null;
  const parsedBody = {
    ...parsed,
    ok: true,
    scope: parsed.scope === 'individual' ? 'assessment' : (parsed.scope || 'assessment'),
    column_label: column,
    column_group: String(term || '1ST TERM').toUpperCase(),
    term,
    academic_session: parsed.academic_session || context?.academic_session || null,
    needs: [],
    question: null,
  };

  const created = await opsRpc('ops_jobs_create', {
    p_school_id: ctx.actor.school_id,
    p_class_key: cls.key,
    p_academic_session: parsedBody.academic_session,
    p_term: term,
    p_service: 'scores',
    p_submitted_by: ctx.actor.id,
    p_submitted_by_email: ctx.actor.email,
    p_instruction: raw,
    p_file_refs: [],
    p_instruction_parsed: parsedBody,
  }).catch(() => null);

  if (!created || created.ok !== true || !created.job?.id) return null;
  await opsRpc('ops_record_assistant', { p_job_id: created.job.id }).catch(() => null);
  await opsRpc('ops_save_instruction', { p_job_id: created.job.id, p_raw: raw, p_parsed: parsedBody })
    .catch(() => null);

  return {
    started: true,
    reused: false,
    job_id: created.job.id,
    class_key: cls.key,
    class_label: cls.label,
    subject: parsedBody.subject,
    subject_key: parsedBody.subject_key || null,
    term,
    column,
    rows: 0,
  };
}

// A photo is kept in the transcript as a short text note, never as bytes.
// Section 16 of the brief: images leave history after the turn they were used
// in, except as a description.
// The model often presents the review in its own words. If it already named
// the open items, appending the generated text would repeat every line.
function reviewAlreadyShown(text, review) {
  const body = String(text || '');
  if (!body) return false;
  if (/needs?\s+your\s+answer/i.test(body)) return true;
  const items = Array.isArray(review?.needs_answer) ? review.needs_answer : [];
  if (!items.length) return false;
  const lower = body.toLowerCase();
  const named = items.filter((item) => item.sheet_name && lower.includes(String(item.sheet_name).toLowerCase()));
  if (named.length >= Math.min(2, items.length)) return true;
  const numbered = (body.match(/^\s*\d{1,3}\s*[.):-]\s+/gm) || []).length;
  return numbered >= Math.min(2, items.length);
}

function chatAttachmentRefs(photoBase64, photoName, sheetRead, attachmentId = null) {
  if (!photoBase64) return [];
  let description = 'Photo attached.';
  if (sheetRead && sheetRead.ok) {
    const bits = [sheetRead.class, sheetRead.subject, sheetRead.column_title].filter(Boolean).join(' · ');
    const count = Array.isArray(sheetRead.lines) ? sheetRead.lines.length : 0;
    if (sheetRead.description) description = sheetRead.description;
    else if (sheetRead.sheet_type === 'blank_page') description = 'Photo of a blank page.';
    else if (sheetRead.sheet_type === 'scores') {
      description = `Photo of a score sheet${bits ? ` (${bits})` : ''} with ${count} line${count === 1 ? '' : 's'} read.`;
    } else description = `Photo attached${bits ? ` (${bits})` : ''}.`;
  }
  return [{
    type: 'photo',
    name: cleanStr(photoName, 120) || null,
    file_id: attachmentId || null,
    description,
  }];
}

function chatWorkingContext(body, draft, context, page, savedState) {
  const supplied = body && body.working_context && typeof body.working_context === 'object'
    ? body.working_context
    : {};
  const saved = savedState && typeof savedState === 'object' ? savedState : {};
  const screen = body && body.screen && typeof body.screen === 'object' ? body.screen : {};
  const classKey = supplied.class_key || draft.class_key || screen.class_key || saved.class_key || null;
  const classLabel = supplied.class_label || draft.class_label || screen.class_label || saved.class_label || null;
  const subject = supplied.subject || draft.subject || screen.subject || saved.subject || null;
  // A chat is not tied to one class or subject. Keep the latest for a quick
  // resume, and a short list of what this chat has already worked on.
  const mergeRecent = (list, entry) => {
    const rows = Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
    const key = entry ? JSON.stringify(entry) : null;
    if (entry && !rows.some((item) => JSON.stringify(item) === key)) rows.unshift(entry);
    return rows.slice(0, 8);
  };
  const recentClasses = mergeRecent(saved.recent_classes, classKey
    ? { key: classKey, label: classLabel || classKey }
    : null);
  const recentSubjects = mergeRecent(saved.recent_subjects, subject
    ? { class_key: classKey || null, subject }
    : null);
  return {
    screen_error: cleanStr(screen.error, 300) || null,
    class_key: classKey,
    class_label: classLabel,
    subject,
    column: supplied.column || draft.column || screen.column || saved.column || null,
    term: supplied.term || draft.term || saved.term || context?.term || null,
    academic_session: supplied.academic_session || draft.academic_session || saved.academic_session || context?.academic_session || null,
    page: supplied.page || screen.page || saved.page || null,
    open_page: page?.job_id || supplied.open_page || saved.open_page || null,
    recent_classes: recentClasses,
    recent_subjects: recentSubjects,
  };
}

async function handleAgentChat(req, res, ctx, body, helpers) {
  const { sendJson, contextForJob } = helpers;
  const mode = cleanStr(body.mode, 30) || 'chat';
  const userText = cleanStr(body.text || body.message, 4000);
  const jobId = cleanStr(body.job_id, 40);
  const chatId = cleanStr(body.chat_id, 40);
  // Tools that work on the open review need the chat they belong to.
  if (ctx && chatId && UUID_RE.test(chatId)) ctx.chat_id = chatId;
  const confirm = body.confirm && typeof body.confirm === 'object' ? body.confirm : null;
  // A small copy of the attached page, so the model can read the header of the
  // sheet itself instead of trusting the sentence alone.
  const rawPhoto = cleanStr(body.photo_base64, 4000000);
  const photoBase64 = /^[A-Za-z0-9+/=\s]+$/.test(rawPhoto) && rawPhoto.length > 200 ? rawPhoto : '';
  const photoMime = cleanStr(body.photo_mime, 40) || 'image/jpeg';
  // Read the sheet through a vision model as structured lines before the main
  // model reasons. If the main model cannot take a picture, the lines still
  // arrive, so a score sheet is never lost.
  const sheetReadPromise = photoBase64
    ? extractSheetPhoto(photoBase64, photoMime, 25000, {
      schoolId: ctx.actor?.school_id || null,
      userId: ctx.actor?.id || null,
      sessionId: cleanStr(body.chat_id, 40) || null,
    }).catch(() => null)
    : Promise.resolve(null);

  if (mode !== 'post_upload' && mode !== 'prepare_page' && !userText && !confirm) {
    return sendJson(res, 400, { ok: false, code: 'OPS_TEXT_EMPTY', message: 'Type a message first.' });
  }

  const [context, balance, jobDetail, chatDetail] = await Promise.all([
    opsRpc('ops_active_context', {}).catch(() => ({})),
    ctx.actor?.school_id
      ? opsRpc('ops_credit_balance', { p_school_id: ctx.actor.school_id }).catch(() => null)
      : Promise.resolve(null),
    jobId && UUID_RE.test(jobId)
      ? opsRpc('ops_jobs_get', { p_id: jobId }).catch(() => null)
      : Promise.resolve(null),
    chatId && UUID_RE.test(chatId) && ctx.actor?.school_id
      ? opsRpc('ops_chat_session_get', {
        p_id: chatId,
        p_school_id: ctx.actor.school_id,
        p_owner_user_id: ctx.actor.id,
        p_message_limit: 60,
      }).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (chatId && UUID_RE.test(chatId) && (!chatDetail || !chatDetail.ok)) {
    return sendJson(res, 404, {
      ok: false,
      code: 'CHAT_NOT_FOUND',
      message: 'That chat is not in this account. Start a new chat.',
    });
  }

  // Section 17: a suspended subscription stops the assistant only. Nothing in
  // the record, print or export path calls this gate.
  const gate = ctx.actor?.school_id
    ? await opsRpc('ops_assistant_gate', { p_school_id: ctx.actor.school_id }).catch(() => null)
    : null;
  if (gate && gate.ok && gate.allowed === false) {
    return sendJson(res, 403, {
      ok: false,
      code: 'ASSISTANT_SUSPENDED',
      message: gate.banner || 'The assistant is paused while the subscription is restored. Recording, search and export still work.',
      gate,
    });
  }

  const meter = {
    schoolId: ctx.actor?.school_id || null,
    userId: ctx.actor?.id || null,
    sessionId: chatId && UUID_RE.test(chatId) ? chatId : null,
    fallbackOnly: Boolean(gate && gate.fallback_only),
    contextTokens: 0,
  };

  // The photo read runs while the context loads. It must finish before the
  // user's turn is saved, because the transcript keeps a text description in
  // place of the image.
  const sheetRead = photoBase64 ? await sheetReadPromise : null;

  // The photo is stored once, before the model reasons, so a refresh or a
  // second device can read the same page again. The chat keeps the file id and
  // a description, not the bytes.
  let attachmentId = null;
  let sheetReview = null;
  let sheetState = null;
  let sheetActionResult = null;
  let sheetError = null;
  const sheetChatId = chatId && UUID_RE.test(chatId) && chatDetail?.ok ? chatId : null;
  if (photoBase64 && sheetChatId) {
    const photoBytes = Buffer.from(photoBase64, 'base64');
    const sha256 = crypto.createHash('sha256').update(photoBytes).digest('hex');
    const put = await opsRpc('ops_sheet_attachment_put', {
      p_session_id: sheetChatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_filename: cleanStr(body.photo_name, 120) || null,
      p_mime: photoMime,
      p_content_b64: photoBase64.replace(/\s+/g, ''),
      p_sha256: sha256,
      p_byte_size: photoBytes.length,
    }).catch((error) => {
      console.error('ops_sheet_photo_save_failed', error?.message || error);
      return null;
    });
    attachmentId = put?.attachment?.id || null;
    if (!attachmentId) sheetError = put?.message || 'The photo could not be kept with this chat.';
  }
  if (sheetRead && sheetRead.ok && attachmentId) {
    await opsRpc('ops_sheet_attachment_describe', {
      p_session_id: sheetChatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_file_id: attachmentId,
      p_description: sheetRead.description
        || [sheetRead.class, sheetRead.subject, sheetRead.column_title].filter(Boolean).join(' · ')
        || 'Photo attached.',
      p_sheet_type: sheetRead.sheet_type || null,
      p_class_key: null,
      p_subject_label: sheetRead.subject || null,
      p_term: sheetRead.term || null,
      p_sheet_read: sheetRead,
    }).catch(() => null);
    const hasLines = Array.isArray(sheetRead.columns)
      ? sheetRead.columns.some((column) => column.lines?.length)
      : (sheetRead.lines?.length || 0) > 0;
    if (sheetRead.sheet_type === 'scores' && hasLines) {
      // The newest sentence may name a class the header left out or correct a
      // misread one. Use it before the sheet header, never after.
      const sheetHint = parseInstruction(userText || '', context);
      const prepared = await prepareSheetReview(ctx, {
        chat_id: sheetChatId,
        class: sheetHint.class_label || sheetRead.class,
        subject: sheetHint.subject || sheetRead.subject,
        term: sheetHint.term || sheetRead.term,
        component: sheetRead.component,
        column: sheetRead.column_title,
      }, context, sheetRead, attachmentId).catch((error) => ({
        ok: false,
        error: error?.message || 'The read lines could not be prepared.',
      }));
      if (prepared?.ok) {
        sheetReview = prepared.review || null;
        sheetActionResult = {
          action: 'prepared',
          saved_lines: prepared.saved_lines || 0,
          review: sheetReview,
        };
      } else {
        sheetError = prepared?.error || sheetError;
        sheetActionResult = { action: 'prepare', ok: false, error: sheetError, needs: prepared?.needs || null };
      }
    }
  }
  if (!sheetReview && sheetChatId) {
    sheetState = await loadSheetState(ctx, sheetChatId).catch(() => null);
    sheetReview = sheetState?.review || null;
  }

  // The photo is kept with the chat even when the class or subject was not
  // clear enough to build the review. A later short answer names it, and the
  // stored bytes or the stored read are used again without asking for the
  // photo. A failed first read is retried once from the stored copy.
  if (!photoBase64 && sheetChatId && !sheetReview && userText && sheetState?.attachment) {
    const stored = sheetState.attachment;
    const age = stored.created_at ? Date.now() - new Date(stored.created_at).getTime() : 0;
    const askedQuestion = /\?\s*$/.test(userText)
      || /^\s*(what|which|how|list|show|tell|did|do|does|is|are|where|who)\b/i.test(userText);
    const parsed = parseInstruction(userText, context);
    let read = stored.sheet_read;
    if (read?.sheet_type === 'scores' && !read.class && !read.subject && parsed.class_label && parsed.subject) {
      read = { ...read, class: parsed.class_label, subject: parsed.subject };
    }
    if ((!read || read.sheet_type !== 'scores') && parsed.class_label && parsed.subject && !askedQuestion) {
      const fetched = await opsRpc('ops_sheet_attachment_get', {
        p_session_id: sheetChatId,
        p_school_id: ctx.actor.school_id,
        p_owner_user_id: ctx.actor.id,
        p_file_id: stored.id,
      }).catch(() => null);
      const bytes = fetched?.attachment?.content_base64;
      if (bytes) {
        const again = await extractSheetPhoto(bytes, stored.mime || 'image/jpeg', 20000, {
          schoolId: ctx.actor?.school_id || null,
          userId: ctx.actor?.id || null,
          sessionId: sheetChatId,
          contextTokens: 0,
        }).catch(() => null);
        if (again?.ok && again.sheet_type === 'scores') {
          read = again;
          await opsRpc('ops_sheet_attachment_describe', {
            p_session_id: sheetChatId,
            p_school_id: ctx.actor.school_id,
            p_owner_user_id: ctx.actor.id,
            p_file_id: stored.id,
            p_description: again.description
              || [again.class, again.subject, again.column_title].filter(Boolean).join(' · ')
              || 'Photo attached.',
            p_sheet_type: again.sheet_type,
            p_class_key: null,
            p_subject_label: again.subject || null,
            p_term: again.term || null,
            p_sheet_read: again,
          }).catch(() => null);
        }
      }
    }
    if (read?.sheet_type === 'scores' && age < 24 * 60 * 60 * 1000 && !askedQuestion) {
      const drafts = await opsRpc('ops_sheet_draft_list', {
        p_session_id: sheetChatId,
        p_school_id: ctx.actor.school_id,
        p_owner_user_id: ctx.actor.id,
        p_file_id: stored.id,
      }).catch(() => null);
      const alreadyWritten = (drafts?.lines || []).some((line) => line.written_at);
      // A sheet already written is never reopened from a later aside.
      if (!alreadyWritten) {
        const prepared = await prepareSheetReview(ctx, {
          chat_id: sheetChatId,
          class: parsed.class_label || read.class || userText,
          subject: parsed.subject || read.subject || userText,
          term: parsed.term || read.term || null,
        }, context, read, stored.id).catch((error) => ({
          ok: false,
          error: error?.message || 'The saved read could not be prepared.',
        }));
        if (prepared?.ok) {
          sheetReview = prepared.review || null;
          sheetActionResult = {
            action: 'prepared',
            saved_lines: prepared.saved_lines || 0,
            review: sheetReview,
          };
        } else if (prepared?.error) {
          sheetError = prepared.error;
        }
      }
    }
  }

  // A later turn answers the open review from the database, never from the
  // model's memory. Answers and "record" are handled before the model speaks,
  // so a refresh or a dropped connection cannot lose them.
  if (!photoBase64 && sheetChatId && sheetState?.review && userText) {
    const answers = parseSheetAnswers(userText, sheetState.review);
    let applied = null;
    if (answers.length) {
      applied = await applySheetAnswers(ctx, { text: userText }, context, sheetChatId).catch((error) => ({
        ok: false,
        error: error?.message || 'The answers could not be saved.',
      }));
      if (applied?.ok && applied.review) {
        sheetReview = applied.review;
        sheetActionResult = {
          action: 'answered',
          applied: applied.applied || answers.length,
          review: sheetReview,
          note: sheetReview?.needs_answer?.length
            ? 'The answers are saved. The items still open are listed once.'
            : 'The answers are saved. Nothing is written until the user says record.',
        };
      } else if (applied?.error) {
        sheetError = applied.error;
      }
    }
    const wantsRecord = /^\s*(?:record|write|save|commit|yes|ok|okay|go ahead|do it)\b/i.test(userText)
      || /\b(?:record|write|save|commit)\s+(?:them|it|all|these|the scores)\b/i.test(userText);
    // Writing still needs its own confirmation. Answering the review settles
    // the lines; it does not write them.
    if (wantsRecord) {
      const committed = await commitSheetReview(ctx, {}, context, sheetChatId).catch((error) => ({
        ok: false,
        error: error?.message || 'The scores could not be written.',
      }));
      if (committed?.committed) {
        sheetReview = committed.review || sheetReview;
        sheetActionResult = {
          action: 'committed',
          batches: committed.batches || [],
          recorded: committed.recorded || 0,
          skipped_existing: committed.skipped_existing || 0,
          held_back: committed.held_back || 0,
          verify: committed.verify || null,
          review: sheetReview,
        };
      } else if (committed?.error) {
        sheetError = committed.error;
        sheetActionResult = committed.batches?.length
          ? { action: 'commit_partial', error: committed.error, batches: committed.batches }
          : { action: 'commit', ok: false, error: committed.error };
      }
    }
    if (sheetActionResult) {
      sheetState = await loadSheetState(ctx, sheetChatId).catch(() => sheetState);
    }
  }

  const rawDraft = body.draft && typeof body.draft === 'object' ? body.draft : {};
  const draft = {
    has_photo: Boolean(rawDraft.has_photo),
    class_key: cleanStr(rawDraft.class_key, 60) || null,
    class_label: cleanStr(rawDraft.class_label, 80) || null,
    subject: cleanStr(rawDraft.subject, 120) || null,
    column: cleanStr(rawDraft.column, 40) || null,
    term: cleanStr(rawDraft.term, 30) || context?.term || null,
    academic_session: cleanStr(rawDraft.academic_session, 30) || context?.academic_session || null,
    phase: cleanStr(rawDraft.phase, 30) || 'chat',
    reading_in_progress: Boolean(rawDraft.reading_in_progress),
  };

  const jobDigest = buildJobDigest(jobDetail, context);

  // Resume from the database, not from the browser's copy. A reloaded page and
  // a different device therefore continue the same conversation.
  // Section 16: six turns in full, older turns carried by the rolling summary.
  // The summary lives in the database, so a reload does not start the chat over.
  const savedMessages = Array.isArray(chatDetail?.messages) ? chatDetail.messages : [];
  const historySource = savedMessages.length
    ? savedMessages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-CONTEXT_KEEP_MESSAGES)
      .map((m) => ({ role: m.role, text: m.content, has_photo: false }))
    : (Array.isArray(body.messages) ? body.messages.slice(-CONTEXT_KEEP_MESSAGES) : []);
  const earlierSummary = cleanStr(chatDetail?.session?.summary, 2600) || null;
  const history = toGeminiHistory(historySource.map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    text: cleanStr(m?.text, 1500),
    has_photo: Boolean(m?.has_photo),
  })).filter((m) => m.text || m.has_photo));

  // Save the user's turn before the model is asked anything. If the reply is
  // slow, the words are already in the chat and a reopen shows where it stopped.
  let chatSaved = Boolean(chatDetail?.ok);
  let chatTitle = cleanStr(chatDetail?.session?.title, 120) || null;
  const attachmentRefs = chatAttachmentRefs(photoBase64, body.photo_name, sheetRead, attachmentId);
  if (chatSaved) {
    const userEntry = confirm
      ? `Confirm ${cleanStr(confirm.tool, 60)}`
      : (userText || (photoBase64 ? 'Score sheet photo attached.' : 'Continue.'));
    const savedUser = await opsRpc('ops_chat_message_add', {
      p_session_id: chatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_role: 'user',
      p_content: userEntry,
      p_tool_calls: [],
      p_tool_results: [],
      p_attachment_refs: attachmentRefs,
    }).catch((error) => {
      console.error('ops_chat_user_save_failed', error?.message || error);
      return null;
    });
    if (!savedUser || savedUser.ok === false) chatSaved = false;
    else chatTitle = cleanStr(savedUser.title, 120) || chatTitle;
  }

  const portalSnapshot = (mode === 'post_upload' || mode === 'prepare_page')
    ? null
    : await fetchSchoolSnapshotIfNeeded(ctx, context, userText, draft, jobDigest);

  // The browser already added this turn's words to the thread. Send them once,
  // in the envelope, so the model does not read the same sentence twice.
  if (mode === 'chat' && userText
    && history.length && history[history.length - 1].role === 'user'
    && String(history[history.length - 1].parts?.[0]?.text || '').trim() === userText) {
    history.pop();
  }

  const schoolContext = {
    academic_session: context?.academic_session || '2026/2027',
    term: context?.term || '1st Term',
    credits_remaining: balance?.remaining != null ? Number(balance.remaining) : null,
    classes: ((context && context.classes) || []).map((c) => ({
      key: c.key,
      label: c.label,
      section: c.section || null,
      person: /^(jss|ss)/i.test(String(c.key || '')) ? 'student' : 'pupil',
      pupils: c.pupils != null ? Number(c.pupils) : null,
      subjects: Array.isArray(c.subjects) ? c.subjects : [],
    })),
  };

  const promptEnvelope = JSON.stringify({
    mode,
    EARLIER_IN_THIS_CHAT: earlierSummary,
    CURRENT_SCREEN: body.screen && typeof body.screen === 'object' ? {
      page: cleanStr(body.screen.page, 40) || null,
      class_label: cleanStr(body.screen.class_label, 80) || null,
      subject: cleanStr(body.screen.subject, 120) || null,
      term: cleanStr(body.screen.term, 30) || null,
      visible_error: cleanStr(body.screen.error, 300) || null,
      note: 'Where the user is looking, not a limit on this chat. Any class and subject may be handled here.',
    } : null,
    SCHOOL_CONTEXT: schoolContext,
    PORTAL_RECORDS_SNAPSHOT: portalSnapshot,
    CURRENT_DRAFT_STATE: draft,
    CHAT_SAVED_STATE: chatDetail?.state || null,
    CURRENT_UPLOADED_PAGE: jobDigest,
    SHEET_READ_FROM_PHOTO: sheetRead ? {
      sheet_type: sheetRead.sheet_type,
      description: sheetRead.description,
      class: sheetRead.class,
      subject: sheetRead.subject,
      term: sheetRead.term,
      columns: Array.isArray(sheetRead.columns)
        ? sheetRead.columns.map((column) => ({
          title: column.title,
          component: column.component,
          readable: column.readable,
          error: column.error,
          lines: column.lines?.length || 0,
        }))
        : null,
      lines: Array.isArray(sheetRead.lines) ? sheetRead.lines.slice(0, 80) : [],
    } : (sheetChatId ? 'No photo in this turn.' : null),
    SHEET_ATTACHMENT: attachmentId
      ? { id: attachmentId, description: sheetRead?.description || null }
      : (sheetState?.attachment || null),
    OPEN_SHEET_REVIEW: sheetReview ? {
      file_id: sheetReview.file_id || null,
      class: sheetReview.class,
      subject: sheetReview.subject,
      term: sheetReview.term,
      columns: sheetReview.columns || [],
      failed_columns: sheetReview.failed_columns || [],
      summary: sheetReview.summary || {},
      ready: (sheetReview.ready || []).slice(0, 60),
      needs_answer: sheetReview.needs_answer || [],
      already_recorded: sheetReview.already_recorded || [],
      blank_count: sheetReview.blank_count || 0,
      can_commit: Boolean(sheetReview.can_commit),
      question: sheetReview.question || null,
    } : null,
    SHEET_DRAFT_LINES: sheetState?.lines?.length
      ? sheetState.lines.slice(0, 120).map((line) => ({
        item: line.item_no,
        line: line.sheet_line,
        column: line.column_title,
        component: line.component,
        sheet_name: line.raw_name,
        pupil: line.match_name || null,
        student_id: line.match_student_id || null,
        score: line.score_value,
        status: line.match_status,
        flags: line.flags,
        written: Boolean(line.written_at),
        note: line.note || null,
      }))
      : null,
    SHEET_ACTION_RESULT: sheetActionResult,
    SHEET_ERROR: sheetError,
    LATEST_USER_MESSAGE: mode === 'post_upload'
      ? '(System event: the reader just finished this photo. Brief the user on what was read from CURRENT_UPLOADED_PAGE, then offer the next step.)'
      : mode === 'prepare_page'
        ? '(System event: a photo is attached. Read SHEET_READ_FROM_PHOTO and OPEN_SHEET_REVIEW first. If SHEET_ACTION_RESULT shows a prepared review, show that one review and stop; never call start_page or record_scores when a review exists. Only call start_page when the page is blank with no marks. If class or subject truly cannot be told, ask one short question.)'
        : userText,
  }, null, 2);

  const userParts = [{ text: promptEnvelope }];
  // The structured read is already in the envelope. Sending the same photo to
  // the main model again costs time without adding a line. It goes inline only
  // when the reader could not read the page at all.
  if (photoBase64 && !(sheetRead && sheetRead.ok)) {
    userParts.push({ inlineData: { mimeType: photoMime, data: photoBase64 } });
  }
  const contents = [...history, { role: 'user', parts: userParts }];
  // The model gets a real working session: enough rounds for a multi-step job,
  // with reads run together and writes kept in order. The deadline leaves room
  // for the final sentence inside the function's 60 seconds.
  const deadline = Date.now() + 46000;
  const executed = [];
  if (sheetActionResult) {
    const counted = sheetActionResult.action === 'committed'
      ? `Recorded ${sheetActionResult.recorded || 0} sheet line${Number(sheetActionResult.recorded) === 1 ? '' : 's'}`
      : sheetActionResult.action === 'answered'
        ? `Saved ${sheetActionResult.applied || 0} sheet answer${Number(sheetActionResult.applied) === 1 ? '' : 's'}`
        : 'Read the score sheet';
    executed.push({
      tool: 'sheet_review',
      summary: `${counted}${sheetActionResult.action === 'committed' ? '' : ` for ${sheetReview?.class || 'the class'}`}`,
      result: sheetActionResult,
    });
  }
  let pending = null;
  let finalText = '';
  let model = null;
  let modelRoute = null;
  let modelError = null;
  let correctionResult = null;

  // A confirmation post runs the saved action directly, then lets the model
  // phrase the result so the user still gets a normal answer.
  if (confirm && confirm.tool) {
    const toolName = cleanStr(confirm.tool, 60);
    const args = confirm.args && typeof confirm.args === 'object' ? confirm.args : {};
    const expected = tokenFor(ctx.actor.school_id, toolName, args);
    if (cleanStr(confirm.token, 40) !== expected) {
      return sendJson(res, 409, { ok: false, code: 'OPS_CONFIRM_STALE', message: 'That confirmation expired. Ask me again and I will re-check.' });
    }
    const result = await executeTool(toolName, args, ctx, context, jobId, true);
    executed.push({ tool: toolName, summary: labelFor(toolName, args, context), result });
    contents.push({
      role: 'user',
      parts: [{ text: `The user tapped Confirm for ${toolName}. Result:\n${JSON.stringify(result).slice(0, 4000)}\nWrite the short outcome now.` }],
    });
    const turn = await assistantTurn(contents, false, meter);
    if (turn && turn.text) { finalText = turn.text; model = turn.model; modelRoute = turn.route || null; }
    else finalText = result.error ? `Not saved: ${result.error}` : 'Saved.';
    if (turn && turn.error) modelError = turn.error;
    else if (turn && turn.skipped) modelError = turn.skipped;
  } else {
    let turn = await assistantTurn(contents, true, meter);
    if (turn && turn.error) modelError = turn.error;
    if ((!turn || turn.error) && !confirm) {
      const guess = guessIntent(userText, context);
      if (guess) {
        const result = await executeTool(guess.tool, guess.args, ctx, context, jobId, false);
        if (result.needs_confirmation) {
          pending = { tool: guess.tool, args: result.args, token: result.token, summary: result.summary };
          finalText = `${result.summary.replace(/\?$/, '')}. Check it and tap Confirm.`;
        } else {
          executed.push({ tool: guess.tool, summary: labelFor(guess.tool, guess.args, context), result });
          finalText = describeFallback(guess.tool, result, context);
        }
      }
    }
    let rounds = 0;
    let toolCallsUsed = 0;
    while (turn && turn.calls.length && toolCallsUsed < MAX_TOOL_CALLS
      && rounds < 6 && Date.now() < deadline - 9000) {
      rounds += 1;
      const room = MAX_TOOL_CALLS - toolCallsUsed;
      const calls = turn.calls.slice(0, Math.max(0, room));
      if (!calls.length) break;
      toolCallsUsed += calls.length;
      contents.push({ role: 'model', parts: turn.parts });
      const results = [];

      const runOne = async (call) => {
        const result = await executeTool(call.name, call.args, ctx, context, jobId, false);
        if (result.needs_confirmation) {
          pending = { tool: call.name, args: result.args, token: result.token, summary: result.summary };
        } else {
          executed.push({ tool: call.name, summary: labelFor(call.name, call.args, context), result });
        }
        return {
          functionResponse: {
            name: call.name,
            response: { result: JSON.stringify(result).slice(0, 8000) },
          },
        };
      };

      // Several lookups at once when nothing is being written; writes stay in
      // the order the model asked for, so two edits cannot race each other.
      if (calls.every((call) => READ_TOOLS.has(call.name))) {
        const settled = await Promise.allSettled(calls.map(runOne));
        settled.forEach((item, index) => {
          if (item.status === 'fulfilled') results.push(item.value);
          else results.push({ functionResponse: { name: calls[index].name, response: { result: JSON.stringify({ error: 'That read failed.' }) } } });
        });
      } else {
        for (const call of calls) {
          if (Date.now() > deadline - 9000) break;
          results.push(await runOne(call));
        }
      }
      contents.push({ role: 'user', parts: results });
      turn = await assistantTurn(contents, true, meter);
    }
    if (turn && turn.text) { finalText = turn.text; model = turn.model; modelRoute = turn.route || null; }
    if (turn && turn.error) modelError = turn.error;
    else if (turn && turn.skipped) modelError = turn.skipped;
    if (!finalText && executed.length) {
      const lines = executed.map((item) => {
        if (item.result?.error) {
          return item.tool === 'start_page'
            ? `No page was started: ${item.result.error}`
            : `${item.summary} — ${item.result.error}`;
        }
        if (!READ_TOOLS.has(item.tool)) return item.summary;
        const read = describeFallback(item.tool, item.result, context);
        return read && read !== 'Done.' ? read : item.summary;
      });
      finalText = lines.join('\n');
    }
    if (!finalText) finalText = fallbackReply(mode, jobDigest, context);
    // A read that ran but could not be described still gets one plain line so
    // the user is never left with only a button label.
    if (!finalText && executed.length) finalText = executed.map((item) => item.summary).join('\n');
  }

  // The review is the one place the user answers. If the model left it out,
  // add it, so the counts and numbered questions are always visible.
  if (sheetReview && sheetActionResult) {
    const action = sheetActionResult.action;
    const reviewText = sheetReviewText(sheetReview);
    const verify = sheetActionResult.verify || {};
    if (action === 'committed') {
      const marks = sheetActionResult.recorded ?? verify.recorded_now ?? 0;
      const learners = verify.recorded_now ?? marks;
      const counts = `Recorded ${marks} mark${Number(marks) === 1 ? '' : 's'} for ${learners} learner${Number(learners) === 1 ? '' : 's'}. Already there ${verify.skipped_existing ?? 0}, held ${verify.held ?? 0}, blank ${verify.blank ?? 0}. Class ${verify.class_size ?? 0}, difference ${verify.difference ?? 0}.`;
      if (!/\brecorded\b[^\n]{0,30}\d/i.test(finalText)) finalText = [finalText, counts].filter(Boolean).join('\n\n');
      if (sheetReview.needs_answer?.length && !reviewAlreadyShown(finalText, sheetReview)) {
        finalText = [finalText, reviewText].filter(Boolean).join('\n\n');
      }
    } else if (sheetReview.needs_answer?.length) {
      if (!reviewAlreadyShown(finalText, sheetReview)) {
        finalText = [finalText, reviewText].filter(Boolean).join('\n\n');
      }
    } else if (action === 'prepared' && sheetReview.summary?.ready) {
      if (!reviewAlreadyShown(finalText, sheetReview) && !/\b(ready|record|write)\b/i.test(finalText)) {
        finalText = [finalText, reviewText].filter(Boolean).join('\n\n');
      }
    }
  } else if (sheetError && !finalText) {
    finalText = sheetError;
  }

  // Detail changes still go through the canonical job correction so a running
  // page keeps one source of truth.
  const intent = Object.keys(executed).length ? 'action' : 'chat';
  const documentFiles = executed
    .flatMap((item) => (Array.isArray(item.result?.documents) ? item.result.documents : []))
    .filter((file) => file && file.url);

  // The mapping table is rendered from the same rows the assistant saw, so it
  // displays even when the model answers in prose or with a different wording.
  // A page change in this turn re-reads the page so the card never shows the
  // state from before the correction.
  const pageTools = new Set(['job_status', 'page_rows', 'set_page_mark', 'map_page_row', 'retry_page']);
  const askedForPage = mode === 'post_upload' || executed.some((item) => pageTools.has(item.tool));
  let mappingDigest = jobDigest;
  if (askedForPage && jobId && UUID_RE.test(jobId)
    && executed.some((item) => ['set_page_mark', 'map_page_row', 'retry_page'].includes(item.tool))) {
    const fresh = await opsRpc('ops_jobs_get', { p_id: jobId }).catch(() => null);
    mappingDigest = buildJobDigest(fresh, context) || jobDigest;
  }
  const mapping = askedForPage ? buildMapping(mappingDigest) : null;

  // A page the model started (or reused) in this turn. The client uploads into
  // it, so this is the only signal that a photo may go up.
  let page = [...executed].reverse()
    .find((item) => item.tool === 'start_page' && item.result?.job_id)?.result || null;
  const direct = !page && (
    executed.some((item) => ['record_scores', 'correct_score'].includes(item.tool))
    || executed.some((item) => item.tool === 'sheet_review'
      && ['prepared', 'answered', 'committed'].includes(item.result?.action))
  );

  // A photo that produced a sheet review is never also started as a blank
  // page. start_page is only for a page with no marks on it.
  const reviewedPhoto = Boolean(sheetActionResult && sheetActionResult.action === 'prepared');
  if (mode === 'prepare_page' && !page && !reviewedPhoto) {
    page = await startPageFromInstruction(ctx, context, userText);
    if (page) executed.push({ tool: 'start_page', summary: labelFor('start_page', {}, context), result: page });
  }

  if (mode === 'prepare_page' && page && !finalText) {
    const label = [page.class_label, page.subject, page.column].filter(Boolean).join(' · ');
    finalText = page.reused
      ? `Using the open page for ${label}. Uploading the photo into it.`
      : `Page ready for ${label}. Uploading the photo into it.`;
  }

  // Save the finished turn before the reply reaches the screen. The state row
  // is what makes a resume exact: class, subject, term, a pending confirmation
  // and the open page all come back with the transcript.
  let chatPersisted = false;
  let chatTitleOut = chatTitle;
  if (chatSaved && chatDetail?.ok) {
    const openBatch = [...executed]
      .reverse()
      .map((item) => cleanStr(item.result?.batch_id, 40))
      .find((value) => UUID_RE.test(value)) || null;
    const openJob = page?.job_id || (jobId && UUID_RE.test(jobId) ? jobId : null);
    const working = chatWorkingContext(body, draft, context, page, chatDetail?.state?.working_context);
    const finished = await opsRpc('ops_chat_turn_finish', {
      p_session_id: chatId,
      p_school_id: ctx.actor.school_id,
      p_owner_user_id: ctx.actor.id,
      p_content: String(finalText || '').trim(),
      p_tool_calls: executed.map((item) => ({ tool: item.tool, summary: item.summary })),
      p_tool_results: executed.map((item) => {
        // A generated document is named in the saved turn too, so the download
        // buttons come back with the transcript after a reload or a new login.
        const files = Array.isArray(item.result?.documents) ? item.result.documents : [];
        return {
          tool: item.tool,
          ok: !item.result?.error,
          summary: item.summary,
          error: item.result?.error || null,
          ...(files.length ? {
            documents: files.slice(0, 8).map((file) => ({
              id: file.id || null,
              url: file.url || null,
              filename: file.filename || null,
              type: file.type || 'cards',
              template: file.template || null,
              mode: file.mode || null,
              class: file.class || null,
              class_key: file.class_key || null,
              page_count: file.page_count || null,
              sample: file.sample === true,
            })),
          } : {}),
        };
      }),
      p_attachment_refs: attachmentRefs,
      p_working_context: working,
      p_pending_review: pending,
      p_open_batch_id: openBatch,
      p_open_job_id: openJob,
      p_route: model || null,
    }).catch((error) => {
      console.error('ops_chat_turn_save_failed', error?.message || error);
      return null;
    });
    chatPersisted = Boolean(finished && finished.ok);
    if (finished?.session?.title) chatTitleOut = cleanStr(finished.session.title, 120) || chatTitleOut;
    // Roll the transcript forward while keeping the send small: older turns
    // become one summary line, the six most recent turns stay whole.
    if (chatPersisted) {
      await opsRpc('ops_chat_trim', {
        p_session_id: chatId,
        p_school_id: ctx.actor.school_id,
        p_owner_user_id: ctx.actor.id,
        p_keep: CONTEXT_KEEP_MESSAGES,
      }).catch(() => null);
    }
  }

  return sendJson(res, 200, {
    ok: true,
    reply: String(finalText || '').trim(),
    intent,
    chat_id: chatDetail?.ok ? chatId : null,
    chat_title: chatTitleOut,
    chat_saved: chatPersisted,
    job_id: page?.job_id || (jobId && UUID_RE.test(jobId) ? jobId : null),
    page,
    direct,
    executed: executed.map((item) => ({
      tool: item.tool,
      ok: !item.result?.error,
      summary: item.summary,
    })),
    pending,
    documents: documentFiles,
    mapping,
    sheet_review: sheetReview || null,
    sheet_error: sheetError || null,
    model: model || null,
    model_route: modelRoute,
    model_error: modelError || null,
    gate: gate || null,
    live_write: false,
    correction: correctionResult,
  });
}

// A small, honest check before a route may become primary. It proves a plain
// answer and one tool call, then the caller records the result.
async function testModelRoute(role) {
  const routes = await loadModelRoutes(true);
  const route = routes[role] || null;
  if (!route) {
    return { ok: false, message: 'That route is not configured or is disabled.' };
  }
  const ask = async (parts, useTools) => {
    const contents = [{ role: 'user', parts }];
    const provider = String(route.provider || '').toLowerCase();
    const turn = provider.includes('gemini')
      ? await geminiTurn(contents, useTools, 18000, route)
      : await riverTurn(contents, useTools, route);
    return turn || null;
  };

  const plain = await ask([{ text: 'Reply with the single word READY.' }], false);
  if (!plain || plain.error || !String(plain.text || '').trim()) {
    return {
      ok: false,
      step: 'reply',
      message: plain?.error || 'The route did not answer.',
    };
  }

  const toolTurn = await ask([{
    text: 'Use the get_school_snapshot tool now. Do not answer in words.',
  }], true);
  const calls = Array.isArray(toolTurn?.calls) ? toolTurn.calls : [];
  if (!toolTurn || toolTurn.error || !calls.length) {
    return {
      ok: false,
      step: 'tool',
      message: toolTurn?.error || 'The route did not produce a tool call.',
      reply: String(plain.text || '').slice(0, 80),
    };
  }

  return {
    ok: true,
    model: plain.model || route.model,
    reply: String(plain.text || '').slice(0, 80),
    tool: calls[0].name,
  };
}

module.exports = {
  handleAgentChat,
  buildJobDigest,
  buildMapping,
  testModelRoute,
  testVisionRoute,
  loadModelRoutes,
};
