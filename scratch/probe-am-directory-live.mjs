/**
 * probe-am-directory-live.mjs (READ-ONLY)
 *
 * Builds the operator directory exactly as /api/clickup/account-managers now
 * does: distinct AM names from the live master tabs (CW + RM) + live ClickUp
 * roster. Reads only - never writes sheets, ClickUp, or data/.
 */
import 'dotenv/config';
import { getAllSheetAccountManagers } from '../src/dashboardApi.js';
import { getClickUpMembers, getAccountManagersList } from '../src/clickup.js';

const sheetNames = await getAllSheetAccountManagers();
const membersState = await getClickUpMembers(true);
const dir = getAccountManagersList({ sheetNames, members: membersState.members });

console.log(`sheet AM cells read: ${sheetNames.length}`);
console.log(`ClickUp roster: ${membersState.members.length} members  ${membersState.error ? `(ERR: ${membersState.error})` : '(ok)'}`);
console.log(`directory: ${dir.total} total = ${dir.linked} linked + ${dir.suggested} suggested + ${dir.notLinked} not linked\n`);

for (const e of dir.accountManagers) {
  const tag = e.status === 'linked' ? '✓ linked'
    : e.status === 'suggested' ? `~ suggested (${e.confidence})`
      : '⚠ not linked';
  const id = e.id != null ? `@${e.id}` : '—';
  const mail = e.email || '—';
  console.log(`  ${tag.padEnd(24)} ${(e.name || '').padEnd(26)} ${String(id).padEnd(14)} ${mail}`);
}
console.log('\nsheet cells:', JSON.stringify(sheetNames.slice(0, 12), null, 0), sheetNames.length > 12 ? `... (+${sheetNames.length - 12})` : '');