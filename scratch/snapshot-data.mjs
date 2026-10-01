/**
 * Snapshot data/ so a real sync can be checked for loss, not just "it ran".
 * Records per collection + the full set of stable ids, written to scratch/
 * (not data/) so it never pollutes the live store.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = new URL('../data/', import.meta.url);
const OUT = process.argv[2] || path.join(new URL('../scratch/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'pre-sync-snapshot.json');

const COLLECTIONS = ['sites', 'daily-review', 'tasks', 'properties', 'dev-projects', 'domains', 'users'];

const snap = { at: new Date().toISOString(), collections: {}, files: {} };
for (const f of fs.readdirSync(DATA)) {
  const p = path.join(DATA.pathname.replace(/^\/([A-Za-z]:)/, '$1'), f);
  if (!f.endsWith('.json')) continue;
  const buf = fs.readFileSync(p);
  snap.files[f] = { bytes: buf.length, mtime: fs.statSync(p).mtime.toISOString() };
}
for (const c of COLLECTIONS) {
  const file = path.join(DATA.pathname.replace(/^\/([A-Za-z]:)/, '$1'), `${c}.json`);
  if (!fs.existsSync(file)) { snap.collections[c] = null; continue; }
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(arr) ? arr : Object.values(arr).flat();
  snap.collections[c] = {
    count: list.length,
    ids: list.map((x) => x && x.id).filter(Boolean).sort(),
  };
}
fs.writeFileSync(OUT, JSON.stringify(snap, null, 2));
console.log(`  snapshot -> ${OUT}`);
for (const [c, v] of Object.entries(snap.collections)) {
  console.log(`  ${c.padEnd(14)} ${v ? `${v.count} records, ${v.ids.length} ids` : '(absent)'}`);
}
