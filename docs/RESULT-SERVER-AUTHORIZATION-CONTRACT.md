# Result Server Authorization Contract

**Status:** Phase 2 central-auth data boundary, no cross-origin SSO redirects

This contract is the server-side boundary for the Result Portal. The browser may
request an operation, but the browser role, hidden controls, cached user object
and URL are never authorization evidence.

## Request flow

1. `POST /api/result-auth` with `action=login` sends the staff login to
   `school_identity_result_login`.
2. The server receives the opaque session secret once and sets a host-only,
   `HttpOnly`, `Secure`, `SameSite=Lax` cookie named `wts_result_session`.
3. The browser calls `POST /api/result-data` with an action and JSON payload.
4. The server extracts the cookie and calls `school_result_api`, or the narrow
   protected RPC for fees, configuration or settings reads.
5. The database validates the session, central person, employment, identity
   account, current Results grant, action permission and required scopes before
   changing Result data.

No session secret is returned to browser JavaScript, placed in a URL, or stored
in `localStorage`. Logout calls `school_identity_session_revoke` and clears the
cookie.

## Protected actions

| Portal action | Required permission | Scope/context |
| --- | --- | --- |
| Legacy Result account/invite actions | retired | Central Registry is the only staff/grant management surface; retained compatibility calls fail closed |
| `results.publish` | `results.publish` | academic session, term and class/subject scope |
| `results.unpublish` | `results.unpublish` | academic session, term and class/subject scope |
| `scores.enter` | `scores.enter` or canonical result-entry permission | session, term, class and subject |
| `traits.enter` | `traits.enter` | session, term and class scope |
| `remarks.enter` | `remarks.enter` or canonical result-entry permission | session, term, class and subject |
| `fees.update` | `results.manage` | active student/class and academic context |
| `students.upsert` | `results.manage` | server whitelist of mutable fields |
| `students.archive` | `results.manage` | soft archive; no destructive delete |
| `settings.read` | `result_settings.manage` (or explicit broad `results.manage`) | sensitive provider key excluded |
| `settings.app_config.update` | `result_settings.manage` (or explicit broad `results.manage`) | provider key preserved server-side |
| `results.review` | `results.review` | class/subject scope when not broad management |
| `results.approve` | `results.approve` | class/subject scope when not broad management |
| `report_cards.generate` | `report_cards.generate` | class/subject scope when not broad management |
| `results.export` | `results.export` | class/subject scope when not broad management |

The exact Result permission definitions are in the Central Registry catalog.
This phase creates no permission grants and does not infer access from a
legacy `admin` or `teacher` string. `results.manage` is an explicit broad
management grant, not a browser role claim.

Published-score lock: once a subject is published, ordinary staff cannot edit
its score rows. A correction requires unpublishing the subject first; an
authorized Results manager may correct a published score. This prevents silent
post-publication teacher changes while preserving an explicit management
correction path.

## Database entry points

- `school_identity_result_login`
- `school_identity_sessions`
- `school_identity_session_validate`
- `school_identity_session_revoke`
- `school_result_identity_resolve`
- `school_result_authorize`
- `school_result_api`
- `school_result_read_api`
- `school_result_traits_update`
- `school_result_remarks_update`
- `school_result_fees_update`
- `school_result_app_config_update`
- `school_result_settings_read`

The resolver and core authorizer are service-only database entry points. The
publicly callable RPCs require a session identifier and secret, and execute as
security-definer functions with a fixed search path. Direct access to the new
session table is denied and RLS is enabled.

## Failure behavior

The boundary denies access when the session is absent, expired, revoked or
audience-mismatched; the person, staff registration, employment or identity
account is inactive; the Results grant is absent or revoked; the Result user
mapping is missing or ambiguous; or a required class or subject scope is not
active. A teacher with no real scope assignment receives a restricted denial;
the system does not grant all classes by default.

## Protected data boundary

Central-auth browser reads for students, classes, subjects, scores, traits,
remarks, fees, published subjects, summaries and report-card source data use
`school_result_read_api`. Central-auth trait and remark writes use their narrow
adapters rather than the generic browser upsert helper. Report-card generation
and exports perform explicit action checks before data is rendered or
downloaded. The complete resource matrix is in
`RESULT-PROTECTED-DATA-ACCESS.md`.

## Transitional behavior

The legacy Result login, first-password setup, self-registration and Result
browser account administration are retired. Retained database compatibility
functions are server-only, RLS-protected and guarded against legacy role/invite
mutation. Direct reads and writes are not an authorization fallback.
