'use strict';

// Single private API for the pilot: jobs, intake photo, file read, review.
// Developer role only; nothing here writes public.students or public.scores.
//
// GET  /api/ops-jobs                 list jobs
// GET  /api/ops-jobs?id=<uuid>       one job with files, rows, decisions, audit
// GET  /api/ops-jobs?file=<uuid>     one stored photo (binary)
// GET  /api/ops-jobs?document=<uuid> one generated document (binary download)
// GET  /api/ops-jobs?documents=1     recent documents for this school (json)
// POST /api/ops-jobs                 { action: 'create' }          create a job
// POST /api/ops-jobs                 { action: 'upload', ... }     attach one photo
// POST /api/ops-jobs                 { action: 'worker_pass' }      read one waiting page (hosted reader)
// POST /api/ops-jobs                 { action: 'decide', ... }     accept/reject a staged row
// POST /api/ops-jobs                 { action: 'attach', ... }     attach one pupil to a C row
// POST /api/ops-jobs                 { action: 'confirm', ... }    confirm gate (ops only)
// POST /api/ops-jobs                 { action: 'text', text }      parse and stage a typed instruction
// POST /api/ops-jobs                 { action: 'parse', text }     parse only, no write
// POST /api/ops-jobs                 { action: 'decide_mark', ... } resolve one ambiguous mark cell
// POST /api/ops-jobs                 { action: 'set_mark', ... }     create or correct one mark cell
// POST /api/ops-jobs                 { action: 'mapping', job_id }   the four map lists, no model call
// POST /api/ops-jobs                 { action: 'documents_readiness', job_id }
// POST /api/ops-jobs                 { action: 'generate_documents', job_id }
// POST /api/ops-jobs                 { action: 'copy_accepted', job_id }
// POST /api/ops-jobs                 { action: 'delete_job', job_id }

const crypto = require('node:crypto');
const sharp = require('sharp');
const { readJsonBody, sendJson } = require('./_lib');
const { deny, opsConfigured, opsRpc, requireDeveloper } = require('./_ops');
const { dispatchJob } = require('./_ops-adapters');
const { CONTRACT_VERSION } = require('./_ops-contract');
const { parseInstruction } = require('./_ops-instruction');
const { renderDocuments } = require('./_ops-documents');
const { handleAgentChat, buildJobDigest, buildMapping, testModelRoute, testVisionRoute } = require('./_ops-agent');

const SERVICES = new Set(['roster', 'scores', 'documents']);
const DECISIONS = new Set(['approve', 'reject', 'hold', 'edit']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);
const MAX_BYTES = 3500000;
// The raw browser file is deliberately allowed above the stored limit: the
// server turns it upright and shrinks it, then applies MAX_BYTES to the result.
// 4.2 MB leaves room under the platform's roughly 4.5 MB request body limit.
const MAX_RAW_BYTES = 4200000;
const MAX_BASE64 = Math.ceil(MAX_RAW_BYTES * 4 / 3) + 4;

// One calm sentence, used only when a new job would start with no credits
// left. Jobs already open are never stopped by this check.
const NO_CREDITS_TEXT = 'There are no credits left on the pilot plan this period, so I cannot start a new job; '
  + 'the jobs already open will still finish, and Thiago can top up the plan to start another.';

// A new job costs credits; attaching to a job already open does not. The
// balance is read from ops, never from a cached number in the page.
async function creditGate(res, schoolId = null, ctx = null) {
  // The developer account is not school staff and pays nothing, so a missing
  // plan or an empty balance never stops the developer from starting a job.
  if (isDeveloper(ctx)) return { ok: true, developer: true, remaining: null };
  if (!schoolId) {
    sendJson(res, 409, {
      ok: false,
      code: 'OPS_SCHOOL_REQUIRED',
      message: 'This account is not attached to a school, so I cannot start a new job. No credits were taken.',
      balance: null,
      live_write: false,
    });
    return null;
  }

  const balance = await opsRpc('ops_credit_balance', { p_school_id: schoolId });
  if (balance && balance.ok === true && Number(balance.remaining) > 0) return balance;

  const noPlan = !balance || balance.code === 'OPS_NO_PLAN';
  const payload = {
    ok: false,
    code: noPlan ? 'OPS_NO_PLAN' : 'OPS_NO_CREDITS',
    message: noPlan
      ? 'No plan is set for this school yet, so I cannot start a new job; Thiago can set the plan and then this will work.'
      : NO_CREDITS_TEXT,
    balance: balance || null,
    live_write: false,
  };
  sendJson(res, 409, payload);
  return null;
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function looksLikeImage(buffer, mime) {
  if (buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (mime === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function looksLikeHeic(buffer) {
  if (buffer.length < 12) return false;
  const brand = buffer.slice(4, 12).toString('ascii');
  return brand.startsWith('ftyp') && /heic|heix|hevc|hevx|mif1|msf1/i.test(brand);
}

function sniffImageMime(buffer, declared, filename) {
  if (looksLikeImage(buffer, 'image/jpeg')) return 'image/jpeg';
  if (looksLikeImage(buffer, 'image/png')) return 'image/png';
  if (looksLikeImage(buffer, 'image/webp')) return 'image/webp';
  if (looksLikeHeic(buffer) || /hei[cf]/i.test(declared) || /\.(heic|heif)$/i.test(filename)) return 'image/heic';
  return IMAGE_TYPES.has(declared) ? declared : '';
}

async function readRawBody(req, limit) {
  if (Buffer.isBuffer(req.body) || req.body instanceof Uint8Array) {
    const held = Buffer.from(req.body);
    if (held.length > limit) {
      const error = new Error('request body is too large');
      error.code = 'BODY_TOO_LARGE';
      error.bytes = held.length;
      throw error;
    }
    return held;
  }
  if (typeof req.body === 'string' && req.body.length) {
    const held = Buffer.from(req.body, 'binary');
    if (held.length > limit) {
      const error = new Error('request body is too large');
      error.code = 'BODY_TOO_LARGE';
      error.bytes = held.length;
      throw error;
    }
    return held;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > limit) {
      const error = new Error('request body is too large');
      error.code = 'BODY_TOO_LARGE';
      error.bytes = total;
      throw error;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

// Turn the phone's original bytes upright and down to a predictable size.
// Sharp reads the EXIF orientation itself, so a sideways camera file becomes
// the same page a person sees. The client never has to decode the photo.
async function normalisePhoto(buffer) {
  const attempts = [
    { side: 1800, quality: 85 },
    { side: 1800, quality: 75 },
    { side: 1400, quality: 80 },
    { side: 1200, quality: 75 },
  ];
  let last = null;
  for (const attempt of attempts) {
    const out = await sharp(buffer, { failOn: 'error', limitInputPixels: 100000000 })
      .rotate()
      .resize({ width: attempt.side, height: attempt.side, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    last = out;
    if (out.data.length <= MAX_BYTES) {
      return {
        buffer: out.data,
        mime: 'image/jpeg',
        width: out.info.width,
        height: out.info.height,
        quality: attempt.quality,
      };
    }
  }
  const error = new Error(`stored copy is still ${last?.data?.length || 0} bytes`);
  error.code = 'OPS_FILE_TOO_LARGE';
  throw error;
}

function uploadDiagnostic(step, error, extra = {}) {
  return {
    step,
    error: String(error && (error.message || error) || '').slice(0, 1000),
    at: new Date().toISOString(),
    ...extra,
  };
}

async function serveFile(req, res, ctx, fileId) {
  if (!UUID_RE.test(fileId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_FILE_ID_INVALID' });
  }
  const payload = await opsRpc('ops_read_file', { p_file_id: fileId });
  if (!payload || payload.ok !== true || !payload.content_b64) {
    return sendJson(res, 404, { ok: false, code: 'OPS_FILE_NOT_FOUND' });
  }
  const buffer = Buffer.from(payload.content_b64, 'base64');
  const mime = SAFE_TYPES.has(payload.mime) ? payload.mime : 'application/octet-stream';
  const disposition = mime === 'application/pdf' ? 'attachment' : 'inline';
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(payload.filename || 'photo')}"`);
  if (mime === 'application/pdf') {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
}

async function serveDocument(req, res, ctx, documentId) {
  if (documentId !== 'latest' && !UUID_RE.test(documentId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_DOCUMENT_ID_INVALID' });
  }
  const payload = documentId === 'latest'
    ? await opsRpc('school_latest_document', { p_school_id: ctx.actor.school_id }).catch(() => null)
    : await opsRpc('school_get_document_for_school', {
      p_id: documentId,
      p_school_id: ctx.actor.school_id,
    }).catch(() => null);
  if (!payload || payload.ok !== true || !payload.content_b64) {
    return sendJson(res, 404, { ok: false, code: 'OPS_DOCUMENT_NOT_FOUND', message: 'That document is no longer available. Make it again.' });
  }
  const buffer = Buffer.from(payload.content_b64, 'base64');
  const mime = payload.mime === 'application/pdf' ? 'application/pdf' : 'application/octet-stream';
  const safeName = String(payload.filename || 'document.pdf')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim() || 'document.pdf';
  const asciiName = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', buffer.length);
  // A plain ASCII name first, because some Android download managers ignore
  // the extended form and fall back to ".bin" without it.
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(payload.filename || asciiName)}`);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
}

function failUpload(res, status, payload, diagnostic) {
  if (diagnostic) {
    try { console.error('ops_upload_failed', JSON.stringify(diagnostic)); } catch {}
  }
  return sendJson(res, status, diagnostic ? { ...payload, diagnostic } : payload);
}

async function uploadPhoto(req, res, ctx, body, rawBuffer = null) {
  const jobId = clean(body.job_id, 40);
  if (!UUID_RE.test(jobId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
  }

  const declaredMime = clean(body.mime, 60).toLowerCase() || 'application/octet-stream';
  const filenameIn = clean(body.filename, 200);

  let buffer = rawBuffer;
  if (!buffer) {
    const base64 = typeof body.data_base64 === 'string' ? body.data_base64.replace(/\s+/g, '') : '';
    if (!base64) {
      return failUpload(res, 400, { ok: false, code: 'OPS_FILE_EMPTY' },
        uploadDiagnostic('receive', 'no photo bytes', { client_step: clean(body.client_step, 80) || null, client_error: clean(body.client_error, 500) || null }));
    }
    if (base64.length > MAX_BASE64) {
      return failUpload(res, 413, { ok: false, code: 'OPS_FILE_TOO_LARGE', limit: MAX_BYTES },
        uploadDiagnostic('receive', 'base64 request is too large', { encoded_length: base64.length }));
    }
    buffer = Buffer.from(base64, 'base64');
  }

  if (!buffer || !buffer.length) {
    return failUpload(res, 400, { ok: false, code: 'OPS_FILE_EMPTY' },
      uploadDiagnostic('receive', 'empty photo body', { client_step: clean(body.client_step, 80) || null, client_error: clean(body.client_error, 500) || null }));
  }
  if (buffer.length > MAX_RAW_BYTES) {
    return failUpload(res, 413, { ok: false, code: 'OPS_FILE_TOO_LARGE', limit: MAX_BYTES },
      uploadDiagnostic('receive', `original photo is ${buffer.length} bytes`, { bytes: buffer.length }));
  }

  const mime = sniffImageMime(buffer, declaredMime, filenameIn);
  if (mime === 'image/heic') {
    return failUpload(res, 400, {
      ok: false,
      code: 'HEIC_PHOTO',
      message: 'That photo is a format the browser cannot open. Send it as JPEG from your gallery.',
    }, uploadDiagnostic('format', 'HEIC/HEIF photo', { bytes: buffer.length, declared_mime: declaredMime }));
  }
  if (!IMAGE_TYPES.has(mime) || !looksLikeImage(buffer, mime)) {
    return failUpload(res, 400, {
      ok: false,
      code: 'OPS_FILE_NOT_IMAGE',
      message: 'The bytes do not look like a JPEG, PNG or WebP photo.',
    }, uploadDiagnostic('decode', 'photo bytes are not a supported image', {
      bytes: buffer.length, declared_mime: declaredMime, filename: filenameIn,
      client_step: clean(body.client_step, 80) || null, client_error: clean(body.client_error, 500) || null,
    }));
  }

  let prepared;
  let source = null;
  try {
    source = await sharp(buffer, { failOn: 'error', limitInputPixels: 100000000 }).metadata();
    prepared = await normalisePhoto(buffer);
  } catch (error) {
    const tooLarge = error && error.code === 'OPS_FILE_TOO_LARGE';
    return failUpload(res, tooLarge ? 413 : 400, {
      ok: false,
      code: tooLarge ? 'OPS_FILE_TOO_LARGE' : 'OPS_FILE_NOT_IMAGE',
      limit: tooLarge ? MAX_BYTES : undefined,
      message: tooLarge
        ? 'The photo could not be made small enough to store.'
        : 'The photo could not be read on the server.',
    }, uploadDiagnostic(tooLarge ? 'resize' : 'decode', error, {
      bytes: buffer.length,
      mime,
      source_width: source?.width || null,
      source_height: source?.height || null,
      orientation: source?.orientation || null,
    }));
  }

  const base = filenameIn.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 180) || `photo-${Date.now()}`;
  const filename = `${base}.jpg`;
  const sha256 = crypto.createHash('sha256').update(prepared.buffer).digest('hex');

  const uploaded = await opsRpc('ops_upload_file', {
    p_job_id: jobId,
    p_filename: filename,
    p_mime: prepared.mime,
    p_content_b64: prepared.buffer.toString('base64'),
    p_sha256: sha256,
    p_uploaded_by: ctx.actor.id,
    p_uploaded_by_email: ctx.actor.email,
    p_max_bytes: MAX_BYTES,
  });

  if (!uploaded || uploaded.ok !== true) {
    return failUpload(res, 400, uploaded || { ok: false, code: 'OPS_UPLOAD_FAILED' },
      uploadDiagnostic('store', uploaded?.message || 'ops_upload_file refused the photo', {
        bytes: prepared.buffer.length,
        mime: prepared.mime,
        sha256,
        client_step: clean(body.client_step, 80) || null,
        client_error: clean(body.client_error, 500) || null,
      }));
  }

  // The reader role, lowest priority first, takes the job from here. The job
  // records the reader's adapter and model before the worker runs, so a change
  // of reader row is visible on the job with no code change.
  const queued = await opsRpc('ops_queue_reader', { p_job_id: jobId });

  const stored = {
    bytes: prepared.buffer.length,
    width: prepared.width,
    height: prepared.height,
    mime: prepared.mime,
    quality: prepared.quality,
    source_bytes: buffer.length,
    source_width: source?.width || null,
    source_height: source?.height || null,
    orientation: source?.orientation || null,
  };

  // The page can read these even when a proxy hides the JSON body.
  res.setHeader('X-Ops-Source-Bytes', String(stored.source_bytes));
  res.setHeader('X-Ops-Stored-Bytes', String(stored.bytes));
  res.setHeader('X-Ops-Stored-Width', String(stored.width));
  res.setHeader('X-Ops-Stored-Height', String(stored.height));

  if (queued && queued.ok === true) {
    return sendJson(res, 201, {
      ok: true,
      file: uploaded.file,
      job: queued.job || uploaded.job,
      stored,
      dispatch: {
        adapter: queued.provider?.adapter || null,
        provider: queued.provider?.label || null,
        model: queued.provider?.model || null,
        contract_version: CONTRACT_VERSION,
        queued: true,
        parked: false,
        reason: null,
        failures: [],
      },
    });
  }

  // No worker is enabled, so the chain lands on Manual, which parks the job
  // for a person. This is the fallback the provider table exists for.
  const dispatch = await dispatchJob(opsRpc, uploaded.job || {}, {
    job_id: jobId,
    filename,
    mime: prepared.mime,
    byte_size: prepared.buffer.length,
    sha256,
  });
  const responseHash = crypto.createHash('sha256').update(JSON.stringify(dispatch.outcome)).digest('hex');

  const parked = await opsRpc('ops_park_job', {
    p_job_id: jobId,
    p_reason: dispatch.outcome.reason || 'Parked for a human.',
    p_adapter: dispatch.adapter || 'manual',
    p_model: dispatch.provider?.model || null,
    p_contract_version: CONTRACT_VERSION,
    p_response_hash: responseHash,
  });

  return sendJson(res, 201, {
    ok: true,
    file: uploaded.file,
    job: parked || uploaded.job,
    stored,
    dispatch: {
      adapter: dispatch.adapter,
      provider: dispatch.provider?.label || null,
      contract_version: CONTRACT_VERSION,
      parked: dispatch.parked,
      reason: dispatch.outcome.reason || null,
      failures: dispatch.failures || [],
    },
  });
}

function jobAgeHours(job) {
  const created = new Date(job?.created_at || 0).getTime();
  if (!Number.isFinite(created) || !created) return Infinity;
  return (Date.now() - created) / 3600000;
}

function latestOpenJob(jobs) {
  const open = new Set(['draft', 'queued', 'processing', 'needs_review']);
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => jobAgeHours(job) <= 24)
    .filter((job) => {
      if (open.has(job.status)) return true;
      // A page the reader stopped before saving a single row cannot be
      // continued by a later sentence: there is nothing on it to add to. A
      // fresh sentence starts a clean page instead of a conflict card.
      if (job.status === 'needs_input') return (job?.counts?.read || 0) > 0;
      return false;
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

function classLabel(context, key) {
  const found = (Array.isArray(context?.classes) ? context.classes : []).find((item) => item.key === key);
  return found?.label || key || 'this class';
}

// A sentence about "this" is parsed against the open job's frozen context, not
// the portal's current class. An explicit class in the sentence still wins.
function contextForJob(context, job) {
  if (!job) return context || {};
  const subject = Array.isArray(job.subject_set) ? job.subject_set[0] : null;
  return {
    ...(context || {}),
    class_key: job.class_key || context?.class_key,
    class_label: classLabel(context, job.class_key),
    academic_session: job.academic_session || context?.academic_session,
    term: job.term || context?.term,
    subject_key: subject?.key || context?.subject_key,
    subject_label: subject?.label || context?.subject_label,
  };
}

function conflictMessage(context, inForce, asked, rows) {
  const have = [
    classLabel(context, inForce?.class_key),
    inForce?.subject,
    inForce?.term,
    inForce?.column_label,
  ].filter(Boolean).join(' · ');
  const want = [
    asked?.class_key ? classLabel(context, asked.class_key) : null,
    asked?.subject,
    asked?.term,
    asked?.column_label,
  ].filter(Boolean).join(' · ');
  const effect = Number(rows) > 0
    ? 'now would only half-switch a page that already has rows.'
    : 'now would make one job carry two instructions.';
  return `${have || 'This job'} is in force: the class, subject, term and column were fixed when the job started. `
    + `Changing it to ${want || 'that'} ${effect} `
    + 'I can start a new job for that instead.';
}

// A correction is not a new job. It edits the job the person already has, and
// it never charges: credit is taken once, when a finished page is approved.
// Once rows exist only the subject can move in place; anything else comes back
// as a conflict for the page to ask "Keep what I have" or "Start again".
async function handleCorrect(req, res, ctx, body) {
  const jobId = clean(body.job_id, 40);
  if (!UUID_RE.test(jobId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
  }
  const raw = clean(body.text || body.instruction, 4000);
  if (!raw) {
    return sendJson(res, 400, { ok: false, code: 'OPS_TEXT_EMPTY' });
  }

  const listed = await opsRpc('ops_jobs_list', {});
  const jobs = Array.isArray(listed?.jobs) ? listed.jobs : [];
  const job = jobs.find((item) => item.id === jobId) || null;
  if (!job) {
    return sendJson(res, 404, { ok: false, code: 'OPS_JOB_NOT_FOUND' });
  }

  const context = await opsRpc('ops_active_context', {});
  const parsed = parseInstruction(raw, contextForJob(context || {}, job));
  const saved = await opsRpc('ops_correct_job', {
    p_job_id: jobId,
    p_parsed: parsed,
    p_raw: raw,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  });

  if (saved?.conflict) {
    return sendJson(res, 409, {
      ...saved,
      ok: false,
      parsed,
      message: conflictMessage(context, saved.in_force, saved.asked, saved.rows),
    });
  }
  return sendJson(res, saved?.ok ? 200 : 400, {
    ...(saved || { ok: false, code: 'OPS_CORRECTION_FAILED' }),
    parsed,
  });
}

async function handleRetry(req, res, ctx, body) {
  const jobId = clean(body.job_id, 40);
  if (!UUID_RE.test(jobId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
  }
  const retried = await opsRpc('ops_retry_job', {
    p_job_id: jobId,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  });
  return sendJson(res, retried?.ok ? 200 : 409, retried || { ok: false, code: 'OPS_RETRY_FAILED' });
}

async function createTextJob(ctx, parsed, raw, service) {
  const created = await opsRpc('ops_jobs_create', {
    p_school_id: ctx.actor.school_id,
    p_class_key: parsed.class_key || null,
    p_academic_session: parsed.academic_session || null,
    p_term: parsed.term || null,
    p_service: service,
    p_submitted_by: ctx.actor.id,
    p_submitted_by_email: ctx.actor.email,
    p_instruction: raw,
    p_file_refs: [],
    p_instruction_parsed: parsed,
  });
  if (!created || created.ok !== true) return null;

  const job = created.job;
  await opsRpc('ops_record_assistant', { p_job_id: job.id }).catch(() => null);
  await opsRpc('ops_save_instruction', { p_job_id: job.id, p_raw: raw, p_parsed: parsed }).catch(() => null);
  return job;
}

async function handleText(req, res, ctx, body) {
  const raw = clean(body.text || body.instruction, 4000);
  if (!raw) {
    return sendJson(res, 400, { ok: false, code: 'OPS_TEXT_EMPTY' });
  }

  const context = await opsRpc('ops_active_context', {});

  if (clean(body.action, 20) === 'parse') {
    const parsedOnly = parseInstruction(raw, context || {});
    return sendJson(res, 200, { ok: true, parsed: parsedOnly, context: context || null });
  }

  const listed = await opsRpc('ops_jobs_list', {});
  const jobs = Array.isArray(listed?.jobs) ? listed.jobs : [];
  const requestedJobId = clean(body.job_id, 40);
  const requested = requestedJobId ? jobs.find((job) => job.id === requestedJobId) : null;
  const target = body.new_job === true || body.new_job === 'true'
    ? null
    : (requested || (requestedJobId ? null : latestOpenJob(jobs)));

  // First parse against the portal context, enough to know whether the
  // sentence is an individual mark or a new-pupil proposal. Those always make
  // their own job. Everything else about "this" is parsed against the open
  // job, so a portal class change cannot silently disagree with it.
  let parsed = parseInstruction(raw, context || {});
  if (target && parsed.scope !== 'add_student' && parsed.scope !== 'individual') {
    parsed = parseInstruction(raw, contextForJob(context, target));
  }

  if (!parsed.ok) {
    return sendJson(res, 200, {
      ok: false,
      code: 'OPS_PARSE_NEEDS_INPUT',
      parsed,
      question: parsed.question,
    });
  }

  if (parsed.scope === 'add_student') {
    if (!(await creditGate(res, ctx.actor.school_id, ctx))) return;
    const job = await createTextJob(ctx, parsed, raw, 'roster');
    if (!job) return sendJson(res, 502, { ok: false, code: 'OPS_REQUEST_FAILED' });
    const proposal = await opsRpc('ops_propose_pupil', {
      p_job_id: job.id,
      p_proposal: parsed.proposal,
    });
    return sendJson(res, 201, {
      ok: true,
      job,
      parsed,
      proposal: proposal?.proposal || null,
      live_write: false,
      message: proposal?.message || 'New pupil held as a proposal. Creating a pupil is blocked until live writes are on.',
    });
  }

  if (parsed.scope === 'individual') {
    if (!(await creditGate(res, ctx.actor.school_id, ctx))) return;
    const job = await createTextJob(ctx, parsed, raw, 'scores');
    if (!job) return sendJson(res, 502, { ok: false, code: 'OPS_REQUEST_FAILED' });
    const staged = await opsRpc('ops_stage_individual', {
      p_job_id: job.id,
      p_name: parsed.pupil_name,
      p_mark: parsed.mark,
      p_column_group: parsed.column_group || '1ST TERM',
      p_column_label: parsed.column_label || 'CLASS EXERCISE',
      p_subject_key: parsed.subject_key,
      p_subject_label: parsed.subject,
    });
    return sendJson(res, 201, {
      ok: true,
      job,
      parsed,
      staged: staged || null,
      live_write: false,
    });
  }

  // A sentence about "this" belongs to the open job in the conversation. If
  // the job already has rows, the database refuses a half-switch and returns
  // the fields that are in force, plus the offer of a new job.
  if (target) {
    const saved = await opsRpc('ops_save_instruction', {
      p_job_id: target.id,
      p_raw: raw,
      p_parsed: parsed,
    });

    if (saved?.conflict === true) {
      return sendJson(res, 409, {
        ok: false,
        code: 'OPS_INSTRUCTION_CONFLICT',
        conflict: true,
        in_force: saved.in_force,
        asked: saved.asked,
        parsed,
        message: conflictMessage(context, saved.in_force, saved.asked, saved.rows),
        offer: { new_job: true, text: raw },
        live_write: false,
      });
    }

    if (saved?.ok !== true) {
      return sendJson(res, 400, saved || { ok: false, code: 'OPS_INSTRUCTION_FAILED' });
    }

    return sendJson(res, 200, {
      ok: true,
      attached: true,
      job: saved.job || target,
      parsed,
      in_force: saved.in_force || null,
      live_write: false,
    });
  }

  if (!(await creditGate(res, ctx.actor.school_id, ctx))) return;
  const job = await createTextJob(ctx, parsed, raw, parsed.column_label ? 'scores' : 'documents');
  if (!job) return sendJson(res, 502, { ok: false, code: 'OPS_REQUEST_FAILED' });
  return sendJson(res, 201, { ok: true, attached: false, job, parsed, live_write: false });
}

async function generateDocuments(req, res, ctx, body) {
  const jobId = clean(body.job_id, 40);
  if (!UUID_RE.test(jobId)) {
    return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
  }

  const detail = await opsRpc('ops_jobs_get', { p_id: jobId });
  if (!detail?.job) {
    return sendJson(res, 404, { ok: false, code: 'OPS_JOB_NOT_FOUND' });
  }

  // Refusals fire here, before the renderer is called.
  const readiness = await opsRpc('ops_document_readiness', { p_job_id: jobId });
  if (!readiness || readiness.ok !== true) {
    const refusal = readiness?.refusals?.[0] || null;
    return sendJson(res, 409, {
      ok: false,
      code: readiness?.code || refusal?.code || 'OPS_DOCUMENTS_REFUSED',
      message: refusal?.message || 'This job is not ready for documents.',
      refusals: readiness?.refusals || [],
      live_write: false,
    });
  }

  let rendered;
  try {
    rendered = await renderDocuments(readiness.data);
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      code: error.code || 'OPS_RENDER_FAILED',
      message: 'The pages could not be made. Nothing was stored.',
    });
  }

  await opsRpc('ops_clear_documents', {
    p_job_id: jobId,
    p_actor: ctx.actor.id,
    p_actor_email: ctx.actor.email,
  });

  const stored = [];
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
    if (!attached || attached.ok !== true) {
      return sendJson(res, 502, {
        ok: false,
        code: attached?.code || 'OPS_DOCUMENT_STORE_FAILED',
        message: 'A finished page could not be stored. Nothing is published.',
      });
    }
    stored.push(attached.file);
  }

  const documentSet = {
    template_version: readiness.data.template_version,
    generated_at: new Date().toISOString(),
    published: false,
    files: stored,
    pages_total: stored.reduce((sum, file) => sum + Number(file.page_count || 0), 0),
    bytes_total: stored.reduce((sum, file) => sum + Number(file.byte_size || 0), 0),
    numbers: rendered.numbers,
    class_size: rendered.numbers.class_size,
    average: rendered.numbers.average,
    highest: rendered.numbers.highest,
    lowest: rendered.numbers.lowest,
    subject_labels: (readiness.data.subject_set || []).map((subject) => subject.label),
    column_label: readiness.data.column_label,
  };

  const recorded = await opsRpc('ops_record_documents', {
    p_job_id: jobId,
    p_document_set: documentSet,
  });

  return sendJson(res, 201, {
    ok: true,
    job: recorded?.job || detail.job,
    documents: documentSet,
    live_write: false,
  });
}

// Chat scope always comes from the verified developer session, never from the
// request body. A missing school means the chat functions are not called.
function chatScope(ctx) {
  const schoolId = ctx?.actor?.school_id || null;
  const ownerId = ctx?.actor?.id || null;
  if (!schoolId || !ownerId) return null;
  return { p_school_id: schoolId, p_owner_user_id: ownerId };
}

// Tags are a small fixed object, not a place to hide a payload.
function chatTags(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, limit] of [['class', 80], ['subject', 120], ['term', 30]]) {
    const text = clean(value[key], limit);
    if (text) out[key] = text;
  }
  return out;
}

// Developer-only settings for the assistant's own routes and the school's
// subscription. The school never sees a provider, model or key.
function isDeveloper(ctx) {
  return Boolean(ctx?.actor?.role === 'developer' || ctx?.actor?.is_developer);
}

// Refuse a paid assistant action while the school's units are finished. Old
// chats stay readable and manageable; the developer is never blocked.
async function blockedByUsage(ctx, res) {
  if (!ctx?.actor?.school_id) return false;
  const gate = await opsRpc('ops_assistant_gate', {
    p_school_id: ctx.actor.school_id,
    p_is_developer: isDeveloper(ctx),
  }).catch(() => null);
  if (!gate || gate.allowed !== false) return false;
  const exhausted = gate.paused === true;
  sendJson(res, exhausted ? 402 : 403, {
    ok: false,
    code: exhausted ? 'ASSISTANT_USAGE_EXHAUSTED' : 'ASSISTANT_SUSPENDED',
    message: gate.banner || 'The assistant is paused while the subscription is restored.',
    gate,
  });
  return true;
}

async function modelSettingsRoute(req, res, ctx, body, action) {
  if (!isDeveloper(ctx)) {
    return sendJson(res, 403, {
      ok: false,
      code: 'MODEL_SETTINGS_DEVELOPER_ONLY',
      message: 'Model settings are for the developer account only.',
    });
  }

  if (action === 'model_save') {
    const role = clean(body.role, 20);
    const payload = await opsRpc('ops_model_config_set', {
      p_role: role,
      p_provider: clean(body.provider, 40),
      p_model: clean(body.model, 120),
      p_base_url: clean(body.base_url, 300) || null,
      p_api_key: typeof body.api_key === 'string' ? body.api_key.slice(0, 500) : null,
      p_enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
      p_secret: process.env.OPS_SECRET_KEY || '',
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email || null,
    });
    return sendJson(res, payload?.ok === false ? 400 : 200, payload);
  }

  if (action === 'model_test') {
    const role = clean(body.role, 20);
    const result = await testModelRoute(role);
    await opsRpc('ops_model_test_record', {
      p_role: role,
      p_ok: Boolean(result.ok),
      p_error: result.ok ? null : String(result.message || '').slice(0, 300),
    }).catch(() => null);
    return sendJson(res, result.ok ? 200 : 502, { ...result, role });
  }

  if (action === 'model_vision_test') {
    const result = await testVisionRoute();
    await opsRpc('ops_model_test_record', {
      p_role: 'vision',
      p_ok: Boolean(result.ok),
      p_error: result.ok ? null : String(result.message || '').slice(0, 300),
    }).catch(() => null);
    return sendJson(res, result.ok ? 200 : 502, { ...result, role: 'vision' });
  }

  if (action === 'model_switch') {
    const role = clean(body.role, 20);
    if (!['primary', 'secondary', 'vision'].includes(role)) {
      return sendJson(res, 400, { ok: false, code: 'MODEL_ROLE_INVALID' });
    }
    // A route must pass before it becomes primary. The old setting is kept in
    // the audit row, so a revert is one more visible action.
    const acceptance = await testModelRoute(role);
    if (!acceptance.ok) {
      return sendJson(res, 409, {
        ok: false,
        code: 'MODEL_ACCEPTANCE_FAILED',
        message: acceptance.message || 'That route did not pass the acceptance check.',
        acceptance,
      });
    }
    const payload = await opsRpc('ops_model_switch', {
      p_role: role,
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email || null,
    });
    return sendJson(res, payload?.ok === false ? 400 : 200, { ...payload, acceptance });
  }

  if (action === 'subscription_set') {
    const due = clean(body.due_date, 40);
    const payload = await opsRpc('ops_subscription_set', {
      p_school_id: ctx.actor.school_id,
      p_status: clean(body.status, 20) || null,
      p_tier: clean(body.tier, 20) || null,
      p_price_naira: Number.isFinite(Number(body.price_naira)) ? Number(body.price_naira) : null,
      p_due_date: due && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null,
      p_included_tokens: Number.isFinite(Number(body.included_tokens)) ? Number(body.included_tokens) : null,
      p_grace_days: Number.isFinite(Number(body.grace_days)) ? Number(body.grace_days) : null,
      p_note: clean(body.note, 300) || null,
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email || null,
    });
    if (payload?.ok !== false) {
      await opsRpc('ops_subscription_usage_set', {
        p_school_id: ctx.actor.school_id,
        p_included_units: Number.isFinite(Number(body.included_units)) ? Number(body.included_units) : null,
        p_price_naira: Number.isFinite(Number(body.price_naira)) ? Number(body.price_naira) : null,
        p_unit_price_naira: Number.isFinite(Number(body.unit_price_naira)) ? Number(body.unit_price_naira) : null,
      }).catch(() => null);
    }
    return sendJson(res, payload?.ok === false ? 400 : 200, payload);
  }

  // Usage percentage: 0 pauses at once, above 0 resumes at that reading.
  if (action === 'usage_set_percent') {
    const pct = Number(body.percent);
    if (!Number.isFinite(pct)) {
      return sendJson(res, 400, { ok: false, code: 'USAGE_PERCENT_REQUIRED', message: 'Give a percentage between 0 and 100.' });
    }
    const usage = await opsRpc('ops_usage_set_percent', {
      p_school_id: ctx.actor.school_id,
      p_pct: Math.max(0, Math.min(100, pct)),
      p_actor_id: ctx.actor.id,
    });
    await opsRpc('ops_audit_append', {
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email || null,
      p_action: 'usage_set_percent',
      p_entity: 'school_subscriptions',
      p_entity_id: ctx.actor.school_id,
      p_detail: { percent: pct },
    }).catch(() => null);
    return sendJson(res, 200, { ok: true, usage, gate: await opsRpc('ops_assistant_gate', {
      p_school_id: ctx.actor.school_id, p_is_developer: true,
    }).catch(() => null) });
  }

  if (action === 'usage_reset') {
    const usage = await opsRpc('ops_usage_reset', {
      p_school_id: ctx.actor.school_id,
      p_actor_id: ctx.actor.id,
    });
    await opsRpc('ops_audit_append', {
      p_actor_id: ctx.actor.id,
      p_actor_email: ctx.actor.email || null,
      p_action: 'usage_reset',
      p_entity: 'school_subscriptions',
      p_entity_id: ctx.actor.school_id,
      p_detail: {},
    }).catch(() => null);
    return sendJson(res, 200, { ok: true, usage, gate: await opsRpc('ops_assistant_gate', {
      p_school_id: ctx.actor.school_id, p_is_developer: true,
    }).catch(() => null) });
  }

  return sendJson(res, 400, { ok: false, code: 'MODEL_ACTION_UNKNOWN' });
}

async function chatRoute(req, res, ctx, body, action) {
  const scope = chatScope(ctx);
  if (!scope) {
    return sendJson(res, 409, {
      ok: false,
      code: 'CHAT_SCHOOL_REQUIRED',
      message: 'This account is not attached to a school, so chats cannot be saved.',
    });
  }

  if (action === 'chat_new') {
    if (await blockedByUsage(ctx, res)) return;
    const payload = await opsRpc('ops_chat_session_create', {
      ...scope,
      p_title: clean(body.title, 120) || null,
      p_tags: chatTags(body.tags),
    });
    return sendJson(res, payload?.ok === false ? 400 : 201, payload);
  }

  if (action === 'chat_update') {
    const chatId = clean(body.chat_id, 40);
    if (!UUID_RE.test(chatId)) {
      return sendJson(res, 400, { ok: false, code: 'CHAT_ID_INVALID' });
    }
    const payload = await opsRpc('ops_chat_session_update', {
      ...scope,
      p_id: chatId,
      p_title: clean(body.title, 120) || null,
      p_tags: chatTags(body.tags),
      p_status: clean(body.status, 20) || null,
      p_pinned: typeof body.pinned === 'boolean' ? body.pinned : null,
    });
    return sendJson(res, payload?.ok === false ? 404 : 200, payload);
  }

  if (action === 'chat_delete' || action === 'chat_restore' || action === 'chat_purge') {
    const chatId = clean(body.chat_id, 40);
    if (!UUID_RE.test(chatId)) {
      return sendJson(res, 400, { ok: false, code: 'CHAT_ID_INVALID' });
    }
    const name = action === 'chat_delete' ? 'ops_chat_session_delete'
      : action === 'chat_restore' ? 'ops_chat_session_restore'
        : 'ops_chat_session_purge';
    const payload = await opsRpc(name, {
      ...scope,
      p_id: chatId,
      ...(action === 'chat_purge' ? { p_force: body.force === true } : {}),
    });
    if (payload?.ok === false) {
      return sendJson(res, payload.code === 'CHAT_PURGE_TOO_SOON' ? 409 : 404, payload);
    }
    return sendJson(res, 200, payload);
  }

  if (action === 'chat_usage') {
    const payload = await opsRpc('ops_chat_usage', { p_school_id: scope.p_school_id });
    const usage = await opsRpc('ops_school_usage', { p_school_id: scope.p_school_id }).catch(() => null);
    return sendJson(res, 200, { ...payload, usage: usage || null });
  }

  // A printed page is charged once the browser has actually printed it.
  if (action === 'printed') {
    const pages = Math.max(1, Math.min(200, Number(body.pages) || 1));
    const usage = await opsRpc('ops_usage_charge', {
      p_school_id: scope.p_school_id,
      p_actor_id: ctx.actor.id || null,
      p_kind: 'print_page',
      p_units: 12 * pages,
      p_developer_excluded: isDeveloper(ctx),
    }).catch(() => null);
    return sendJson(res, 200, { ok: true, pages, usage: usage || null });
  }

  return sendJson(res, 400, { ok: false, code: 'CHAT_ACTION_UNKNOWN' });
}

module.exports = async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (!opsConfigured()) {
    return deny(res, 503, 'OPS_NOT_CONFIGURED', 'The pilot schema is not reachable from this deployment.');
  }

  const ctx = await requireDeveloper(req, res);
  if (!ctx) return;

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (clean(req.query?.context, 10)) {
        const context = await opsRpc('ops_active_context', {});
        const balance = await opsRpc('ops_credit_balance', { p_school_id: ctx.actor.school_id }).catch(() => null);
        return sendJson(res, 200, { ...(context || {}), balance: balance || null });
      }

      // The light gate reading. It answers while paused, so the page can show
      // the pause and re-enable itself once the developer resets.
      if (clean(req.query?.gate, 5)) {
        if (!ctx.actor?.school_id) return sendJson(res, 409, { ok: false, code: 'GATE_SCHOOL_REQUIRED' });
        const gate = await opsRpc('ops_assistant_gate', {
          p_school_id: ctx.actor.school_id,
          p_is_developer: isDeveloper(ctx),
        });
        return sendJson(res, 200, { ...gate, usage: await opsRpc('ops_school_usage', {
          p_school_id: ctx.actor.school_id,
        }).catch(() => null) });
      }

      // Developer settings: model routes and the school's monthly summary.
      if (clean(req.query?.models, 10)) {
        if (!isDeveloper(ctx)) {
          return sendJson(res, 403, { ok: false, code: 'MODEL_SETTINGS_DEVELOPER_ONLY' });
        }
        const payload = await opsRpc('ops_model_config_list', {});
        // Section 20: every view is logged with who and when. The audit row
        // holds no key, only the fact that the console was opened.
        await opsRpc('ops_audit_append', {
          p_actor_id: ctx.actor.id,
          p_actor_email: ctx.actor.email || null,
          p_action: 'model_config_view',
          p_entity: 'model_config',
          p_entity_id: null,
          p_detail: {},
        }).catch(() => null);
        return sendJson(res, 200, {
          ...(payload || {}),
          key_encryption: Boolean(process.env.OPS_SECRET_KEY),
        });
      }

      if (clean(req.query?.summary, 10)) {
        if (!ctx.actor?.school_id) {
          return sendJson(res, 409, { ok: false, code: 'SUMMARY_SCHOOL_REQUIRED' });
        }
        const payload = await opsRpc('ops_school_month_summary', {
          p_school_id: ctx.actor.school_id,
          p_month: null,
        });
        const gate = await opsRpc('ops_assistant_gate', { p_school_id: ctx.actor.school_id }).catch(() => null);
        return sendJson(res, 200, { ...(payload || {}), gate: gate || null });
      }

      // Chat sidebar: list and one transcript. Both are owner-scoped in the
      // database function, so a guessed id from another account is not found.
      if (clean(req.query?.chats, 10)) {
        const scope = chatScope(ctx);
        if (!scope) {
          return sendJson(res, 409, { ok: false, code: 'CHAT_SCHOOL_REQUIRED' });
        }
        // The 30-day restore window is enforced here as well as by the single
        // purge action, so expired deleted chats do not accumulate.
        await opsRpc('ops_chat_purge_due', { p_school_id: scope.p_school_id }).catch(() => null);
        // A chat untouched for 60 days is compacted, never deleted. Reopening
        // restores the full transcript from the cold copy.
        await opsRpc('ops_chat_compact_due', { p_school_id: scope.p_school_id }).catch(() => null);
        const payload = await opsRpc('ops_chat_sessions_list', {
          ...scope,
          p_search: clean(req.query?.q, 120) || null,
          p_status: clean(req.query?.status, 20) || 'active',
        });
        return sendJson(res, 200, payload);
      }

      const chatId = clean(req.query?.chat, 40);
      if (chatId) {
        if (!UUID_RE.test(chatId)) {
          return sendJson(res, 400, { ok: false, code: 'CHAT_ID_INVALID' });
        }
        const scope = chatScope(ctx);
        if (!scope) {
          return sendJson(res, 409, { ok: false, code: 'CHAT_SCHOOL_REQUIRED' });
        }
        let payload = await opsRpc('ops_chat_session_get', {
          ...scope,
          p_id: chatId,
          p_message_limit: 200,
        });
        if (payload?.ok && payload.session?.status === 'archived'
          && (!Array.isArray(payload.messages) || payload.messages.length === 0)) {
          const restored = await opsRpc('ops_chat_session_restore_cold', {
            ...scope,
            p_id: chatId,
          }).catch(() => null);
          if (restored?.ok && restored.restored > 0) {
            payload = await opsRpc('ops_chat_session_get', {
              ...scope,
              p_id: chatId,
              p_message_limit: 200,
            });
          }
        }
        if (!payload || payload.ok === false) {
          return sendJson(res, 404, {
            ok: false,
            code: 'CHAT_NOT_FOUND',
            message: 'That chat is not in this account.',
          });
        }
        return sendJson(res, 200, payload);
      }

      if (String(req.query?.documents || '') === '1') {
        const limit = Math.min(Math.max(Number(req.query?.limit) || 24, 1), 100);
        const payload = await opsRpc('school_recent_documents', {
          p_school_id: ctx.actor.school_id,
          p_limit: limit,
        }).catch(() => null);
        return sendJson(res, 200, payload && payload.ok ? payload : { ok: true, documents: [] });
      }

      const fileId = clean(req.query?.file, 40);
      if (fileId) {
        return await serveFile(req, res, ctx, fileId);
      }

      const documentId = clean(req.query?.document, 40);
      if (documentId) {
        return await serveDocument(req, res, ctx, documentId);
      }

      const id = clean(req.query?.id, 40);
      if (id) {
        if (!UUID_RE.test(id)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const payload = await opsRpc('ops_jobs_get', { p_id: id });
        if (!payload) {
          return sendJson(res, 404, { ok: false, code: 'OPS_JOB_NOT_FOUND' });
        }
        return sendJson(res, 200, payload);
      }

      const payload = await opsRpc('ops_jobs_list', {});
      return sendJson(res, 200, payload || { ok: true, jobs: [] });
    }

    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const query = (() => {
        try { return new URL(req.url, 'https://local.invalid').searchParams; } catch { return new URLSearchParams(); }
      })();

      // Raw photo path: the browser sends the original bytes, never a base64
      // copy. The server owns orientation, resizing and the 3.5 MB check.
      if (query.get('action') === 'upload' && !contentType.startsWith('application/json')) {
        let raw = null;
        try {
          raw = await readRawBody(req, MAX_RAW_BYTES);
        } catch (error) {
          return failUpload(res, 413, {
            ok: false,
            code: 'OPS_FILE_TOO_LARGE',
            limit: MAX_BYTES,
            message: 'That photo is too big to send. I can only take one up to about 3 MB.',
          }, uploadDiagnostic('receive', error, { bytes: error?.bytes || null }));
        }
        if (await blockedByUsage(ctx, res)) return;
        return await uploadPhoto(req, res, ctx, {
          action: 'upload',
          job_id: query.get('job_id') || '',
          filename: query.get('filename') || '',
          mime: query.get('mime') || contentType,
          client_step: query.get('client_step') || '',
          client_error: query.get('client_error') || '',
        }, raw);
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { ok: false, code: 'OPS_PAYLOAD_INVALID' });
      }

      const action = clean(body.action, 20) || 'create';

      // Browser-side failures come here so the next one is named. No photo
      // bytes are involved and nothing is written to the school's data.
      if (action === 'client_error') {
        const detail = {
          job_id: clean(body.job_id, 40) || null,
          step: clean(body.step, 80) || 'unknown',
          error: clean(body.error, 1000) || 'unknown browser error',
          user_agent: clean(req.headers['user-agent'], 300) || null,
          at: new Date().toISOString(),
        };
        try { console.error('ops_client_error', JSON.stringify(detail)); } catch {}
        return sendJson(res, 200, { ok: true, diagnostic: detail });
      }

      if (action === 'worker_pass') {
        // The hosted reader pass lives here so the deployment stays inside the
        // plan's function limit. One call reads at most one waiting page.
        const { runOnePass } = require('./_ops-worker-core');
        const pass = await runOnePass({ worker: 'ops-portal' });
        return sendJson(res, 200, {
          ok: true,
          claimed: pass.claimed,
          result: pass.result,
          job_id: pass.job || null,
          adapter: pass.adapter || null,
          duration_ms: pass.duration_ms || null,
          note: pass.note || null,
        });
      }

      if (action === 'upload' || action === 'prepare_page') {
        if (await blockedByUsage(ctx, res)) return;
        if (action === 'upload') return await uploadPhoto(req, res, ctx, body);
      }

      if (action.startsWith('chat_')) {
        return await chatRoute(req, res, ctx, body, action);
      }

      if (action.startsWith('model_') || action === 'subscription_set'
        || action === 'usage_set_percent' || action === 'usage_reset') {
        return await modelSettingsRoute(req, res, ctx, body, action);
      }

      if (action === 'chat') {
        return await handleAgentChat(req, res, ctx, body, {
          sendJson,
          conflictMessage,
          contextForJob,
        });
      }

      // The page card refreshes its four lists after a name is mapped or a
      // score is corrected, without making the model answer again.
      if (action === 'mapping') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const [context, jobDetail] = await Promise.all([
          opsRpc('ops_active_context', {}).catch(() => ({})),
          opsRpc('ops_jobs_get', { p_id: jobId }).catch(() => null),
        ]);
        const mapping = buildMapping(buildJobDigest(jobDetail, context));
        return sendJson(res, mapping ? 200 : 404, mapping
          ? { ok: true, mapping }
          : { ok: false, code: 'OPS_MAPPING_EMPTY', message: 'That page has no read lines to show.' });
      }

      if (action === 'text' || action === 'parse') {
        return await handleText(req, res, ctx, body);
      }

      if (action === 'correct') {
        return await handleCorrect(req, res, ctx, body);
      }

      // Retry hands the same open job back to the reader queue. It never
      // creates another job and never takes another credit.
      if (action === 'retry') {
        return await handleRetry(req, res, ctx, body);
      }

      if (action === 'documents_readiness') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const readiness = await opsRpc('ops_document_readiness', { p_job_id: jobId });
        return sendJson(res, readiness?.ok ? 200 : 409, readiness || { ok: false, code: 'OPS_DOCUMENTS_REFUSED' });
      }

      if (action === 'generate_documents') {
        return await generateDocuments(req, res, ctx, body);
      }

      if (action === 'copy_accepted') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        if (!(await creditGate(res, ctx.actor.school_id, ctx))) return;
        const copied = await opsRpc('ops_copy_accepted_job', {
          p_source: jobId,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
        });
        return sendJson(res, copied?.ok ? 201 : 400, copied || { ok: false, code: 'OPS_COPY_FAILED' });
      }

      if (action === 'delete_job') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const deleted = await opsRpc('ops_delete_proof_copy', {
          p_job_id: jobId,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
        });
        return sendJson(res, deleted?.ok ? 200 : 409, deleted || { ok: false, code: 'OPS_DELETE_FAILED' });
      }

      if (action === 'decide_mark') {
        const jobId = clean(body.job_id, 40);
        const markId = clean(body.mark_id, 40);
        if (!UUID_RE.test(jobId) || !UUID_RE.test(markId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_MARK_ID_INVALID' });
        }
        const status = clean(body.status, 10) || 'read';
        const value = body.value == null || body.value === '' ? null : Number(body.value);
        if (status === 'read' && (value == null || !Number.isFinite(value) || value < 0 || value > 100)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_MARK_VALUE_INVALID' });
        }
        const payload = await opsRpc('ops_decide_mark', {
          p_job_id: jobId,
          p_mark_id: markId,
          p_value: value,
          p_status: status,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
          p_note: clean(body.note, 500) || null,
        });
        return sendJson(res, payload?.ok ? 200 : 400, payload || { ok: false, code: 'OPS_MARK_FAILED' });
      }

      // A page can be read without a mark row for every line. This creates the
      // one cell being typed, or corrects the existing cell, and never touches
      // the other marks on the page.
      if (action === 'set_mark') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const rowId = clean(body.staged_row_id, 40);
        if (!UUID_RE.test(rowId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_ROW_ID_INVALID' });
        }
        const status = clean(body.status, 10) || 'read';
        const value = body.value == null || body.value === '' ? null : Number(body.value);
        if (status === 'read' && (value == null || !Number.isFinite(value) || value < 0 || value > 100)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_MARK_VALUE_INVALID' });
        }
        const payload = await opsRpc('ops_set_mark', {
          p_job_id: jobId,
          p_staged_row_id: rowId,
          p_value: value,
          p_status: status,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
          p_note: clean(body.note, 500) || null,
        });
        return sendJson(res, payload?.ok ? 200 : 400, payload || { ok: false, code: 'OPS_MARK_FAILED' });
      }

      if (action === 'decide') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const rowId = clean(body.staged_row_id, 40);
        if (!UUID_RE.test(rowId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_ROW_ID_INVALID' });
        }
        const decision = clean(body.decision, 20);
        if (!DECISIONS.has(decision)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_DECISION_INVALID' });
        }
        const payload = await opsRpc('ops_jobs_decide', {
          p_job_id: jobId,
          p_staged_row_id: rowId,
          p_decision: decision,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
          p_note: clean(body.note, 1000) || null,
        });
        return sendJson(res, payload?.ok ? 200 : 400, payload || { ok: false, code: 'OPS_DECISION_FAILED' });
      }

      if (action === 'attach') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const rowId = clean(body.staged_row_id, 40);
        if (!UUID_RE.test(rowId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_ROW_ID_INVALID' });
        }
        const studentId = clean(body.student_id, 40);
        if (!UUID_RE.test(studentId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_PUPIL_ID_INVALID' });
        }
        const payload = await opsRpc('ops_attach_row', {
          p_job_id: jobId,
          p_staged_row_id: rowId,
          p_student_id: studentId,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
        });
        return sendJson(res, payload?.ok ? 200 : 400, payload || { ok: false, code: 'OPS_ATTACH_FAILED' });
      }

      if (action === 'confirm') {
        const jobId = clean(body.job_id, 40);
        if (!UUID_RE.test(jobId)) {
          return sendJson(res, 400, { ok: false, code: 'OPS_JOB_ID_INVALID' });
        }
        const payload = await opsRpc('ops_jobs_confirm', {
          p_job_id: jobId,
          p_actor: ctx.actor.id,
          p_actor_email: ctx.actor.email,
        });
        return sendJson(res, payload?.ok ? 200 : 409, payload || { ok: false, code: 'OPS_CONFIRM_FAILED' });
      }

      if (action !== 'create') {
        return sendJson(res, 400, { ok: false, code: 'OPS_ACTION_NOT_SUPPORTED' });
      }

      const service = clean(body.service, 20);
      if (!SERVICES.has(service)) {
        return sendJson(res, 400, { ok: false, code: 'OPS_SERVICE_INVALID', message: 'service must be roster, scores or documents.' });
      }

      // The instruction is parsed here, at creation, and its class, subject,
      // term and column are frozen in the same job. A later sentence cannot
      // switch a page that already has rows.
      const context = await opsRpc('ops_active_context', {});
      const raw = clean(body.instruction, 4000);
      const isPhotoLabel = /^photo of the page\.?$/i.test(raw);
      const parsed = raw && !isPhotoLabel ? parseInstruction(raw, context || {}) : null;

      if (parsed && !parsed.ok) {
        return sendJson(res, 200, {
          ok: false,
          code: 'OPS_PARSE_NEEDS_INPUT',
          parsed,
          question: parsed.question,
          message: parsed.question || 'I need one more detail before this job starts.',
        });
      }

      // No fallback to the active class. The page sends the class the person
      // confirmed, and an empty class must stay empty.
      const classKey = (parsed && parsed.ok ? parsed.class_key : null)
        || clean(body.class_key, 60)
        || null;

      if (!(await creditGate(res, ctx.actor.school_id, ctx))) return;

      const payload = await opsRpc('ops_jobs_create', {
        p_school_id: ctx.actor.school_id,
        p_class_key: classKey,
        p_academic_session: (parsed && parsed.ok ? parsed.academic_session : null)
          || clean(body.academic_session, 20)
          || context?.academic_session
          || null,
        p_term: (parsed && parsed.ok ? parsed.term : null)
          || clean(body.term, 20)
          || context?.term
          || null,
        p_service: service,
        p_submitted_by: ctx.actor.id,
        p_submitted_by_email: ctx.actor.email,
        p_instruction: raw || null,
        p_file_refs: [],
        p_instruction_parsed: parsed && parsed.ok ? parsed : null,
      });

      if (payload?.job?.id) {
        const recorded = await opsRpc('ops_record_assistant', { p_job_id: payload.job.id });
        if (recorded?.job) payload.job = recorded.job;
      }

      return sendJson(res, 201, payload || { ok: false, code: 'OPS_REQUEST_FAILED' });
    }

    res.setHeader('Allow', 'GET, HEAD, POST');
    return sendJson(res, 405, { ok: false, code: 'OPS_METHOD_NOT_ALLOWED' });
  } catch (error) {
    const status = error.status === 503 ? 503 : 502;
    return sendJson(res, status, {
      ok: false,
      code: error.code || 'OPS_REQUEST_FAILED',
      message: 'The pilot store did not answer. Nothing was changed.',
    });
  }
};
