# OfficeOS + Report Automation — Full Implementation Guide

**Status:** Implementation blueprint. This document is the complete, code-level map for merging the **Report Automation** project into **OfficeOS** (bridge-first webhook architecture). It is written so another AI (or engineer) can implement the feature without re-deriving the codebase facts.

**Source of decisions:** `REPORT_AUTOMATION_MERGE_ARCHITECTURE.md` (the approved plan) + direct inspection of both codebases (verified line references below).

---

## 1. The Two Codebases At A Glance

| | Report Automation (source features) | OfficeOS / maintenance-mailer (target host) |
|---|---|---|
| Location | `C:\Users\toufi_qicjadj\Report automation` | `C:\Users\toufi_qicjadj\Downloads\maintenance-mailer` |
| Stack | Next.js 15 (App Router) + OpenNext/Cloudflare Workers + Cloudflare D1 + Drizzle ORM + Better Auth + Tailwind v4 | Plain Node.js `http` server + static SPA (no framework) + JSON file persistence |
| Live URL | `report-automation.taion16240.workers.dev` | local / LAN only |
| Server entry | `src/app/**` (Next routes) | `src/server.js` (~2550 lines, single file) |
| Data layer | Cloudflare D1 (SQLite) via Drizzle, schema in `src/db/schema.ts` | `src/db.js` + `data/*.json` |
| Auth | Better Auth sessions (secure cookies) | None real — `?role=` query param + `localStorage.officeos_session` profile chooser (forgeable) |
| Roles | `superadmin`, `admin`, `member`, `reviewer` | `superadmin`, `admin`, `user` (client-side nav only) |
| ClickUp | `src/lib/clickup.ts` — **contains a hard-coded API key fallback (MUST be removed/rotated)** | `src/clickup.js` — read-only task/comment lookup via `process.env.CLICKUP_API_TOKEN` (safe pattern) |

**Golden rules for the implementer:**
1. Report Automation keeps working unchanged at its live worker URL. OfficeOS becomes the **report mirror + chat knowledge base**.
2. Never copy the hard-coded ClickUp token from Report Automation (see §9). Rotate that token in ClickUp; OfficeOS uses its own `CLICKUP_API_TOKEN` env var.
3. OfficeOS's existing maintenance / Sheets / Dev Tracker / SOP handbook / email flows must remain unchanged.
4. OfficeOS uses its existing local role/profile experience for this phase. No new login. JSON data layer first, D1 later.
5. Do not read/copy `.env.local`, `service-account.json`, or any credential files.

---

## 2. File-By-File Structure

### 2.1 Report Automation (`C:\Users\toufi_qicjadj\Report automation`)

```
Report automation/
├─ src/
│  ├─ app/
│  │  ├─ api/
│  │  │  ├─ auth/
│  │  │  │  ├─ [...all]/route.ts        # Better Auth catch-all handler
│  │  │  │  └─ dev-login/route.ts       # dev-only login (disabled in prod)
│  │  │  ├─ clickup/
│  │  │  │  └─ overdue/route.ts          # GET list overdue tasks (per member), POST preview
│  │  │  ├─ departments/route.ts         # GET/POST/PATCH/DELETE departments
│  │  │  ├─ debug-env/route.ts           # env diagnostic (non-secret only)
│  │  │  ├─ export/route.ts               # GET fine-tuning JSONL export (superadmin)
│  │  │  ├─ schedule/route.ts             # GET/POST/DELETE schedule assignments
│  │  │  ├─ submissions/
│  │  │  │  ├─ route.ts                   # GET list (scoped), POST create + generateReport
│  │  │  │  └─ [id]/route.ts              # GET one, PATCH edit (creates submission_edits row)
│  │  │  ├─ team-links/route.ts           # GET/POST/DELETE/PATCH team task links
│  │  │  └─ users/route.ts                # GET/PATCH/DELETE users (admin)
│  │  ├─ (auth-pages) / (dashboard pages)  # Next UI: form, history, admin views, calendar, etc.
│  ├─ db/
│  │  ├─ index.ts                         # D1 client + drizzle instance
│  │  └─ schema.ts                        # ⭐ full Drizzle schema (see §3)
│  ├─ lib/
│  │  ├─ api-helpers.ts                   # requireSession, getRequestDeps, withErrorHandling
│  │  ├─ auth.ts                          # Better Auth config (users table, role field)
│  │  ├─ auth-client.ts                   # client-side Better Auth hooks
│  │  ├─ clickup.ts                       # ⚠️ hard-coded DEFAULT_API_KEY + DEFAULT_TEAM_ID (remove+rotate)
│  │  ├─ parse-messages.ts                # WhatsApp paste parser → form values
│  │  ├─ permissions.ts                   # RBAC: Role, Action, PERMISSIONS map, can/requirePermission
│  │  ├─ report-formatter.ts              # REPORT_CONFIG + generateReport(input) → final text
│  │  └─ timezone.ts                      # Asia/Dhaka helpers + daily cutoff
│  └─ ...
├─ drizzle.config.ts, wrangler.toml, package.json, next.config.ts
```

### 2.2 OfficeOS (`C:\Users\toufi_qicjadj\Downloads\maintenance-mailer`)

```
maintenance-mailer/
├─ src/
│  ├─ server.js              # ⭐ single Node http server: ALL routes + static file serving (~2550 lines)
│  ├─ db.js                  # ⭐ JSON persistence: dbRead/dbWrite into data/*.json + typed getters/setters
│  ├─ dashboardApi.js        # overview data, site previews, email sending (used by server.js)
│  ├─ masterApi.js           # ⚠️ LEGACY / UNUSED — server.js does NOT import this. Do not extend it.
│  ├─ sheets.js              # Google Sheets reads (CW/RM Maintenance, Daily Review, Dev Tracker)
│  ├─ sheetsCache.js         # in-memory read cache + invalidation
│  ├─ sheetSchema.js         # sheet discovery / schema registry
│  ├─ devAssistant.js        # answerDevQuestion() — builtin + LLM chain (§7)
│  ├─ enterpriseRag.js       # hybrid vector+BM25 RAG over data/rag-index.json (§7)
│  ├─ docsRag.js             # Google Docs ingestion for chat
│  ├─ handbookRag.js         # SOP handbook (external Worker) chat integration
│  ├─ clickup.js             # read-only ClickUp task/comment lookup (CLICKUP_API_TOKEN) — safe pattern
│  └─ ... (email/sheet helpers)
├─ public/
│  └─ master-app.js          # ⭐ SPA: NAV_SECTIONS (≈L198), viewFns (≈L298), localStorage session (≈L475–549)
├─ data/                     # JSON stores (see §6.1)
└─ REPORT_AUTOMATION_MERGE_ARCHITECTURE.md   # the approved plan this guide implements
```

---

## 3. Report Automation — Data Schema (D1, `src/db/schema.ts`)

### Tables & key columns

**`users`** — `id` (text pk), `name`, `email` (unique), `emailVerified`, `image`, `role` (`superadmin|admin|member|reviewer`, default `member`), `departmentId` → departments, timestamps.

**`session` / `account` / `verification`** — Better Auth v1+ internal tables (token unique, userId FK cascade, provider fields).

**`departments`** — `id`, `name` (unique), `description`, timestamps.

**`team_task_links`** — shared dev-task links injected into the "Total {n} development task" section of every report: `id`, `url`, `sortOrder`, `addedBy` → users, `departmentId` → departments (cascade), `createdAt`.

**`schedule_assignments`** — `id`, `userId` → users (cascade), `assignedDate` (`'YYYY-MM-DD'`), `assignedBy` → users, `createdAt`; **unique `(userId, assignedDate)`**.

**`submissions`** — the daily report itself:
- `id` text pk, `userId` → users, `reportDate` `'YYYY-MM-DD'`; **unique `(userId, reportDate)`**
- `rawWhatsappText` (nullable raw WhatsApp paste)
- `rawInput` (JSON string — verbatim copy of the full POST body, used to reconstruct edit state)
- Denormalized counts: `totalAssigned`, `tasksDone`, `tasksDoneLink`, `inReview`, `inProgress`, `overdueTasks`, `overdueDependencies`, `overdueDepNote`, `tomorrowCount`
- `finalReport` (text — the server-generated formatted report, the source of truth for display)
- Edit tracking: `editedBy` → users, `editedAt`, `editCount` (default 0)
- `createdAt`

**`submission_edits`** — append-only audit log: `id`, `submissionId` → submissions (cascade), `editedBy` → users, `editedAt`, `previousRawInput`, `previousReport`, `changeNote`.

### Contract to mirror in OfficeOS

A submission is identified by **(userId, reportDate)**; edits increment `editCount` and append a `submission_edits` row. `finalReport` is generated server-side by `generateReport()` from `rawInput` — OfficeOS must treat `finalReport` as immutable evidence and keep `rawInput` out of chat indexing where possible.

---

## 4. Report Automation — Logic Modules

### 4.1 RBAC (`src/lib/permissions.ts`)
- `Role = "superadmin" | "admin" | "member" | "reviewer"`.
- `Action` grants:
  - **superadmin:** everything incl. `manage:admin_roles`, `manage:departments`, `export:data`.
  - **admin:** `view:all`, `edit:any`, `manage:schedule`, `manage:users`, `view:departments`, `export:data` (no department CRUD, no admin-role changes).
  - **reviewer:** `view:all`, `edit:own` (no schedule/user/export).
  - **member:** `view:own`, `submit:own`, `edit:own`.
- API routes call `requireSession()` then `requirePermission(role, action)`.

### 4.2 Report generation (`src/lib/report-formatter.ts`)
- `REPORT_CONFIG` — header/labels/zero-pad. Editing this object changes the report format; `generateReport()` is pure.
- `generateReport(ReportInput) → string` builds:
  1. Header line: `"Here are the details of our tasks for today:"`
  2. `Report: <date>` formatted as `D Mon YYYY`
  3. `Total Assigned tasks on Click-Up = N` (falls back to done+review+progress)
  4. `Tasks Done = NN` + each done-task URL on its own line (`tasksDoneLinks[]` or legacy `tasksDoneLink` split on newlines)
  5. Optional maintenance block (`* Maintenance is on-going*` / `Total Maintenance completed - N`)
  6. `In review = N`, `In Progress = N`, `Over Due Tasks = NN`
  7. `Over Due Tasks (Dependencies) = NN <note>` 
  8. `Total {n} development task` + team links (from `team_task_links` table, filtered by department, sorted by `sortOrder`)
  9. `Tomorrow’s Team Plan/Tasks on Click-Up = N (We will work on these tasks tomorrow)`
- `FineTuningRecord` export shape for `/api/export`.

### 4.3 WhatsApp parser (`src/lib/parse-messages.ts`)
- Parses pasted WhatsApp task messages into structured form values (counts/links). Used by the UI form; server only stores the raw text + form JSON.

### 4.4 Submission flow (mirror these semantics in the webhook payload)
- **POST `/api/submissions`:** require `submit:own` → load team task links → build `ReportInput` → `generateReport` → insert submissions row (rawInput = `JSON.stringify(body)`, finalReport). Returns `{ id, finalReport }` 201.
- **PATCH `/api/submissions/[id]`:** edit (within cutoff) → insert `submission_edits` with previous values → update row + `editCount + 1`.
- **GET `/api/submissions`:** member sees only own; reviewer/admin see own department only; superadmin sees all (optional `?departmentId=` filter, `unassigned` supported). **Non-superadmins see `superadmin` user roles masked to `admin`** in responses.

### 4.5 Timezone (`src/lib/timezone.ts`)
- All report dates are `'YYYY-MM-DD'` in **Asia/Dhaka**. Same convention must be used by OfficeOS for schedule/missing-report KPIs.

### 4.6 ClickUp (`src/lib/clickup.ts`) — ⚠️ SECURITY ISSUE
- Contains: `DEFAULT_API_KEY = "pk_87418108_J3Z9LHN42XMVMQSMB71U5BZJV0QJGJN1"`, `DEFAULT_TEAM_ID = "10554421"`, `DEFAULT_TIMEZONE = "Asia/Dhaka"`.
- `getClickUpHeaders(apiKey?)` falls back to env then the hard-coded default. **This key must be treated as compromised: rotate it in ClickUp, and never copy it to OfficeOS.** OfficeOS's own pattern (`src/clickup.js`, `CLICKUP_API_TOKEN`) is the model to follow.

---

## 5. OfficeOS — Route Inventory (`src/server.js`)

All app routes live under `/api/master/` (guard at ≈L298). Request handling pattern: `pathname === X && method === Y` → `const b = await body()` → role from `b.role || reqUrl.searchParams.get('role')` → call helper → `ok(...)` / `err(400|401|403|500, msg)`.

### Full inventory (verify against this list — do not duplicate when adding report routes)

| Method & Path | Purpose |
|---|---|
| GET `/api/master/db-status` | DB file status |
| GET `/api/master/stats` | aggregate stats |
| GET/POST `/api/master/months`, POST `/months/select`, POST `/add-month`, POST `/cleanup-empty-columns` | month columns in CW/RM sheets |
| POST `/api/master/sync` | sheets → Daily Review sync |
| GET/POST `/api/master/users`, PUT/DELETE `/api/master/users/:id` | user CRUD (superadmin) |
| POST `/api/master/sites/bulk-assign` | assign users to sites |
| GET/POST `/api/master/sites`, PUT `/api/master/sites/:id`, PUT `/:id/status`, POST `/api/master/sites/:id/assign` | site management (admin+) |
| POST `/api/master/sync-status` | explicit sync to sheet |
| GET `/api/master/daily-review`, GET `/daily-review-all`, GET `/summary` | daily review reads (≈L687–829) |
| PUT `/api/master/daily-review/:id`, POST `/daily-review/batch` | daily review writes |
| GET/POST/PUT/DELETE `/api/master/tasks` (+ `/:id`) | tasks (admin+) |
| GET `/api/master/properties`, PUT/DELETE `/:id` | property registry (superadmin) |
| GET `/api/master/dev-projects`, POST `/fetch-live`, POST `/create-project`, PUT `/:id/items/:idx`, POST `/:id/items`, POST `/:id/feedback-round`, POST `/:id/bulk-sitemap` | Dev Tracker |
| GET/POST `/api/master/dev-assistant` | ⭐ chat: GET = overview snapshot, POST = ask (see §7) |
| POST `/api/master/rag/sync`, GET `/rag/search` | RAG re-ingestion + diagnostic search |
| GET/POST `/api/master/sheet-schema` (+ `/refresh`) | sheet schema discovery |
| GET/PUT `/api/master/assistant-config`, POST `/test`, `/test-source`, `/test-documents`, `/test-handbook` | AI provider/RAG settings (superadmin) |
| GET `/api/master/assistant-metrics` | provider/cache metrics |
| GET/POST `/api/master/domain-expiry`, POST `/check-uptime` | domain/uptime monitors |
| GET/POST/PUT/DELETE `/api/master/notices` | notices |
| GET/POST `/api/master/domain-expiry-requests`, POST `/:id/resolve` | expiry requests (admin+) |
| GET/PUT/POST/DELETE `/api/master/sheet-credentials` (+ `/:id`, `/test`, `/:id/data`, `/:id/cell`, `/:id/row`, `/:id/column`) | connected smart sheets |
| GET/POST/PUT/DELETE `/api/master/custom-sheets` (+ `/:id/probe`, `/:id/data`) | custom sheet tabs |
| `app.get('/')` + static file serving | SPA (public/) — tail ≈L2493 |

### Route sandbox tip for the implementer
Report routes should be added **inside the `/api/master/` guard**, following the same `if (pathname === ... && method === ...)` idiom, so static serving and existing routes are untouched.

---

## 6. OfficeOS — Data Layer & Frontend

### 6.1 JSON stores (`data/*.json`, via `src/db.js`)
Existing: `users.json`, `sites.json`, `tasks.json`, `properties.json`, `daily-review.json`, `dev-tracker.json`, `dev-projects.json`, `notices.json`, `domain-expiry-requests.json`, `domains.json`, `meta.json`, `distribution.json`, `custom-sheets.json`, `sheet-credentials.json`, `sheet-schema.json`, `assistant-config.json`, `assistant-metrics.json`, `rag-index.json`.

**`db.js` primitives:** `dbRead(name)` / `dbWrite(name, data)` (path `data/<name>.json`), `uuid()`, plus typed helpers (`getUsers/setUsers/getSites/getDailyReview/...`). New report stores should add matching typed helpers to `db.js`.

**`users.json` shape (verified):** `{id, name, role: 'superadmin'|'admin'|'user', email, active}`. Current data: superadmin = Toufiq; user = Sabbir, Taion, Medul, Saiful, Roeich. Emails are currently empty — the report user-mapping (Phase 2) will match Report Automation users by **ClickUp display name** (sezan, medul, taion) or by office username.

### 6.2 SPA (`public/master-app.js`)
- `NAV_SECTIONS` (≈L198) maps `role → sections[]` (`user`, `admin`, `superadmin`). Each section has `title` + `items[{id, icon, label, badge?}]`.
- `viewFns` (≈L298) maps `viewId → render function`. Navigation calls `navigate(viewId)` which looks up `viewFns[viewId]`.
- Session: `localStorage.officeos_session = {role, userName, userId}` (≈L475–549). **Client-forgeable** — acceptable only for trusted-network use this phase.
- To add Report Portal: append a `user` NAV section (e.g. `{ title: 'Reporting', items: [{ id:'report-portal', icon: ..., label:'My Daily Report' }] }`) and a `superadmin` section (`report-operations`) with the same view functions in `viewFns`.

---

## 7. OfficeOS — Chat / RAG Internals (what report answers must plug into)

### 7.1 Chat route — `POST /api/master/dev-assistant` (server.js ≈L1111–1294)
Flow: get `question` → build `history` (last 6 turns) → optional live project read (Dev Tracker) → `schemaText` (sheet schema summary) → handbook intent check → `allSheetsSummary` → Google Docs retrieval → **`retrieveRag`** (enterpriseRag) → `clickUpEvidence = []` (**intentionally disabled — Phase 2 placeholder**) → `answerDevQuestion(...)` for the final answer. Response: `{answer, intent, project, data, suggestions, engine, cached, steps, liveData}`.

### 7.2 `src/enterpriseRag.js`
- Index file: `data/rag-index.json`; chunk shape: `{id, text, vector, metadata}`.
- Metadata today: `{source_type: 'sheet'|'doc', file_name, sheet_tab?, row_number?, section_heading, source_url, last_modified, ...}`.
- `retrieveRag(question, {sourceType, candidateLimit, limit})` filters chunks by `source_type` (verified filter at ≈L145), hybrid scores, returns top-k.
- `sourceTypeForQuestion(question)` (≈L225): returns `'doc'` for how-to/SOP words, `'sheet'` for status/update/report words, `''` otherwise. **Report questions will need a `'daily_report'` branch.**
- Citation formatter ≈L228: `[n] <text>\nSOURCE: <file_name> / <tab>, row <row> — <url>`.

### 7.3 `src/devAssistant.js`
- `answerDevQuestion(question, projects, {config, schemaText, debug, allSheets, documents, sites, enterpriseRag, history, forceBuiltin})` — builtin deterministic engine first; falls back to configured LLM provider chain when needed.
- This is where a **deterministic report answerer** (missing reports, "what did X report on date D") belongs — see §8.3.

---

## 8. Bridge Architecture — Concrete Implementation Map

### 8.1 New OfficeOS modules to create

| New file | Responsibility |
|---|---|
| `src/reportBridge.js` | HMAC verify/sign helper (`verifyReportWebhook`), `createHmacSignature(secret, body)`, timestamp/`eventId` replay window (~5 min), returns `{ok, event}` or `{error}`. |
| `src/dailyReports.js` | Report repository: `getDailyReports(filter)`, `getDailyReportByUserDate(userId, reportDate)`, `upsertDailyReport(event)`, `appendRevision(...)`, `getDailyReportRevisions(reportId)`, `getReportSchedules(...)`, `setReportSchedule(...)`, `getReportTaskLinks(...)`, `saveReportTaskLinks(...)`, `getMissingReports(date, schedules)` , `regenerateReportChunks(reportId)`, `removeReportChunks(reportId)`. Pure JSON via `db.js` — a thin interface so a D1 adapter can replace it later (Phase 4). |
| `src/reportRag.js` | Derives RAG chunks from `daily-reports.json` (metadata `source_type: 'daily_report'`), embeds, appends to `daily-report-rag.json`. Re-uses the embedding pipeline exported by `enterpriseRag.js` (see §8.4). |

### 8.2 New data stores (`data/*.json`)

| File | Records |
|---|---|
| `daily-reports.json` | `{id, sourceReportId, revision, userId, userName, reportDate, rawInput?, finalReport, counts:{done,review,progress,overdue,overdueDeps,tomorrow,totalAssigned,maintenanceEnabled,maintenanceTotal}, taskLinks:[{taskId,name,url}], author:{sourceUserId,name,email}, eventId, eventType, createdAt, updatedAt}` — **one current record per (userId, reportDate)**. |
| `daily-report-revisions.json` | append-only `{id, reportId, revision, finalReport, changedBy, changedAt, reason}` |
| `report-schedules.json` | `{id, userId, reportDate, assignedBy, createdAt}` — informative only this phase |
| `report-task-links.json` | `{id, url, taskId, taskName, scope:'global'|'team'|'user', userId?, source, addedBy, addedAt, fetchedAt}` — dedupe on `taskId` |
| `daily-report-rag.json` | `{chunkId, reportId, text, vector, metadata, indexedAt}` — regenerable, never hand-edited |
| `report-ingest-errors.json` | dead-letter log `{id, eventId, payloadHash, error, receivedAt, replayedAt?}` |

### 8.3 New routes in `src/server.js` (inside the `/api/master/` guard)

| Route | Auth (remember: client `role` is NOT secure) | Behavior |
|---|---|---|
| `POST /api/master/report-automation/ingest` | **HMAC only (no role)** | Verify timestamp + signature with `process.env.REPORT_AUTOMATION_WEBHOOK_SECRET`. Reject replay/expired (window ≤ 5 min afa `occurredAt`). Idempotent on `(sourceReportId, revision)` — look up in `daily-reports.json`; equal revision → `200 {duplicate:true}`; newer revision → upsert + append revision row + regenerate chunks; missing → insert + regenerate chunks. On verify failure → `401` and log to `report-ingest-errors.json` (never log the payload or secret). |
| `GET /api/master/daily-reports` | role (user = own only; superadmin/admin = all) | Filter `?date=&userId=`; returns mirror rows w/o `rawInput` unless empty-role superadmin asks for audit export. |
| `GET /api/master/daily-reports/missing` | superadmin | `GET /api/master/daily-reports/missing?date=YYYY-MM-DD` — compares `report-schedules.json` to `daily-reports.json`; used by Report Operations + chat. |
| `GET /api/master/daily-reports/:id` | user = owns; superadmin = any | One report + its revisions (from `daily-report-revisions.json`). |
| `POST /api/master/report-schedules` / `DELETE .../:id` | superadmin (server-side role check) | Schedule CRUD; informative only. |
| `GET/POST /api/master/report-task-links` | GET: all roles (scoped); POST/import: **superadmin only** | ClickUp task preview/import (§9). |
| `GET /api/master/report-export?format=jsonl|csv` | superadmin | Export `finalReport` + metadata, no `rawInput` unless explicit warn-and-confirm. |
| `POST /api/master/report-resync` | superadmin | Force re-derive chunks / replay dead letters manually. |

**Role helper:** add `requireServerRole(role, allowedRoles)` in `reportBridge.js` that reads role from body/query but **asserts a real server-side identity source for superadmin-gated routes** (for this phase: an `OFFICEOS_ADMIN_PASSPHRASE` header or the existing superadmin user-id from `users.json` matched to a configured report owner — accept the planned limitation, see §11).

### 8.4 Chat integration

1. **`sourceTypeForQuestion`** (enterpriseRag.js ≈L225): add branch → question matches /daily report|who (did|reported|submitted)|missing report|yesterday|this week|overdue from reports|report on/i → `'daily_report'`.
2. **`daily-report-rag.json` chunk text** (the ingestion shape from the plan, implemented in `reportRag.js`):
   ```
   Daily report — 2026-09-22
   Author: Jane Doe
   Tasks done: 4
   In review: 2
   In progress: 1
   Overdue: 1
   Final report: ...
   Task evidence: ClickUp task title — URL
   ```
   Metadata: `{source_type:'daily_report', report_id, author_name, report_date, revision, user_id, source_url?}` — store `user_id`/`report_date` in metadata so retrieval + access scope can filter deterministically.
3. **`answerDevQuestion`** (devAssistant.js): before the generic chain, run a **deterministic report path**:
   - "Who has not submitted today?" → `reportBridge`/`dailyReports.getMissingReports(todayDhaka)` → structured answer with date + names.
   - "What did <person> report <date>?" → resolve person (match OfficeOS `users.json` name OR report `author_name`), filter chunks by `user_id`+`report_date`, return `finalReport` text + revision + submission time.
   - Summaries/trends ("summarize this week's maintenance blockers") → pass date-filtered `daily_report` chunks into the LLM path with citation formatting already supported.
   - Access scope: only superadmin queries may cross users; a normal user's chat retrieves only their own `user_id` chunks (enforced in the retrieval filter — do NOT rely on the LLM).
4. Keep `clickUpEvidence` disabled until Phase 2; when enabled it must use the **safe** `src/clickup.js` read-only adapter (env token only).

### 8.5 Frontend (public/master-app.js)

- **`NAV_SECTIONS.user`** add section `Reporting` → `{id:'report-portal', label:'My Daily Report'}`.
- **`NAV_SECTIONS.superadmin`** add section → `{id:'report-operations', label:'Report Operations', badge:'Super'}`.
- **`viewFns`** add `report-portal` (calls `GET /api/master/daily-reports?userId=<session.userId>`; shows latest + history + "Submit report" button linking to `https://report-automation.taion16240.workers.dev` until the native form is merged) and `report-operations` (Today KPIs: scheduled/submitted/missing + done/review/progress/overdue totals; Reports table with date/user filters + revision drawer; Schedule; ClickUp import preview; Export). Reuse existing UI patterns (`esc()`, `getNavSvg(icon)`, `toast`/modal helpers used by other superadmin views).

---

## 9. ClickUp Security Changes (required, not optional)

1. **Rotate the token** `pk_87418108_J3Z9LHN42XMVMQSMB71U5BZJV0QJGJN1` in ClickUp — it is in Report Automation source code and must be considered compromised. Remove `DEFAULT_API_KEY` / `DEFAULT_TEAM_ID` from `src/lib/clickup.ts` (replace with env-only, mirroring `src/clickup.js`'s pattern).
2. OfficeOS uses **one env var**: `CLICKUP_API_TOKEN` (already the convention in `src/clickup.js`). Never in browser code, JSON data files, logs, chat prompts, or Git.
3. **Superadmin-only server-side gating** for every OfficeOS report/ClickUp route. A `role` string from the browser is not authorization (see §11).
4. Import workflow: pick users → match ClickUp identity → fetch overdue/open tasks via ClickUp API → **preview** (name, status, due date, assignees, canonical URL) → superadmin selects tasks + scope → OfficeOS saves deduplicated `report-task-links.json` records (with `fetchedAt`). No token reaches the client at any step.
5. Cache read-only ClickUp responses briefly (existing TTL pattern in `src/clickup.js` = 5 min) and record `fetchedAt` so chat never presents stale data as live.

---

## 10. Webhook Contract (exact shape)

Report Automation's **server** calls `POST https://<officeos-host>/api/master/report-automation/ingest` after its own D1 write succeeds (`src/app/api/submissions/route.ts` POST and `submissions/[id]/route.ts` PATCH). Headers: `Content-Type: application/json`, `X-Report-Signature: sha256=<hex>`, `X-Report-Timestamp: <unix-ms>`.

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

Signature = `HMAC-SHA256(REPORT_AUTOMATION_WEBHOOK_SECRET, timestamp + "." + rawBody)` (canonical form to be fixed in `reportBridge.js` and the Report Automation sender). Reject if `|now - occurredAt| > 5 min`. Idempotency key: `(sourceReportId, revision)`.

**Report Automation sender:** add a small `emitReportWebhook(event)` in a new `src/lib/report-webhook.ts` (or inline in submissions routes) that runs **after** the D1 insert/update commits and fire-and-forgets the signed POST. On failure, log server-side (Cloudflare `console`/`wrangler` logs) — OfficeOS also offers `POST /api/master/report-resync` for manual recovery.

---

## 11. Honest Security State (must be preserved in code comments)

- OfficeOS auth today = client-supplied `?role=` / `body.role` + forgeable `localStorage.officeos_session`. **This cannot enforce author/admin/superadmin privacy after public hosting.** It is accepted for trusted-network use this phase (per the plan's confirmed decisions).
- Therefore: **the webhook itself is the only truly secure boundary** (server-to-server HMAC). All report/schedule/ClickUp/RAG routes must later derive identity from a real server session (Google OAuth / Better Auth or email OTP with signed HTTP-only cookies) before multi-user public hosting. Until then:
  - Superadmin-gated routes should additionally check `users.json` for a verified office superadmin user-id sent via a non-browser channel (env-configured admin passphrase header) rather than trusting `role` alone.
  - Never echo `rawInput`, tokens, or webhook secret in any response/log/chat prompt.

---

## 12. Implementation Sequence (with concrete files)

### Phase 0 — bridge prep
- [ ] Rotate leaked ClickUp token; remove `DEFAULT_API_KEY`/`DEFAULT_TEAM_ID` from Report Automation `src/lib/clickup.ts` (env-only, like OfficeOS `src/clickup.js`).
- [ ] Export `embed`/`hash` helpers from `enterpriseRag.js` if not already exported (reportRag reuses them).
- [ ] Set `REPORT_AUTOMATION_WEBHOOK_SECRET` on both environments; set `CLICKUP_API_TOKEN` on OfficeOS if not present.
- [ ] Map office `users.json` ↔ Report Automation users (by office username ↔ ClickUp member name: sezan, medul, taion; Toufiq superadmin).

### Phase 1 — reliable report bridge
- [ ] Report Automation: add webhook emission after D1 write (`src/lib/report-webhook.ts` + calls in `submissions/route.ts` POST and `submissions/[id]/route.ts` PATCH).
- [ ] OfficeOS: `src/reportBridge.js` (verify/replay/idempotency/dead-letter).
- [ ] OfficeOS: `src/dailyReports.js` + `data/daily-reports.json` + `daily-report-revisions.json` + `report-ingest-errors.json`.
- [ ] OfficeOS: route `POST /api/master/report-automation/ingest` (+ GET `daily-reports`, `daily-reports/missing`, `daily-reports/:id`, `report-resync`).
- [ ] OfficeOS: `src/reportRag.js` + `data/daily-report-rag.json`; regenerate chunks in the ingest transaction.
- [ ] Frontend: **report-portal** (user) + **report-operations** (superadmin) nav + `viewFns`.

### Phase 2 — ClickUp links & operational controls
- [ ] OfficeOS: `report-task-links.json` + superadmin-only ClickUp import routes (preview → explicit save → dedupe).
- [ ] OfficeOS: revision history UI in Report Operations.
- [ ] OfficeOS: export route (`jsonl|csv`), no rawInput without warning.
- [ ] (Mirror of Report Automation schedules is optional; implement `report-schedules.json` only if missing-report KPIs require it; keep hosted schedule as source until then.)

### Phase 3 — chat knowledge
- [ ] `sourceTypeForQuestion` → `'daily_report'` branch.
- [ ] Deterministic paths in `answerDevQuestion` (missing reports, per-user-per-date reports), scoped retrieval by `user_id`/`report_date` metadata.
- [ ] Cookie/auth integration starts here if public hosting planned (see §11).
- [ ] Later (explicitly NOT now): port the Report Automation authoring form into OfficeOS; change report-portal's submit button to native form; keep webhook as fallback until retired.

### Phase 4 — quality & hosted readiness
- [ ] Tests: user isolation, superadmin visibility, session bypass attempts, cutoff behavior, duplicate imports, revision/chat freshness, HMAC-replay rejection.
- [ ] Backups for `data/*.json`; D1 storage adapter for `src/dailyReports.js` before public multi-user hosting.

---

## 13. Acceptance Criteria → Route Mapping

| Criterion | How verified |
|---|---|
| Report saved in hosted app appears in OfficeOS + chat instantly | `POST /api/master/report-automation/ingest` → `GET /api/master/daily-reports` + `POST /api/master/dev-assistant` returns it with source_type `daily_report` |
| HMAC-invalid/replayed webhook rejected/deduplicated + logged | ingest route `401`s bad sig; `{duplicate:true}` on re-send; entry in `report-ingest-errors.json` |
| Normal user sees only own mirrored reports | `GET /api/master/daily-reports` + report-portal filtered by session userId; chat retrieval scoped by `user_id` |
| Superadmin sees all report status/schedules/history | `report-operations` (superadmin nav) + `daily-reports/:id` revisions + `daily-reports/missing` |
| Superadmin previews ClickUp tasks, saves selected; no token to client | import routes (superadmin-only) using `src/clickup.js` env adapter; preview JSON has no auth fields |
| New/edited reports immediately retrievable with correct citations | chunk regen on ingest; chat cites author/date/revision/source |
| Chat does not leak other users' reports | retrieval scope filter before LLM; normal-user test in Phase 4 |
| Dashboard works if ClickUp down | overdue fetch failures → honest `error` field; report data unaffected |
| Existing flows unchanged | full regression of §5 route inventory (maintenance/Sheets/Dev Tracker/SOP/email) |

---

## 14. Key Verified Reference Lines (for the implementer)

- Report Automation schema: `Report automation/src/db/schema.ts` (submissions unique `(user_id, report_date)`; submission_edits audit; RBAC roles).
- Formatter: `src/lib/report-formatter.ts` (`REPORT_CONFIG`, `generateReport`, `ReportInput`, `FineTuningRecord`).
- Permissions: `src/lib/permissions.ts` (`PERMISSIONS` map, `requirePermission`).
- Submission create: `src/app/api/submissions/route.ts` (POST body → rawInput JSON → finalReport).
- ⚠️ Hard-coded ClickUp key: `src/lib/clickup.ts` L25–31 — rotate, never copy.
- OfficeOS server: `Downloads/maintenance-mailer/src/server.js` — `/api/master/` guard L298; dev-assistant chat L1111–1294; `clickUpEvidence = []` L1249; static serving tail ≈L2493.
- OfficeOS DB: `src/db.js` (`dbRead`/`dbWrite`, `DATA_DIR`, typed helpers).
- OfficeOS RAG: `src/enterpriseRag.js` (chunk shape L72–124; source filter L145; `sourceTypeForQuestion` L225; citation format L228).
- OfficeOS chat engine: `src/devAssistant.js` (`answerDevQuestion`).
- OfficeOS SPA: `public/master-app.js` (`NAV_SECTIONS` L198, `viewFns` L298, localStorage session L475–549).
- OfficeOS ClickUp safe adapter: `src/clickup.js` (env token, TTL cache, read-only).