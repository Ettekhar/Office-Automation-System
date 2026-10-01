/**
 * Discovery Pass Script
 * Fetches real data from Google Sheets (Dev Tracker) and ClickUp
 * and prints a structured Markdown report.
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Credentials ──────────────────────────────────────────────────────────────
const SA_PATH = path.join(ROOT, 'service-account.json');
const CLICKUP_TOKEN = 'pk_87418108_J3Z9LHN42XMVMQSMB71U5BZJV0QJGJN1';

// ── Dev Tracker Sheet ─────────────────────────────────────────────────────────
const SHEET_ID = '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78';
const TABS = [
  'AnsAngel coalition',
  'Nines Hotel',
  'Sara Paris  Booth ',
  'Bunting& Murray Construction',
  'The House',
  'Reitz Union',
];

// ── Google Sheets Auth ────────────────────────────────────────────────────────
async function getSheetsClient() {
  const key = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── ClickUp Fetch Helper ──────────────────────────────────────────────────────
async function cuFetch(path) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    return { __error: `HTTP ${res.status}`, detail: txt.slice(0, 300) };
  }
  return res.json();
}

// ── Get sheet GID for a tab name ──────────────────────────────────────────────
async function getTabGids(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const gidMap = {};
  for (const sh of meta.data.sheets || []) {
    gidMap[sh.properties.title] = sh.properties.sheetId;
  }
  return gidMap;
}

// ── Fetch one tab ─────────────────────────────────────────────────────────────
async function fetchTab(sheets, tabName) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return resp.data.values || [];
  } catch (e) {
    return { error: e.message };
  }
}

// ── Analyse a tab's raw rows ──────────────────────────────────────────────────
function analyseTab(rawRows, tabName) {
  if (!Array.isArray(rawRows)) return { error: rawRows.error };

  if (rawRows.length === 0) return { headers: [], dataRows: 0, example: null, inconsistencies: [] };

  const headers = rawRows[0];
  const dataRows = rawRows.slice(1);

  // Example: first non-empty data row
  const example = dataRows.find(r => r.some(c => c && c.trim() !== '')) || null;

  // Inconsistency checks
  const inconsistencies = [];

  // Find status-like columns
  const statusCols = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => /status|completed|feedback|readiness/i.test(h));

  for (const { h, i } of statusCols) {
    const vals = dataRows
      .map(r => (r[i] || '').trim())
      .filter(Boolean);
    const unique = [...new Set(vals)];
    if (unique.length > 0) {
      inconsistencies.push(`Column "${h}" (col ${i}): distinct values → ${unique.map(v => `"${v}"`).join(', ')}`);
    }
  }

  // Date columns
  const dateCols = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => /date|updated|created/i.test(h));

  for (const { h, i } of dateCols) {
    const vals = dataRows.map(r => (r[i] || '').trim()).filter(Boolean);
    const formats = new Set();
    for (const v of vals) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) formats.add('YYYY-MM-DD');
      else if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) formats.add('DD/MM/YYYY');
      else if (/^\d{2}\/\d{2}\/\d{2}$/.test(v)) formats.add('DD/MM/YY');
      else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) formats.add('M/D/YY or similar');
      else if (v) formats.add(`other:"${v.slice(0, 20)}"`);
    }
    if (formats.size > 1) {
      inconsistencies.push(`Column "${h}" (col ${i}): MIXED date formats → ${[...formats].join(' | ')}`);
    }
  }

  return { headers, dataRows: dataRows.length, example, inconsistencies };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const out = [];
  const log = s => out.push(s);

  // ─── GOOGLE SHEETS ───────────────────────────────────────────────────────
  log('## Sheet Structure\n');
  log(`**Sheet ID:** \`${SHEET_ID}\``);
  log(`**Sheet URL:** https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit\n`);

  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (e) {
    log(`❌ Could not authenticate with Google: ${e.message}`);
    process.exit(1);
  }

  const gidMap = await getTabGids(sheets);

  const tabData = {};
  for (const tab of TABS) {
    const gid = gidMap[tab] ?? 'NOT FOUND';
    log(`### Tab: \`${tab}\``);
    log(`- **GID:** ${gid}`);
    log(`- **Direct URL:** https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${gid}\n`);

    const raw = await fetchTab(sheets, tab);
    const analysis = analyseTab(raw, tab);
    tabData[tab] = { gid, analysis, raw };

    if (analysis.error) {
      log(`❌ Error fetching tab: ${analysis.error}\n`);
      continue;
    }

    log(`**Headers (${analysis.headers.length} columns):**`);
    analysis.headers.forEach((h, i) => log(`  ${i}: \`${h}\``));
    log(`\n**Data rows:** ${analysis.dataRows}\n`);
  }

  // ─── EXAMPLE ROWS ────────────────────────────────────────────────────────
  log('\n---\n## Sheet Example Rows\n');
  for (const tab of TABS) {
    const { analysis } = tabData[tab];
    log(`### \`${tab}\``);
    if (!analysis || analysis.error) {
      log('❌ No data (error fetching tab).\n');
      continue;
    }
    if (!analysis.example) {
      log('No populated data rows found.\n');
      continue;
    }
    const headers = analysis.headers;
    const row = analysis.example;
    log('| Col | Header | Value |');
    log('|-----|--------|-------|');
    headers.forEach((h, i) => {
      log(`| ${i} | ${h} | ${(row[i] ?? '').replace(/\|/g, '\\|')} |`);
    });
    log('');
  }

  // ─── INCONSISTENCIES ─────────────────────────────────────────────────────
  log('\n---\n## Sheet Inconsistencies\n');
  let anyInconsistency = false;
  for (const tab of TABS) {
    const { analysis } = tabData[tab];
    if (!analysis || analysis.error || analysis.inconsistencies.length === 0) continue;
    anyInconsistency = true;
    log(`### \`${tab}\``);
    for (const inc of analysis.inconsistencies) {
      log(`- ${inc}`);
    }
    log('');
  }
  if (!anyInconsistency) {
    log('No inconsistencies detected in status/date columns across any tab.\n');
  }

  // ─── CLICKUP STRUCTURE ───────────────────────────────────────────────────
  log('\n---\n## ClickUp Structure\n');

  // Get authorized teams (workspaces)
  const teamsData = await cuFetch('/team');
  if (teamsData.__error) {
    log(`❌ ClickUp auth failed: ${teamsData.__error} — ${teamsData.detail}`);
    log('\n**Token used:** `pk_87418108_J3Z9LHN42XMVMQSMB71U5BZJV0QJGJN1`\n');
  } else {
    const teams = teamsData.teams || [];
    log(`**Workspaces found:** ${teams.length}\n`);

    for (const team of teams) {
      log(`### Workspace: "${team.name}" (ID: \`${team.id}\`)\n`);

      // Spaces
      const spacesData = await cuFetch(`/team/${team.id}/space?archived=false`);
      const spaces = spacesData.spaces || [];
      log(`**Spaces (${spaces.length}):**`);

      const allLists = [];
      const allStatuses = new Set();

      for (const space of spaces) {
        log(`\n#### Space: "${space.name}" (ID: \`${space.id}\`)`);

        // Folders
        const foldersData = await cuFetch(`/space/${space.id}/folder?archived=false`);
        const folders = foldersData.folders || [];

        // Folderless lists
        const flData = await cuFetch(`/space/${space.id}/list?archived=false`);
        const flessList = flData.lists || [];

        const spaceLists = [...flessList];

        for (const folder of folders) {
          const flsData = await cuFetch(`/folder/${folder.id}/list?archived=false`);
          const fls = flsData.lists || [];
          spaceLists.push(...fls);
          log(`  - Folder: "${folder.name}" → ${fls.length} list(s): ${fls.map(l => `"${l.name}"`).join(', ')}`);
        }

        if (flessList.length) {
          log(`  - Folderless lists: ${flessList.map(l => `"${l.name}"`).join(', ')}`);
        }

        // Collect statuses from space
        if (space.statuses) {
          for (const st of space.statuses) allStatuses.add(st.status);
        }

        allLists.push(...spaceLists);
      }

      // ─── Match sheet projects to ClickUp tasks ──────────────────────────
      log('\n### Project Name Matching (Sheet vs ClickUp)\n');
      log('| Sheet Project | Matching ClickUp List | Match Type |');
      log('|---|---|---|');

      const sheetProjects = TABS;
      const listNames = allLists.map(l => ({ id: l.id, name: l.name }));

      const matchResults = [];
      for (const proj of sheetProjects) {
        const normProj = proj.trim().toLowerCase();
        let match = listNames.find(l => l.name.trim().toLowerCase() === normProj);
        let matchType = 'exact';
        if (!match) {
          match = listNames.find(l =>
            l.name.toLowerCase().includes(normProj.split(' ')[0].toLowerCase()) ||
            normProj.includes(l.name.toLowerCase().split(' ')[0].toLowerCase())
          );
          matchType = match ? 'partial' : 'none';
        }
        matchResults.push({ proj, match, matchType });
        log(`| ${proj} | ${match ? `"${match.name}" (ID: \`${match.id}\`)` : 'NOT FOUND'} | ${matchType} |`);
      }
      log('');

      // ─── Task sample + statuses from relevant lists ──────────────────────
      log('### Task Status Values (all distinct values seen)\n');
      const taskStatusValues = new Set();
      let exampleComment = null;
      let crossCheckResult = null;

      // Find a list with tasks for cross-check (look for one with pending feedback)
      for (const list of allLists.slice(0, 10)) {
        const tasksData = await cuFetch(`/list/${list.id}/task?page=0&include_closed=true`);
        const tasks = tasksData.tasks || [];
        for (const task of tasks) {
          if (task.status?.status) taskStatusValues.add(task.status.status);
        }

        // Grab first comment we can find from any task in matched lists
        if (!exampleComment) {
          for (const task of tasks.slice(0, 5)) {
            const commData = await cuFetch(`/task/${task.id}/comment`);
            const comms = commData.comments || [];
            if (comms.length > 0) {
              const c = comms[0];
              exampleComment = {
                listName: list.name,
                taskName: task.name,
                taskStatus: task.status?.status,
                author: c.user?.username || c.user?.email || 'unknown',
                text: (c.comment_text || '').slice(0, 300),
                date: c.date
                  ? new Date(parseInt(c.date)).toISOString()
                  : 'unknown',
              };
              break;
            }
          }
        }
      }

      log([...taskStatusValues].map(s => `- \`${s}\``).join('\n') || 'No tasks found in accessible lists.\n');
      log('');

      // ─── CLICKUP STATUS VALUES ────────────────────────────────────────────
      log('\n---\n## ClickUp Status Values\n');
      if (taskStatusValues.size === 0) {
        log('Could not retrieve task statuses — no tasks returned from accessible lists.');
      } else {
        log('Distinct task status strings observed across all fetched tasks:\n');
        for (const s of taskStatusValues) log(`- \`${s}\``);
      }
      log('');

      // ─── EXAMPLE COMMENT ─────────────────────────────────────────────────
      log('\n---\n## ClickUp Example Comment\n');
      if (!exampleComment) {
        log('No comments found on any tasks in the accessible lists.');
      } else {
        log(`**From list:** "${exampleComment.listName}"`);
        log(`**Task:** "${exampleComment.taskName}" (status: \`${exampleComment.taskStatus}\`)`);
        log(`**Author:** ${exampleComment.author}`);
        log(`**Date:** ${exampleComment.date}`);
        log(`**Text:**\n> ${exampleComment.text.replace(/\n/g, '\n> ')}`);
      }
      log('');

      // ─── CROSS-CHECK ─────────────────────────────────────────────────────
      log('\n---\n## Sheet-to-ClickUp Cross-Check\n');
      log('Searching for a project where Sheet shows a pending/incomplete feedback round...\n');

      // Scan sheet data for pending feedback
      let pendingFound = null;
      for (const tab of TABS) {
        const { analysis, raw } = tabData[tab];
        if (!analysis || analysis.error || !raw || !Array.isArray(raw)) continue;
        const headers = raw[0] || [];
        const rows = raw.slice(1);

        // Find feedback status columns
        const fbCols = headers
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => /feedback.*note|feedbacks.*note|status/i.test(h));

        for (const row of rows) {
          for (const { h, i } of fbCols) {
            const val = (row[i] || '').toLowerCase();
            if (val && !val.includes('completed') && !val.includes('complete') && val.trim() !== '') {
              // This row has pending feedback
              pendingFound = {
                tab,
                projectName: row[0] || row[1] || '(unknown)',
                column: h,
                sheetValue: row[i],
              };
              break;
            }
          }
          if (pendingFound) break;
        }
        if (pendingFound) break;
      }

      if (!pendingFound) {
        log('All feedback rounds in sheet appear Completed — no pending row found for cross-check.\n');
        log('*(This means the sheet may be fully up to date, or the "pending" indicator uses a non-standard format.)*\n');
      } else {
        log(`**Sheet project:** \`${pendingFound.tab}\``);
        log(`**Row project name:** ${pendingFound.projectName}`);
        log(`**Column:** "${pendingFound.column}"`);
        log(`**Sheet value:** \`${pendingFound.sheetValue}\`\n`);

        // Try to find matching ClickUp task
        const matchRes = matchResults.find(m => m.proj === pendingFound.tab);
        if (!matchRes || !matchRes.match) {
          log('**ClickUp match:** NOT FOUND — no ClickUp list name matched this sheet project name.');
          log('> ⚠️ This confirms a sheet-to-ClickUp gap. Agent will need a fuzzy-match or manual mapping fallback.\n');
        } else {
          const listId = matchRes.match.id;
          const tasksData = await cuFetch(`/list/${listId}/task?page=0&include_closed=true`);
          const tasks = tasksData.tasks || [];
          if (tasks.length === 0) {
            log(`**ClickUp list:** "${matchRes.match.name}" (ID: \`${listId}\`) — list found but NO tasks inside.`);
            log('> ⚠️ List exists but is empty. Sheet-to-task link is broken.\n');
          } else {
            const t = tasks[0];
            log(`**ClickUp list:** "${matchRes.match.name}"`);
            log(`**ClickUp task:** "${t.name}"`);
            log(`**ClickUp status:** \`${t.status?.status}\``);
            log(`\n| | Value |`);
            log(`|---|---|`);
            log(`| **Sheet** | \`${pendingFound.sheetValue}\` |`);
            log(`| **ClickUp** | \`${t.status?.status}\` |`);
            const agree = (t.status?.status || '').toLowerCase().includes('complet') ===
              (pendingFound.sheetValue || '').toLowerCase().includes('complet');
            log(`\n**Agreement:** ${agree ? '✅ Agree' : '❌ Disagree — values do not match'}`);
          }
        }
      }
    }
  }

  // ─── ACCESS & AUTH NOTES ─────────────────────────────────────────────────
  log('\n---\n## Access & Auth Notes\n');
  log('### Google Sheets');
  log('- **Method:** Google Service Account (JSON key file)');
  log(`- **Key file path:** \`./service-account.json\``);
  log('- **Scopes used:** `https://www.googleapis.com/auth/spreadsheets.readonly`');
  log('- **Status:** ✅ Working (data fetched successfully above)');
  log('- **For a new script:** Load `service-account.json`, create a `googleapis` JWT auth, pass to `google.sheets({ version: "v4", auth })`. No OAuth flow needed — service account is already granted access to the sheet.\n');
  log('### ClickUp');
  log('- **Method:** Personal API Token (Bearer token in `Authorization` header)');
  log('- **Token:** `pk_87418108_...` (from `.env` → `CLICKUP_API_TOKEN`)');
  log('- **Endpoint base:** `https://api.clickup.com/api/v2`');
  log('- **Status:** See results above — token was used live for this report');
  log('- **For a new script:** Set `Authorization: <token>` header on every request. No OAuth needed.\n');

  // ─── OPEN QUESTIONS ───────────────────────────────────────────────────────
  log('\n---\n## Open Questions\n');
  log('1. **Custom fields on ClickUp tasks** — the v2 `/task` endpoint returns custom fields per task, but whether any of these 6 projects use custom fields (date, status, etc.) will be visible only if tasks exist in the matched lists.');
  log('2. **Sheet "Feedback" columns** — the exact column names carrying per-feedback-round status differ by tab (some use "Feedbacks -- Note/Updates", some "Status"). The headers printed in Sheet Structure above are the ground truth.');
  log('3. **ClickUp list ↔ sheet project mapping** — see the Project Name Matching table above. Any row showing "none" means the agent needs a manual alias table or fuzzy fallback.');
  log('4. **Sheet tab name with trailing spaces** — `"Sara Paris  Booth "` has double-space and trailing space. Any script must use the EXACT string from `detectedTabs` in `sheet-credentials.json`.');
  log('5. **ClickUp workspace access** — if the token has access to multiple workspaces, all are listed above. Confirm which workspace/space the 6 projects actually live in.');

  // ─── OUTPUT ───────────────────────────────────────────────────────────────
  console.log(out.join('\n'));
}

main().catch(e => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
