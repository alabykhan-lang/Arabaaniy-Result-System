# Result Security Migration Plan

## Completed in this phase

- Added central Result identity resolution and fail-safe mapping checks.
- Added central Result login without an SSO redirect.
- Added unique server-side Result sessions with expiry, last-seen and revocation
  fields; raw session secrets are hashed in the database.
- Added server-side permission and class/subject scope authorization.
- Added protected server routes for login, logout and Result actions.
- Added protected Result read adapters for students, classes, subjects, scores,
  traits, remarks, fees, published subjects, summaries and report-card source
  data.
- Added explicit report-card generation and export authorization checks before
  protected browser rendering/download workflows.
- Added context-aware class/subject assignment adapters and management UI in
  Central Registry.
- Added Central Registry credential activation/recovery UI using the audited
  temporary-credential routine through a session-native management adapter.
- Added server-side Central Registry session adapters using host-only HttpOnly
  cookies. Result scope reads/writes and credential issuance use session-native
  adapters; the Result browser has no role or invite administration surface.
- Routed publishing, score, trait, remark, fee, student and app-config writes
  through protected RPCs. Legacy role and invite mutation is fail-closed.
- Rejected destructive Result user deletion; central deprovisioning is required.
- Revoked anonymous/authenticated direct writes to `user_profiles`,
  `invite_codes` and `published_subjects`.
- Disabled first-supplied legacy passwords and self-registration in the Result
  browser client.
- Added security headers and an explicit Origin allowlist for Result API routes.

## Still transitional

The following items remain transitional:

- report-card markup and calculations remain client-side after protected reads;
  server-side action authorization is present, but a server-rendered report
  artifact is not yet implemented;
- Central Registry student/staff/guardian record adapters and Result scope,
  credential and module-access management use session-native routes;
- provider-key/OCR processing requires a server-side provider configuration;
  browser provider secrets are no longer accepted.

RLS is applied per table through the Central Registry migrations. No broad
policy is used for an unassigned Result account.

## Next migration sequence

1. Verify each live RLS migration and protected read/write route.
2. Verify real class and subject scope assignments through Central Registry and
   verify denial for unassigned teachers.
3. Run authorised real-account workflow verification without changing results.
4. Complete server-side provider configuration and report artifact review.
5. Re-audit the shared-domain cookie and begin PKCE only after every checklist
   item is passed.
