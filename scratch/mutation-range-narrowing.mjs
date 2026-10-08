/**
 * Mutation-test the 3 range/narrowing assertions just added to
 * verify-agent-email.mjs. Each mutation must turn the suite RED; originals are
 * held in memory and restored in a finally block, then hash-verified.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = 'C:\\Users\\toufi_qicjadj\\Downloads\\maintenance-mailer';
const RU = `${REPO}\\src\\reportUtils.js`;
const LMA = `${REPO}\\src\\localMailAgent.js`;
const IDX = `${REPO}\\src\\index.js`;
const TEST = `${REPO}\\scratch\\verify-agent-email.mjs`;

const originals = new Map([[RU, fs.readFileSync(RU, 'utf8')], [LMA, fs.readFileSync(LMA, 'utf8')], [IDX, fs.readFileSync(IDX, 'utf8')]]);

function run() {
  try {
    execSync(`node "${TEST}"`, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
const failing = (out) => (out.match(/^\s*x\s+.+$/gm) || []).map((s) => s.trim());

const mutations = [
  {
    name: 'A. drop the A:D narrowing in rowsToHtmlTable',
    expect: 'narrows the grid to the report body',
    apply: () => {
      let t = originals.get(RU);
      const before = t;
      t = t.replace('(row || []).slice(0, REPORT_BODY_COLS)', '(row || [])');
      if (t === before) throw new Error('mutation A did not apply');
      fs.writeFileSync(RU, t);
    },
    target: RU,
  },
  {
    name: "B. agent reads A1:D200 while the CLI reads A1:Z300",
    expect: 'read the SAME report range',
    apply: () => {
      let t = originals.get(LMA);
      const before = t;
      t = t.replace(
        /reportRows = await getTabValues\(job\.matchedTab, 'A1:Z300'/,
        "reportRows = await getTabValues(job.matchedTab, 'A1:D200'",
      );
      if (t === before) throw new Error('mutation B did not apply');
      fs.writeFileSync(LMA, t);
    },
    target: LMA,
  },
  {
    name: "C. both read A1:B300 (below column D)",
    expect: 'at least column D',
    apply: () => {
      for (const [p, re] of [[LMA, /'A1:Z300'/g], [IDX, /'A1:Z300'/g]]) {
        let t = originals.get(p);
        const before = t;
        t = t.replace(re, "'A1:B300'");
        if (t === before) throw new Error(`mutation C did not apply to ${p}`);
        fs.writeFileSync(p, t);
      }
    },
    target: [LMA, IDX],
  },
];

let allBite = true;
try {
  // baseline first
  const base = run();
  console.log(`  baseline: exit=${base.code} (${base.code === 0 ? 'GREEN' : 'RED'})`);
  if (base.code !== 0) { console.log('  *** baseline is not green - mutation results unreliable ***'); }

  for (const m of mutations) {
    m.apply();
    const r = run();
    const hits = failing(r.out).filter((l) => l.includes(m.expect));
    const ok = r.code !== 0 && hits.length > 0;
    allBite = allBite && ok;
    console.log(`  ${ok ? 'BITE ' : 'MISS '} ${m.name}`);
    console.log(`        exit=${r.code}, expected failure seen: ${hits.length > 0}`);
    if (!ok) console.log(`        failing lines: ${JSON.stringify(failing(r.out).slice(0, 4))}`);
    // restore immediately before the next mutation
    for (const [p, text] of originals) fs.writeFileSync(p, text);
  }
} finally {
  for (const [p, text] of originals) fs.writeFileSync(p, text);
}

// prove restoration
console.log('\n=== restoration ===');
let clean = true;
for (const [p, text] of originals) {
  const now = fs.readFileSync(p, 'utf8');
  const same = now === text;
  clean = clean && same;
  console.log(`  ${same ? 'ok  ' : 'DIFF'} ${p.slice(REPO.length + 1)}`);
}
const final = run();
console.log(`  suite after restore: exit=${final.code} (${final.code === 0 ? 'GREEN' : 'RED'})`);
console.log(`\n  ${allBite && clean && final.code === 0 ? 'ALL MUTATIONS BIT, files restored, suite green' : 'PROBLEM - see above'}`);
process.exit(allBite && clean && final.code === 0 ? 0 : 1);
