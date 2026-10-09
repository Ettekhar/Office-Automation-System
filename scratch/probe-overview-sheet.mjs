import { getOverviewData } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/dashboardApi.js';

const data = await getOverviewData(null, 'all');
const sites = data.sites || [];
console.log(`sites returned: ${sites.length}`);

const byAcct = {};
for (const s of sites) {
  const k = s.account || '?';
  byAcct[k] = byAcct[k] || { total: 0, withUrl: 0, sample: [] };
  byAcct[k].total++;
  if (s.reportUrl) {
    byAcct[k].withUrl++;
    if (byAcct[k].sample.length < 3) byAcct[k].sample.push(`${s.websiteUrl} -> ${s.reportUrl}`);
  }
}
for (const [k, v] of Object.entries(byAcct)) {
  console.log(`\n${k}: ${v.withUrl}/${v.total} have a reportUrl`);
  for (const s of v.sample) console.log(`   ${s}`);
}
console.log(`\nall reportUrl values look like sheet links: ${sites.every((s) => !s.reportUrl || /^https:\/\/docs\.google\.com\/spreadsheets\//.test(s.reportUrl))}`);
console.log(`every site carries the key: ${sites.every((s) => 'reportUrl' in s)}`);
