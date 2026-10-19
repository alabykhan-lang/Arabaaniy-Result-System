# Result Legacy Migration Complete

## Completed

- Result login no longer accepts legacy browser passwords or first-password
  setup.
- Result sessions are accepted only through the server-managed HttpOnly cookie.
- The browser no longer sends Result table requests to the Supabase Data API.
- Legacy database helper names fail closed when called without the central
  session boundary.
- The prior transitional Result emergency gate was retired from Supabase; it
  is no longer an authentication or legacy-access authority source.
- The Result UI no longer exposes Legacy Login, Register, invite rotation or
  browser role changes. Result account and scope administration is performed
  in Central Registry.
- The browser no longer persists Result settings or credential-like values in
  localStorage. Navigation state in sessionStorage is display state only.
- Result reads, writes, publishing, report-card authorization and exports use
  protected server actions.
- The nine high-risk Result tables have individual RLS migrations and reviewed
  rollback SQL in the Central Registry repository.
- The shared permission catalog now contains the exact Result contract,
  including `traits.enter`, `results.unpublish`, `result_users.manage` and
  `result_settings.manage`.
- The Central Registry management link is now derived from a server-validated
  `central_registry_management_allowed` result. It is not inferred from the
  Result grant, a browser role, or local storage.
- The Central Registry session endpoint rejects management access unless the
  current active grant contains a canonical management permission. The
  existing approved primary management grant was corrected to include
  `central_registry.administer`; no identity, role, assignment or duplicate
  grant was created.

## Remaining compatibility

- The old Result database functions remain in the database for controlled
  rollback and server adapters; their inputs still require a validated session
  where exposed.
- Report-card markup, calculations and PDF rendering remain in the browser after
  protected data retrieval.
- Central Registry management and record adapters use the host-only session
  cookie. School Platform workspace sign-in also uses a server-issued
  HttpOnly cookie; opaque client credentials are not stored in the browser.
- Provider-key/OCR processing requires a server-side provider configuration and
  is not enabled from browser storage.

No identity, student, class, score, scope assignment or academic record was
created by this migration. The one existing approved management grant was
updated idempotently to restore its missing canonical permission, with an
audit event and no change to existing Result grants or data.

