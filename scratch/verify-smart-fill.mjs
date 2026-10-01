/**
 * verify-smart-fill.mjs — OFFLINE, ZERO-WRITE check of the smart column fill.
 *
 * Uses the header rows read live from the Daily Review workbook (2026-09-25)
 * plus the URL/account columns already documented in the architecture notes, and
 * asserts that resolveUserTabDataColumns picks the right column for every
 * recognized field and never claims the URL / account column.
 */
import { resolveUserTabDataColumns, resolveUserTabAccountColumn } from '../src/columnMap.js';

const HEADER_ROWS = {
  Toufiq:  [' Website URL','Company','Maintenance','Maintenance Report Sent','ClickUp Link','GA4 Report','Newsletter Mail','Form Submission Mail','Client Response','Booking Engine','UPTimeRobot Monitoring','Cloudflare issues','Assignment'],
  Sabbir:  [' ','Website','Maintenance','Maintenance Report Sent','GA4 Report','Newsletter Mail','Form Name','Form Submission Mail','Booking / Reservstion Link','Cloudflare issues','Assignment'],
  Taion:   [' ','','Maintenance','Maintenance Report Sent','Newsletter Mail','Form Name','Form Submission Mail','Booking / Reservstion Link','Cloudflare issues','','','Assignment'],
  Medul:   ['-','Website URL','Website','Maintenance','Maintenance Report Sent','GA4 Report','Newsletter Mail','Form Submission Mail','SMTP/Client Response','Booking Engine','Cloudflare issues','Assignment'],
  Saiful:  ['Website URL','Website','Maintenance','Maintenance Report Sent','GA4 Report','Newsletter Mail','Form Name','Form Submission Mail','Booking / Reservstion Link','Cloudflare issues','Assignment'],
  Tarikul: ['Website URL','','Maintenance','Maintenance Report Sent','Account Manager','Form Name','Newsletter Mail','Form Name','Form Submission Mail','Booking / Reservstion Link','Cloudflare issues','Assignment'],
  Roeich:  ['Website URL','Website','Maintenance','Maintenance Report Sent','GA4 Report','Newsletter Mail','Form Name','Form Submission Mail','Booking / Reservstion Link','Cloudflare issues','Assignment'],
  Asif:    ['Website URL','Newsletter Mail','Form Submission Mail','','Assignment'],
};

// urlCol / accountCol as verified live and recorded in docs/database-architecture.md
const LAYOUT = {
  Toufiq:  { urlCol: 0,  accountCol: 1  },
  Sabbir:  { urlCol: 0,  accountCol: 1  },
  Taion:   { urlCol: 0,  accountCol: 1  },
  Medul:   { urlCol: 1,  accountCol: 2  },
  Saiful:  { urlCol: 0,  accountCol: 1  },
  Tarikul: { urlCol: 0,  accountCol: 1  },
  Roeich:  { urlCol: 0,  accountCol: 1  },
  Asif:    { urlCol: 0,  accountCol: -1 },
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

console.log('resolveUserTabDataColumns against live header rows\n');

for (const [tab, headers] of Object.entries(HEADER_ROWS)) {
  const { urlCol, accountCol } = LAYOUT[tab];
  const { columns, matched } = resolveUserTabDataColumns({ headers, rows: [], urlCol, accountCol });

  // 1. Never claim the URL column or the account column.
  for (const [field, idx] of Object.entries(columns)) {
    check(`${tab}: ${field} not on url col`, idx !== urlCol, `got ${idx}`);
    if (accountCol >= 0) check(`${tab}: ${field} not on account col`, idx !== accountCol, `got ${idx}`);
  }

  // 2. Never claim the Assignment marker column.
  const markerIdx = headers.findIndex(h => String(h).trim().toLowerCase() === 'assignment');
  if (markerIdx >= 0) {
    for (const [field, idx] of Object.entries(columns)) {
      check(`${tab}: ${field} not on marker col`, idx !== markerIdx, `got ${idx}`);
    }
  }

  console.log(`  ${tab.padEnd(8)} -> ` + Object.entries(columns)
    .map(([f, i]) => `${f}@${i}(${String(headers[i] ?? '').trim()})`).join(', '));
  console.log(`  ${''.padEnd(8)}    ${Object.keys(columns).length} recognized field(s)`);
}

// 3. Specific high-risk mappings verified explicitly.
const sabbir = resolveUserTabDataColumns({ headers: HEADER_ROWS.Sabbir, rows: [], urlCol: 0, accountCol: 1 });
check('Sabbir maintenance -> col 2', sabbir.columns.maintenance === 2, `got ${sabbir.columns.maintenance}`);
check('Sabbir reportSent -> col 3', sabbir.columns.reportSent === 3, `got ${sabbir.columns.reportSent}`);
check('Sabbir booking -> col 8 (typo header)', sabbir.columns.booking === 8, `got ${sabbir.columns.booking}`);
check('Sabbir formName -> col 6', sabbir.columns.formName === 6, `got ${sabbir.columns.formName}`);
check('Sabbir ga4 -> col 4', sabbir.columns.ga4 === 4, `got ${sabbir.columns.ga4}`);
check('Sabbir does NOT map clickup (absent)', sabbir.columns.clickup === undefined, `got ${sabbir.columns.clickup}`);
check('Sabbir does NOT map clientResponse (absent)', sabbir.columns.clientResponse === undefined, `got ${sabbir.columns.clientResponse}`);
check('Sabbir does NOT map uptime (absent)', sabbir.columns.uptime === undefined, `got ${sabbir.columns.uptime}`);

const toufiq = resolveUserTabDataColumns({ headers: HEADER_ROWS.Toufiq, rows: [], urlCol: 0, accountCol: 1 });
check('Toufiq maintenance -> col 2', toufiq.columns.maintenance === 2, `got ${toufiq.columns.maintenance}`);
check('Toufiq reportSent -> col 3 (not confused with maintenance)', toufiq.columns.reportSent === 3, `got ${toufiq.columns.reportSent}`);
check('Toufiq uptime -> col 10', toufiq.columns.uptime === 10, `got ${toufiq.columns.uptime}`);
check('Toufiq clientResponse -> col 8', toufiq.columns.clientResponse === 8, `got ${toufiq.columns.clientResponse}`);
check('Toufiq clickup -> col 4', toufiq.columns.clickup === 4, `got ${toufiq.columns.clickup}`);

const medul = resolveUserTabDataColumns({ headers: HEADER_ROWS.Medul, rows: [], urlCol: 1, accountCol: 2 });
check('Medul maintenance -> col 3', medul.columns.maintenance === 3, `got ${medul.columns.maintenance}`);
check('Medul clientResponse -> col 8 (SMTP/Client Response)', medul.columns.clientResponse === 8, `got ${medul.columns.clientResponse}`);

const asif = resolveUserTabDataColumns({ headers: HEADER_ROWS.Asif, rows: [], urlCol: 0, accountCol: -1 });
check('Asif newsletter -> col 1', asif.columns.newsletter === 1, `got ${asif.columns.newsletter}`);
check('Asif formSubmission -> col 2', asif.columns.formSubmission === 2, `got ${asif.columns.formSubmission}`);
check('Asif does NOT guess the headerless col 3 (booking)', asif.columns.booking === undefined, `got ${asif.columns.booking}`);
check('Asif has no maintenance column (left absent)', asif.columns.maintenance === undefined, `got ${asif.columns.maintenance}`);

// 4. Account resolution still works and does not pick the URL column.
const acc = resolveUserTabAccountColumn({ headers: HEADER_ROWS.Asif, rows: [['https://x.com','A','','','']], urlCol: 0 });
check('Asif has no account column (data-grounded)', acc.col === null, `got ${acc.col}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
