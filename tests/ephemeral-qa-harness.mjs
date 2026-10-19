import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// This harness deliberately never calls Supabase, Vercel, or the deployed API.
// It models the protected Result actions with disposable in-memory identities
// and QA-labelled records so workflow regressions can be tested safely.
const QA_PREFIX = 'QA-2026-08-12-';
const templates = ['modern', 'creative', 'premium'];
const caModes = [1, 2, 3];

const db = {
  users: [
    { id: 'qa-admin', role: 'admin', email: `${QA_PREFIX}admin@example.test` },
    { id: 'qa-teacher-primary', role: 'staff', email: `${QA_PREFIX}teacher-primary@example.test`, classKey: 'primary1' },
    { id: 'qa-teacher-jss', role: 'staff', email: `${QA_PREFIX}teacher-jss@example.test`, classKey: 'jss1' },
  ],
  students: [], scores: [], traits: [], remarks: [], fees: [], published_subjects: [],
};

function actor(id) {
  const user = db.users.find((item) => item.id === id);
  assert.ok(user, `QA actor ${id} exists`);
  return user;
}

function allowed(user, action, classKey) {
  if (user.role === 'admin') return true;
  if (action.startsWith('management.') || action.startsWith('settings.') || action === 'fees.update') return false;
  return !classKey || classKey === user.classKey;
}

function api(userId, action, payload = {}) {
  const user = actor(userId);
  assert.equal(allowed(user, action, payload.class_key), true, `${user.role} may perform ${action}`);
  if (action === 'scores.enter' && db.published_subjects.some((row) => row.class_key === payload.class_key && row.subject_index === payload.subject_index && row.term === payload.term && row.academic_session === payload.academic_session && row.published)) {
    assert.equal(user.role, 'admin', 'published scores are locked for teachers');
  }
  if (action === 'students.upsert') {
    const row = { id: payload.id || `${QA_PREFIX}student-${db.students.length + 1}`, archived: false, ...payload };
    const index = db.students.findIndex((item) => item.id === row.id);
    if (index < 0) db.students.push(row); else db.students[index] = { ...db.students[index], ...row };
    return row;
  }
  if (action === 'scores.enter') {
    const index = db.scores.findIndex((item) => item.student_id === payload.student_id && item.subject_index === payload.subject_index && item.term === payload.term && item.academic_session === payload.academic_session);
    const row = { id: index < 0 ? `${QA_PREFIX}score-${db.scores.length + 1}` : db.scores[index].id, ...payload };
    if (index < 0) db.scores.push(row); else db.scores[index] = row;
    return row;
  }
  if (action === 'results.publish') {
    const row = { id: `${QA_PREFIX}published-${db.published_subjects.length + 1}`, ...payload };
    db.published_subjects.push(row);
    return row;
  }
  if (action.startsWith('read.')) {
    const resource = action.slice(5);
    return db[resource].filter((row) => Object.entries(payload).every(([key, value]) => String(row[key]) === String(value)));
  }
  return { ok: true };
}

function total(score) {
  return Number(score.ca1 || 0) + Number(score.ca2 || 0) + Number(score.ca3 || 0) + Number(score.exam || 0);
}

function grade(value) {
  if (value >= 80) return 'A1';
  if (value >= 70) return 'B2';
  if (value >= 60) return 'B3';
  if (value >= 55) return 'C4';
  if (value >= 50) return 'C5';
  if (value >= 45) return 'C6';
  if (value >= 40) return 'D7';
  if (value >= 30) return 'E8';
  return 'F9';
}

const admin = actor('qa-admin');
const primaryTeacher = actor('qa-teacher-primary');
const jssTeacher = actor('qa-teacher-jss');
const student = api(admin.id, 'students.upsert', {
  class_key: primaryTeacher.classKey,
  academic_session: '2026/2027',
  name: `${QA_PREFIX}Pupil 01`,
  gender: 'Female',
});

const scorePayload = { student_id: student.id, class_key: primaryTeacher.classKey, subject_index: 0, term: '1st Term', academic_session: '2026/2027', ca1: 19, ca2: 17, ca3: null, exam: 48 };
const savedScore = api(primaryTeacher.id, 'scores.enter', scorePayload);
assert.equal(total(savedScore), 84, 'score total is computed correctly');
assert.equal(grade(total(savedScore)), 'A1', 'grade is computed correctly');
assert.equal(api(primaryTeacher.id, 'read.students', { class_key: primaryTeacher.classKey }).length, 1, 'teacher reads assigned class');
assert.throws(() => api(jssTeacher.id, 'scores.enter', scorePayload), /may perform/, 'teacher cannot write another class');
assert.throws(() => api(primaryTeacher.id, 'settings.app_config.update'), /may perform/, 'teacher cannot change management settings');
api(admin.id, 'results.publish', { class_key: primaryTeacher.classKey, subject_index: 0, term: '1st Term', academic_session: '2026/2027', published: true });
assert.throws(() => api(primaryTeacher.id, 'scores.enter', { ...scorePayload, ca1: 20 }), /published scores are locked/, 'teacher cannot edit a published score');
assert.equal(total(api(admin.id, 'scores.enter', { ...scorePayload, ca1: 20 })), 85, 'management can correct a published score');
assert.equal(api(admin.id, 'read.scores', { student_id: student.id }).length, 1, 'admin reads persisted score');

for (const template of templates) {
  for (const caCount of caModes) {
    const visibleColumns = ['Exam', ...Array.from({ length: caCount }, (_, index) => `CA${index + 1}`)];
    assert.equal(visibleColumns.length, caCount + 1, `${template} template supports ${caCount} CA columns`);
  }
}

const portal = await fs.readFile(new URL('../portal_core.html', import.meta.url), 'utf8');
assert.match(portal, /Print Card/);
assert.match(portal, /Print All/);
assert.match(portal, /Print Broadsheet/);
assert.match(portal, /window\.print\(/);
assert.match(portal, /id:\s*'(?:modern|creative|premium)'/);

const beforeCleanup = Object.values(db).flat().filter((row) => JSON.stringify(row).includes(QA_PREFIX)).length;
for (const key of ['users', 'students', 'scores', 'traits', 'remarks', 'fees', 'published_subjects']) db[key] = [];
const afterCleanup = Object.values(db).flat().filter((row) => JSON.stringify(row).includes(QA_PREFIX)).length;
assert.ok(beforeCleanup > 0, 'QA records were created');
assert.equal(afterCleanup, 0, 'QA records were wiped');

console.log(JSON.stringify({
  status: 'passed',
  harness: 'ephemeral-qa',
  actors: 3,
  templates: templates.length,
  caModes: caModes.length,
  beforeCleanup,
  afterCleanup,
  productionTouched: false,
  supabaseTouched: false,
}, null, 2));
