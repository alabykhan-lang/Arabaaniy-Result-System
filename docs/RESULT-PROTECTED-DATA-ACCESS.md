# Result Protected Data Access

**Status:** Phase 3 protected data boundary, no PKCE SSO

## Request boundary

Central-auth Result browser requests use `POST /api/result-data`. The route
reads the host-only `HttpOnly; Secure; SameSite=Lax` Result cookie and forwards
only an allowlisted action to a guarded database function. The browser role,
localStorage object, hidden control or URL is not authorization evidence.

## Protected reads

`read.students`, `read.classes`, `read.subjects`, `read.scores`,
`read.traits`, `read.remarks`, `read.fees`, `read.published_subjects`,
`read.result_summary` and `read.report_card` resolve through
`school_result_read_api`.

The adapter filters by the supplied class, student, subject, academic session
and term. It returns only selected columns and excludes archived students from
active reads. It requires a valid session, active person and staff record,
active employment, active identity account, active Results grant, the required
permission and applicable class/subject scope.

## Protected writes

Central-auth writes use these server-side actions:

- `scores.enter` -> `school_result_api`
- `traits.enter` -> `school_result_traits_update`
- `remarks.enter` -> `school_result_remarks_update`
- `fees.update` -> `school_result_fees_update`
- `students.upsert` and `students.archive` -> `school_result_api`
- `results.publish` -> `school_result_api`
- `results.unpublish` -> `school_result_api` with a separate permission check
- `settings.app_config.update` -> `school_result_app_config_update`
- `settings.read` -> `school_result_settings_read`
- `result_settings.manage` -> protected settings adapters
- Result account and scope administration -> Central Registry session-native
  management adapters; the Result portal does not write `user_profiles` or
  `invite_codes`.

Writes validate academic session and term where applicable, check student/class
membership, enforce numeric ranges and record Result audit events. Student
removal is a soft archive; hard deletion is not exposed by the protected path.

## Report cards and exports

`report_cards.generate` is checked before card data is loaded. `results.export`
is checked before broadsheets, progress reports, analytics, subject awards and
backup downloads. Central-auth exports are restricted to the active class cache
and do not export other classes loaded in the browser.

Calculations, card markup, publishing behavior and existing data are unchanged.
The database remains the source of truth for protected reads.

## Compatibility boundary

The Result Portal legacy login, browser password values, localStorage session
fallback, direct Data API operations and browser role/invite administration are
retired. Retained database compatibility code is protected by the server
boundary, deny-by-default RLS and legacy mutation guards. A protected request
without the central HttpOnly session is rejected.

Report-card and analytics calculations remain client-side after protected source
reads. Provider-key/OCR processing requires future server-side provider
configuration before it can be enabled.

The nine Result tables are rolled out with deny-by-default RLS migrations in
the shared Central Registry repository. The RLS matrix and rollback reference
are recorded in `RESULT-RLS-ROLLOUT.md` and the Central Registry rollback file.

The former transitional Result emergency gate has been retired from the shared
database. It cannot restore legacy Result access or bypass WTS Staff Login.

## Central Registry management boundary

The Result sidebar does not use `results.manage` as a proxy for Central Registry
authority. The protected Result session response obtains a boolean from
`school_result_central_management_access`, which validates the active Result
session and the same person's active Central Registry management grant. The
Central Registry link is hidden by default and is rendered only for a positive
server response.

The Central Registry `/api/registry-session` route repeats the canonical
permission check for both existing sessions and login issuance. A direct visit
or forged browser state therefore receives `MANAGEMENT_ACCESS_DENIED`; menu
visibility is not the security boundary. The approved existing primary
management grant was restored with `central_registry.administer` and no new
identity, role, scope or Result grant was created.

