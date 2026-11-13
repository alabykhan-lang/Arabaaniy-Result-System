#!/usr/bin/env node
'use strict';

// Minimal external worker. No OpenBot, no dependencies.
// Run: SUPABASE_SERVICE_ROLE_KEY=... node ops/worker-example.mjs
//
// It claims one job, heartbeats once, then parks it for a human because this
// example has no parser attached. A real worker would replace the park call
// with an adapter call that returns a v1 staged-rows outcome.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gnixdjglpsaarlrzqgdg.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER = process.env.WORKER_NAME || `cron-${process.pid}`;
const CONTRACT_VERSION = '1.0.0';

async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

async function main() {
  if (!KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is required (read it from the platform secret store).');
    return;
  }
  const job = await rpc('ops_claim_job', { p_worker: WORKER, p_lease_seconds: 300 });
  if (!job) {
    console.log('No queued job.');
    return;
  }

  console.log(`Claimed ${job.id} (${job.service}), attempt ${job.attempts}.`);

  const beat = await rpc('ops_heartbeat_job', {
    p_job_id: job.id,
    p_worker: WORKER,
    p_lease_seconds: 300,
  });
  if (!beat) {
    console.log('Lease was lost; stopping without writing.');
    return;
  }

  // Real worker: call the adapter, validate against ops-contract/v1, then write
  // staged rows. This example has no vendor, so it parks the job honestly.
  const parked = await rpc('ops_park_job', {
    p_job_id: job.id,
    p_reason: 'Example cron worker has no parser attached; parked for a human.',
    p_adapter: 'cron-example',
    p_model: null,
    p_contract_version: CONTRACT_VERSION,
    p_response_hash: null,
    p_worker: WORKER,
    p_attempt: job.attempts,
  });

  console.log(`Parked as ${parked?.status || 'unknown'}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
