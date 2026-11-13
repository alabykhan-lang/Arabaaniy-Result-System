#!/usr/bin/env node
'use strict';

// OpenBot agent worker. No vendor SDK, no dependency beyond Node and the
// repository's contract module.
//
// The worker label is the actor on every audit row. The service-role key is
// read from the environment and is never printed, stored in a job, or written
// to a file.
//
// Usage (one job):
//   node ops/worker-openbot.mjs claim
//   node ops/worker-openbot.mjs download --job <uuid> [--out /tmp/page.jpg]
//   # the agent reads that file and writes a lines file: <no>\t<handwritten name>
//   node ops/worker-openbot.mjs match --job <uuid> --lines lines.tsv --out rows.json
//   node ops/worker-openbot.mjs finish --job <uuid> --attempt 1 --rows rows.json
//
// Extra steps:
//   heartbeat --job <uuid> --attempt 1
//   event --job <uuid> --attempt 1 --action read_complete [--detail '{"ms":1234}']
//   fail --job <uuid> --attempt 1 --error "reason"
//
// The read itself is the OpenBot agent looking at the downloaded page. That is
// the adapter. Everything after it is deterministic: match against the frozen
// class list, validate the 1.0.0 contract, then stage through ops_finish_job.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CONTRACT_VERSION, validateStagedRows } = require('../api/_ops-contract.js');
const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.FIRST_CHOICE_SUPABASE_URL
  || 'https://gnixdjglpsaarlrzqgdg.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.FIRST_CHOICE_SUPABASE_SERVICE_ROLE_KEY
  || '';
const WORKER = process.env.WORKER_NAME || 'openbot_agent';
const OUT_DIR = process.env.OPS_WORK_DIR || '/tmp/openbot-ops';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function rpc(name, body) {
  if (!KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || `RPC ${name} failed with HTTP ${response.status}`);
  }
  return payload;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function claim() {
  const lease = Number(arg('lease', '600'));
  const job = await rpc('ops_claim_job', { p_worker: WORKER, p_lease_seconds: lease });
  if (!job) {
    console.log(JSON.stringify({ ok: true, worker: WORKER, job: null }, null, 2));
    return;
  }
  console.log(JSON.stringify({ ok: true, worker: WORKER, job }, null, 2));
}

async function download() {
  const jobId = required('job');
  const attempt = Number(required('attempt'));
  const detail = await rpc('ops_jobs_get', { p_id: jobId });
  const job = detail?.job;
  const file = detail?.files?.[0];
  if (!job || !file) throw new Error('job or file not found');

  const payload = await rpc('ops_read_file', { p_file_id: file.id });
  if (!payload?.content_b64) throw new Error('file bytes not returned');
  const buffer = Buffer.from(payload.content_b64, 'base64');
  const digest = sha256(buffer);
  if (digest !== file.sha256) throw new Error('file checksum does not match the stored checksum');

  await mkdir(OUT_DIR, { recursive: true, mode: 0o700 });
  const ext = payload.mime === 'image/png' ? '.png' : payload.mime === 'image/webp' ? '.webp' : '.jpg';
  const out = path.resolve(arg('out', path.join(OUT_DIR, `${jobId}${ext}`)));
  await writeFile(out, buffer, { mode: 0o600 });

  const event = await rpc('ops_worker_event', {
    p_job_id: jobId,
    p_worker: WORKER,
    p_attempt: attempt,
    p_action: 'file_downloaded',
    p_detail: { bytes: buffer.length, mime: payload.mime, sha256: digest },
  });
  if (event?.ok !== true) throw new Error(event?.code || 'download audit was refused');

  console.log(JSON.stringify({
    ok: true,
    job_id: jobId,
    attempt,
    file: out,
    bytes: buffer.length,
    mime: payload.mime,
    sha256: digest,
  }, null, 2));
}

async function heartbeat() {
  const jobId = required('job');
  const attempt = Number(required('attempt'));
  const beat = await rpc('ops_heartbeat_job', {
    p_job_id: jobId,
    p_worker: WORKER,
    p_lease_seconds: Number(arg('lease', '600')),
  });
  if (!beat) throw new Error('OPS_CLAIM_LOST');
  console.log(JSON.stringify({ ok: true, lease_until: beat.lease_until, attempt }, null, 2));
}

async function event() {
  const jobId = required('job');
  const attempt = Number(required('attempt'));
  const action = required('action');
  let detail = {};
  const raw = arg('detail');
  if (raw) detail = JSON.parse(raw);
  const result = await rpc('ops_worker_event', {
    p_job_id: jobId,
    p_worker: WORKER,
    p_attempt: attempt,
    p_action: action,
    p_detail: detail,
  });
  if (result?.ok !== true) throw new Error(result?.code || 'event refused');
  console.log(JSON.stringify({ ok: true, action, attempt }, null, 2));
}

async function fail() {
  const jobId = required('job');
  const attempt = Number(required('attempt'));
  const job = await rpc('ops_fail_job', {
    p_job_id: jobId,
    p_worker: WORKER,
    p_error: arg('error', 'worker failed'),
  });
  if (!job) throw new Error('OPS_CLAIM_LOST');
  console.log(JSON.stringify({ ok: true, status: job.status, attempt }, null, 2));
}

// ---------------------------------------------------------------------------
// Name matching lives in api/_ops-match.js so the CLI worker and any adapter
// use exactly the same deterministic rules. It never guesses: an exact or
// normalised name yields an admission number; a single close candidate yields
// a candidate only; everything else is flagged.
// ---------------------------------------------------------------------------
const { matchLines } = require('../api/_ops-match.js');

function loadLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const tab = line.indexOf('\t');
    if (tab === -1) return { no: null, raw: line.trim() };
    const no = Number(line.slice(0, tab));
    return { no: Number.isFinite(no) ? no : null, raw: line.slice(tab + 1).trim() };
  });
}

async function match() {
  const jobId = required('job');
  const linesFile = required('lines');
  const out = path.resolve(required('out'));
  const subjectKey = arg('subject', '');
  const subjectLabel = arg('label', '');
  const component = arg('component', 'ca1');

  const detail = await rpc('ops_jobs_get', { p_id: jobId });
  const pupils = Array.isArray(detail?.roster) ? detail.roster : [];
  if (!pupils.length) throw new Error('this job has no frozen class list');
  const jobClass = detail?.job?.class_key || '';
  const chosenSubject = subjectKey || (jobClass ? `${jobClass}:writing` : '');

  const document = matchLines(loadLines(await readFile(linesFile, 'utf8')), pupils, {
    subjectKey: chosenSubject,
    subjectLabel,
    component,
  });
  const rows = document.rows;
  validateStagedRows(document);
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });

  const summary = {
    ok: true,
    job_id: jobId,
    lines: rows.length,
    accepted: rows.filter((row) => row.admno).length,
    need_eye: rows.filter((row) => !row.admno).length,
    snapshot: pupils.length,
    out,
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function finish() {
  const jobId = required('job');
  const attempt = Number(required('attempt'));
  const rowsFile = required('rows');
  const document = JSON.parse(await readFile(rowsFile, 'utf8'));
  validateStagedRows(document);

  const result = await rpc('ops_finish_job', {
    p_job_id: jobId,
    p_worker: WORKER,
    p_attempt: attempt,
    p_rows: document.rows,
    p_adapter: 'openbot_agent',
    p_model: null,
    p_contract_version: CONTRACT_VERSION,
    p_response_hash: sha256(JSON.stringify(document)),
    p_reason: arg('reason'),
  });
  if (result?.ok !== true) throw new Error(result?.code || 'finish was refused');
  console.log(JSON.stringify({ ok: true, worker: WORKER, ...result }, null, 2));
}

// ---------------------------------------------------------------------------
// Four-list alignment. People, not strings: token sets are order-insensitive,
// the surname is compared first, and a first name may only be forgiven after
// the surname matches. A = exact, B = suggested (never accepted), C = on the
// sheet but not in the portal, D = in the portal but not on the sheet.
// ---------------------------------------------------------------------------
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

function editSimilarity(a, b) {
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

function surnameMatches(a, b) {
  if (!a || !b) return false;
  return a === b
    || keyToken(a) === keyToken(b)
    || editSimilarity(a, b) >= 0.72
    || editSimilarity(keyToken(a), keyToken(b)) >= 0.70;
}

function firstCloseness(given, pupilGiven) {
  if (!given.length && !pupilGiven.length) return 1;
  if (!given.length || !pupilGiven.length) return 0;
  const scores = given.map((token) => Math.max(...pupilGiven.map((other) => editSimilarity(keyToken(token), keyToken(other)))));
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function splitHandwritten(raw) {
  const text = String(raw || '');
  const dash = text.indexOf('-');
  if (dash !== -1) {
    return { surname: tokens(text.slice(0, dash)), given: tokens(text.slice(dash + 1)), dashed: true };
  }
  const all = tokens(text);
  return { surname: all.slice(0, 1), given: all.slice(1), dashed: false };
}

function scoreNamePair(raw, pupilName) {
  const sheet = splitHandwritten(raw);
  const pupil = tokens(pupilName);
  let best = null;
  for (let i = 0; i < pupil.length; i += 1) {
    const surnameToken = pupil[i];
    const given = pupil.filter((_, j) => j !== i);
    if (!surnameMatches(sheet.surname.join(' '), surnameToken)) continue;
    const first = firstCloseness(sheet.given, given);
    const surnameScore = editSimilarity(sheet.surname.join(' '), surnameToken);
    const total = 0.65 * surnameScore + 0.35 * first;
    if (!best || total > best.total) best = { total, surname: surnameScore, first };
  }
  return best;
}

async function align() {
  const jobId = required('job');
  const out = path.resolve(arg('out', path.join(OUT_DIR, `${jobId}-alignment.json`)));
  const detail = await rpc('ops_jobs_get', { p_id: jobId });
  const rows = Array.isArray(detail?.staged_rows) ? detail.staged_rows : [];
  const roster = Array.isArray(detail?.roster) ? detail.roster : [];
  if (!rows.length) throw new Error('this job has no staged rows');
  if (!roster.length) throw new Error('this job has no frozen class list');

  const used = new Set();
  const state = new Map();
  const items = [];
  const lists = { A: [], B: [], C: [] };

  // A: full name identical after removing the dash and case.
  for (const row of rows) {
    const sheet = tokens(row.student_name_raw);
    const hit = roster.find((pupil) => !used.has(pupil.id) && tokens(pupil.name).join(' ') === sheet.join(' '));
    if (!hit) continue;
    used.add(hit.id);
    state.set(row.id, 'A');
    items.push({
      staged_row_id: row.id, match_list: 'A', student_id: hit.id,
      surname_score: 1, first_score: 1, candidate_names: [hit.name], confidence: 1,
    });
    lists.A.push({ row_no: row.row_no, raw: row.student_name_raw, pupil: hit.name, admno: hit.admno });
  }

  // B: same surname, first name close. Scored before any line is accepted.
  const candidates = [];
  for (const row of rows) {
    if (state.has(row.id)) continue;
    const found = [];
    for (const pupil of roster) {
      if (used.has(pupil.id)) continue;
      const score = scoreNamePair(row.student_name_raw, pupil.name);
      if (!score || score.total < 0.65 || score.first < 0.55) continue;
      found.push({ ...score, pupil });
    }
    found.sort((a, b) => b.total - a.total);
    candidates.push({ row, found });
  }

  const flat = [];
  for (const { row, found } of candidates) {
    for (const candidate of found) flat.push({ row, ...candidate });
  }
  flat.sort((a, b) => b.total - a.total);

  const assigned = new Map();
  const tiedPupils = new Set();
  for (const candidate of flat) {
    const rowId = candidate.row.id;
    if (assigned.has(rowId) || used.has(candidate.pupil.id)) continue;
    const found = candidates.find((entry) => entry.row.id === rowId).found;
    const ties = found.filter((entry) => entry.pupil.id !== candidate.pupil.id
      && !used.has(entry.pupil.id)
      && Math.abs(entry.total - candidate.total) <= 0.02);
    if (ties.length) {
      const names = [candidate.pupil.name, ...ties.map((entry) => entry.pupil.name)];
      names.forEach((_, index) => tiedPupils.add([candidate.pupil, ...ties.map((entry) => entry.pupil)][index].id));
      assigned.set(rowId, { tied: true, names, ...candidate });
    } else {
      assigned.set(rowId, { tied: false, ...candidate });
      used.add(candidate.pupil.id);
    }
  }

  for (const row of rows) {
    if (state.has(row.id)) continue;
    const hit = assigned.get(row.id);
    if (!hit) {
      state.set(row.id, 'C');
      items.push({
        staged_row_id: row.id, match_list: 'C', candidate_names: [], confidence: null,
      });
      lists.C.push({ row_no: row.row_no, raw: row.student_name_raw });
      continue;
    }
    state.set(row.id, 'B');
    items.push({
      staged_row_id: row.id,
      match_list: 'B',
      candidate_admno: hit.tied ? null : hit.pupil.admno,
      candidate_names: hit.tied ? hit.names : [hit.pupil.name],
      surname_score: Number(hit.surname.toFixed(3)),
      first_score: Number(hit.first.toFixed(3)),
      confidence: Number(hit.total.toFixed(3)),
      flag: 'near_match',
    });
    lists.B.push({
      row_no: row.row_no,
      raw: row.student_name_raw,
      pupil: hit.tied ? null : hit.pupil.name,
      candidates: hit.tied ? hit.names : [hit.pupil.name],
      surname_score: Number(hit.surname.toFixed(3)),
      first_score: Number(hit.first.toFixed(3)),
      score: Number(hit.total.toFixed(3)),
    });
  }

  const portalOnly = roster
    .filter((pupil) => !used.has(pupil.id) && !tiedPupils.has(pupil.id))
    .map((pupil) => ({ id: pupil.id, name: pupil.name, admno: pupil.admno }));
  lists.D = portalOnly;

  const counts = {
    A: lists.A.length,
    B: lists.B.length,
    C: lists.C.length,
    D: portalOnly.length,
    pending: lists.B.length + lists.C.length,
  };

  const saved = await rpc('ops_stage_alignment', {
    p_job_id: jobId,
    p_rows: items,
    p_counts: counts,
    p_portal_only: portalOnly,
  });
  if (saved?.ok !== true) throw new Error(saved?.code || 'alignment was refused');

  await writeFile(out, `${JSON.stringify({ counts, lists }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, job_id: jobId, counts, out }, null, 2));
}

const command = process.argv[2];
const commands = { claim, download, heartbeat, event, fail, match, finish, align };

if (!commands[command]) {
  console.error('Commands: claim | download | heartbeat | event | fail | match | finish');
  process.exit(2);
}

commands[command]().catch((error) => {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exit(1);
});
