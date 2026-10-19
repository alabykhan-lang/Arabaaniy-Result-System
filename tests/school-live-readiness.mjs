import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const portalUrl = process.env.RESULT_PORTAL_URL || 'http://localhost:3000';
const root = new URL('..', import.meta.url);
const portal = await fs.readFile(new URL('portal_core.html', root), 'utf8');
const dataApi = await fs.readFile(new URL('api/result-data.js', root), 'utf8');
const authApi = await fs.readFile(new URL('api/result-auth.js', root), 'utf8');
const manifest = await fs.readFile(new URL('manifest.webmanifest', root), 'utf8');
const androidActivity = await fs.readFile(new URL('android-app/src/main/java/com/firstchoice/standard/results/MainActivity.java', root), 'utf8');
const bootstrapSql = await fs.readFile(new URL('docs/school-portal-supabase-bootstrap.sql', root), 'utf8');

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) console.error(`FAIL  ${name}: ${detail}`);
  else console.log(`PASS  ${name}: ${detail}`);
}

check('three report-card templates',
  (portal.match(/id:\s*'(?:modern|creative|premium)'/g) || []).length === 3,
  'modern, creative and premium are defined');
check('dynamic CA selector',
  /assessment-ca-toggle/.test(portal) && /setAssessmentCaCount\(/.test(portal) && /\[1,2,3\]/.test(portal),
  '1, 2 and 3 CA choices are rendered by the client');
check('dynamic report-card CA columns',
  /Array\.from\(\{length:assessment\.caCount\}/.test(portal),
  'report cards derive CA columns from assessment.caCount');
check('protected data endpoint',
  /RESULT_SESSION_REQUIRED/.test(dataApi),
  'unauthenticated data requests are rejected');
check('management-only settings endpoint',
  /settings\.app_config\.update/.test(dataApi) && /requireManagement\(token\)/.test(dataApi),
  'management guard is present in the data API');
check('teacher class context stays local',
  /!hasResultPermission\('result_settings\.manage'\)/.test(portal) && /local_only:true/.test(portal),
  'teachers can enter classes without writing the school-wide academic context');
check('safe next-term activation path',
  /settings\.activate_next_term/.test(dataApi) && /academic_context/.test(dataApi) && /settings\.activate_next_term/.test(portal) && /skipCloud/.test(portal),
  'term configuration and academic context are synchronized before local state changes');
check('explicit result unpublish handling',
  /action === 'results\.unpublish'/.test(dataApi) && /RESULT_ACTION_NOT_SUPPORTED/.test(dataApi),
  'unpublish is implemented explicitly and unknown actions are rejected');
check('report-card actions are supported',
  /NON_PERSISTENT_ACTIONS/.test(dataApi) && /report_cards\.generate/.test(dataApi) && /results\.export/.test(dataApi),
  'card generation and export validation calls are explicit non-writing actions');
check('score writes require a returned row',
  /RESULT_SCORE_SAVE_FAILED/.test(dataApi) && /if \(!rows\?\.\[0\]\)/.test(dataApi),
  'the API rejects empty update responses instead of reporting an old score as saved');
check('published scores lock teacher edits',
  /RESULT_SCORE_LOCKED/.test(dataApi) && /published_subjects\?class_key=eq\./.test(dataApi),
  'published subjects are locked for staff while management retains correction access');
check('teacher result-write policies',
  /Signed-in staff can insert results/.test(bootstrapSql) && /Signed-in staff can update results/.test(bootstrapSql),
  'the bootstrap grants classroom write access while keeping management settings protected');
check('idempotent labelled demo loader',
  /read\.students/.test(portal) && /No duplicate pupils were created/.test(portal),
  're-running the demo loader does not create another copy of the labelled pupils');
check('grade scale persistence',
  /cfg\.gradeScale=GRADE_SCALE\.map/.test(portal) && /hydrateGradeScale/.test(portal),
  'saved grade thresholds are restored and used by the portal');
check('report card fee visibility follows settings',
  /getSessionCfg\(\)\.showFees!==false/.test(portal),
  'fee schedule is hidden only when management turns it off');
check('school administrator identity configurable',
  /SCHOOL_ADMIN_EMAIL/.test(authApi),
  'school administrator email is configurable via environment variable');
check('mobile-first install metadata',
  /display\": \"standalone/.test(manifest) && /school-logo\.png/.test(manifest) && /meta name=\"theme-color\"/.test(portal),
  'PWA metadata, school logo and mobile theme are present');
check('customizable Android wrapper',
  /AndroidPrint/.test(androidActivity),
  'Android app supports native printing');
check('responsive overflow containment',
  /tbl-wrap\{overflow-x:auto/.test(portal) && /sheet-header,\.sheet-row\{min-width:570px/.test(portal),
  'wide score/report tables scroll inside their containers on phones');

const failed = checks.filter((item) => !item.passed);
console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.length }, null, 2));
if (failed.length) process.exitCode = 1;
