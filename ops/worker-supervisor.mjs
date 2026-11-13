#!/usr/bin/env node
'use strict';

// Supervisor for the continuous reader loop.
//
// It owns one worker-daemon child and restarts that child if it exits for any
// reason. Cron never runs this file directly; the watchdog starts it when its
// process is gone. One supervisor at a time, enforced by a PID file that is
// also checked for liveness, so a killed supervisor never blocks a new one.

import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
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

async function log(event, extra) {
  const line = { ts: new Date().toISOString(), event, ...extra };
  await appendFile(LOG_PATH, `${JSON.stringify(line)}\n`, { mode: 0o600 }).catch(() => {});
}

async function takePidFile() {
  await mkdir(path.dirname(PID_PATH), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(PID_PATH, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = await readFile(PID_PATH, 'utf8').catch(() => '');
      let held = null;
      try { held = JSON.parse(raw); } catch (_) {}
      if (pidAlive(held?.pid)) return false;
      await unlink(PID_PATH).catch(() => {});
    }
  }
  return false;
}

async function dropPidFile() {
  const raw = await readFile(PID_PATH, 'utf8').catch(() => '');
  try {
    const held = JSON.parse(raw);
    if (held?.pid === process.pid) await unlink(PID_PATH);
  } catch (_) {
    // A missing or replaced file is not ours to remove.
  }
}

if (await takePidFile()) {
  let stopping = false;
  let child = null;

  const launch = () => {
    child = spawn(process.execPath, [path.join(HERE, 'worker-daemon.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
    log('child_started', { child_pid: child.pid });
    child.on('exit', (code, signal) => {
      log('child_exited', { child_pid: child.pid, code, signal });
      if (!stopping) setTimeout(launch, 2000);
    });
  };

  const stop = async (signal) => {
    stopping = true;
    log('stopping', { signal });
    if (child && pidAlive(child.pid)) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    await dropPidFile();
    process.exit(0);
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  launch();
  log('supervisor_started', { pid: process.pid });
}
