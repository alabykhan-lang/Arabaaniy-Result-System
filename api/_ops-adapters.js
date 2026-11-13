'use strict';

// Adapter boundary. The pipeline calls this module, never a vendor.
//
// Interface (same for every provider):
//   health()                       -> { status: 'ok' | 'degraded' | 'down', detail }
//   interpret(instruction, ctx)    -> Intent | Park
//   parseRoster(input, ctx)        -> StagedRows | Park
//   parseScores(input, ctx)        -> StagedRows | Park
//
// input is a descriptor, never secrets: { filename, mime, byte_size, sha256, job_id }.
// A daemon may also pass content_b64 for the one photo it already downloaded;
// otherwise the adapter fetches the bytes through the service-role file reader.
//
// Installed adapters are manual (parks for a human) and gemini_vision (reads a
// page through GEMINI_API_KEY). The openbot_agent adapter exists only inside an
// OpenBot agent turn, so a plain process must not claim work for it.

const sharp = require('sharp');
const { CONTRACT_VERSION, validateOutcome, validateStagedRows } = require('./_ops-contract');
const { matchLines } = require('./_ops-match');

const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.SUPABASE_URL
  || 'https://gnixdjglpsaarlrzqgdg.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || '';
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL
  || process.env.GEMINI_MODEL
  || 'gemini-3.1-flash-lite';

function park(reason, detail) {
  return {
    schema_version: CONTRACT_VERSION,
    outcome: 'park',
    reason,
    detail: detail || null,
  };
}

const manual = {
  id: 'manual',
  label: 'Manual (park for a human)',
  autonomous: false,
  async health() {
    return { status: 'ok', detail: 'Always available; parks work for a human.' };
  },
  async interpret(instruction, context) {
    return park('Manual provider: instruction queued for a human.', { service: context?.service || null });
  },
  async parseRoster(input, context) {
    return park('Manual provider: roster photo stored; name entry awaits a human.', {
      filename: input?.filename || null,
      job_id: context?.job_id || null,
    });
  },
  async parseScores(input, context) {
    return park('Manual provider: score photo stored; score entry awaits a human.', {
      filename: input?.filename || null,
      job_id: context?.job_id || null,
    });
  },
};

// ---------------------------------------------------------------------------
// Gemini vision reader. It reads one page through the Google Generative
// Language API. The key is read from the environment only; it is never put on
// a job, in a log line, or in a staged row.
//
// The adapter receives either photo bytes (content_b64, used by the daemon) or
// a job descriptor. In the descriptor case it fetches the bytes through
// ops_read_file with the project service-role key.
// ---------------------------------------------------------------------------
function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function directRpc(name, body) {
  if (!SERVICE_KEY) throw codedError('OPS_SERVICE_KEY_MISSING', 'service role key is not configured');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(45000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw codedError('OPS_READ_FAILED', payload?.message || `RPC ${name} failed`);
  return payload;
}

async function loadJobDetail(input, context) {
  const jobId = context?.job_id || input?.job_id;
  if (!jobId) throw codedError('OPS_JOB_REQUIRED', 'job_id is required');
  if (context?.job && context?.files) return context;
  if (typeof context?.opsRpc === 'function') {
    return context.opsRpc('ops_jobs_get', { p_id: jobId });
  }
  return directRpc('ops_jobs_get', { p_id: jobId });
}

async function loadPhoto(input, context, detail) {
  if (input?.content_b64) {
    return { base64: String(input.content_b64), mime: input.mime || 'image/jpeg' };
  }
  const file = Array.isArray(detail?.files) ? detail.files[0] : null;
  if (!file?.id) throw codedError('OPS_FILE_MISSING', 'this job has no photo');
  const payload = typeof context?.opsRpc === 'function'
    ? await context.opsRpc('ops_read_file', { p_file_id: file.id })
    : await directRpc('ops_read_file', { p_file_id: file.id });
  if (!payload?.content_b64) throw codedError('OPS_FILE_MISSING', 'photo bytes were not returned');
  return { base64: String(payload.content_b64), mime: payload.mime || file.mime || 'image/jpeg', file };
}

async function callGemini(model, prompt, mime, base64) {
  const key = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw codedError('GEMINI_KEY_MISSING', 'GEMINI_API_KEY is not set');

  const models = [...new Set([model, GEMINI_MODEL, 'gemini-2.5-flash'].filter(Boolean))];
  let lastStatus = 0;
  for (const candidate of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && !data.error) {
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    }
    lastStatus = response.status;
    // A missing model is worth one retry with the next candidate. An auth or
    // quota refusal is the same for every model, so stop there.
    if (response.status !== 404) break;
  }
  throw codedError(`GEMINI_HTTP_${lastStatus || 'ERROR'}`, 'the vision provider refused the request');
}

function parseJsonRows(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    throw codedError('GEMINI_RESPONSE_INVALID', 'the vision provider did not return JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rows)) throw codedError('GEMINI_RESPONSE_INVALID', 'the vision provider returned no rows');
  return rows;
}

function numberOrNull(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function componentFor(job, fallback) {
  if (fallback && ['ca1', 'ca2', 'ca3', 'exam'].includes(fallback)) return fallback;
  const label = String(job?.column_label || '').toUpperCase();
  if (label.includes('EXAM')) return 'exam';
  if (label.includes('CA 3') || label.includes('CA3') || label.includes('THIRD')) return 'ca3';
  if (label.includes('CA 2') || label.includes('CA2') || label.includes('SECOND')) return 'ca2';
  return 'ca1';
}

function subjectFor(job) {
  const first = Array.isArray(job?.subject_set) ? job.subject_set[0] : null;
  return {
    subjectKey: first?.key || (job?.class_key ? `${job.class_key}:writing` : ''),
    subjectLabel: first?.label || '',
  };
}

function scorePrompt(job, roster) {
  const subject = subjectFor(job);
  const known = roster.slice(0, 300).map((pupil) => `${pupil.admno || '?'}\t${pupil.name || ''}`).join('\n');
  return [
    'You are reading one photograph of a handwritten school score sheet.',
    `Class: ${job?.class_key || 'unknown'}. Subject: ${subject.subjectLabel || subject.subjectKey || 'unknown'}. Column: ${job?.column_label || 'unknown'}.`,
    'Return JSON only, shaped exactly like this:',
    '{"rows":[{"row_no":1,"name_raw":"name as written","admno":"printed admission number or empty","value":17,"confidence":0.9,"flag":""}]}',
    'Rules:',
    '- One row per handwritten line, in the order printed.',
    '- name_raw is the name exactly as written. Never rewrite it from the known list.',
    '- admno is only the admission number printed on the page. Leave it empty if none is printed.',
    '- value is the mark as a number. Leave it out if the mark is unreadable.',
    '- confidence is between 0 and 1. Set flag to "unreadable" when you cannot read a line.',
    '- Never invent a pupil or a mark.',
    known ? `Known pupils in this class (admission number then name):\n${known}` : '',
  ].filter(Boolean).join('\n');
}

function rosterPrompt(job) {
  return [
    'You are reading one photograph of a handwritten class list.',
    `Class: ${job?.class_key || 'unknown'}.`,
    'Return JSON only, shaped exactly like this:',
    '{"rows":[{"row_no":1,"name_raw":"name as written","admno":"printed admission number or empty"}]}',
    'Rules:',
    '- One row per handwritten name, in the order printed.',
    '- name_raw is the name exactly as written.',
    '- admno is only an admission number printed on the page.',
    '- Never invent a pupil.',
  ].join('\n');
}

const geminiVision = {
  id: 'gemini_vision',
  label: 'Gemini vision reader',
  autonomous: true,
  async health() {
    const key = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) return { status: 'down', detail: 'GEMINI_API_KEY is not set' };
    return { status: 'ok', detail: `Key present; model ${GEMINI_MODEL}` };
  },
  async interpret(instruction, context) {
    return park('The vision reader reads photos; a typed instruction waits for the assistant.', {
      service: context?.service || null,
      job_id: context?.job_id || null,
    });
  },
  async parseScores(input, context) {
    const detail = await loadJobDetail(input, context);
    const job = detail?.job || {};
    const roster = Array.isArray(detail?.roster) ? detail.roster : [];
    const photo = await loadPhoto(input, context, detail);
    const text = await callGemini(context?.model || GEMINI_MODEL, scorePrompt(job, roster), photo.mime, photo.base64);
    const raw = parseJsonRows(text);

    const seen = raw.map((row, index) => ({
      row_no: Number.isInteger(row?.row_no) && row.row_no > 0 ? row.row_no : index + 1,
      name_raw: String(row?.name_raw ?? row?.name ?? '').trim().slice(0, 300),
      admno: String(row?.admno ?? '').trim().slice(0, 300),
      value: numberOrNull(row?.value),
      confidence: numberOrNull(row?.confidence),
      flag: String(row?.flag ?? '').trim().slice(0, 300),
    })).filter((row) => row.name_raw || row.value != null);

    if (!seen.length) throw codedError('OPS_READ_EMPTY', 'the page produced no score lines');

    const component = componentFor(job, context?.component);
    const subject = subjectFor(job);
    let document;

    if (roster.length) {
      document = matchLines(
        seen.map((row) => ({ no: row.row_no, raw: row.name_raw })),
        roster,
        { subjectKey: subject.subjectKey, subjectLabel: subject.subjectLabel, component },
      );
      document.rows.forEach((row, index) => {
        const read = seen[index];
        if (!read) return;
        if (read.value != null) row.value = Math.min(100, Math.max(0, read.value));
        const printed = read.admno
          ? roster.find((pupil) => String(pupil.admno || '').toUpperCase() === read.admno.toUpperCase())
          : null;
        if (printed) {
          row.admno = printed.admno;
          delete row.candidate_admno;
          delete row.flag;
          row.confidence = Math.max(Number(row.confidence || 0), 0.95);
        } else if (read.flag && !row.flag) {
          row.flag = read.flag;
        }
      });
      document.warnings = document.rows.some((row) => row.flag)
        ? ['Lines with a flag are waiting for a human; none of them were accepted.']
        : [];
    } else {
      document = {
        schema_version: CONTRACT_VERSION,
        rows: seen.map((row) => ({
          row_no: row.row_no,
          name_raw: row.name_raw,
          ...(row.admno ? { admno: row.admno } : {}),
          ...(row.value != null ? { value: Math.min(100, Math.max(0, row.value)) } : {}),
          component,
          ...(row.confidence != null ? { confidence: Math.min(1, Math.max(0, row.confidence)) } : {}),
          ...(row.flag ? { flag: row.flag } : {}),
        })),
        warnings: ['No frozen class list is attached to this job; every line waits for a human.'],
      };
    }

    validateStagedRows(document);
    return document;
  },
  async parseRoster(input, context) {
    const detail = await loadJobDetail(input, context);
    const job = detail?.job || {};
    const photo = await loadPhoto(input, context, detail);
    const text = await callGemini(context?.model || GEMINI_MODEL, rosterPrompt(job), photo.mime, photo.base64);
    const raw = parseJsonRows(text);

    const rows = raw.map((row, index) => ({
      row_no: Number.isInteger(row?.row_no) && row.row_no > 0 ? row.row_no : index + 1,
      name_raw: String(row?.name_raw ?? row?.name ?? '').trim().slice(0, 300),
      ...(String(row?.admno ?? '').trim() ? { admno: String(row.admno).trim().slice(0, 300) } : {}),
    })).filter((row) => row.name_raw);

    if (!rows.length) throw codedError('OPS_READ_EMPTY', 'the page produced no roster lines');

    const document = {
      schema_version: CONTRACT_VERSION,
      rows,
      warnings: ['Roster lines are staged for a human to confirm; this reader never adds a pupil by itself.'],
    };
    validateStagedRows(document);
    return document;
  },
};

// ---------------------------------------------------------------------------
// River vision reader. It reads one page through an OpenAI-compatible
// /chat/completions endpoint. The key, base URL and model come from the
// environment and the provider row only; none of them is written into a job,
// a log line or a staged row.
//
// The page is sent upright (EXIF rotation applied), longest side 1300-1800,
// JPEG q85. The adapter records the bytes actually sent, the dimensions and the
// model in context.read_meta so the worker can put them in the audit trail.
// ---------------------------------------------------------------------------
function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function riverConfig(context) {
  return {
    apiKey: String(process.env.RIVER_API_KEY || '').trim(),
    baseUrl: String(process.env.RIVER_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: String(context?.model || process.env.RIVER_READER_MODEL || '').trim(),
  };
}

function secondOpinionConfig() {
  const model = String(process.env.RIVER_SECOND_OPINION_MODEL || '').trim();
  const baseUrl = String(
    process.env.RIVER_SECOND_OPINION_BASE_URL || process.env.RIVER_BASE_URL || '',
  ).trim().replace(/\/+$/, '');
  return {
    apiKey: String(process.env.RIVER_API_KEY || '').trim(),
    baseUrl,
    model,
    maxTokens: clampNumber(process.env.RIVER_SECOND_OPINION_MAX_TOKENS, 2600, 2000, 8000),
    timeoutMs: clampNumber(process.env.RIVER_SECOND_OPINION_TIMEOUT_MS, 60000, 10000, 120000),
    enabled: Boolean(model && baseUrl && String(process.env.RIVER_API_KEY || '').trim()),
  };
}

function riverScorePrompt(job) {
  const subject = subjectFor(job);
  const group = String(job?.column_group || '').trim();
  const label = String(job?.column_label || '').trim();
  const expected = Number(job?.roster_snapshot_count) || 0;
  return [
    'You are transcribing names and marks from one photograph of a handwritten school score sheet.',
    `Class: ${job?.class_key || 'unknown'}. Subject: ${subject.subjectLabel || subject.subjectKey || 'unknown'}.`,
    `Target column: ${group ? `${group} · ` : ''}${label || 'the target column'}.`,
    'Return JSON only, shaped exactly like this:',
    '{"rows":[{"row_no":1,"name_raw":"surname - given names","value":17,"confidence":0.9}]}',
    'How to read each line:',
    `- One row per printed line number, in order.${expected ? ` There are ${expected} printed lines.` : ''}`,
    '- Copy the name letter by letter, exactly as the teacher wrote it. Keep the hyphen and every given name.',
    '- Do not correct spelling, do not substitute a name you know, and do not use any class list.',
    '- If a letter is genuinely unclear, give your best single reading. Never leave letters out and never abbreviate.',
    '- Include every written given name, even a third name.',
    '- value is the mark in the target column only. Use null when the cell is blank.',
    '- Use the string "unclear" when a digit could be read more than one way (for example 1/7, 4/9, 0/6, 5/6). Never guess an ambiguous digit.',
    '- confidence is between 0 and 1.',
    '- Never invent a pupil, a row or a mark that is not printed on the page.',
  ].join('\n');
}

function riverRosterPrompt(job) {
  return [
    'You are reading one photograph of a handwritten class list.',
    `Class: ${job?.class_key || 'unknown'}.`,
    'Return JSON only, shaped exactly like this:',
    '{"rows":[{"row_no":1,"name_raw":"name as written","admno":"printed admission number or empty"}]}',
    'Rules:',
    '- One row per handwritten name, in the order printed.',
    '- row_no is the printed line number.',
    '- name_raw is the name exactly as written.',
    '- admno is only an admission number printed on the page.',
    '- Never invent a pupil or a row.',
  ].join('\n');
}

async function callRiver(config, prompt, mime, base64, options = {}) {
  if (!config.apiKey) throw codedError('RIVER_KEY_MISSING', 'RIVER_API_KEY is not set');
  if (!config.baseUrl) throw codedError('RIVER_BASE_URL_MISSING', 'RIVER_BASE_URL is not set');
  if (!config.model) throw codedError('RIVER_MODEL_MISSING', 'no model is set on the provider row or in RIVER_READER_MODEL');

  const started = Date.now();
  const body = {
    model: config.model,
    temperature: options.temperature == null ? 0 : options.temperature,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64}`, detail: 'high' } },
      ],
    }],
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs || 120000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw codedError('RIVER_TIMEOUT', 'the vision provider did not answer in time');
    }
    throw codedError('RIVER_NETWORK_ERROR', 'the vision provider could not be reached');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // The status is enough for the worker log. The response body can contain
    // account detail, so it never goes any further.
    throw codedError(`RIVER_HTTP_${response.status}`, 'the vision provider refused the request');
  }
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => part?.text || '').join('')
    : String(content || '');
  if (!text.trim()) throw codedError('RIVER_RESPONSE_EMPTY', 'the vision provider returned no text');
  return { text, data, elapsedMs: Date.now() - started };
}

async function prepareRiverPage(buffer) {
  const longest = clampNumber(process.env.RIVER_IMAGE_LONG_SIDE, 1800, 1300, 1800);
  const out = await sharp(buffer, { failOn: 'error', limitInputPixels: 100000000 })
    .rotate()
    .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}

function riverJson(text, code) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    throw codedError(code || 'RIVER_RESPONSE_INVALID', 'the vision provider did not return JSON');
  }
}

function cellReading(value) {
  if (value == null) return { kind: 'blank' };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'read', value } : { kind: 'unclear' };
  }
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'null' || text === 'none' || text === '-') return { kind: 'blank' };
  if (/unclear|ambiguous|\?/.test(text)) return { kind: 'unclear' };
  const number = Number(text.replace(/[^0-9.-]/g, ''));
  if (Number.isFinite(number)) return { kind: 'read', value: number };
  return { kind: 'unclear' };
}

function riverRows(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.rows;
  if (!Array.isArray(rows)) throw codedError('RIVER_RESPONSE_INVALID', 'the vision provider returned no rows');
  return rows.map((row, index) => ({
    row_no: Number.isInteger(row?.row_no) && row.row_no > 0 ? row.row_no : index + 1,
    name_raw: String(row?.name_raw ?? row?.name ?? '').trim().slice(0, 300),
    admno: String(row?.admno ?? '').trim().slice(0, 300),
    value: cellReading(row?.value),
    confidence: numberOrNull(row?.confidence),
    flag: String(row?.flag ?? '').trim().slice(0, 300),
  })).filter((row) => row.name_raw || row.value.kind !== 'blank');
}

function priorAmbiguousCells(detail) {
  const rows = Array.isArray(detail?.staged_rows) ? detail.staged_rows : [];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const cells = new Map();
  for (const mark of Array.isArray(detail?.marks) ? detail.marks : []) {
    if (mark?.status !== 'ambiguous') continue;
    const row = byId.get(String(mark.staged_row_id));
    if (!row) continue;
    cells.set(`${row.row_no}|${mark.column_label}`, mark);
  }
  return cells;
}

// Find one cell in the printed 1ST TERM block: the fourth sub-column
// (CLASS EXERCISE on this sheet). The crop is only for the optional second
// opinion; a page whose grid cannot be located simply skips it.
async function locateRiverCell(pageBuffer, rowNo, rowCount, columnGroup) {
  if (!/^1\s*ST\b|^1ST\b/i.test(String(columnGroup || ''))) return null;
  const raw = await sharp(pageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const width = info.width;
  const height = info.height;

  const y0 = Math.round(height * 0.17);
  const y1 = Math.round(height * 0.90);
  const xCounts = new Array(width).fill(0);
  for (let x = Math.round(width * 0.45); x < width; x += 1) {
    let dark = 0;
    for (let y = y0; y < y1; y += 1) if (data[y * width + x] < 150) dark += 1;
    xCounts[x] = dark;
  }
  const vertical = [];
  for (let x = Math.round(width * 0.45) + 1; x < width - 1; x += 1) {
    if (xCounts[x] > (y1 - y0) * 0.60
        && xCounts[x] >= xCounts[x - 1] && xCounts[x] >= xCounts[x + 1]) vertical.push(x);
  }
  const vLines = [];
  for (const x of vertical) {
    const last = vLines[vLines.length - 1];
    if (last != null && x - last <= 7) vLines[vLines.length - 1] = (last + x) / 2;
    else vLines.push(x);
  }
  const first = vLines.findIndex((x) => x > width * 0.50);
  const sequence = first >= 0 ? vLines.slice(first, first + 6) : [];
  if (sequence.length < 5) return null;
  const stepX = median(sequence.slice(1).map((x, index) => x - sequence[index])
    .filter((gap) => gap > width * 0.015 && gap < width * 0.08));
  if (!stepX || stepX < width * 0.015 || stepX > width * 0.08) return null;
  const left = sequence[0] + stepX * 3;
  const right = sequence[0] + stepX * 4;

  // Row rules are clearest in the blank column just after the target cell.
  const xa = Math.min(width - 2, Math.round(right + stepX * 0.25));
  const xb = Math.min(width, Math.round(right + stepX * 0.85));
  if (xb - xa < 4) return null;
  const yCounts = new Array(height).fill(0);
  for (let y = Math.round(height * 0.12); y < Math.round(height * 0.95); y += 1) {
    let dark = 0;
    for (let x = xa; x < xb; x += 1) if (data[y * width + x] < 160) dark += 1;
    yCounts[y] = dark;
  }
  const horizontal = [];
  for (let y = Math.round(height * 0.12) + 1; y < Math.round(height * 0.95) - 1; y += 1) {
    if (yCounts[y] > (xb - xa) * 0.5
        && yCounts[y] >= yCounts[y - 1] && yCounts[y] >= yCounts[y + 1]) horizontal.push(y);
  }
  const hLines = [];
  for (const y of horizontal) {
    const last = hLines[hLines.length - 1];
    if (last != null && y - last <= 5) hLines[hLines.length - 1] = (last + y) / 2;
    else hLines.push(y);
  }
  if (hLines.length < 4) return null;

  // Keep the evenly spaced rule lines and drop handwriting peaks. The photo is
  // slightly angled, so the gap grows from the top of the page to the bottom;
  // a wide band accepts that without accepting a line from the next cell.
  const minGap = height * 0.012;
  const maxGap = height * 0.035;
  let start = -1;
  for (let i = 0; i < hLines.length && start < 0; i += 1) {
    const gaps = [];
    let last = hLines[i];
    for (let j = i + 1; j < hLines.length && gaps.length < 5; j += 1) {
      const gap = hLines[j] - last;
      if (gap < minGap) continue;
      if (gap > maxGap) break;
      gaps.push(gap);
      last = hLines[j];
    }
    if (gaps.length < 4) continue;
    const steady = median(gaps);
    if (steady && gaps.every((gap) => Math.abs(gap - steady) <= steady * 0.3)) start = i;
  }
  if (start < 0) return null;
  const rules = [];
  for (let i = start; i < hLines.length; i += 1) {
    const y = hLines[i];
    const last = rules[rules.length - 1];
    if (last == null) {
      rules.push(y);
      continue;
    }
    const gap = y - last;
    if (gap >= minGap && gap <= maxGap) rules.push(y);
  }
  if (rules.length < rowNo + 1) return null;

  const top = rules[rowNo - 1];
  const bottom = rules[rowNo];
  const center = (top + bottom) / 2;
  if (center < 0 || center > height) return null;

  const cropWidth = Math.max(24, Math.round(right - left));
  const cropHeight = Math.max(18, Math.round(bottom - top + 6));
  const cropLeft = Math.max(0, Math.round(left - 3));
  const cropTop = Math.max(0, Math.round(top - 3));
  return {
    left: cropLeft,
    top: cropTop,
    width: Math.min(width - cropLeft, cropWidth + 6),
    height: Math.min(height - cropTop, cropHeight),
  };
}

async function readFlaggedCell(pageBuffer, rowNo, rowCount, job) {
  const config = secondOpinionConfig();
  if (!config.enabled) return null;
  let box;
  try {
    box = await locateRiverCell(pageBuffer, rowNo, rowCount, job?.column_group);
  } catch (_) {
    box = null;
  }
  if (!box || box.width < 8 || box.height < 8) return null;

  let crop;
  try {
    crop = await sharp(pageBuffer)
      .extract(box)
      .resize({ width: Math.min(520, box.width * 6) })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (_) {
    return null;
  }

  const prompt = [
    'This is one cell from a handwritten school marks sheet.',
    `The printed column is ${job?.column_label || 'the target column'}, usually a mark from 0 to 30.`,
    'Return JSON only: {"value":24} or {"value":"unclear"}.',
    'Use "unclear" when the digits could be read more than one way. Do not explain.',
  ].join('\n');

  try {
    const answer = await callRiver(config, prompt, 'image/jpeg', crop.toString('base64'), {
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      temperature: 0,
    });
    const parsed = riverJson(answer.text, 'RIVER_SECOND_OPINION_INVALID');
    return { reading: cellReading(parsed?.value), elapsedMs: answer.elapsedMs };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name column second pass.
//
// The full page is read for names and marks. Names are the part that decides
// whether a line is accepted, and on a phone photo they occupy a small part of
// the page. This second pass crops only the NAME column out of the upright
// page, in bands of ten printed lines, and enlarges each band far beyond the
// single-cell crop used for ambiguous digits. It reads names only and never
// reads a mark a second time.
//
// The two readings are compared per line. A line is only accepted on a name
// when both readings are the same after case, punctuation and accents are
// removed; otherwise the line stays open and the review screen shows both
// spellings. This pass never changes the matcher and never reads the roster.
// ---------------------------------------------------------------------------

const NAME_BAND_ROWS = 10;

function nameSecondConfig(context) {
  const base = riverConfig(context);
  return {
    ...base,
    model: String(process.env.RIVER_NAME_SECOND_MODEL || base.model || '').trim(),
  };
}

function nameKey(value) {
  return String(value || '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameBandPrompt(start, end, roster) {
  const known = (roster || [])
    .slice(0, 300)
    .map((pupil) => `${pupil.admno || '?'}\t${pupil.name || ''}`)
    .join('\n');
  return [
    'This is a crop of the NAME column of a handwritten school score sheet.',
    `The printed line numbers ${start} to ${end} are visible at the left edge. Read only the names; there are no marks in this crop.`,
    'The class register is below. For every printed line, choose exactly one register entry, copied letter for letter, or "unsure".',
    'Return JSON only, shaped exactly like this:',
    `{"rows":[{"row_no":${start},"pupil":"NAME EXACTLY AS IN THE REGISTER or unsure","literal":"the name as written on the page"}]}`,
    `Return exactly one row for each printed line from ${start} to ${end}, using the printed row number, in order.`,
    '- "pupil" must be copied from the register. Never invent a name and never answer with a spelling that is not in the register.',
    '- Answer "unsure" when the writing cannot belong to any register entry, or when two entries are genuinely equally plausible.',
    '- "literal" is the page spelling only: keep the hyphen and every given name, never correct it, never substitute the register entry.',
    '- Include every written given name, even a third name.',
    '- Do not return any line number outside this crop and do not return a mark.',
    'REGISTER',
    known || '(the register is empty; answer unsure for every line)',
  ].join('\n');
}

// Finds the printed row rules by scanning a blank grid column just right of the
// names. The blank strip is chosen by darkness, so it works without knowing
// the column widths of this particular sheet.
async function locateRiverNameBands(pageBuffer, rowCount) {
  if (!Number.isInteger(rowCount) || rowCount < 2) return null;
  let raw;
  try {
    raw = await sharp(pageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  } catch (_) {
    return null;
  }
  const { data, info } = raw;
  const width = info.width;
  const height = info.height;
  if (!width || !height) return null;

  const yTop = Math.round(height * 0.10);
  const yBottom = Math.round(height * 0.985);
  const win = Math.max(24, Math.round(width * 0.05));
  let blank = { frac: Infinity, x: -1 };
  for (let x = Math.round(width * 0.55); x + win < Math.round(width * 0.70); x += 4) {
    let dark = 0;
    for (let y = yTop; y < yBottom; y += 1) {
      for (let xx = x; xx < x + win; xx += 1) if (data[y * width + xx] < 145) dark += 1;
    }
    const frac = dark / ((yBottom - yTop) * win);
    if (frac < blank.frac) blank = { frac, x };
  }
  if (blank.x < 0) return null;

  const counts = [];
  for (let y = Math.round(height * 0.08); y < Math.round(height * 0.995); y += 1) {
    let dark = 0;
    for (let x = blank.x; x < blank.x + win; x += 1) if (data[y * width + x] < 145) dark += 1;
    counts.push({ y, frac: dark / win });
  }
  const peaks = [];
  for (let i = 1; i < counts.length - 1; i += 1) {
    const c = counts[i];
    if (c.frac > 0.5 && c.frac >= counts[i - 1].frac && c.frac >= counts[i + 1].frac) peaks.push(c);
  }
  const rules = [];
  for (const p of peaks) {
    const last = rules[rules.length - 1];
    if (last && p.y - last.y <= 5) {
      if (p.frac > last.frac) rules[rules.length - 1] = p;
    } else {
      rules.push(p);
    }
  }
  if (rules.length < 8) return null;

  const minGap = height * 0.009;
  const maxGap = height * 0.022;
  let start = -1;
  for (let i = 0; i < rules.length && start < 0; i += 1) {
    let last = rules[i].y;
    let previous = null;
    let steady = 0;
    for (let j = i + 1; j < rules.length && steady < 10; j += 1) {
      const gap = rules[j].y - last;
      if (gap < minGap || gap > maxGap) break;
      if (previous != null && (gap < previous * 0.8 || gap > previous * 1.25)) break;
      previous = gap;
      steady += 1;
      last = rules[j].y;
    }
    if (steady >= 10) start = i;
  }
  if (start < 0) return null;

  const picked = [rules[start].y];
  for (let i = start + 1; i < rules.length; i += 1) {
    const gap = rules[i].y - picked[picked.length - 1];
    if (gap < minGap || gap > maxGap) break;
    picked.push(rules[i].y);
  }

  let bounds;
  if (picked.length >= rowCount + 1) {
    bounds = picked.slice(0, rowCount + 1);
  } else {
    const top = picked[0];
    const bottom = rules[rules.length - 1].y;
    if (!(bottom > top)) return null;
    bounds = Array.from({ length: rowCount + 1 }, (_, i) => top + ((bottom - top) * i) / rowCount);
  }

  const x0 = Math.max(0, Math.round(width * 0.15));
  const x1 = Math.min(width, blank.x + win + Math.round(width * 0.01));
  if (x1 - x0 < width * 0.2) return null;

  const bands = [];
  for (let bandStart = 1; bandStart <= rowCount; bandStart += NAME_BAND_ROWS) {
    const bandEnd = Math.min(rowCount, bandStart + NAME_BAND_ROWS - 1);
    const top = Math.max(0, Math.round(bounds[bandStart > 1 ? bandStart - 2 : 0] - 2));
    const bottom = Math.min(height, Math.round(bounds[bandEnd] + 2));
    if (bottom - top < 12) return null;
    bands.push({
      start: bandStart,
      end: bandEnd,
      box: { left: x0, top, width: x1 - x0, height: bottom - top },
    });
  }
  if (process.env.OPS_DEBUG_NAME_BANDS) {
    console.error('OPS_NAME_BANDS', JSON.stringify({ width, height, blank, start, rules: rules.length, picked: picked.length, bounds: bounds.map(Math.round), bands: bands.map((b) => b.box) }));
  }
  return bands;
}

async function readRiverNameSecondPass(pageBuffer, context, job, seen, roster) {
  const config = nameSecondConfig(context);
  if (!config.apiKey || !config.baseUrl || !config.model) {
    return { ok: false, reason: 'name_second_not_configured', byRow: new Map(), bands: 0 };
  }
  const rowCount = Array.isArray(seen) ? seen.length : 0;
  const bands = await locateRiverNameBands(pageBuffer, rowCount);
  if (!bands) return { ok: false, reason: 'name_column_not_located', byRow: new Map(), bands: 0 };

  const known = Array.isArray(roster) ? roster : [];
  const byKnownName = new Map(known.map((pupil) => [nameKey(pupil.name), pupil.name]));

  const started = Date.now();
  const outcomes = await Promise.all(bands.map(async (band) => {
    let crop;
    try {
      crop = await sharp(pageBuffer)
        .extract(band.box)
        .resize({ width: 2000, kernel: 'lanczos3' })
        .jpeg({ quality: 92 })
        .toBuffer();
    } catch (_) {
      return null;
    }
    const size = band.end - band.start + 1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const answer = await callRiver(config, nameBandPrompt(band.start, band.end, known), 'image/jpeg', crop.toString('base64'), {
          temperature: 0,
          maxTokens: 1600,
          timeoutMs: 45000,
        });
        const parsed = riverJson(answer.text, 'RIVER_NAME_PASS_INVALID');
        const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
        if (rows.length !== size) continue;
        const numbers = rows.map((row) => Number(row?.row_no));
        const numbered = numbers.every((n) => Number.isInteger(n) && n >= band.start && n <= band.end)
          && new Set(numbers).size === size;
        return rows.map((row, index) => {
          const pupil = String(row?.pupil ?? '').trim();
          const literal = String(row?.literal ?? row?.name_raw ?? '').trim().slice(0, 300);
          return {
            row_no: numbered ? Number(row.row_no) : band.start + index,
            // The only allowed roster output is an entry copied from the
            // register. Anything else, including "unsure", is not a hint.
            pupil: byKnownName.get(nameKey(pupil)) || null,
            literal,
          };
        });
      } catch (_) {
        // One retry covers a dropped connection or a short answer.
      }
    }
    return null;
  }));

  const byRow = new Map();
  let agreed = 0;
  let disputed = 0;
  let hinted = 0;
  let unsure = 0;
  let unread = 0;
  const seenByRow = new Map((seen || []).map((row) => [Number(row.row_no), row]));
  outcomes.forEach((rows, index) => {
    const band = bands[index];
    if (!rows) {
      for (let n = band.start; n <= band.end; n += 1) {
        if (seenByRow.has(n)) unread += 1;
      }
      return;
    }
    for (const row of rows) {
      if (!seenByRow.has(row.row_no)) continue;
      const page = seenByRow.get(row.row_no).name_raw;
      const literal = row.literal || page;
      byRow.set(row.row_no, { pupil: row.pupil, literal });
      if (row.pupil) hinted += 1;
      else unsure += 1;
      if (nameKey(literal) === nameKey(page)) agreed += 1;
      else disputed += 1;
    }
  });

  return {
    ok: true,
    model: config.model,
    byRow,
    bands: bands.length,
    hinted,
    unsure,
    agreed,
    disputed,
    unread,
    elapsedMs: Date.now() - started,
  };
}

function appendNote(...parts) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ').slice(0, 500);
}

async function buildRiverMarks(job, seen, matchedRows, detail, pageBuffer) {
  const columnGroup = String(job?.column_group || '1ST TERM');
  const columnLabel = String(job?.column_label || 'CLASS EXERCISE');
  const targets = new Set([columnLabel]);
  const prior = priorAmbiguousCells(detail);
  const rowCount = matchedRows.length;
  const marks = [];

  for (let index = 0; index < matchedRows.length; index += 1) {
    const read = seen[index];
    const rowNo = Number(matchedRows[index]?.row_no) || index + 1;
    if (!read) continue;
    const old = prior.get(`${rowNo}|${columnLabel}`);
    const base = {
      row_no: rowNo,
      column_group: columnGroup,
      column_label: columnLabel,
    };

    if (old) {
      const mark = {
        ...base,
        value: null,
        status: 'ambiguous',
        candidates: Array.isArray(old.candidates) ? old.candidates : [],
        confidence: old.confidence == null ? 0.5 : Number(old.confidence),
        note: old.note || 'This digit is ambiguous on the page.',
      };
      const second = await readFlaggedCell(pageBuffer, rowNo, rowCount, job);
      if (second?.reading?.kind === 'read') {
        mark.note = appendNote(mark.note, `Second opinion reads ${second.reading.value}; still needs your eye.`);
      } else if (second?.reading?.kind === 'unclear' || second?.reading?.kind === 'blank') {
        mark.note = appendNote(mark.note, 'Second opinion could not read it; still needs your eye.');
      }
      marks.push(mark);
      continue;
    }

    if (read.value.kind === 'unclear') {
      marks.push({
        ...base,
        value: null,
        status: 'ambiguous',
        candidates: [],
        confidence: read.confidence == null ? 0.5 : Math.min(1, Math.max(0, read.confidence)),
        note: 'The digit is ambiguous on the page.',
      });
    } else if (read.value.kind === 'read') {
      marks.push({
        ...base,
        value: Math.min(100, Math.max(0, read.value.value)),
        status: 'read',
        confidence: read.confidence == null ? null : Math.min(1, Math.max(0, read.confidence)),
      });
    } else {
      marks.push({ ...base, value: null, status: 'blank' });
    }
  }

  // Only the target column is asked of the model. Nothing is invented for a
  // column that was not read.
  return { marks, columns: [...targets] };
}

const riverVision = {
  id: 'river_vision',
  label: 'River vision reader',
  autonomous: true,
  async health(provider) {
    const config = riverConfig(provider);
    if (!config.apiKey) return { status: 'down', detail: 'RIVER_API_KEY is not set' };
    if (!config.baseUrl) return { status: 'down', detail: 'RIVER_BASE_URL is not set' };
    if (!config.model) return { status: 'down', detail: 'no River model on the provider row or in RIVER_READER_MODEL' };
    return { status: 'ok', detail: `Key present; model ${config.model}` };
  },
  async interpret(instruction, context) {
    return park('The vision reader reads photos; a typed instruction waits for the assistant.', {
      service: context?.service || null,
      job_id: context?.job_id || null,
    });
  },
  async parseScores(input, context) {
    const detail = await loadJobDetail(input, context);
    const job = detail?.job || {};
    const roster = Array.isArray(detail?.roster) ? detail.roster : [];
    const photo = await loadPhoto(input, context, detail);
    const config = riverConfig(context);
    const page = await prepareRiverPage(Buffer.from(photo.base64, 'base64'));
    const answer = await callRiver(config, riverScorePrompt(job), 'image/jpeg', page.buffer.toString('base64'));
    const raw = riverJson(answer.text);

    const seen = riverRows(raw);
    if (!seen.length) throw codedError('OPS_READ_EMPTY', 'the page produced no score lines');

    const expected = Number(job?.roster_snapshot_count) || roster.length || 0;
    if (expected > 0 && seen.length !== expected) {
      const refusal = park(
        `OPS_ROW_COUNT_MISMATCH: the reader saw ${seen.length} lines but the class list has ${expected}; nothing was staged.`,
        { code: 'OPS_ROW_COUNT_MISMATCH', expected, read: seen.length },
      );
      context.read_meta = {
        adapter: 'river_vision',
        model: config.model,
        sent_bytes: page.buffer.length,
        width: page.width,
        height: page.height,
        elapsed_ms: answer.elapsedMs,
        rows: seen.length,
        marks: 0,
      };
      return refusal;
    }

    const component = componentFor(job, context?.component);
    let document;

    // Names get a second, dedicated read of the name column only. The page
    // read above stays the single read for marks. A line whose two readings
    // differ is staged with both spellings and can never pass as a match.
    const nameSecond = await readRiverNameSecondPass(page.buffer, context, job, seen, roster).catch(() => null);
    const secondByRow = nameSecond?.byRow instanceof Map ? nameSecond.byRow : new Map();

    // The reader never matches names. It stages the name exactly as written and
    // the printed admission number, if any. The daemon runs the shared
    // four-list alignment after the rows exist, so every reader gets the same
    // surname-first comparison and the same A/B/C/D result.
    document = {
      schema_version: CONTRACT_VERSION,
      rows: seen.map((row) => {
        const read = secondByRow.get(row.row_no) || null;
        const literal = String(read?.literal || '').trim();
        const pupil = String(read?.pupil || '').trim();
        let flag = row.flag;
        if (pupil) {
          // A closed-set reader named one register entry. It is carried as a
          // hint, never as an acceptance: the matcher decides A/B/C and a tap
          // is still required for B.
          flag = `name_hint|${pupil}|${literal || row.name_raw}`;
        } else if (literal && nameKey(literal) !== nameKey(row.name_raw)) {
          flag = `name_disputed|${literal}`;
        }
        return {
          row_no: row.row_no,
          name_raw: row.name_raw,
          ...(row.admno ? { admno: row.admno } : {}),
          ...(row.value.kind === 'read' ? { value: Math.min(100, Math.max(0, row.value.value)) } : {}),
          component,
          ...(row.confidence != null ? { confidence: Math.min(1, Math.max(0, row.confidence)) } : {}),
          ...(flag ? { flag } : {}),
        };
      }),
      warnings: roster.length
        ? ['Names are matched after reading, so a close match is a suggestion only.']
        : ['No frozen class list is attached to this job; every line waits for a human.'],
    };

    const built = await buildRiverMarks(job, seen, document.rows, detail, page.buffer);
    context.staged_marks = built.marks;
    context.read_meta = {
      adapter: 'river_vision',
      model: config.model,
      sent_bytes: page.buffer.length,
      width: page.width,
      height: page.height,
      elapsed_ms: answer.elapsedMs,
      rows: seen.length,
      marks: built.marks.length,
      columns: built.columns,
      second_opinion: Boolean(secondOpinionConfig().enabled),
      name_second_pass: nameSecond?.ok
        ? {
          model: nameSecond.model,
          bands: nameSecond.bands,
          hinted: nameSecond.hinted,
          unsure: nameSecond.unsure,
          agreed: nameSecond.agreed,
          disputed: nameSecond.disputed,
          unread: nameSecond.unread,
          elapsed_ms: nameSecond.elapsedMs,
        }
        : { ok: false, reason: nameSecond?.reason || 'name_second_failed' },
    };

    validateStagedRows(document);
    return document;
  },
  async parseRoster(input, context) {
    const detail = await loadJobDetail(input, context);
    const job = detail?.job || {};
    const photo = await loadPhoto(input, context, detail);
    const config = riverConfig(context);
    const page = await prepareRiverPage(Buffer.from(photo.base64, 'base64'));
    const answer = await callRiver(config, riverRosterPrompt(job), 'image/jpeg', page.buffer.toString('base64'));
    const raw = riverJson(answer.text);
    const rows = riverRows(raw)
      .filter((row) => row.name_raw)
      .map((row) => ({
        row_no: row.row_no,
        name_raw: row.name_raw,
        ...(row.admno ? { admno: row.admno } : {}),
      }));
    if (!rows.length) throw codedError('OPS_READ_EMPTY', 'the page produced no roster lines');

    context.read_meta = {
      adapter: 'river_vision',
      model: config.model,
      sent_bytes: page.buffer.length,
      width: page.width,
      height: page.height,
      elapsed_ms: answer.elapsedMs,
      rows: rows.length,
      marks: 0,
    };
    const document = {
      schema_version: CONTRACT_VERSION,
      rows,
      warnings: ['Roster lines are staged for a human to confirm; this reader never adds a pupil by itself.'],
    };
    validateStagedRows(document);
    return document;
  },
};

const ADAPTERS = { manual, gemini_vision: geminiVision, river_vision: riverVision };

function adapterMethod(service, job) {
  // A page job that names a printed column is a marks page even when it was
  // opened from the names flow; the same read supplies the names and the marks.
  if (job?.column_label) return 'parseScores';
  if (service === 'roster') return 'parseRoster';
  if (service === 'scores') return 'parseScores';
  return 'interpret';
}

async function listAllProviders(opsRpc) {
  try {
    const payload = await opsRpc('ops_providers_list', {});
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    return providers.filter(Boolean);
  } catch (_) {
    // If the registry cannot be read, the manual provider is still the floor.
    return [{ label: manual.label, kind: 'manual', adapter: 'manual', priority: 1000, enabled: true, role: 'reader' }];
  }
}

async function listProviders(opsRpc) {
  const providers = await listAllProviders(opsRpc);
  return providers.filter((provider) => provider.enabled);
}

function getAdapter(id) {
  return ADAPTERS[id] || null;
}

// Runs the fallback chain: primary (if installed), then the next, then manual.
// Every outcome crosses the contract validator before it is returned.
async function dispatchJob(opsRpc, job, input) {
  const wantedRole = adapterMethod(job?.service, job) === 'interpret' ? 'assistant' : 'reader';
  const providers = (await listProviders(opsRpc)).filter((provider) => (provider.role || 'reader') === wantedRole);
  const ordered = providers.slice().sort((a, b) => (a.priority || 100) - (b.priority || 100));
  const method = adapterMethod(job?.service, job);
  const failures = [];

  for (const provider of ordered) {
    const adapter = ADAPTERS[provider.adapter];
    if (!adapter || typeof adapter[method] !== 'function') {
      failures.push({ adapter: provider.adapter, error: 'adapter not installed in this deployment' });
      continue;
    }

    try {
      const context = {
        job_id: job?.id || null,
        service: job?.service || null,
        class_key: job?.class_key || null,
        academic_session: job?.academic_session || null,
        term: job?.term || null,
        model: provider.model || null,
        opsRpc,
      };
      const outcome = method === 'interpret'
        ? await adapter.interpret(job?.instruction || '', context)
        : await adapter[method](input || {}, context);
      validateOutcome(outcome);
      return {
        ok: true,
        provider,
        adapter: adapter.id,
        outcome,
        parked: outcome.outcome === 'park',
        failures,
      };
    } catch (error) {
      failures.push({ adapter: provider.adapter, error: error.code || error.message || 'adapter failed' });
    }
  }

  const fallback = park('No provider in the chain succeeded; parked for a human.', { failures });
  return {
    ok: false,
    provider: null,
    adapter: 'manual',
    outcome: fallback,
    parked: true,
    failures,
  };
}

async function healthReport(opsRpc) {
  const providers = await listProviders(opsRpc);
  return Promise.all(providers.map(async (provider) => {
    const adapter = ADAPTERS[provider.adapter];
    if (!adapter) return { adapter: provider.adapter, label: provider.label, status: 'down', detail: 'adapter not installed' };
    try {
      const health = await adapter.health();
      return { adapter: provider.adapter, label: provider.label, ...health };
    } catch (error) {
      return { adapter: provider.adapter, label: provider.label, status: 'down', detail: error.message };
    }
  }));
}

module.exports = {
  adapterMethod,
  dispatchJob,
  getAdapter,
  healthReport,
  listAllProviders,
  listProviders,
  park,
};
