/**
 * probe-wrangler-kv-cache.mjs — READ-ONLY inspection of the local .wrangler
 * miniflare KV cache (sqlite + content-addressed blobs). Prints only key
 * names, value lengths and sha256 prefixes. No values are printed.
 * Any cached value that is JSON is saved verbatim to a PRIVATE file under
 * AppData\Local\Temp\opencode\ for the user's own inspection.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const repo = process.cwd();
const kvRoot = path.join(repo, '.wrangler', 'state', 'v3', 'kv');

const sqliteFiles = [
  path.join(kvRoot, 'miniflare-KVNamespaceObject', 'a303e38fea8af02420923f79abd4c9681604fd1f0921fdf111ec7863cd190d56.sqlite'),
  path.join(kvRoot, 'miniflare-KVNamespaceObject', 'metadata.sqlite'),
];

const outDir = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'opencode');
fs.mkdirSync(outDir, { recursive: true });

function h16(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

for (const sq of sqliteFiles) {
  console.log(`\n=== sqlite: ${path.basename(sq)} ===`);
  if (!fs.existsSync(sq)) { console.log('  (missing)'); continue; }
  try {
    const db = new DatabaseSync(sq, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log(`  tables: ${tables.map((t) => t.name).join(', ')}`);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
      try {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        console.log(`  -- ${t.name}: ${rows.length} rows (cols: ${cols.join(', ')})`);
        for (const r of rows) {
          const keys = Object.keys(r);
          const keyCol = keys.find((k) => /^key$/i.test(k)) || keys[0];
          const valCol = keys.find((k) => /^value/i.test(k));
          const keyName = String(r[keyCol] ?? '');
          if (!valCol) {
            // no value column: print scalar fields that look safe (skip blobs/etag/expiration handled below)
            const summary = Object.fromEntries(
              Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 40 ? `string(${v.length})` : v]),
            );
            console.log(`    key=${keyName}  ${JSON.stringify(summary)}`);
            continue;
          }
          const rawVal = r[valCol];
          const buf = Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(String(rawVal ?? ''), 'utf8');
          console.log(`    key=${keyName}  valueBytes=${buf.length}  sha256=${h16(buf)}`);
          // try JSON; save verbatim to private dir (value not printed)
          const text = buf.toString('utf8');
          if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
              const parsed = JSON.parse(text);
              const topKeys = Array.isArray(parsed) ? `array(${parsed.length})` : Object.keys(parsed).join(', ');
              console.log(`        json keys: ${topKeys}`);
              const safeName = `${keyName.replace(/[^a-z0-9.-]/gi, '_')}.kv-cached-${h16(buf)}.json`;
              fs.writeFileSync(path.join(outDir, safeName), text);
              console.log(`        saved (private): ${path.join(outDir, safeName)}`);
            } catch {
              console.log('        (value is not valid JSON)');
            }
          }
        }
      } catch (e) {
        console.log(`  -- ${t.name}: read error: ${e.message}`);
      }
    }
    db.close();
  } catch (e) {
    console.log(`  open error: ${e.message}`);
  }
}

console.log('\n=== blobs (content-addressed cache) ===');
const walk = (d) => {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else {
      const buf = fs.readFileSync(p);
      const first = p.includes('blobs') ? path.basename(p).split(/[^0-9a-f]/i)[0] : '';
      console.log(`  ${ent.name}  ${buf.length} B  sha256(${h16(buf)})  filenameHash=${first}`);
      const text = buf.toString('utf8');
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          const top = Array.isArray(parsed) ? `array(${parsed.length})` : Object.keys(parsed).join(', ');
          console.log(`      json keys: ${top}`);
          const safeName = `blob-${h16(buf)}.json`;
          fs.writeFileSync(path.join(outDir, safeName), text);
          console.log(`      saved (private): ${path.join(outDir, safeName)}`);
        } catch {
          console.log('      (not JSON)');
        }
      } else {
        console.log('      (not JSON)');
      }
    }
  }
};
if (fs.existsSync(kvRoot)) walk(kvRoot);