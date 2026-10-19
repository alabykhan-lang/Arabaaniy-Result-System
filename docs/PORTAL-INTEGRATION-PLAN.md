# Result Portal Integration Plan

**Status:** Result Portal PKCE SSO is implemented on `main`; production deployment verification is in progress.

## Boundary

The School Platform is the WTS Workspace and central entry point. Central Registry remains the authority for people, staff status, credentials, grants and scopes. Result Portal remains a separate application and repository.

The browser does not receive a central password, service-role key, client secret, password hash or reusable central session secret. Attendance and Notification are deliberately unchanged.

## Current flow

1. WTS Workspace shows Results only from a current active `results` grant.
2. Result Portal starts a browser PKCE request with S256, state and nonce.
3. `wts-school-platform.vercel.app/api/sso/authorize` requires the WTS Workspace session and exact Result client/callback.
4. Supabase stores only the authorization-code, state and nonce hashes. The code expires after five minutes and is single-use.
5. Result Portal posts the code and verifier to `/api/result-sso-token`.
6. Supabase revalidates the central session linkage, person, employment, identity account, active credential, Results grant and Result profile mapping.
7. Result Portal creates its own host-only HttpOnly session cookie.
8. Existing protected Result APIs continue to enforce server-side permissions and class/subject scopes.

## Fixed allowlist

- Client: `result_portal`
- Target: `results`
- Method: `S256`
- Callback: `https://wts-result-system.vercel.app/portal_core.html`

No wildcard redirect or credentialed wildcard CORS is used.

## Login and logout

A direct Result visit with no valid Result session starts the central redirect. There is no normal Result password form, public Legacy Login or Register. Result logout revokes the Result session, clears its cookie and returns to Workspace. WTS Workspace and Central Registry logout revoke linked Result sessions.

The old public Result-password RPC is no longer executable by anonymous or authenticated Data API roles. Password management remains a central WTS function.

## Data preservation

No student, score, trait, remark, fee, publication, report-card, identity or grant records are created or changed by the SSO integration. Attendance and Notification are outside the source and database changes in this phase.
