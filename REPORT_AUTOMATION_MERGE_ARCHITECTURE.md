# OfficeOS + Daily Report Automation — Merge Architecture

**Status:** discovery and design only — no application behavior has been changed by this document.

## 1. Objective

Bring the useful capabilities from the separate **Report Automation** project into OfficeOS so there is one product and one navigation system:

- A normal OfficeOS user gets a **My Daily Report** dashboard: scheduled reporting status, a WhatsApp-paste/report form, a preview, submit/edit controls, and their own history.
- A superadmin gets **Report Operations**: every user's report status, schedules, report history, ClickUp task preview/import, and report-link management.
- Every submitted daily report is saved as an immutable operational record and added to the OfficeOS chat knowledge base. The chat can answer questions such as “what did Maria report yesterday?”, “which reports are missing today?”, and “what ClickUp tasks were overdue in last Friday's reports?” with date, user, and source links.

This is a feature merge, **not** a second application embedded inside OfficeOS. OfficeOS remains the single dashboard and API server.

## 2. What exists today

### OfficeOS (target host)

- Node.js server (`src/server.js`) and single-page dashboard (`public/master-app.js`).
- JSON data layer (`src/db.js` and `data/*.json`).
- Existing `user`, `admin`, and `superadmin` dashboard views.
- Existing Daily Review, Sheets, dev-tracker, maintenance, ClickUp helper, and RAG/chat systems.
- Current user selection is a local dashboard profile chooser; it is **not sufficient as real access control** when hosted publicly.

### Separate Report Automation project (source features)

- Next.js / Cloudflare D1 / Better Auth implementation.
- Daily report form with WhatsApp-message parsing, counts, task URLs, maintenance fields, preview, and final formatted report.
- Submission history and schedule-driven “report due today” workflow.
- Admin/reviewer report views, department scoping, users, calendars, exports, and ClickUp overdue-task discovery.
- It currently includes a ClickUp token fallback in source code. That must never be copied into OfficeOS or Git history.

## 3. Chosen delivery approach — bridge first, merge safely later

The Report Automation application is already live at `report-automation.taion16240.workers.dev`. The best immediate approach is **not** to copy/port its entire Next.js UI into OfficeOS before it is needed. Keep it as the report-writing application and add an OfficeOS **Report Portal** that receives a secure mirror of report events.

This gives OfficeOS live report visibility and chat knowledge immediately, without risking the existing hosted report workflow. A later UI merge can reuse the same OfficeOS report repository and API.

### Why bridge-first is better now

- The currently hosted Report Automation application keeps working while OfficeOS is extended.
- A report submission is copied to OfficeOS at the moment it is saved; chat never depends on a slow periodic scrape.
- OfficeOS can show a unified report dashboard alongside existing maintenance, email-report, Sheets, and project tools.
- The same API and report storage will remain useful if/when the authoring UI is later moved into OfficeOS.
- It avoids a risky two-way data sync. Report Automation is the only writer at first; OfficeOS is the reporting mirror and AI reader.

## 4. Bridge architecture

```text
Author uses Report Automation (existing hosted app)
             |
             | submit / edit / delete event
             | HMAC-signed server-to-server webhook
             v
OfficeOS report-ingestion endpoint
             |
             +--> report snapshot repository + revision history
             +--> derived RAG chunks for OfficeOS chat
             +--> Report Portal (read-only mirror)
             |
             +--> superadmin ClickUp link import/configuration
                         |
                         v
                       ClickUp API
```

### Why this approach

- No duplicated daily-report form or risky immediate data migration.
- Report Automation remains the writer during phase 1; OfficeOS reads a verified mirror.
- Daily reports become first-class, date-filterable OfficeOS evidence instead of only text shown on a page.
- The storage boundary can move from JSON files to D1 later without changing the user-facing workflows.

### Event contract

Report Automation sends `POST /api/master/report-automation/ingest` from its **server** after a successful create/edit. OfficeOS verifies a timestamped HMAC signature before accepting the payload. The browser never receives the webhook secret.

```json
{
  "eventId": "uuid",
  "eventType": "report.created | report.updated",
  "occurredAt": "2026-09-22T10:15:00.000Z",
  "sourceReportId": "report-automation-id",
  "revision": 2,
  "author": { "sourceUserId": "...", "name": "...", "email": "..." },
  "report": {
    "reportDate": "2026-09-22",
    "finalReport": "...",
    "counts": { "done": 4, "review": 2, "progress": 1, "overdue": 1 },
    "taskLinks": [{ "taskId": "...", "name": "...", "url": "..." }]
  }
}
```

OfficeOS stores `sourceReportId + revision` idempotently. Retried webhooks cannot duplicate reports or chat chunks.

## 5. Data model to add

Create a report repository module (for example `src/dailyReports.js`) rather than mixing this into Daily Review rows.

| Store | Purpose | Key fields |
|---|---|---|
| `daily-reports.json` | Current report records and final output | `id`, `userId`, `userName`, `reportDate`, `rawInput`, `finalReport`, status counts, `createdAt`, `updatedAt` |
| `daily-report-revisions.json` | Immutable edit history | `id`, `reportId`, `revision`, `finalReport`, `changedBy`, `changedAt`, `reason` |
| `report-schedules.json` | Who is expected to submit on each date | `id`, `userId`, `reportDate`, `assignedBy`, `createdAt` |
| `report-task-links.json` | Shared / user / department ClickUp links with provenance | `id`, `url`, `taskId`, `taskName`, `scope`, `source`, `addedBy`, `addedAt` |
| `daily-report-rag.json` | Derived searchable chunks only, regenerable | `chunkId`, `reportId`, `text`, `metadata`, `indexedAt` |

`rawInput` is useful for the form and audit trail, but only the relevant final report fields should be used by chat. Avoid indexing unneeded pasted WhatsApp content or sensitive personal information.

### Record rules

- One current report per user per local reporting date (`Asia/Dhaka`); later edits create revisions.
- `finalReport` is stored exactly as shown at submission time, including linked tasks.
- Every imported ClickUp task retains its task ID, URL, source query, fetched timestamp, and user/department scope.
- A submitted report immediately regenerates its own RAG chunks. Edits replace the active chunks and preserve the old revision outside the active chat index.

## 6. UI and role design

### Normal user

Add **Report Portal** to the existing user sidebar.

1. **My latest report / history** — OfficeOS mirror of their saved hosted reports.
2. **Submit report** — a clear button opens the existing Report Automation form until that authoring UI is deliberately moved into OfficeOS.
3. **Privacy boundary** — normal users see only their own mirrored reports and report-linked task data.
4. **Future merge-ready** — the OfficeOS portal API is designed so its current outbound link can later be replaced by the native form without changing history/chat data.

### Superadmin

Add a **Report Operations** section with:

1. **Today** — scheduled, submitted, missing, completed/in-review/in-progress/overdue totals.
2. **Reports** — filter by date, user, project/account, and submission state; read/edit/audit revision history.
3. **Schedule** — assign reporting dates and copy a weekly schedule.
4. **Users & access** — map existing OfficeOS users to Report Automation identities; control which OfficeOS profiles see report features.
5. **ClickUp task import** — search selected team members, preview overdue/open tasks, explicitly choose the links to save, then import them into the correct scope.
6. **Export** — JSONL/CSV export of final reports, with a warning before any raw-input export.

The agreed access model is: **author = own reports; admin = reports they are allowed to manage; superadmin = all reports**. Department scoping is out of scope.

## 7. ClickUp design

### What the superadmin workflow does

1. Pick one or more OfficeOS users.
2. OfficeOS resolves/matches their ClickUp identities.
3. Server fetches overdue/open tasks from ClickUp.
4. Superadmin sees a **preview**: task name, status, due date, assignees, and canonical URL.
5. Superadmin selects tasks and chooses scope (global, team, or a single user).
6. OfficeOS saves only approved task metadata/links, deduplicated by ClickUp task ID.
7. A report submission can attach those saved links; chat can cite them as report evidence.

### Security requirements

- Remove the Report Automation source-code API-key fallback. Assume that key is exposed and rotate it in ClickUp.
- Use one server-side environment variable such as `CLICKUP_API_TOKEN`; never send it to the browser, JSON data files, logs, chat prompts, or Git.
- Add a superadmin-only server authorization check to all ClickUp configuration/import routes. A `role` string sent by the browser is not authorization.
- Cache read-only ClickUp responses briefly and record `fetchedAt` so chat never describes stale data as live data.
- Keep task-link import separate from live ClickUp comments. Comments require a separately proven, read-only capability and explicit scope.

## 8. Chat/RAG integration

Daily reports should be a new source type: `daily_report`.

### Ingestion text shape

```text
Daily report — 2026-09-22
Author: Jane Doe
Tasks done: 4
In review: 2
In progress: 1
Overdue: 1
Final report: ...
Task evidence: ClickUp task title — URL
```

### Retrieval behavior

1. Detect report questions: `daily report`, `what did <person> do`, `missing report`, `yesterday`, `this week`, `overdue from reports`.
2. Resolve the date in `Asia/Dhaka`; ask a follow-up only if a date/person cannot be safely determined.
3. Apply access scope before retrieval:
   - user: own reports only;
   - superadmin: all reports;
   - future admin: own department only.
4. Prefer direct, structured answers for counts/missing reports. Use LLM synthesis only when the user asks for a summary/trend.
5. Cite `author`, `report date`, submission time, revision, and ClickUp link where available.
6. Never infer that a task was completed or a client report was sent solely because a task URL exists.

### Example answers

- “Who has not submitted today?” → deterministic schedule/report comparison.
- “What did Ahmed report yesterday?” → that report's final text + task links.
- “Summarize this week’s maintenance blockers.” → date-filtered report chunks, grouped by repeated blockers, citing each report.

## 9. Temporary access model and hosting limitation

For this phase, users may submit a report on any day; a schedule can remain informative only. OfficeOS can use its existing profile selection to decide which portal navigation is visible.

However, the current OfficeOS role picker is suitable only for local/trusted-network use: a browser can change local storage or call routes directly. It cannot securely enforce “author/admin/superadmin” privacy after public hosting.

Before enabling normal users outside a trusted local network, add one of:

1. **Recommended:** Google OAuth / Better Auth (reuse the Report Automation model) with signed server sessions.
2. A simpler passwordless email/OTP system with signed HTTP-only session cookies.

Until then, the ingestion webhook itself will still be secure: it is server-to-server and HMAC authenticated. All report, schedule, user-management, ClickUp-import, and RAG routes must later derive identity and role from the server session—not from a client-supplied role or user ID.

## 10. Implementation sequence

### Phase 0 — bridge preparation

- Do not copy `node_modules`, `.next`, `.env.local`, credentials, or deployment artifacts between projects.
- Remove hard-coded ClickUp secrets; rotate the exposed token.
- Map existing OfficeOS users to the report automation user names/emails.
- Add `REPORT_AUTOMATION_WEBHOOK_SECRET` to both server environments, never to browser code.

### Phase 1 — reliable report bridge

- Extend the hosted Report Automation server route to emit a signed event only after its own D1 write succeeds.
- Add OfficeOS webhook verification, idempotent report repository, revision history, dead-letter/error log, and manual resync endpoint.
- Add normal-user **Report Portal** history and superadmin **Report Operations** list.
- Build/update report RAG chunks in the same transaction flow.

### Phase 2 — ClickUp links and operational controls

- Keep the existing hosted report schedule initially; mirror schedule state only if OfficeOS needs it for missing-report KPIs.
- Add OfficeOS ClickUp adapter with secure settings, member matching, task preview, explicit import, deduplication, and audit fields.
- Add revision history and report export.

### Phase 3 — chat knowledge and eventual UI merge

- Add report intent routing and deterministic report queries.
- Add scoped retrieval/citations and evaluation questions based on real reports.
- Later, port the report authoring form into OfficeOS only after the bridge has proven the data model and access rules. Then change the Report Portal's submit button to the native form; keep the webhook as a migration/fallback mechanism until retired.

### Phase 4 — quality and hosted readiness

- Test user isolation, superadmin visibility, session bypass attempts, cutoff behavior, duplicate imports, and revision/chat freshness.
- Add backups and an eventual D1 storage adapter before multi-user public hosting.

## 11. Acceptance criteria

- A report saved in the hosted application appears in OfficeOS and chat without manual copying.
- An HMAC-invalid/replayed webhook is rejected or deduplicated and logged safely.
- A normal user can see only their own mirrored reports in the OfficeOS portal.
- A superadmin can see all report status, schedules, and report history.
- A superadmin can preview ClickUp tasks and explicitly save selected links; no API token reaches the client.
- New/edited reports immediately become retrievable by OfficeOS chat with correct user/date citations.
- Chat does not leak another user's reports to a normal user.
- The dashboard still works if ClickUp is unavailable; it reports the failure honestly and preserves existing reports.
- Existing maintenance, Sheets, Dev Tracker, SOP handbook, and email flows remain unchanged.

## 12. Confirmed decisions and remaining decision

Confirmed:

1. Do not add a new login in this phase; use OfficeOS's existing local role/profile experience and add proper hosted auth later.
2. Users may submit any day.
3. Reports are visible to the author, authorized admins, and superadmins; department scoping is not needed.
4. Preserve the current ClickUp overdue-task preview/import behavior first.
5. The existing hosted Report Automation application remains active while OfficeOS receives a mirrored report copy.

Remaining decision:

- Should the OfficeOS report mirror use its existing JSON repository for the first local phase, or should it write directly to a dedicated Cloudflare D1 database now? I recommend **JSON first for the local OfficeOS merge**, with a D1-ready repository interface, then D1 before public multi-user hosting.
