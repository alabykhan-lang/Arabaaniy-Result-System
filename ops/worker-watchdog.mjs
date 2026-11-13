#!/usr/bin/env node
'use strict';

// Cron watchdog. It starts the supervisor only when the supervisor is gone.
//
// This file never claims a job itself. All claiming stays in the one loop
// behind the one lock, so a watchdog tick cannot cause a second read or a
// second charge.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = '/var/lib/openbot/.local/state';
const PID_PATH = process.env.OPS_WORKER_SUPERVISOR_PID
  || path.join(STATE_DIR, 'ops-worker-supervisor.pid');
const LOG_PATH = process.env.OPS_WORKER_SUPERVISOR_LOG
  || path.join(STATE_DIR, 'ops-worker-supervisor.log');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function log(event) {
  const line = { ts: new Date().toISOString(), event };
  await appendFile(LOG_PATH, `${JSON.stringify(line)}\n`, { mode: 0o600 }).catch(() => {});
}

const raw = await readFile(PID_PATH, 'utf8').catch(() => '');
let held = null;
try { held = JSON.parse(raw); } catch (_) {}

if (pidAlive(held?.pid)) {
  process.exit(0);
}

await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [path.join(HERE, 'worker-supervisor.mjs')], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
});
child.unref();
await log('watchdog_started_supervisor');
process.exit(0);
