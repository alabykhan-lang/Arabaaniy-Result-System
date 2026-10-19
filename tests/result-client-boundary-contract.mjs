import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../portal_core.html", import.meta.url), "utf8");

assert.equal(/supabase\.co|\/rest\/v1|supabase-js/i.test(source), false, "Result browser source contains a direct Supabase boundary");
assert.equal(/localStorage|wts_pw_|base64 browser password/i.test(source), false, "Result browser source retains browser-persisted authority or data");
assert.equal(/Legacy Login|self-registration|first-password browser setup/i.test(source), false, "Result browser source retains a legacy authentication surface");
assert.equal(/id=["']page-admin["']|loadAdminPanel|invite_codes|user_profiles/i.test(source), false, "Result browser source retains legacy administration UI");
assert.match(source, /School Result Portal|Sign In|secure.*sign-in/i);
assert.match(source, /\/api\/result-auth/);
assert.match(source, /\/api\/result-data/);
assert.equal(source.includes('id="modal-term-session"'), false, "Result still exposes an editable academic session field");
assert.match(source, /academic_history/);
assert.match(source, /CONTEXT_READ_ONLY/);
assert.match(source, /RESULT_MUTATING_ACTIONS/);
assert.match(source, /Official current context/);

console.log("Result client protected-boundary contract passed");
