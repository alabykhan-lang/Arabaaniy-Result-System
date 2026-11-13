'use strict';

// One pass of the record-book reader, written for a short-lived host.
//
// The continuous daemon in ops/worker-daemon.mjs does the same work behind a
// local file lock. This module is the hosted version: it claims one job with
// the database lease (ops_claim_job is atomic, so two hosts cannot read the
// same page twice), reads it, stages the marks and the four-list alignment,
// then returns. No local state, no key file, nothing on one machine.

const { createHash } = require('node:crypto');
const { CONTRACT_VERSION, validateOutcome } = require('./_ops-contract');
const { adapterMethod, getAdapter } = require('./_ops-adapters');
const { alignRows } = require('./_ops-align');

const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.SUPABASE_URL
  || 'https://gnixdjglpsaarlrzqgdg.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || '';

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
  if (!SERVICE_KEY) throw codedError('OPS_SERVICE_KEY_MISSING');
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
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

// Manual is a hand-off, not a reader. A vendor with no installed adapter, no
// key, or a failed health check is skipped before any job is claimed.
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
      if (!provider.enabled && (provider.role || 'reader') === 'reader') notes.push(`${provider.adapter}_disabled`);
    }
    return { usable, provider: null, note: notes.join(';') || 'no_enabled_reader' };
  }
  return { usable, provider: usable[0].provider, note: null };
}

function providerForJob(job, usable) {
  const wanted = String(job?.adapter || '');
  return (usable.find((entry) => entry.provider.adapter === wanted) || usable[0]).provider;
}

async function runOnePass(options = {}) {
  const worker = String(options.worker || 'ops-serverless').slice(0, 60);
  const leaseSeconds = Number(options.leaseSeconds) || 300;
  const heartbeatMs = Number(options.heartbeatMs) || 20000;
  const started = Date.now();
  const state = { worker, claimed: 0, result: 'idle', job: null, adapter: null };

  if (!SERVICE_KEY) {
    state.result = 'no_service_key';
    return state;
  }

  // The page asks about the heartbeat row, not a timer, so a hosted pass says
  // it is here before it does anything.
  await rpc('ops_worker_beat', { p_worker: worker, p_pid: 0, p_mode: 'once' }).catch(() => null);

  const listed = await rpc('ops_providers_list', {});
  const providers = Array.isArray(listed?.providers) ? listed.providers : [];
  const selection = await selectReader(providers);
  if (!selection.provider) {
    state.result = 'no_reader';
    state.note = selection.note;
    return state;
  }

  const job = await rpc('ops_claim_job', { p_worker: worker, p_lease_seconds: leaseSeconds });
  if (!job) {
    state.result = 'idle';
    return state;
  }

  state.claimed = 1;
  state.job = job.id;

  const provider = providerForJob(job, selection.usable);
  const adapter = getAdapter(provider.adapter);
  const method = adapterMethod(job.service, job);
  state.adapter = provider.adapter;

  const lost = { value: false };
  let timer = null;
  const beat = async () => {
    const ok = await rpc('ops_heartbeat_job', {
      p_job_id: job.id,
      p_worker: worker,
      p_lease_seconds: leaseSeconds,
    }).catch(() => null);
    if (!ok) lost.value = true;
  };
  const event = async (action, detail) => {
    const saved = await rpc('ops_worker_event', {
      p_job_id: job.id,
      p_worker: worker,
      p_attempt: job.attempts,
      p_action: action,
      p_detail: detail || {},
    });
    if (saved?.ok !== true) throw codedError(saved?.code || 'OPS_EVENT_REFUSED');
  };

  try {
    if (!adapter || typeof adapter[method] !== 'function') throw codedError('OPS_ADAPTER_MISSING');
    await beat();
    if (lost.value) throw codedError('OPS_CLAIM_LOST');

    timer = setInterval(() => { beat().catch(() => { lost.value = true; }); }, heartbeatMs);
    timer.unref?.();

    const detail = await rpc('ops_jobs_get', { p_id: job.id });
    const file = Array.isArray(detail?.files) ? detail.files[0] : null;
    if (!file?.id) throw codedError('OPS_FILE_MISSING');

    const payload = await rpc('ops_read_file', { p_file_id: file.id });
    if (!payload?.content_b64) throw codedError('OPS_FILE_MISSING');
    const buffer = Buffer.from(payload.content_b64, 'base64');
    const digest = sha256(buffer);
    if (file.sha256 && digest !== file.sha256) throw codedError('OPS_CHECKSUM_MISMATCH');

    await event('file_downloaded', { bytes: buffer.length, mime: payload.mime || file.mime, sha256: digest });

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
      const meta = { ...readMeta };
      delete meta.columns;
      await event('page_read', meta);
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
        p_worker: worker,
        p_attempt: job.attempts,
      });
      if (!parked) throw codedError('OPS_CLAIM_LOST');
      state.result = 'parked';
      return state;
    }

    const finished = await rpc('ops_finish_job', {
      p_job_id: job.id,
      p_worker: worker,
      p_attempt: job.attempts,
      p_rows: outcome.rows,
      p_adapter: adapter.id,
      p_model: readModel,
      p_contract_version: CONTRACT_VERSION,
      p_response_hash: sha256(JSON.stringify(outcome)),
      p_reason: null,
    });
    if (finished?.ok !== true) throw codedError(finished?.code || 'OPS_FINISH_REFUSED');

    let markSummary = null;
    if (Array.isArray(context.staged_marks) && context.staged_marks.length) {
      const staged = await rpc('ops_stage_marks', { p_job_id: job.id, p_marks: context.staged_marks });
      if (staged?.ok !== true) {
        state.result = `finished:${finished.status || 'ok'}:marks_failed:${staged?.code || 'OPS_MARKS_REFUSED'}`;
        return state;
      }
      markSummary = staged.summary || null;
    }

    let alignment = null;
    try {
      const after = await rpc('ops_jobs_get', { p_id: job.id });
      const rows = Array.isArray(after?.staged_rows) ? after.staged_rows : [];
      const roster = Array.isArray(after?.roster) ? after.roster : [];
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
    return state;
  } catch (error) {
    if (safeCode(error) === 'OPS_CLAIM_LOST') {
      state.result = 'claim_lost';
      return state;
    }
    const failed = await rpc('ops_fail_job', {
      p_job_id: job.id,
      p_worker: worker,
      p_error: `serverless ${safeCode(error)}`,
    }).catch(() => null);
    state.result = failed ? `failed:${safeCode(error)}:${failed.status || 'unknown'}` : `failed:${safeCode(error)}:claim_lost`;
    if (failed?.status === 'needs_input') state.note = 'three_attempts_used';
    return state;
  } finally {
    if (timer) clearInterval(timer);
    state.duration_ms = Date.now() - started;
    console.log('ops_worker_pass', JSON.stringify({
      worker,
      claimed: state.claimed,
      result: state.result,
      job: state.job,
      adapter: state.adapter,
      duration_ms: state.duration_ms,
      note: state.note || null,
    }));
  }
}

module.exports = { runOnePass };
