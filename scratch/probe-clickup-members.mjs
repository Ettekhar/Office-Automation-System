import 'dotenv/config';
const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
const all = [];
async function fetchTeam(id) {
  const res = await fetch(`https://api.clickup.com/api/v2/team/${id}?include_members=true`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  const members = (data.team?.members || []).map((m) => m.user || m).filter((m) => m && m.id != null);
  console.log(`team ${id} (${data.team?.name}): ${res.status}, ${members.length} members`);
  return members;
}
const cw = await fetchTeam('10554421');
const rm = await fetchTeam('1100380000021140');
for (const m of [...cw, ...rm]) {
  if (!all.some((x) => x.id === m.id)) all.push(m);
}
console.log(`unique across both: ${all.length}`);

const expected = [
  ['Mohammed Razib', 30032526],
  ['Jacob Smith', 87307012],
  ['Yana Petrova', 57111537],
  ['Sienna Crawford', 81585543],
  ['Holly Hollingsworth', 75337006],
  ['Sonya Taylor', 14783666],
  ['Michael Curran', 75419535],
  ['Madison Ploss', 43143953],
  ['Kylie Chen', 75554530],
  ['Sally Chaupiz', 81573370],
  ['Pooja Upadhaya', 38524001],
  ['Sajedur Rahman Sadhin', 182653419],
  ['MD Rifat', 57032730],
  ['Stephanie Smith', 14825030],
  ['Olivia Weiss', 81573375],
  ['Yolanda Tates', 14825033],
  ['Dana Sparks', 57226062],
];
let found = 0;
for (const [name, id] of expected) {
  const m = all.find((x) => x.id === id);
  const byName = all.find((x) => (x.username || '').toLowerCase() === name.toLowerCase());
  if (m || byName) found++;
  console.log(`  ${found ? '' : 'MISS '}${name.padEnd(24)} id=${String(id).padEnd(11)} byId=${m ? 'YES' : 'no'} byName=${byName ? `YES(${byName.id})` : 'no'}  sample=${m ? `${m.username || '(null)'} <${m.email || ''}>` : ''}`);
}
console.log(`\nfound ${found}/${expected.length} of the 17 directory AMs`);
console.log('\ntop 8 sample members:', all.slice(0, 8).map((m) => `${m.username || '(null)'} <${m.email || ''}> #${m.id}`).join(' | '));