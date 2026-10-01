/**
 * Live, zero-write verification of all three assignment entry points.
 *
 * The assignment routes accept ?dryRun=1. This exercises that path over HTTP
 * with a real, currently unassigned site and an active user, then proves:
 *   - each route answers with a plan and the explicit no-write note;
 *   - the site's committed assignedUsers list is unchanged;
 *   - every data/*.json file is byte-identical (no DB, audit, or conflict write);
 *   - the selected live Daily Review tab is byte-identical (no sheet write).
 *
 * It intentionally makes no assignment and writes nothing itself.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId } from '../src/userTabWriteBack.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const DATA = path.join(ROOT, 'data');
const BASE = 'http://localhost:3000';
const failures = [];
let checks = 0;

function ok(condition, message, detail) {
  checks++;
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    if (detail !== undefined) console.log(`       ${JSON.stringify(detail)}`);
    failures.push(message);
  }
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function jsonSnapshot(dir) {
  const out = {};
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    out[name] = digest(await readFile(path.join(dir, name)));
  }
  return out;
}
async function request(route, options = {}) {
  const res = await fetch(BASE + route, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${route} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return payload;
}

const [siteResponse, userResponse] = await Promise.all([
  request('/api/master/sites'),
  request('/api/master/users'),
]);
const sites = siteResponse.sites || [];
const users = userResponse.users || [];
const user = users.find((u) => u.name === 'Medul' && u.active !== false);
const site = sites.find((s) => !Array.isArray(s.assignedUsers) || s.assignedUsers.length === 0);
ok(!!user, 'found an active test user (Medul)');
ok(!!site, 'found a currently unassigned real site');
if (!user || !site) process.exit(1);

const { id: sheetId } = getDailyReviewSheetId();
const tabBefore = await getTabValues(user.name, 'A:ZZ', sheetId);
const dataBefore = await jsonSnapshot(DATA);
const assignedBefore = JSON.stringify(site.assignedUsers || []);

console.log(`\n  site : ${site.url}`);
console.log(`  user : ${user.name} (${user.id})`);
console.log(`  tab  : ${user.name} — ${tabBefore.length} rows`);
console.log('\n  1. quick assign: POST /api/master/sites/:id/assign?dryRun=1');
const quick = await request(`/api/master/sites/${site.id}/assign?dryRun=1`, {
  method: 'POST',
  body: JSON.stringify({ userIds: [user.id] }),
});
ok(quick.dryRun === true, 'quick-assign reports dryRun=true', quick);
ok(quick.note === 'Dry run: no DB and no sheet writes were made.', 'quick-assign explicitly says it wrote nothing', quick.note);
ok(quick.userTabWriteBack && Array.isArray(quick.userTabWriteBack.wouldAppend), 'quick-assign returns the sheet append plan', quick.userTabWriteBack);

console.log('\n  2. site edit: PUT /api/master/sites/:id?dryRun=1');
const put = await request(`/api/master/sites/${site.id}?dryRun=1`, {
  method: 'PUT',
  body: JSON.stringify({ assignedUsers: [user.id] }),
});
ok(put.dryRun === true, 'site-edit reports dryRun=true', put);
ok(put.note === 'Dry run: no DB and no sheet writes were made.', 'site-edit explicitly says it wrote nothing', put.note);
ok(put.userTabWriteBack && Array.isArray(put.userTabWriteBack.wouldAppend), 'site-edit returns the sheet append plan', put.userTabWriteBack);
ok(Array.isArray(put.site?.assignedUsers) && put.site.assignedUsers.includes(user.id), 'site-edit response is the WOULD-result state', put.site);

console.log('\n  3. bulk assign: POST /api/master/sites/bulk-assign?dryRun=1');
const bulk = await request('/api/master/sites/bulk-assign?dryRun=1', {
  method: 'POST',
  body: JSON.stringify({ siteIds: [site.id], userIds: [user.id], mode: 'add' }),
});
ok(bulk.dryRun === true, 'bulk-assign reports dryRun=true', bulk);
ok(bulk.note === 'Dry run: no DB and no sheet writes were made. `sites` shows the state that WOULD result.', 'bulk-assign explicitly says it wrote nothing', bulk.note);
ok(bulk.sites?.[0]?.assignedUsers?.includes(user.id), 'bulk-assign returns the WOULD-result state', bulk.sites);
ok(Array.isArray(bulk.userTabWriteBack) && bulk.userTabWriteBack[0]?.wouldAppend?.length > 0, 'bulk-assign returns the sheet append plan', bulk.userTabWriteBack);

const afterSite = (await request('/api/master/sites')).sites.find((s) => s.id === site.id);
ok(JSON.stringify(afterSite?.assignedUsers || []) === assignedBefore, 'the committed assignment is unchanged after all three dry runs', {
  before: JSON.parse(assignedBefore), after: afterSite?.assignedUsers || [],
});
const dataAfter = await jsonSnapshot(DATA);
const changedData = [...new Set([...Object.keys(dataBefore), ...Object.keys(dataAfter)])]
  .filter((name) => dataBefore[name] !== dataAfter[name]);
ok(changedData.length === 0, 'every data/*.json file is byte-identical', changedData);
const tabAfter = await getTabValues(user.name, 'A:ZZ', sheetId);
ok(JSON.stringify(tabAfter) === JSON.stringify(tabBefore), 'the live Daily Review tab is byte-identical');

console.log(`\n  plan: ${quick.userTabWriteBack?.wouldAppend?.[0]?.siteUrl || site.url} -> ${user.name} tab`);
console.log(`  data files checked: ${Object.keys(dataBefore).length}; live rows compared: ${tabBefore.length}`);
console.log(`\n  ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log(`  failures: ${failures.join('; ')}`);
  process.exit(1);
}
