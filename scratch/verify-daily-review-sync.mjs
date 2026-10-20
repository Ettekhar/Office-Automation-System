// Regression: a maintenance-only Daily Review sync must NOT clear Report Sent.
// Before 2026-10-20 dailyReviewReportSentCellValue({}) returned '' (a write),
// so every maintenance edit blanked the tab's Report Sent cell.
import 'dotenv/config';
import { dailyReviewReportSentCellValue as f } from '../src/sheets.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; console.log(`PASS  ${label} => ${JSON.stringify(got)}`); }
  else { fail++; console.log(`FAIL  ${label} => ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
}

eq('no fields at all -> null (do not touch)', f({}), null);
eq('explicit undefined -> null', f({ reportSentRaw: undefined, reportSentStatus: undefined }), null);
eq('explicit empty raw -> clear', f({ reportSentRaw: '' }), '');
eq('raw No', f({ reportSentRaw: 'No' }), 'No');
eq('raw Yes', f({ reportSentRaw: 'Yes' }), 'Yes');
eq('raw To Do', f({ reportSentRaw: 'To Do' }), 'To Do');
eq('status yes -> Yes', f({ reportSentStatus: 'yes' }), 'Yes');
eq('status sent -> Yes', f({ reportSentStatus: 'sent' }), 'Yes');
eq('status no -> No', f({ reportSentStatus: 'no' }), 'No');
eq('status pending -> No', f({ reportSentStatus: 'pending' }), 'No');
eq('explicit empty status -> clear', f({ reportSentStatus: '' }), '');
eq('empty raw + status sent -> Yes', f({ reportSentRaw: '', reportSentStatus: 'sent' }), 'Yes');
eq('raw empty + status empty -> clear', f({ reportSentRaw: '', reportSentStatus: '' }), '');

console.log(`\n${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
