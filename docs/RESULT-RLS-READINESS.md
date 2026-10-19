# Result RLS Readiness

RLS is a table-by-table release gate. The Result client boundary is now
fail-closed for all legacy browser table operations. Each live RLS migration
must still be applied and verified independently; this document does not
authorize a global toggle.

| Table | Protected central replacement | Legacy dependency | RLS status |
| --- | --- | --- | --- |
| `students` | `read.students`, `students.upsert`, `students.archive` | No active browser Data API path | Enabled and verified |
| `scores` | `read.scores`, `scores.enter` | No active browser Data API path | Enabled and verified |
| `traits` | `read.traits`, `school_result_traits_update` | No active browser Data API path | Enabled and verified |
| `remarks` | `read.remarks`, `school_result_remarks_update` | No active browser Data API path | Enabled and verified |
| `fees` | `read.fees`, `school_result_fees_update` | No active browser Data API path | Enabled and verified |
| `published_subjects` | `read.published_subjects`, `results.publish` | No active browser Data API path | Enabled and verified |
| `settings` | `school_result_settings_read`, app-config adapter | No active browser Data API path | Enabled and verified |
| `user_profiles` | Protected Result administration actions | No active browser Data API path | Enabled and verified |
| `invite_codes` | Protected Result invite actions | No active browser Data API path | Enabled and verified |

## Rollout gate

For each table, the matching protected replacement was deployed, the named
migration was applied, direct REST reads returned HTTP 401, protected
unauthenticated calls returned `RESULT_SESSION_REQUIRED`, and post-change
counts matched the baseline. Never use a broad policy as a temporary substitute
for a missing assignment.

## Rollback

If a table causes an operational regression, disable the affected UI/API route,
revert the policy change through a reviewed migration, and confirm counts and
report-card output. Do not restore unrestricted writes or drop identity/session
tables. See `RESULT-ROLLBACK-PLAN.md`.
