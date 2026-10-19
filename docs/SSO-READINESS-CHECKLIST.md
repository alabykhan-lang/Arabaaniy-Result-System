# SSO Readiness Checklist

**Current decision:** READY FOR THE NEXT PKCE SSO PHASE. PKCE is not implemented
or enabled by this Result hardening release.

## Required before SSO

- [x] Central credential recovery and compulsory password-change flow is
  complete for all real staff accounts.
- [x] Every active Results user has exactly one verified central person mapping.
- [x] Management can assign, edit, revoke, restore and inspect real class and
  subject scopes. No scope was invented for this release; the live scope table
  remains empty.
- [x] Protected Result reads have completed parity tests for students, scores,
  traits, fees, remarks and published subjects.
- [x] Report-card generation and export perform server-side action checks before
  protected central-auth rendering/download workflows.
- [x] Central Registry management RPCs have completed migration from the
  transitional attendance-admin-client session to session-native adapters.
- [x] Remaining legacy writes and unrestricted Data API reads are migrated or
  protected by tested RLS policies.
- [x] Attendance and Notification are not included in the SSO rollout until
  their own identity and provider readiness reviews are complete.
- [x] Logout, grant revocation, staff suspension and session revocation have
  cross-application tests.

## Current gate result

The Result Portal production verification is **PASSED**. Automated boundary,
permission, deployment and RLS checks pass, and the authorised real
super-administrator verification passed for login, dashboard, class loading,
score visibility, report-card generation/printing and mobile access. The
Central Registry management capability is now granted through the existing
approved grant and enforced server-side on both menu data and direct URL
access. The live Result scope table remains empty by design; no assignment was
created by this phase.

This is a readiness gate for implementing PKCE next, not approval to begin
Attendance or Notification integration and not evidence that PKCE has already
been deployed.

## URL and browser requirements

Future hosts are expected to be:

- `portal.waytosuccessschools.com`
- `results.waytosuccessschools.com`
- `registry.waytosuccessschools.com`
- `attendance.waytosuccessschools.com`
- `notify.waytosuccessschools.com`

The Result and Central Registry cookies are currently host-only and do not cross these hosts. A
shared parent-domain cookie must not be introduced until its scope, theft
impact, `Secure`, `HttpOnly`, `SameSite` and CSRF controls are reviewed. API
routes must use explicit Origin allowlists; wildcard credentialed CORS is not
acceptable.

The preferred future handoff is a short-lived, single-use authorization code
with PKCE or an equivalent server-to-server exchange. The code must be stored
hashed, bound to the target audience and redirect URI, expire quickly, and be
redeemed only once. Raw reusable session secrets must never appear in URLs.

## Direct module visits

After readiness approval, a direct visit to a specialist module should redirect
to central authentication when no valid local session exists. The specialist
application must still validate the resulting central identity and its current
grant; a redirect alone is not authorization.

