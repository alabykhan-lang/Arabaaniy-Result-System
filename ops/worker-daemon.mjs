#!/usr/bin/env node
'use strict';

// Continuous reader worker.
//
// One process claims a job, reads it through whichever enabled reader provider
// the adapter registry can actually run, stages the four-list alignment, then
// looks for the next job a few seconds later. A single lock means only one
// process can claim at a time, so a queued photo cannot be charged twice.
//
// Cron does not claim anything. It runs ops/worker-watchdog.mjs once a minute
// as a watchdog, which starts the supervisor again only when its process is
// gone. Every pass writes a heartbeat row so the page can ask whether a reader
// is actually alive instead of guessing from the clock.
//
// The reader key and the service-role key come from the environment only. No
// key, no claim: when the reader is not configured the job stays queued and
// the page keeps its honest "nothing is reading right now" state.
//
// Run:
//   SUPABASE_SERVICE_ROLE_KEY=... [RIVER_API_KEY=... RIVER_BASE_URL=... RIVER_READER_MODEL=...] node ops/worker-daemon.mjs
//   node ops/worker-daemon.mjs --once     one pass, for a test or a cron retry
//
// Optional:
//   WORKER_NAME                 default ops-daemon
//   OPS_WORKER_LOCK             default /var/lib/openbot/.local/state/ops-worker.lock
//   OPS_WORKER_LOG              default /var/lib/openbot/.local/state/ops-worker.log
//   OPS_WORKER_LEASE_SECONDS    default 300
//   OPS_WORKER_HEARTBEAT_MS     default 30000
//   OPS_WORKER_INTERVAL_MS      default 3000
//
// The log is one JSON line per claim, failure, or idle minute: timestamp, jobs
// claimed, result, duration. It never contains photo bytes, pupil names, or
// key material.

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CONTRACT_VERSION, validateOutcome } = require('../api/_ops-contract.js');
const { adapterMethod, getAdapter } = require('../api/_ops-adapters.js');
const { alignRows } = require('../api/_ops-align.js');

const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.FIRST_CHOICE_SUPABASE_URL
  || 'https://gnixdjglpsaarlrzqgdg.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.FIRST_CHOICE_SUPABASE_SERVICE_ROLE_KEY
  || '';
const WORKER = process.env.WORKER_NAME || 'ops-daemon';
const STATE_DIR = '/var/lib/openbot/.local/state';
const LOCK_PATH = process.env.OPS_WORKER_LOCK || path.join(STATE_DIR, 'ops-worker.lock');
const LOG_PATH = process.env.OPS_WORKER_LOG || path.join(STATE_DIR, 'ops-worker.log');
const LEASE_SECONDS = clampInt(process.env.OPS_WORKER_LEASE_SECONDS, 300, 30, 3600);
const HEARTBEAT_MS = clampInt(process.env.OPS_WORKER_HEARTBEAT_MS, 30000, 5000, 120000);
const INTERVAL_MS = clampInt(process.env.OPS_WORKER_INTERVAL_MS, 3000, 1000, 15000);
const STALE_LOCK_MS = 5 * 60 * 1000;
const ONCE = process.argv.includes('--once');
const MODE = ONCE ? 'once' : 'loop';

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  const code = String(error?.code || '').trim();
  if (/^[A-Z0-9_]{3,64}$/.test(code)) return code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  return 'ERROR';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function rpc(name, body) {
  if (!KEY) throw codedError('OPS_SERVICE_KEY_MISSING');
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (_) {
    throw codedError('OPS_NETWORK_ERROR');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw codedError(`OPS_RPC_HTTP_${response.status}`);
  return payload;
}

async function ensureStateDir() {
  await mkdir(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
}

// Atomic create. A lock whose process is gone, or one older than five minutes,
// is broken at once, so a killed reader cannot block the queue.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLock() {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
      }));
      await handle.close();
      return { ok: true, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(LOCK_PATH).catch(() => null);
      if (!info) continue;
      const raw = await readFile(LOCK_PATH, 'utf8').catch(() => '');
      let held = null;
      try { held = JSON.parse(raw); } catch (_) {}
      const age = Date.now() - info.mtimeMs;
      if (held?.pid && !pidAlive(held.pid)) {
        await unlink(LOCK_PATH).catch(() => {});
        continue;
      }
      if (age > STALE_LOCK_MS) {
        await unlink(LOCK_PATH).catch(() => {});
        continue;
      }
      return { ok: false, age_ms: Math.round(age), pid: held?.pid || null };
    }
  }
  return { ok: false, age_ms: null };
}

async function touchLock() {
  const now = new Date();
  await utimes(LOCK_PATH, now, now).catch(() => {});
}

// The page asks about this row, not about a timer. One upsert per pass and one
// every few seconds while a page is being read.
async function beat() {
  return rpc('ops_worker_beat', {
    p_worker: WORKER,
    p_pid: process.pid,
    p_mode: MODE,
  }).catch(() => null);
}

async function sweepDrafts() {
  return rpc('ops_sweep_drafts', { p_age_seconds: 600 }).catch(() => null);
}

async function releaseLock(token) {
  try {
    const raw = await readFile(LOCK_PATH, 'utf8');
    const held = JSON.parse(raw);
    if (held?.token === token) await unlink(LOCK_PATH);
  } catch (_) {
    // A missing or replaced lock is not ours to remove.
  }
}

async function writeLog(state, durationMs) {
  const line = {
    ts: new Date().toISOString(),
    claimed: state.claimed,
    result: state.result,
    duration_ms: Math.max(0, Math.round(durationMs)),
  };
  if (state.job) line.job = state.job;
  if (state.adapter) line.adapter = state.adapter;
  if (state.read) line.read = state.read;
  if (state.alignment) line.alignment = state.alignment;
  if (state.note) line.note = state.note;
  try {
    await ensureStateDir();
    await appendFile(LOG_PATH, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (_) {
    // The run must not crash because its log file is unwritable.
    console.error('ops-worker: could not write the run log');
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Pick the enabled reader whose adapter this plain process can actually run.
// Manual is a hand-off, not a reader. A vendor that has no installed adapter,
// no key, or a failed health check is skipped before any job is claimed.
async function selectReader(providers) {
  const readers = providers
    .filter((provider) => provider && provider.enabled && (provider.role || 'reader') === 'reader')
    .sort((a, b) => (a.priority || 1000) - (b.priority || 1000));

  const usable = [];
  const notes = [];

  for (const provider of readers) {
    if (provider.adapter === 'manual') {
      notes.push('manual_needs_human');
      continue;
    }
    const adapter = getAdapter(provider.adapter);
    if (!adapter) {
      notes.push(`${provider.adapter}_not_installed`);
      continue;
    }
    if (adapter.autonomous === false) {
      notes.push(`${provider.adapter}_needs_human`);
      continue;
    }
    let health;
    try {
      health = await adapter.health(provider);
    } catch (error) {
      health = { status: 'down', detail: safeCode(error) };
    }
    if (health?.status !== 'ok') {
      notes.push(`${provider.adapter}_${String(health?.status || 'down').replace(/[^a-z0-9]/gi, '_')}`);
      continue;
    }
    usable.push({ provider, adapter });
  }

  if (!usable.length) {
    for (const provider of providers) {
      if (!provider.enabled && (provider.role || 'reader') === 'reader') {
        notes.push(`${provider.adapter}_disabled`);
      }
    }
    return { usable, provider: null, note: notes.join(';') || 'no_enabled_reader' };
  }
  return { usable, provider: usable[0].provider, note: null };
}

function providerForJob(job, usable) {
  const wanted = String(job?.adapter || '');
  return (usable.find((entry) => entry.provider.adapter === wanted) || usable[0]).provider;
}

async function heartbeat(job, state) {
  const beat = await rpc('ops_heartbeat_job', {
    p_job_id: job.id,
    p_worker: WORKER,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (!beat) state.claim_lost = true;
}

async function event(job, action, detail) {
  const result = await rpc('ops_worker_event', {
    p_job_id: job.id,
    p_worker: WORKER,
    p_attempt: job.attempts,
    p_action: action,
    p_detail: detail || {},
  });
  if (result?.ok !== true) throw codedError(result?.code || 'OPS_EVENT_REFUSED');
}

async function readOne(state) {
  if (!KEY) {
    state.result = 'no_service_key';
    return;
  }

  // The provider registry changes by hand, so a short cache keeps the claim
  // loop from turning a 3-second interval into a stream of database reads.
  if (!readOne.registry || Date.now() - readOne.registry.at > 30000) {
    const payload = await rpc('ops_providers_list', {});
    readOne.registry = {
      at: Date.now(),
      providers: Array.isArray(payload?.providers) ? payload.providers : [],
    };
  }
  const providers = readOne.registry.providers;
  const selection = await selectReader(providers);
  if (!selection.provider) {
    state.result = 'no_reader';
    state.note = selection.note;
    return;
  }

  const job = await rpc('ops_claim_job', {
    p_worker: WORKER,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (!job) {
    state.result = 'idle';
    return;
  }

  state.claimed = 1;
  state.job = job.id;

  const provider = providerForJob(job, selection.usable);
  const adapter = getAdapter(provider.adapter);
  const method = adapterMethod(job.service, job);
  state.adapter = provider.adapter;

  let timer = null;
  try {
    if (!adapter || typeof adapter[method] !== 'function') throw codedError('OPS_ADAPTER_MISSING');
    await heartbeat(job, state);
    if (state.claim_lost) throw codedError('OPS_CLAIM_LOST');

    timer = setInterval(() => {
      heartbeat(job, state).catch(() => {
        state.claim_lost = true;
      });
    }, HEARTBEAT_MS);
    timer.unref?.();

    const detail = await rpc('ops_jobs_get', { p_id: job.id });
    const file = Array.isArray(detail?.files) ? detail.files[0] : null;
    if (!file?.id) throw codedError('OPS_FILE_MISSING');

    const payload = await rpc('ops_read_file', { p_file_id: file.id });
    if (!payload?.content_b64) throw codedError('OPS_FILE_MISSING');
    const buffer = Buffer.from(payload.content_b64, 'base64');
    const digest = sha256(buffer);
    if (file.sha256 && digest !== file.sha256) throw codedError('OPS_CHECKSUM_MISMATCH');

    await event(job, 'file_downloaded', {
      bytes: buffer.length,
      mime: payload.mime || file.mime,
      sha256: digest,
    });

    const context = {
      job_id: job.id,
      service: job.service,
      class_key: job.class_key || null,
      academic_session: job.academic_session || null,
      term: job.term || null,
      model: provider.model || null,
      opsRpc: rpc,
      job: detail.job || job,
      files: detail.files || [],
      roster: Array.isArray(detail.roster) ? detail.roster : [],
      staged_rows: Array.isArray(detail.staged_rows) ? detail.staged_rows : [],
      marks: Array.isArray(detail.marks) ? detail.marks : [],
    };
    const input = {
      job_id: job.id,
      file_id: file.id,
      filename: file.filename,
      mime: payload.mime || file.mime,
      byte_size: buffer.length,
      sha256: digest,
      content_b64: payload.content_b64,
    };

    const outcome = await adapter[method](input, context);
    const shape = validateOutcome(outcome);
    const readMeta = context.read_meta || null;
    const readModel = readMeta?.model || provider.model || null;

    if (readMeta) {
      // Bytes actually sent, dimensions and model live on the job's audit trail.
      // The page buffer itself is never written anywhere.
      const meta = { ...readMeta };
      delete meta.columns;
      await event(job, 'page_read', meta);
      state.read = {
        model: readMeta.model || null,
        sent_bytes: readMeta.sent_bytes || null,
        width: readMeta.width || null,
        height: readMeta.height || null,
        elapsed_ms: readMeta.elapsed_ms || null,
      };
    }

    if (shape === 'park') {
      const parked = await rpc('ops_park_job', {
        p_job_id: job.id,
        p_reason: outcome.reason || 'Parked for a human.',
        p_adapter: adapter.id,
        p_model: readModel,
        p_contract_version: CONTRACT_VERSION,
        p_response_hash: sha256(JSON.stringify(outcome)),
        p_worker: WORKER,
        p_attempt: job.attempts,
      });
      if (!parked) throw codedError('OPS_CLAIM_LOST');
      state.result = 'parked';
      return;
    }

    const finished = await rpc('ops_finish_job', {
      p_job_id: job.id,
      p_worker: WORKER,
      p_attempt: job.attempts,
      p_rows: outcome.rows,
      p_adapter: adapter.id,
      p_model: readModel,
      p_contract_version: CONTRACT_VERSION,
      p_response_hash: sha256(JSON.stringify(outcome)),
      p_reason: null,
    });
    if (finished?.ok !== true) throw codedError(finished?.code || 'OPS_FINISH_REFUSED');

    // Marks are staged after the rows exist, through the same service-role RPC
    // the agent path uses. An adapter that read no marks leaves this out.
    let markSummary = null;
    if (Array.isArray(context.staged_marks) && context.staged_marks.length) {
      const staged = await rpc('ops_stage_marks', {
        p_job_id: job.id,
        p_marks: context.staged_marks,
      });
      if (staged?.ok !== true) {
        state.result = `finished:${finished.status || 'ok'}:marks_failed:${staged?.code || 'OPS_MARKS_REFUSED'}`;
        return;
      }
      markSummary = staged.summary || null;
    }

    // One matcher for every reader. The adapter staged names as written; this
    // pass turns them into the same four lists the pilot was trained with and
    // stores them on the job, so a reload never loses the alignment.
    let alignment = null;
    try {
      const stagedRows = await rpc('ops_jobs_get', { p_id: job.id });
      const rows = Array.isArray(stagedRows?.staged_rows) ? stagedRows.staged_rows : [];
      const roster = Array.isArray(stagedRows?.roster) ? stagedRows.roster : [];
      if (rows.length) {
        const result = alignRows(rows, roster);
        const saved = await rpc('ops_stage_alignment', {
          p_job_id: job.id,
          p_rows: result.items,
          p_counts: result.counts,
          p_portal_only: result.portalOnly,
        });
        if (saved?.ok !== true) throw codedError(saved?.code || 'OPS_ALIGNMENT_REFUSED');
        alignment = saved.counts || result.counts;
      }
    } catch (error) {
      state.note = `alignment_failed:${safeCode(error)}`;
    }

    state.result = `finished:${finished.status || 'ok'}${markSummary ? ':marks_staged' : ''}${alignment ? ':aligned' : ''}`;
    if (alignment) state.alignment = alignment;
  } catch (error) {
    if (safeCode(error) === 'OPS_CLAIM_LOST') {
      state.result = 'claim_lost';
      return;
    }
    const failed = await rpc('ops_fail_job', {
      p_job_id: job.id,
      p_worker: WORKER,
      p_error: `daemon ${safeCode(error)}`,
    }).catch(() => null);
    state.result = failed
      ? `failed:${safeCode(error)}:${failed.status || 'unknown'}`
      : `failed:${safeCode(error)}:claim_lost`;
    if (failed?.status === 'needs_input') state.note = 'three_attempts_used';
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function main() {
  const started = Date.now();
  const state = { claimed: 0, result: 'error' };
  let lock = { ok: false };

  try {
    await ensureStateDir();
    lock = await acquireLock();
    if (!lock.ok) {
      state.result = 'locked';
      if (lock.age_ms != null) state.note = `lock_age_ms=${lock.age_ms}`;
      await writeLog(state, Date.now() - started);
      return;
    }

    await beat();

    if (ONCE) {
      await readOne(state);
      await writeLog(state, Date.now() - started);
      return;
    }

    // Keep the heartbeat fresh even while a page is being read for a minute.
    // The job lease has its own heartbeat; this one answers "is a reader alive".
    const beatTimer = setInterval(() => { beat().catch(() => {}); }, 15000);
    beatTimer.unref?.();

    await sweepDrafts();
    let lastIdleLog = 0;
    let lastSweep = Date.now();

    while (true) {
      const pass = { claimed: 0, result: 'idle' };
      const passStarted = Date.now();
      await touchLock();
      await beat();
      if (Date.now() - lastSweep >= 60000) {
        lastSweep = Date.now();
        await sweepDrafts();
      }
      try {
        await readOne(pass);
      } catch (error) {
        pass.result = `error:${safeCode(error)}`;
      }
      if (pass.claimed || pass.result !== 'idle' || Date.now() - lastIdleLog >= 60000) {
        lastIdleLog = Date.now();
        await writeLog(pass, Date.now() - passStarted);
      }
      await sleep(INTERVAL_MS);
    }
  } catch (error) {
    await writeLog({ ...state, result: `error:${safeCode(error)}` }, Date.now() - started);
  } finally {
    // One-shot runs release at once. A loop keeps the lock for its lifetime and
    // is cleaned up by the PID check if it is killed.
    if (ONCE && lock.ok) await releaseLock(lock.token);
  }
}

main()
  .then(() => {
    if (ONCE) process.exitCode = 0;
  })
  .catch(() => {
    if (ONCE) process.exitCode = 0;
  });
