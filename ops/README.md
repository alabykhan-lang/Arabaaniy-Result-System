# Ops worker contract (v1)

The portal and the `ops` schema are the data plane. Any process can be the worker:
an OpenBot agent, a cron script, a vendor job, or a human with curl. Nothing in the
pilot imports OpenBot.

Read this with sections 14 and 15 of `SCHOOL_AGENT_STAFF_SPEC.md`.

## Claiming work

The only entry points are these functions, callable with the project service-role key:

| Function | Purpose |
|---|---|
| `public.ops_claim_job(p_worker, p_lease_seconds)` | Claim one queued job with `FOR UPDATE SKIP LOCKED`. Returns the job or `null`. |
| `public.ops_heartbeat_job(p_job_id, p_worker, p_lease_seconds)` | Extend the lease. Returns `null` if the lease was lost. |
| `public.ops_worker_event(p_job_id, p_worker, p_attempt, p_action, p_detail)` | Record one worker step. Refused unless this worker still owns this attempt. |
| `public.ops_finish_job(job, worker, attempt, rows, ...)` | Replace the job's staged rows with contract-valid output, resolve pupils against the frozen class list, and move to `needs_input` or `needs_review`. |
| `public.ops_fail_job(p_job_id, p_worker, p_error)` | Return the job to `queued`, or park it at `needs_input` after three attempts. After three it is handed to Manual. |
| `public.ops_park_job(...)` | Park a job for a human. When the job is claimed, pass the same `p_worker` (and `p_attempt`) or the call is refused. |

A claim sets `claimed_by`, `claimed_at`, `lease_until`, and increments `attempts`.
If the lease expires without a heartbeat, the next claim returns the job to `queued`.
After three attempts it moves to `needs_input` with `last_error` kept. A job is never
silently dropped and never marked done without finishing.

Two workers cannot take the same job: the claim runs in one transaction with
`FOR UPDATE SKIP LOCKED`. A stale worker whose lease expired cannot overwrite the job a
newer worker now owns: park checks the worker label and attempt number before writing.

### Cron example without OpenBot

```bash
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/ops_claim_job" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_worker":"cron-01","p_lease_seconds":300}'
```

Replace the key with a platform secret. Do not put it in a job row or in the school's code.
`ops/worker-example.mjs` is a complete no-dependency Node worker.

## OpenBot agent worker

`ops/worker-openbot.mjs` is the OpenBot teammate as a worker. It uses the same
claim protocol and the same contract, and its worker label (`openbot_agent`) is
the actor on every audit row.

```bash
export SUPABASE_SERVICE_ROLE_KEY=...          # platform secret; never commit it
node ops/worker-openbot.mjs claim
node ops/worker-openbot.mjs download --job <uuid> --attempt 1
# The agent looks at the downloaded page and writes: <line number>\t<name as written>
node ops/worker-openbot.mjs match --job <uuid> --lines lines.tsv --out rows.json \
  --subject nursery1:writing --label Writing
node ops/worker-openbot.mjs finish --job <uuid> --attempt 1 --rows rows.json
```

`download` checks the stored sha256 before writing a private temp file.
`match` resolves names only against that job's frozen class list; an exact or
normalised name yields an admission number, a single close candidate yields
`candidate_admno`, and everything else is flagged. `finish` validates the
1.0.0 contract, writes staged rows, and moves the job to `needs_input` when any
line needs a human, otherwise `needs_review`.

Marks use the same job after the rows exist. The agent reads the printed mark
columns and posts cells with `column_group` (the printed term block) and
`column_label` (the printed column, for example `CLASS EXERCISE`), never a
positional index. A blank stays blank, a value outside 0–100 is rejected as a
cell, and an ambiguous digit pair (`1/7`, `4/9`, `0/6`, `5/6`) is stored as
`ambiguous` with its candidates and flagged for the reviewer. One bad cell
flags that cell, not the job.

```bash
# stage cells through the service-role RPC; one call replaces the job's cells
# public.ops_stage_marks(p_job_id, p_marks)
# rebuild the four alignment lists and store them on the job
node ops/worker-openbot.mjs align --job <uuid> --out alignment.json
```

`align` compares token sets order-insensitively, surname first, with per-token
edit distance scaled by length. A surname must match before a first name can be
forgiven. It writes A (exact), B (same surname, first name close — suggested,
never accepted), C (on the sheet, not in the portal) and D (in the portal, not
on the sheet) onto `staged_rows.match_list` and `jobs.alignment`. A row appears
in at most one list; an equal-closeness tie goes to B with both candidates named.

The download and every later step are fenced by worker label and attempt. If the
lease is lost, the calls are refused and nothing is overwritten.

## Plain one-shot daemon

`ops/worker-daemon.mjs` is the reader that runs without an agent chat turn. It
is started once a minute and claims at most one job per run, so a crash cannot
leave a process holding the queue.

```cron
* * * * * cd /var/lib/openbot/first-choice-result-portal && if [ -f /var/lib/openbot/.config/first-choice/reader.env ]; then set -a; . /var/lib/openbot/.config/first-choice/reader.env; set +a; fi; /var/lib/openbot/.local/bin/node ops/worker-daemon.mjs >> /var/lib/openbot/.local/state/ops-worker-cron.log 2>&1
```

The environment file is owned by the server account and mode `0600`:

```bash
SUPABASE_SERVICE_ROLE_KEY=...
RIVER_API_KEY=...
RIVER_BASE_URL=https://api.river.ai/v1
RIVER_READER_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017
# optional second opinion; absent means it does not run
RIVER_SECOND_OPINION_MODEL=zai-org/GLM-5.3-Flash
RIVER_SECOND_OPINION_MAX_TOKENS=2600
```

`RIVER_API_KEY` is read by the `river_vision` adapter only. The base URL and
model come from these variables and the provider row; none is hard-coded. No key
is ever written to a job, an audit row, a staged row, or a log line.

`GEMINI_API_KEY` is read by the `gemini_vision` adapter only. `FIRST_CHOICE_GEMINI_API_KEY`
is accepted as a fallback name. The Gemini row stays disabled.

Enable the River reader row once:

```sql
insert into ops.providers (label, kind, adapter, model, key_ref, priority, enabled, role)
values ('River vision reader', 'api', 'river_vision',
        'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'RIVER_API_KEY', 15, true, 'reader')
on conflict (label) do update
  set adapter = excluded.adapter, model = excluded.model,
      key_ref = excluded.key_ref, priority = excluded.priority,
      enabled = excluded.enabled, role = excluded.role, updated_at = now();
```

The agent row may stay enabled. A plain cron process cannot run the
`openbot_agent` adapter, so the daemon skips it and uses the enabled vision row;
the job is stamped with the adapter that actually read it.

### River vision reader

`river_vision` sends the page to an OpenAI-compatible `POST /chat/completions`
with a text block and one `image_url` data block. It applies EXIF rotation, sends
the page upright with its longest side between 1300 and 1800 pixels, JPEG quality
85, and records the bytes actually sent, the dimensions and the model in the
audit row `worker.page_read`. The page buffer itself is never stored.

The prompt asks for one line per printed row: row number, name as written, and
only the target printed column. A blank stays blank; an ambiguous digit is the
string `unclear` and is never guessed. The parse goes through the same matcher
and the same `ops_stage_marks` cell path as a human read. The adapter stages a
mark only for the target column; it does not invent blank cells for columns it
did not read.

A page job that names a printed column is read as a marks page even when it was
opened from the names flow. If the model returns a different number of rows than
the class list, the adapter parks the job with `OPS_ROW_COUNT_MISMATCH` and stages
nothing; rows are never padded.

A pre-existing ambiguous cell keeps its per-cell flag when the same row and
column are read again. It is never resolved by the model.

The optional second opinion uses the same key and `RIVER_SECOND_OPINION_MODEL`
(`zai-org/GLM-5.3-Flash`), temperature 0 and at least 2000 max tokens. It runs
only when `RIVER_SECOND_OPINION_MODEL` is present, only on cells already flagged,
and sends one small crop per flagged cell. It can add a note and keep a cell at
`needs_input`; it can never overwrite a confident read or make a cell accepted.

What a run does, in order:

1. Takes `/var/lib/openbot/.local/state/ops-worker.lock` atomically. A second
   run exits with `locked`. A lock older than five minutes is broken
   automatically, so a killed run cannot block the queue for ever.
2. Reads `ops.providers` and keeps enabled `reader` rows in priority order. A
   row is usable only when its adapter is installed in this process and its
   `health()` is `ok`. `manual` is a hand-off, not a reader. An `openbot_agent`
   row is not usable from a plain process; that adapter only exists inside an
   OpenBot agent turn. If no row is usable the run stops before claiming, so a
   missing key leaves the job `queued` and the page keeps its honest waiting
   state. It does not retry hot or crash.
3. Claims one job through `public.ops_claim_job` with a 300-second lease. If
   the job's recorded adapter is one of the usable readers, that reader is
   used; otherwise the lowest-priority usable reader is used and its adapter
   and model are recorded when the job finishes.
4. Checks the photo sha256, heartbeats every 30 seconds, and calls the selected
   adapter's `parseRoster` or `parseScores`. A typed instruction goes through
   `interpret`, which parks.
5. Validates the 1.0.0 contract. Valid rows go through `ops_finish_job`, then
   any marks the adapter read go through `ops_stage_marks`; a park goes through
   `ops_park_job` with this worker and attempt. Any error
   goes through `ops_fail_job`, which returns the job to `queued` for attempts
   1 and 2 and parks it at `needs_input` on attempt 3.
6. Writes one JSON line to `/var/lib/openbot/.local/state/ops-worker.log`:

```json
{"ts":"2026-10-31T21:17:39.039Z","claimed":0,"result":"no_reader","duration_ms":130,"note":"openbot_agent_not_installed;manual_needs_human;gemini_vision_disabled"}
```

The line carries the timestamp, the number of jobs claimed, the result and the
duration. It never carries photo bytes, pupil names, or key material. A run
that dies leaves its lease behind; the next claim returns the job to `queued`
after the lease expires, or parks it after the third attempt.

## Adapter boundary

Every provider implements:

```
health()                       -> ok | degraded | down
interpret(instruction, ctx)    -> Intent
parseRoster(input, ctx)        -> StagedRows
parseScores(input, ctx)        -> StagedRows
```

The pipeline calls `api/_ops-adapters.js`, never a vendor. Input is a descriptor
(`filename`, `mime`, `byte_size`, `sha256`, `job_id`), not a secret. A daemon may
also pass the one photo it has already downloaded as `content_b64`; an adapter
without it fetches the bytes through the service-role file reader.

`river_vision` reads a page through the River account in `reader.env` and the
model on its provider row. `gemini_vision` reads through `GEMINI_API_KEY`; it
stays disabled. Both return contract-valid rows: a name is resolved only against
the job's frozen class list, and an unreadable line is flagged, never guessed.

## Versioned JSON contract

Contract version: **1.0.0** (`api/_ops-contract.js`, schemas in `ops-contract/v1/`).

- `intent.schema.json`
- `staged-rows.schema.json`
- `park.schema.json`

Output that does not match is rejected as a failure. It is never coerced.

## Providers

Routing lives in `ops.providers`, ordered by `priority`. Each row has a `role`:

- `reader` may look at handwriting.
- `assistant` may read typed text only and is never selected to read a page.

Current rows:

- `OpenBot agent`, reader, adapter `openbot_agent`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, priority 10, enabled.
- `OpenBot assistant`, assistant, adapter `openbot_agent`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, priority 10, enabled.
- `River vision reader`, reader, adapter `river_vision`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `key_ref` `RIVER_API_KEY`, priority 15, enabled.
- `Gemini vision reader`, reader, adapter `gemini_vision`, model `gemini-3.1-flash-lite`, `key_ref` `FIRST_CHOICE_GEMINI_API_KEY`, priority 20, disabled.
- `Manual (park for a human)`, reader, adapter `manual`, priority 1000, enabled.

The chain picks the lowest-priority enabled row for the role the job needs. A
photo asks for a reader; a typed instruction asks for an assistant. The chosen
adapter and model are written onto the job (`adapter`/`model` or
`assistant_adapter`/`assistant_model`) and into the audit row
`job.reader_selected`, so switching the reader row is visible on the next job
with no code change. Manual stays last, so a missing worker degrades to a human
instead of losing work.

`key_ref` is a secret *name*, resolved by the platform secret store. No key material is
stored in `ops`, in a job, or in the school's code.

## Free-text instructions

The chat has no class, subject, term or section pickers. The active class, term,
session and section come from `ops.active_context()` in one place. A sentence is
parsed by `api/_ops-instruction.js` into class, subject, printed assessment
column, term and scope:

- `record this for JSS2 English language` → JSS 2 / English Language.
- `this is the CA` → `CLASS EXERCISE`; `this is the exam` → `EXAM`.
- `record this for JSS3 mathematics second term` → JSS 3 / Mathematics / 2nd Term.
- `record this for Azeez in Primary 1, 10 marks` → one pupil, one mark, no photo.
- `add this new student to Primary 2` → a pupil proposal only.

An unknown class or subject is never guessed: the reply offers the closest two
real ones in one line and asks. The raw text and the parsed result are both kept
on the job. The first sentence also freezes class, subject set, term and printed
column, plus the school's grade bands and ranges, in the same transaction that
creates the job. A later sentence that disagrees is refused with
`OPS_INSTRUCTION_CONFLICT`, names the fields in force, and offers a new job
instead; it never half-switches a job that is already fixed.

`POST /api/ops-jobs` actions: `text` (parse and stage), `parse` (parse only),
`decide_mark` (resolve one ambiguous cell), and `?context=1` on GET for the
active context.

## Broadsheet and report cards

`POST /api/ops-jobs` with `action: "documents_readiness"` runs every refusal
before a page exists, and `action: "generate_documents"` renders both documents
server-side from the same readiness payload. No browser and no print dialog are
involved. `api/_ops-documents.js` uses `pdfkit` with embedded DejaVu Sans, A4
portrait, black text and a table rule on every row.

- Broadsheet: one row per pupil ordered by admission number, one column per
  subject, then total, average and position. Class size, per-subject average,
  highest and lowest are printed above the table. Ties share a position and the
  rule is printed; a pupil missing a subject is ranked on what they have and
  marked with an asterisk, never zero-filled.
- Report cards: one page per pupil, built only from that pupil's broadsheet row,
  in the same admission-number order. A card prints the mark as written, the
  grade and descriptor from the school's own bands, and the school's remark.
- The school's bands are written out of 100. When a column is only out of 30 or
  70, the grade is the same band applied to the mark as a percentage of the
  column's maximum; the printed mark is never rescaled. This note is printed on
  the card.
- Finished files are stored in `ops.job_files` with `kind = 'document'`, their
  page count, byte size, sha256 and `document_type`, and the set is recorded on
  `ops.jobs.document_set`. `template_version` is frozen at creation
  (`2026-10-31.1` for the pilot).
- File names follow
  `{school}-{class}-{subject|broadsheet}-{session}-{term}-{template_version}.pdf`.
- Generation is one key. `published_at` is separate and stays null; nothing is
  sent to a parent here.

Refusals are returned as `409` with every offending row named:
`OPS_ROWS_PENDING`, `OPS_SUBJECT_EMPTY`, `OPS_PUPIL_COUNT_MISMATCH`,
`OPS_MARK_RANGE`, `OPS_TOTAL_MISMATCH`. Nothing half-built is stored.

`action: "copy_accepted"` makes a throwaway `is_proof_copy` job from one job's
accepted rows, with its own frozen roster of exactly those pupils. Only that
kind of job can be removed (`action: "delete_job"` → `OPS_NOT_PROOF_COPY` for a
real job). This is how the renderer is proved without touching a real job.

## Individual entry and pupil proposals

An individual entry creates the same staged row and mark as a photo job, with
the same approval gate; it never writes `public.scores`. A new-pupil sentence
creates a row in `ops.pupil_proposals` with status `blocked` and returns
`live_write:false`; creating a pupil is a live write and stays off in this
pilot.

## Metering

Credits are counted once per job outcome at the gateway, not inside adapters. Retries are
free and a vendor swap does not change the charge.

The tables are data, not code, and all three live in `ops`:

| Table | Holds |
|---|---|
| `ops.work_types` | One row per kind of work: `names`, `names_marks`, `names_marks_documents`, each with a credit value and an `is_placeholder` flag. Change a credit value here and every later charge uses it; no deploy. |
| `ops.school_plans` | One row per school: plan name, credits per period, period start, status. First Choice is seeded as `First Choice pilot`; the allowance is a **labelled placeholder**, not a price. |
| `ops.credit_ledger` | One row per charge: job id, school, plan, work type, credits, `balance_after`, and the time. `job_id` is `UNIQUE`, so the database itself refuses a second charge for the same job. |

Where the charge lands: approval (the gateway) calls `ops.charge_job` in the same
transaction that marks the job finished. The work type is chosen from what the job
actually produced — documents present, marks read, or names only — and its price is
read from `ops.work_types` at that moment. A job parked at `needs_input` never reaches
this point and is never charged. Re-confirming an approved job, a provider retry, or a
second page render finds the existing ledger row and adds nothing. `balance_after` is
stored so the finished card can say `Used 1 credit · 214 left` without recalculating.

The balance is `credits_per_period` minus ledger charges since `period_start`, clamped
at zero, exposed by `ops.credit_balance` / `public.ops_credit_balance`. It appears in the
chat header, refreshed after every approval.

Every new job carries an explicit `school_id` from the signed-in developer's staff
profile; `public.ops_jobs_create` refuses a null or inactive school instead of looking one
up. A proof copy inherits its source job's school and refuses a source with no school.
`ops.current_plan` matches the exact school id only: a missing id or a school with no
active plan returns no plan, never the earliest plan. The charge path checks the job's
school, the plan's school and the plan status before writing; a mismatch or missing plan
writes no ledger row and returns a plain sentence. The header and context balance use the
same signed-in school id.

Zero balance: creating a new job (`create`, `text`, `add_student`, `individual`,
`copy_accepted`) is refused with `OPS_NO_CREDITS` and one calm sentence that says the
open jobs will still finish and Thiago can top up the plan. Upload, decide, mark
resolution, document generation and approval are never gated, so a job already in
flight always finishes. A charge that would take the balance below zero records the real
credits and stores `balance_after = 0`; the ledger's check constraints refuse any
negative `credits` or `balance_after`. There is no payment provider, no card handling and
no invoicing: this is accounting only.

The seed values in `20261031210000_ops_metering.sql` are placeholders for the school to
replace: 250 credits per period, and 1 / 2 / 3 credits for the three work types. Do not
present them as prices. Reversal is still one statement: `drop schema if exists ops cascade;`.


## Reproducibility

`ops.jobs.adapter`, `model`, `contract_version`, and `response_hash` record what produced
the output. `response_hash` is the sha256 of the raw adapter response.
