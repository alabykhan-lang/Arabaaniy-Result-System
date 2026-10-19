import assert from "node:assert/strict";

const baseUrl = process.env.RESULT_PORTAL_URL || "https://wts-result-system.vercel.app";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  return { response, payload };
}

const unauthenticated = await request("/api/result-data", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "read.students", payload: {} }),
});
assert.equal(unauthenticated.response.status, 401);
assert.equal(unauthenticated.payload.code, "RESULT_SESSION_REQUIRED");
assert.equal(Object.hasOwn(unauthenticated.payload, "session_secret"), false);

const invalidOrigin = await request("/api/result-data", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
  body: JSON.stringify({ action: "read.students", payload: {} }),
});
assert.equal(invalidOrigin.response.status, 403);
assert.equal(invalidOrigin.payload.code, "ORIGIN_NOT_ALLOWED");

console.log("Result protected access contract passed");
