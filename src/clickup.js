/** Read-only ClickUp task lookup used to enrich a linked maintenance row. */
const cache = new Map();
const TTL = 5 * 60 * 1000;

function taskIdFromUrl(url) {
  const value = String(url || '').trim();
  // ClickUp accepts both /t/<task> and /t/<workspace>/<task>.  Always use
  // the final path segment so a workspace id is never mistaken for a task id.
  const match = value.match(/clickup\.com\/t\/([^?#/]+)(?:\/([^?#/]+))?/i);
  return match ? (match[2] || match[1]) : '';
}

export async function getClickUpTask(taskUrl) {
  const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
  const taskId = taskIdFromUrl(taskUrl);
  if (!token || !taskId) return null;
  const old = cache.get(taskId);
  if (old && old.expiresAt > Date.now()) return old.value;
  const response = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}?include_subtasks=true`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`ClickUp task lookup returned HTTP ${response.status}`);
  const task = await response.json();
  const value = {
    id: task.id,
    name: task.name || '',
    status: task.status?.status || '',
    url: task.url || taskUrl,
    updatedAt: task.date_updated ? new Date(Number(task.date_updated)).toISOString() : '',
    dueDate: task.due_date ? new Date(Number(task.due_date)).toISOString().slice(0, 10) : '',
    assignees: (task.assignees || []).map((person) => person.username || person.email || '').filter(Boolean),
  };
  cache.set(taskId, { value, expiresAt: Date.now() + TTL });
  return value;
}

function commentBody(comment) {
  if (typeof comment?.comment_text === 'string') return comment.comment_text.trim();
  if (typeof comment?.text === 'string') return comment.text.trim();
  if (Array.isArray(comment?.comment)) return comment.comment.map((part) => part?.text || '').join('').trim();
  return '';
}

/** Read the newest comments only. This never creates, edits, resolves, or
 * deletes a ClickUp comment. Comments are deliberately kept out of the LLM
 * prompt: when requested, they are shown directly as source evidence. */
export async function getClickUpTaskComments(taskUrl, { limit = 25 } = {}) {
  const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
  const taskId = taskIdFromUrl(taskUrl);
  if (!token || !taskId) return [];
  const cacheKey = `comments:${taskId}`;
  const old = cache.get(cacheKey);
  if (old && old.expiresAt > Date.now()) return old.value;
  const response = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`ClickUp comment lookup returned HTTP ${response.status}`);
  const body = await response.json();
  const value = (body.comments || []).slice(0, Math.max(1, Math.min(25, limit))).map((comment) => ({
    id: String(comment.id || ''),
    text: commentBody(comment),
    author: comment.user?.username || comment.user?.email || comment.user?.email_address || 'Unknown',
    createdAt: comment.date ? new Date(Number(comment.date)).toISOString() : '',
  })).filter((comment) => comment.text);
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL });
  return value;
}

export const AM_DIRECTORY = {
  // Mohammed / MD Razib
  'mohammed': { name: 'Mohammed Razib', id: 30032526, email: 'mohammed@cogwheelmarketing.com' },
  'mohammed razib': { name: 'Mohammed Razib', id: 30032526, email: 'mohammed@cogwheelmarketing.com' },
  'md razib': { name: 'Mohammed Razib', id: 30032526, email: 'mohammed@cogwheelmarketing.com' },
  'razib': { name: 'Mohammed Razib', id: 30032526, email: 'mohammed@cogwheelmarketing.com' },

  // Jacob / Jacob Smith
  'jacob': { name: 'Jacob Smith', id: 87307012, email: 'jacob@cogwheelmarketing.com' },
  'jacob smith': { name: 'Jacob Smith', id: 87307012, email: 'jacob@cogwheelmarketing.com' },

  // Yana / Yana Petrova
  'yana': { name: 'Yana Petrova', id: 57111537, email: 'yana@cogwheelmarketing.com' },
  'yana petrova': { name: 'Yana Petrova', id: 57111537, email: 'yana@cogwheelmarketing.com' },

  // Sienna / Sienna Crawford
  'sienna': { name: 'Sienna Crawford', id: 81585543, email: 'sienna@cogwheelmarketing.com' },
  'sienna crawford': { name: 'Sienna Crawford', id: 81585543, email: 'sienna@cogwheelmarketing.com' },

  // Holly / Holly Hollingsworth
  'holly': { name: 'Holly Hollingsworth', id: 75337006, email: 'holly@cogwheelmarketing.com' },
  'holly hollingsworth': { name: 'Holly Hollingsworth', id: 75337006, email: 'holly@cogwheelmarketing.com' },

  // Sonya / Sonya Taylor
  'sonya': { name: 'Sonya Taylor', id: 14783666, email: 'sonya@cogwheelmarketing.com' },
  'sonya taylor': { name: 'Sonya Taylor', id: 14783666, email: 'sonya@cogwheelmarketing.com' },

  // Michael / Michael Curran
  'michael': { name: 'Michael Curran', id: 75419535, email: 'michael@cogwheelmarketing.com' },
  'michael curran': { name: 'Michael Curran', id: 75419535, email: 'michael@cogwheelmarketing.com' },

  // Madison / Madison Ploss
  'madison': { name: 'Madison Ploss', id: 43143953, email: 'madison@cogwheelmarketing.com' },
  'madison ploss': { name: 'Madison Ploss', id: 43143953, email: 'madison@cogwheelmarketing.com' },

  // Kylie / Kylie Chen
  'kylie': { name: 'Kylie Chen', id: 75554530, email: 'kylie@cogwheelmarketing.com' },
  'kylie chen': { name: 'Kylie Chen', id: 75554530, email: 'kylie@cogwheelmarketing.com' },

  // Sally / Sally Chaupiz
  'sally': { name: 'Sally Chaupiz', id: 81573370, email: 'sally@cogwheelmarketing.com' },
  'sally chaupiz': { name: 'Sally Chaupiz', id: 81573370, email: 'sally@cogwheelmarketing.com' },

  // Pooja / Pooja Upadhaya
  'pooja': { name: 'Pooja Upadhaya', id: 38524001, email: 'pooja@cogwheelanalytics.com' },
  'pooja upadhaya': { name: 'Pooja Upadhaya', id: 38524001, email: 'pooja@cogwheelanalytics.com' },

  // Sajedur / Sajedur Rahman Sadhin
  'sajedur': { name: 'Sajedur Rahman Sadhin', id: 182653419, email: 'sajedur@razibmarketing.net' },
  'sajedur rahman': { name: 'Sajedur Rahman Sadhin', id: 182653419, email: 'sajedur@razibmarketing.net' },
  'sajedur rahman sadhin': { name: 'Sajedur Rahman Sadhin', id: 182653419, email: 'sajedur@razibmarketing.net' },

  // Rifat / MD Rifat
  'rifat': { name: 'MD Rifat', id: 57032730, email: 'rifat@cogwheelmarketing.com' },
  'md rifat': { name: 'MD Rifat', id: 57032730, email: 'rifat@cogwheelmarketing.com' },

  // Stephanie / Stephanie Smith
  'stephanie': { name: 'Stephanie Smith', id: 14825030, email: 'stephanie@cogwheelmarketing.com' },
  'stephanie smith': { name: 'Stephanie Smith', id: 14825030, email: 'stephanie@cogwheelmarketing.com' },

  // Olivia / Olivia Weiss
  'olivia': { name: 'Olivia Weiss', id: 81573375, email: 'olivia@cogwheelmarketing.com' },

  // Yolanda / Yolanda Tates
  'yolanda': { name: 'Yolanda Tates', id: 14825033, email: 'yolanda@cogwheelmarketing.com' },

  // Dana / Dana Sparks
  'dana': { name: 'Dana Sparks', id: 57226062, email: 'accounting@cogwheelmarketing.com' },
};

export const OVI_CLICKUP_USER = {
  name: 'Md Atiar Rahman Ovi',
  id: 49039188,
  email: 'ovi@razibmarketing.net',
};

// ── Live ClickUp workspace members (read-only, cached) ──────────────────────
// The roster is used ONLY to *propose* a ClickUp user for a sheet AM name that
// is not in AM_DIRECTORY (see getAccountManagersList). A proposed match is
// always surfaced as unverified - it can never be @-mentioned in a comment,
// because resolveAccountManager() (the source of @mentions) does not read it.
const membersCache = { value: null, expiresAt: 0 };
const MEMBERS_TTL = 10 * 60 * 1000; // ClickUp roster refreshes on the same cadence

/**
 * Read-only list of every workspace member the token can see.
 *  - GET /api/v2/team            -> team ids
 *  - GET /api/v2/team/{id}?include_members=true -> that team's members
 * Never throws: a ClickUp hiccup must not break the mailer console. The caller
 * receives { members, error, at } and shows whatever it could get.
 */
export async function getClickUpMembers(force = false) {
  if (!force && membersCache.value && membersCache.expiresAt > Date.now()) {
    return membersCache.value;
  }
  const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
  const result = { members: [], error: '', at: new Date().toISOString() };
  if (!token) {
    result.error = 'no CLICKUP_API_TOKEN configured';
    membersCache.value = result;
    membersCache.expiresAt = Date.now() + MEMBERS_TTL;
    return result;
  }
  try {
    const teamsRes = await fetch('https://api.clickup.com/api/v2/team', {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (!teamsRes.ok) throw new Error(`ClickUp team lookup returned HTTP ${teamsRes.status}`);
    const teamsData = await teamsRes.json();
    const teams = Array.isArray(teamsData.teams) ? teamsData.teams : [];

    const seen = new Set();
    for (const team of teams) {
      try {
        const memberRes = await fetch(
          `https://api.clickup.com/api/v2/team/${encodeURIComponent(team.id)}?include_members=true`,
          { headers: { Authorization: token, 'Content-Type': 'application/json' } },
        );
        if (!memberRes.ok) continue;
        const memberData = await memberRes.json();
        for (const entry of memberData.team?.members || []) {
          const user = entry?.user || entry;
          if (!user || user.id == null || seen.has(user.id)) continue;
          seen.add(user.id);
          result.members.push({
            id: user.id,
            username: String(user.username || ''),
            email: String(user.email || user.email_address || ''),
          });
        }
      } catch {
        // one team failing must not kill the directory
      }
    }
    result.members.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }
  membersCache.value = result;
  membersCache.expiresAt = Date.now() + MEMBERS_TTL;
  return result;
}

/**
 * Try to find a ClickUp member for a single sheet AM token.
 * Confidence is deliberately conservative:
 *   'email' and 'exact' and 'full' are strong; 'first' (first-name only) is weak
 *   and is only ever shown as an unverified suggestion.
 * Never throws, never guesses when nothing matches.
 */
export function matchClickUpMember(rawToken, members) {
  const token = String(rawToken || '').trim().toLowerCase();
  if (!token || !Array.isArray(members) || members.length === 0) return null;

  if (token.includes('@')) {
    const byEmail = members.find((m) => (m.email || '').trim().toLowerCase() === token);
    if (byEmail) return { ...byEmail, confidence: 'email' };
  }

  const exact = members.find((m) => (m.username || '').trim().toLowerCase() === token);
  if (exact) return { ...exact, confidence: 'exact' };

  const tokenWords = token.split(/\s+/).filter(Boolean);
  if (tokenWords.length >= 2) {
    const full = members.find((m) => {
      const words = (m.username || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      return words.length >= 2 && tokenWords.every((w) => words.includes(w));
    });
    if (full) return { ...full, confidence: 'full' };
  }

  const firstWord = tokenWords[0];
  if (firstWord && firstWord.length >= 2) {
    const first = members.find((m) => {
      const uname = (m.username || '').trim().toLowerCase();
      const words = uname.split(/\s+/).filter(Boolean);
      return uname === firstWord || words.includes(firstWord) || uname.startsWith(firstWord + ' ');
    });
    if (first) return { ...first, confidence: 'first' };
  }
  return null;
}

/**
 * Builds the notification comment text with @mentions for the Account Manager(s) and Ovi.
 * Handles single names, full names, multi-assignees (e.g. "Rifat, Sajedur"),
 * and provides safe fallbacks so sending emails NEVER gets stuck.
 */
export function resolveAccountManager(rawAm) {
  const raw = String(rawAm || '').trim();
  const isNonPerson =
    !raw ||
    /^(n\/?a|no\s*am|none)/i.test(raw) ||
    /support\s*(team|email)/i.test(raw);

  if (isNonPerson) {
    return {
      raw,
      isNonPerson: true,
      matchedUsers: [],
      unmatchedNames: [],
      fyiUser: OVI_CLICKUP_USER,
    };
  }

  const tokens = raw.split(/[,&/]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const matchedUsers = [];
  const unmatchedNames = [];

  for (const token of tokens) {
    let am = AM_DIRECTORY[token];
    if (!am) {
      const firstWord = token.split(/\s+/)[0];
      am = AM_DIRECTORY[firstWord];
    }
    if (am) {
      if (!matchedUsers.some((u) => u.id === am.id)) {
        matchedUsers.push(am);
      }
    } else {
      unmatchedNames.push(token);
    }
  }

  return {
    raw,
    isNonPerson: false,
    matchedUsers,
    unmatchedNames,
    fyiUser: OVI_CLICKUP_USER,
  };
}

/**
 * The operator directory shown by "👥 View All AMs".
 *
 * Source of truth is the sheet: pass the distinct AM strings currently present
 * in the master tabs' Account Manager column (getAllSheetAccountManagers in
 * dashboardApi.js). Each name is then placed in one of three states:
 *
 *   linked     -> in AM_DIRECTORY, so it has a verified ClickUp @mention id
 *   suggested  -> not in AM_DIRECTORY, but matched against the live ClickUp
 *                 roster (matchClickUpMember). UNVERIFIED: shown in the console
 *                 only, never fed to a comment's @mentions.
 *   not_linked -> in the sheet but matched to nothing. No id is fabricated.
 *
 * When no sheet data is available (or every name filtered out), it falls back
 * to the hardcoded AM_DIRECTORY so a sheets hiccup never empties the directory.
 */
export function getAccountManagersList({ sheetNames = null, members = [] } = {}) {
  const NO_PERSON_RE = /^(n\/?a|no\s*am|none)/i;
  const SUPPORT_RE = /support\s*(team|email)/i;
  const collected = new Map(); // key (lowercased) -> display spelling from the sheet
  if (Array.isArray(sheetNames)) {
    for (const raw of sheetNames) {
      const cell = String(typeof raw === 'object' && raw !== null ? raw.name ?? raw : raw ?? '').trim();
      if (!cell || NO_PERSON_RE.test(cell) || SUPPORT_RE.test(cell)) continue;
      const tokens = cell
        .split(/[,&/]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const token of tokens) {
        if (!token || NO_PERSON_RE.test(token) || SUPPORT_RE.test(token)) continue;
        const key = token.toLowerCase();
        if (key && !collected.has(key)) collected.set(key, token);
      }
    }
  }

  const entries = [];
  const seenIds = new Set();

  for (const [key, display] of collected) {
    // the same precedence resolveAccountManager uses for @mentions
    let am = AM_DIRECTORY[key];
    if (!am) am = AM_DIRECTORY[key.split(/\s+/)[0]];
    if (am) {
      if (!seenIds.has(am.id)) {
        seenIds.add(am.id);
        entries.push({
          name: am.name,
          token: display,
          id: am.id,
          email: am.email,
          status: 'linked',
          source: 'directory',
        });
      }
      continue;
    }

    const match = matchClickUpMember(key, members);
    if (match) {
      if (!seenIds.has(match.id)) {
        seenIds.add(match.id);
        entries.push({
          name: match.username || display,
          token: display,
          id: match.id,
          email: match.email,
          status: 'suggested',
          source: 'clickup',
          confidence: match.confidence,
        });
      }
      continue;
    }

    entries.push({ name: display, token: display, status: 'not_linked' });
  }

  // Defensive fallback: no usable sheet names -> the old hardcoded directory,
  // so the button never shows an empty list because a sheet read failed.
  if (entries.length === 0) {
    const map = new Map();
    for (const val of Object.values(AM_DIRECTORY)) {
      if (!map.has(val.id)) map.set(val.id, val);
    }
    for (const val of map.values()) {
      entries.push({
        name: val.name,
        token: val.name,
        id: val.id,
        email: val.email,
        status: 'linked',
        source: 'directory',
      });
    }
  }

  const rank = { linked: 0, suggested: 1, not_linked: 2 };
  entries.sort(
    (a, b) => rank[a.status] - rank[b.status] || (a.name || '').localeCompare(b.name || ''),
  );

  return {
    accountManagers: entries,
    total: entries.length,
    linked: entries.filter((e) => e.status === 'linked').length,
    suggested: entries.filter((e) => e.status === 'suggested').length,
    notLinked: entries.filter((e) => e.status === 'not_linked').length,
    fyiUser: OVI_CLICKUP_USER,
  };
}

/**
/**
 * Builds the plain-text preview string (used in the UI preview panel).
 * @mentions are shown as `@userId` for human readability only.
 */
export function buildMaintenanceNotificationComment({ accountManager, websiteUrl, monthName }) {
  const cleanUrl = String(websiteUrl || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  const month = monthName || 'the current month';
  const amRes = resolveAccountManager(accountManager);

  if (amRes.isNonPerson) {
    return `We have completed Maintenance for the month of ${month} and sent email to clients for ${cleanUrl}. FYI @${OVI_CLICKUP_USER.id}`;
  }

  const mentions = [];
  for (const user of amRes.matchedUsers) {
    mentions.push(`@${user.id}`);
  }
  for (const name of amRes.unmatchedNames) {
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    mentions.push(`AM: ${capitalized}`);
  }

  const prefix = mentions.length > 0 ? `${mentions.join(' ')} ` : '';
  return `${prefix}We have completed Maintenance for the month of ${month} and sent email to clients for ${cleanUrl}. FYI @${OVI_CLICKUP_USER.id}`;
}

/**
 * Builds the rich-text `comment` blocks array for the ClickUp API.
 *
 * Per the verified MD doc (clickup-comment-with-mention.md, 2026-09-14):
 * - Real @mentions MUST use `{ type: 'tag', user: { id: <numeric_id> } }` blocks
 *   at the ROOT of the request body as a `comment` array.
 * - Using `comment_text` with "@userId" strings only stores literal text —
 *   no mention tag is created and no notification is sent.
 *
 * Structure sent to API:
 * {
 *   "comment": [
 *     { "type": "tag", "user": { "id": 87307012 } },
 *     { "text": " We have completed Maintenance..." },
 *     { "type": "tag", "user": { "id": 49039188 } }
 *   ],
 *   "notify_all": false
 * }
 */
export function buildMaintenanceNotificationBlocks({ accountManager, websiteUrl, monthName }) {
  const cleanUrl = String(websiteUrl || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  const month = monthName || 'the current month';
  const amRes = resolveAccountManager(accountManager);

  const blocks = [];

  if (!amRes.isNonPerson && amRes.matchedUsers.length > 0) {
    // Tag each matched Account Manager
    for (let i = 0; i < amRes.matchedUsers.length; i++) {
      if (i > 0) blocks.push({ text: ' ' }); // space between multiple tags
      blocks.push({ type: 'tag', user: { id: amRes.matchedUsers[i].id } });
    }
    // Append any unresolved names as plain text
    if (amRes.unmatchedNames.length > 0) {
      const names = amRes.unmatchedNames
        .map((n) => `AM: ${n.charAt(0).toUpperCase() + n.slice(1)}`)
        .join(', ');
      blocks.push({ text: ` ${names}` });
    }
    // Main message body
    blocks.push({
      text: ` We have completed Maintenance for the month of ${month} and sent email to clients for ${cleanUrl}. FYI `,
    });
  } else {
    // Non-person / support team — no AM tag, just the message
    blocks.push({
      text: `We have completed Maintenance for the month of ${month} and sent email to clients for ${cleanUrl}. FYI `,
    });
  }

  // Always tag Ovi at the end
  blocks.push({ type: 'tag', user: { id: OVI_CLICKUP_USER.id } });

  return blocks;
}

export async function getClickUpTaskPreview({
  timeTrackUrl,
  websiteUrl,
  accountManager,
  monthName,
}) {
  const taskId = taskIdFromUrl(timeTrackUrl);
  const amResolution = resolveAccountManager(accountManager);
  const commentText = buildMaintenanceNotificationComment({ accountManager, websiteUrl, monthName });
  const isAutoCloseEnabled = String(process.env.CLICKUP_AUTO_CLOSE_ENABLED || 'false').toLowerCase() === 'true';
  const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
  const hasToken = Boolean(token);

  // Only attempt live task lookup if there's a task ID AND a token
  let liveTask = null;
  let taskError = null;
  if (taskId && hasToken) {
    try {
      // Use a short timeout — this is preview, never block the UI
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const cached = cache.get(taskId);
        if (cached && cached.expiresAt > Date.now()) {
          liveTask = cached.value;
        } else {
          const response = await fetch(
            `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}?include_subtasks=true`,
            { headers: { Authorization: token, 'Content-Type': 'application/json' }, signal: controller.signal }
          );
          clearTimeout(timeoutId);
          if (response.ok) {
            const task = await response.json();
            liveTask = {
              id: task.id,
              name: task.name || '',
              status: task.status?.status || '',
              url: task.url || timeTrackUrl,
              updatedAt: task.date_updated ? new Date(Number(task.date_updated)).toISOString() : '',
              assignees: (task.assignees || []).map((p) => p.username || p.email || '').filter(Boolean),
            };
            cache.set(taskId, { value: liveTask, expiresAt: Date.now() + TTL });
          } else {
            // Non-200 = show a warning in UI, don't throw
            taskError = `ClickUp API returned HTTP ${response.status}`;
          }
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') {
          taskError = 'ClickUp API timed out (5s limit)';
        } else {
          taskError = fetchErr.message;
        }
      }
    } catch (outerErr) {
      taskError = outerErr.message;
    }
  } else if (taskId && !hasToken) {
    taskError = 'CLICKUP_API_TOKEN not set — comment preview only';
  }

  const currentStatus = liveTask?.status || (taskId ? (taskError ? 'lookup-error' : 'unknown') : 'none');
  const isClosed = (liveTask?.status || '').toLowerCase() === 'closed';

  let ready = Boolean(taskId);
  let statusBadge = 'ready';
  let statusMessage = '';

  if (!taskId) {
    statusBadge = 'no_task';
    statusMessage = 'No ClickUp time track URL found for this site in the sheet';
    ready = false;
  } else if (isClosed) {
    statusBadge = 'already_closed';
    statusMessage = `Task #${taskId} is already marked Closed in ClickUp`;
  } else if (taskError) {
    // Show as warning — the preview still works for the comment content
    statusBadge = 'warning';
    statusMessage = `Task #${taskId} found (${taskError}). Comment preview still generated.`;
    ready = true; // Still allow sync button — task URL is valid
  } else if (liveTask) {
    statusBadge = 'ready';
    statusMessage = `Task #${taskId} is currently "${currentStatus}". Ready to close & notify.`;
  } else {
    statusBadge = 'ready';
    statusMessage = `Task #${taskId} detected. Ready to close & notify.`;
  }

  return {
    ready,
    statusBadge,
    statusMessage,
    taskId: taskId || null,
    timeTrackUrl: timeTrackUrl || null,
    currentStatus,
    targetStatus: 'Closed',
    liveTask,
    taskError,
    hasToken,
    accountManager: amResolution,
    fyiUser: OVI_CLICKUP_USER,
    commentText,
    autoCloseEnabled: isAutoCloseEnabled,
  };
}


/**
 * Closes the ClickUp time track task and posts the completion notification comment.
 * Includes a strict safety guard: unless CLICKUP_AUTO_CLOSE_ENABLED=true in the environment,
 * it runs in dry-run mode and will not mutate production ClickUp tasks.
 */
export async function completeClickUpMaintenanceTask({
  timeTrackUrl,
  websiteUrl,
  accountManager,
  monthName,
  dryRun = false,
}) {
  const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
  const taskId = taskIdFromUrl(timeTrackUrl);
  if (!taskId) {
    return { skipped: true, reason: 'No valid ClickUp task ID found in time track URL' };
  }

  const commentText = buildMaintenanceNotificationComment({ accountManager, websiteUrl, monthName });
  // Rich-text blocks for the actual API call (produces real @mention tags)
  const commentBlocks = buildMaintenanceNotificationBlocks({ accountManager, websiteUrl, monthName });

  // STRICT SAFETY GUARD:
  // Must be explicitly enabled via CLICKUP_AUTO_CLOSE_ENABLED=true in .env to perform live mutations.
  const isEnabled = String(process.env.CLICKUP_AUTO_CLOSE_ENABLED || 'false').toLowerCase() === 'true';
  const shouldDryRun = dryRun || !isEnabled;

  if (shouldDryRun) {
    const reason = !isEnabled ? 'CLICKUP_AUTO_CLOSE_ENABLED is not enabled in settings' : 'dryRun flag is active';
    console.log(`[ClickUp DRY RUN - ${reason}]`);
    console.log(`  Task ID: ${taskId} (${timeTrackUrl})`);
    console.log(`  Would update status to: "Closed"`);
    console.log(`  Would post comment: "${commentText}"`);
    return {
      dryRun: true,
      reason,
      taskId,
      status: 'Closed',
      comment: commentText,
    };
  }

  if (!token) {
    throw new Error('CLICKUP_API_TOKEN is missing in environment');
  }

  // 1. Post notification comment using the rich-text `comment` blocks array.
  // Per clickup-comment-with-mention.md: `comment_text` with "@userId" strings
  // does NOT create real mention tags — only the root-level `comment` array does.
  const commentRes = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comment: commentBlocks,   // ← root-level array, NOT comment_text
      notify_all: false,        // assignees/watchers are always notified regardless
    }),
  });
  if (!commentRes.ok) {
    const errText = await commentRes.text().catch(() => '');
    throw new Error(`ClickUp post comment failed (HTTP ${commentRes.status}): ${errText}`);
  }
  const commentData = await commentRes.json();

  // 2. Change status to "Closed"
  const statusRes = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'Closed',
    }),
  });
  if (!statusRes.ok) {
    const errText = await statusRes.text().catch(() => '');
    throw new Error(`ClickUp update status to Closed failed (HTTP ${statusRes.status}): ${errText}`);
  }
  const taskData = await statusRes.json();

  // Invalidate read cache for this task
  cache.delete(taskId);
  cache.delete(`comments:${taskId}`);

  return {
    success: true,
    taskId,
    status: taskData.status?.status || 'Closed',
    commentId: commentData.id,
    commentText,
  };
}

