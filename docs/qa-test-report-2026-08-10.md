# First Choice Result Portal — QA readiness report

Run date: 10 August 2026  
Portal: https://first-choice-result-portal.vercel.app  
Supabase project: `gnixdjglpsaarlrzqgdg`  
Run type: read-only preflight and parallel persona audit

## Executive result

The deployment is reachable and the protected data boundary is responding correctly to anonymous and invalid-origin requests. The portal is **not yet ready for a destructive, authenticated term-transition run**.

Three independent QA personas reviewed the repository and live endpoints in parallel:

- Management persona: staff management, invite control, settings authorization, demo-data safety, and term activation.
- Teacher persona: classes, SS department selection, students, OCR, score entry, publishing, traits, remarks, broadsheet, progress, and refresh behavior.
- Report-card persona: settings propagation, assessment columns, fees, attendance, traits, remarks, and the three templates.

No cloud records were created, deleted, or changed during this run.

## Verified gates

| Gate | Result |
|---|---|
| Portal deployment responds | Pass — HTTP 200 |
| Auth status endpoint responds | Pass — HTTP 200 in the current local-auth design |
| Anonymous result-data request rejected | Pass — HTTP 401 |
| Invalid-origin result-data request rejected | Pass — HTTP 403/401 boundary response |
| Protected-access contract | Pass |
| Three report-card templates present | Pass — Modern, Creative, Premium |
| Assessment settings feed score entry/broadsheet/report-card columns | Pass by source audit |
| Positive signed-in management workflow | Not run — no authorized test session available |
| Positive signed-in teacher workflow | Not run — no authorized test session available |

## Release blockers and follow-up items

The initial audit recorded teacher testing as pending because public signup was rate-limited. That item was completed later through two auto-confirmed QA users; see the authenticated teacher smoke run below.

1. Positive cloud testing with separate teacher personas is still pending. Supabase Auth rate-limited the disposable teacher registrations, so staff restrictions, activity tracking, promotion/removal, and suspension have not been positively verified from a teacher session.
2. The next-term path is now protected and synchronized: the API writes the configuration and official academic context together, resets the active class to the homepage fallback, and restores the previous configuration if the context write fails. It was intentionally not activated during this QA run. A database transaction/RPC would still be the strongest future guarantee.
3. `history.*` remains a read-only placeholder and returns no historical rows; archived-history verification is therefore limited.
4. `results.unpublish` is now explicit, and unsupported actions now return `RESULT_ACTION_NOT_SUPPORTED` instead of a false success.
5. The staff-profile insert bootstrap policy now requires a new profile to be a non-developer `staff` profile. Apply `docs/first-choice-supabase-bootstrap.sql` to the First Choice Supabase project if that policy has not already been run there.
6. Demo loading is now idempotent for the labelled names. Existing duplicate demo rows from the earlier smoke run remain visible so the owner can cross-check them; they should be cleared only after review.
7. OCR uses a browser-held Gemini key and camera capture is disabled by the current Permissions-Policy. OCR must not be treated as production-ready until that boundary is corrected.
8. The assessment UI is dynamic, but a full cross-module score validation pass is still required whenever management changes CA/exam totals.

9. Published-score governance is now fail-closed for ordinary staff: teachers
cannot edit a published subject; they must unpublish it before correction.
Results management retains an explicit correction path. A durable score-change
history/audit log remains a future database migration item.

## Confirmed source-level behavior

- The three selected report-card layouts use the same live content builder.
- CA count and per-CA marks are consumed by score entry, broadsheet, and report-card column generation.
- School identity, attendance, traits, remarks, fees schedule, signature, and selected template are wired into report-card rendering.
- The current portal has a labelled demo-data loader. The authenticated smoke run loaded the dataset, and the loader now checks existing labelled names before creating rows.
- Saved grade-scale values are restored from configuration, and report-card fee visibility now follows the configured session setting.
- Management-only guards cover app settings, academic context changes, term activation, staff actions, and invite actions.

## Authenticated teacher smoke run

Public email signup was rate-limited by Supabase Auth, so two auto-confirmed QA teacher users were created directly in the First Choice Supabase Authentication panel. Both now have active ordinary `staff` profiles and are not developers.

The live RLS policy was corrected after the first teacher test exposed a mismatch: the portal allowed score entry, but the database allowed only management writes. Staff can now write classroom students, scores, traits and remarks, and publish/unpublish result subjects; fees, settings and the official academic context remain management-controlled.

| Live check | Result |
|---|---|
| Primary teacher sign-in | Pass — ordinary School Staff / Result access role |
| Secondary teacher sign-in | Pass — ordinary School Staff / Result access role |
| Staff navigation restriction | Pass — Settings and Management access are hidden |
| Primary 2 class entry | Pass for both teacher personas |
| Score entry | Pass — CA1 change persisted after save and refresh with no false failure message |
| Registered staff profiles | Pass — two active non-developer staff rows confirmed in Supabase |

## Follow-up defect found and fixed

The owner’s clean Primary 3 card test exposed `Failed to load card data`, which was not caught in the earlier smoke run. Root cause: the API hardening correctly rejected unknown actions, but the card page still called `report_cards.generate` and exports used `results.export` as non-writing validation actions. Those actions are now explicitly supported and return read-only success.

| Follow-up check | Result |
|---|---|
| Primary 3 card from clean management session | Pass — card content, subjects, traits, fees and remarks rendered |
| Manager writes a score | Pass — score changed to 12 and displayed Saved |
| Separate teacher session reads the same score | Pass — score 12 appeared in the subject sheet with no failure message |

## Authenticated management smoke run

The owner’s signed-in developer/management session was used for a controlled smoke run. The run was not allowed to activate the next term.

| Live check | Result |
|---|---|
| Demo seed | Pass — 44 labelled pupils across 22 class groups, with photos, scores, published subjects, traits, fees and remarks |
| Class entry | Pass — Primary 2 loaded with demo records |
| Score save | Pass — edited score persisted and displayed as Saved |
| Refresh while inside score sheet | Pass — the same subject sheet reopened and the edited score remained present |
| Unpublish / publish | Pass — subject changed to Draft, then returned to Published |
| SS department routing | Pass — SS1 opened General, Science, Arts and Commercial choices; SS1 Science loaded with records |
| One-CA mode | Pass — score entry showed CA1 and Exam only |
| Three-CA mode | Pass — score entry showed CA1, CA2, CA3 and Exam |
| Two-CA restoration | Pass — management setting restored to the original 2-CA configuration |
| Broadsheet | Pass — dynamic CA1/CA2 columns and saved values rendered |
| Report card | Pass — subjects, CA1/CA2, exam, totals, traits, next-term fee schedule and remarks rendered |
| Three templates | Pass — Alternative 1, Alternative 2 and Alternative 3 were each selected and restored to Alternative 2 |
| Management overview | Pass — currently reports 0 registered staff accounts |

## Remaining run blockers and newly detected issue

- Teacher activity tracking, admin promotion/removal, and suspension were not yet positively exercised.
- The earlier repeated demo load created duplicate `Demo Pupil - ...` records; the current Primary 2 smoke class showed six pupils. The loader is now idempotent for future runs, but those existing rows remain for owner review.

## Required next test pass

The next pass should use a clearly labelled QA run, for example `QA-2026-08-10`, with:

- one school-management test account;
- at least two teacher test accounts assigned to different classes;
- 20–30 labelled mock pupils per selected class;
- score, trait, remark, attendance, publication, and report-card checks from separate sessions;
- verification from a second browser/device before any term change;
- three report-card exports, one for each available template;
- only after all checks pass, a management-confirmed term transition with a captured before/after configuration snapshot.

The QA records should remain labelled and visible for the owner’s cross-checking. They should be removed only after the owner confirms that review is complete.
