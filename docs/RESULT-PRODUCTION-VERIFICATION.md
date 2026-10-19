# Result Production Verification

**Status: PASSED â€” production verification complete for the Result hardening
release.** The reported Central Registry management denial was traced to a
missing canonical permission on the existing approved management grant. The
grant and both application-side gates are now aligned. No academic record was
changed.

## Baseline

The live pre-RLS baseline was captured without changing records:

| Record set | Count |
| --- | ---: |
| Students | 798 |
| Scores | 14303 |
| Traits | 17520 |
| Remarks | 757 |
| Fees | 757 |
| Published subjects | 300 |
| Result profiles | 25 |
| Invite codes | 1 |
| Active Result grants | 25 |
| Active Result scopes | 0 |

The before and after counts are identical. The empty scope count is intentional:
no class or subject assignment was invented for this correction.

## Automated checks

- Result protected endpoint rejects a request without the Result session.
- Result protected endpoint rejects an unapproved Origin.
- Result client JavaScript parses successfully.
- Browser legacy boundary scan confirms no active Supabase Data API helper,
  Base64 password comparison or trusted localStorage Result session write.
- Existing production pages and protected API deployment remain available.
- Direct anonymous REST reads for all nine migrated tables returned HTTP 401.
- RLS is enabled with one deny policy per migrated table and no anonymous table
  `SELECT`, `INSERT`, `UPDATE` or `DELETE` privilege.
- Post-migration counts exactly match the baseline above.
- Central and School Platform browser contract scans contain no direct browser
  Supabase RPC login, opaque client-secret storage or Result localStorage
  authority path.
- The exact Result permission contract distinguishes `traits.enter` from
  `scores.enter` and `results.unpublish` from `results.publish`; an explicit
  `results.manage` grant remains the documented broad management permission.
- The existing approved primary Central Registry grant contains the canonical
  `central_registry.administer` permission. No identity, duplicate role,
  duplicate grant or Result grant was created.
- Result login derives `central_registry_management_allowed` through a guarded
  server RPC; the Central Registry session route repeats the canonical
  management check for existing sessions and login issuance.
- The focused Result sidebar and Central Registry management-gate contracts
  pass, including fail-closed behavior when the capability check errors.

## Authorised real-account verification

The authorised super-administrator verification passed without changing
academic records for:

- Central WTS login;
- dashboard loading;
- class loading;
- score visibility;
- report-card generation and printing; and
- mobile access.

The correction was verified through the live existing grant, server-side
management gate, protected deployment contracts and post-correction data
counts. No score write, publishing change, assignment mutation, revocation
mutation or password change was performed for testing. The existing Result
calculations and report-card design were not rebuilt.

The Result Portal is ready for the next PKCE SSO implementation phase. PKCE is
not implemented in this release, and Attendance and Notification remain out of
scope.

