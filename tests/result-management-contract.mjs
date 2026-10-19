import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const portal = await readFile(new URL('../portal_core.html', import.meta.url), 'utf8');
const dataApi = await readFile(new URL('../api/result-data.js', import.meta.url), 'utf8');

// This school portal owns Results management. Central Registry management is
// deliberately out of scope and must never be inferred from a browser role.
assert.match(portal, /results-management-only/);
assert.match(portal, /CURRENT_CENTRAL_MANAGEMENT_ALLOWED=false/);
assert.match(portal, /document\.body\.classList\.remove\('central-management-mode'\)/);
assert.match(dataApi, /requireManagement\(token\)/);
assert.match(dataApi, /management\.staff\.list/);
assert.match(dataApi, /management\.staff\.update/);
assert.match(dataApi, /management\.invite\.update/);

console.log('Result management boundary contract passed');
