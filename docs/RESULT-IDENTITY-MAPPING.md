# Result Identity Mapping

**Status:** Implemented against the existing live identity records

## Canonical mapping

The Result Portal does not identify staff by name. The server resolves the
existing mapping through these keys:

`user_profiles.id`
-> `staff_attendance_profiles.user_profile_id`
-> `school_identity_accounts.legacy_user_profile_id`
-> `school_identity_accounts.person_id`
-> `school_identity_credentials.person_id`
-> `attendance_admin_clients.central_person_id`

The central identity is `school_people.id` / `person_id`. The Result profile is
`user_profiles.id`. No duplicate staff identity is created by this phase.

## Live verification

The current production inspection resolved all 25 existing Result user profiles
to one central person identity each. No ambiguous mapping was accepted. The
Result profiles, central accounts, credential records and attendance identity
links remain the existing real records.

The database also confirms that Supabase Auth is not the current staff identity
source for these users. The new Result path therefore validates the Central
Registry credential and central person identity directly; it does not pretend
that an `auth.users` ID exists where it does not.

## Resolver checks

`school_result_identity_resolve(person_id, identity_account_id)` returns only a
safe Result profile and staff mapping after checking:

- exactly one Result `user_profiles` mapping;
- matching `legacy_user_profile_id` and `person_id`;
- active person and staff registration;
- active employment status;
- active identity account;
- optional identity-account match supplied by the session.

It returns a safe failure for no match, more than one match, inactive staff,
inactive account or inactive employment. It never falls back to email or name
matching.

## Grant checks

Identity mapping is not access. A mapped person must also have a current active
`school_access_grants` record for `app_code=results`. Grant validity dates,
revocation/status and the permission list are rechecked while validating every
Result session. The Result role string is retained for compatibility display;
the server uses permissions and scopes for decisions.

## Scope checks

Teacher-style actions require active `school_staff_access_scopes` rows for the
requested class and, for subject-result actions, subject. New assignments carry
the real academic session and term in the existing metadata column and are
managed through the Central Registry access screen. The current live scope
table has no assigned rows, so non-management staff are intentionally
restricted until management assigns real scopes. No broad teacher access was
invented.
