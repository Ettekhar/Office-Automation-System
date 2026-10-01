# Database-First Architecture — Team Progress & Website Assignments

> **Status (2026-09-25):** the JSON database foundation and the seven review
> additions are implemented and verified. Cloudflare D1 remains a later
> migration target; the application still uses the local JSON repository.
>
> This document is the design and operating record for the database-as-source-
> of-truth migration. Google Sheets are connected operational interfaces, not
> the authoritative store.

---

## A. Current architecture

The app is a single Node.js process (`src/server.js`, dashboard on `:3000`) that
serves `public/` and exposes JSON endpoints under `/api/master/*`. Data lives in
`data/*.json`, managed by `src/db.js` (a small relational JSON repository: one
file per collection, loaded and saved through repository functions).

```text
Google Sheets (operational interfaces)
      │  getTabValues / batchUpdate  (src/sheets.js, cached + rate-limited)
      ▼
Sync / import (src/syncFromSheets.js)       UI edits (public/master-app.js)
      │                                               │
      └──────────────────┬────────────────────────────┘
                         ▼
              data/*.json through src/db.js
              (stable IDs, merge rules, audit, conflicts)
                         │
                         ▼
              API / dashboard / Sheets write-back
```

### Collections

| File | Entity | Important fields | Written by |
|---|---|---|---|
| `users.json` | team members | id, name, role, active | UI + sync seed |
| `sites.json` | websites (CW + RM) | id, url, account, company, status, assignedUsers[], monthlyHistory[], domainExpiry | sync + UI |
| `daily-review.json` | site × user progress rows | id, siteId, userId, rowIndex, sourceTab, sourceRow, sheetSpreadsheetId, maintenance/report fields | sync + UI + write-back |
| `tasks.json` | distribution work sheet | id, siteId, assigneeId, task/status fields | sync |
| `properties.json` | property registry | id, name, url, assignee fields | sync |
| `dev-projects.json` | development tracker | id, name, url, status | sync |
| `meta.json` | active month and sync metadata | activeMonth, lastSync | sync |
| `audit-log.json` | append-only change history | actor, action, entity, field, oldValue, newValue, source, reason | UI + sync + write-back |
| `sync-conflicts.json` | durable divergence queue | entity, field, state, occurrences, policy | sync + write-back failures |
| `user-aliases.json` | explicit identity aliases | canonical name → approved aliases | identity seed |

`db.js` is the only supported write path for these collections. Callers do not
edit JSON files directly, and import code does not invent replacement records.

### Runtime flows

1. **Full sync** — `POST /api/master/sync` reads the configured sheets, merges
   records by stable natural keys, and persists through `db.js`. Empty or failed
   imports preserve existing records and emit a warning.
2. **Daily Review view** — `GET /api/master/daily-review` overlays the active
   month's `site.monthlyHistory` status, then reconciles mismatches to each
   active user's tab using one batched call per user. A missing sheet-manager
   credential fails loudly; there is no spreadsheet-ID fallback.
3. **Assignment** — the three assignment entry points commit the canonical DB
   assignment first, then invoke `syncAssignmentToUserTabs()`. The sheet is an
   operational projection of the DB assignment.
4. **Site edit/status** — the site record is the source of truth; status and
   other sheet projections are best-effort write-backs with audit entries.

---

## B. Findings closed in this workstream

The original `db.getSite is not a function` error was only the visible symptom.
The following deeper problems were addressed without a whole-app rewrite:

1. **Identity churn** — sync no longer generates new UUIDs for existing sites or
   daily-review rows. Natural-key matching reuses the existing stable ID.
2. **Wholesale clobbering** — an empty/failed import cannot replace a non-empty
   collection with `[]`.
3. **No history** — meaningful mutations now append an audit record with actor,
   time, field, old value, new value, source, and reason.
4. **Scattered column mapping** — `src/columnMap.js` is the canonical resolver
   shared by import, reconcile, and assignment write-back.
5. **Untrusted identity matching** — `resolveUserByName()` uses explicit aliases
   first, then conservative token matching, and returns `null` for unknown
   names rather than fabricating a user.
6. **Unsafe concurrency** — supported writes can carry `expectedUpdatedAt`; a
   stale request receives `409 STALE_VERSION` before mutation. Clients that omit
   the expectation retain the legacy last-write-wins behavior.
7. **Unbounded/silent sync behavior** — dry-run mode is zero-write, divergences
   are durable and deduplicated, and cache/rate-limit behavior is observable.

---

## C. Data model and provenance

### C1. Canonical records

| Collection | Identity | Merge rule |
|---|---|---|
| `users` | `id` | explicit alias/name resolution; never create a user from an unknown sheet label |
| `sites` | `id`; normalized `url + account` | reuse ID; refresh sheet-owned fields; preserve DB-owned fields and assignments |
| `daily-review` | `id`; composite `(siteId,userId)` | reuse row ID; blank sheet cell preserves an existing nonblank DB value |
| `tasks` | natural key derived from site + task identity | queue candidates by natural key and match one-to-one; never first-wins duplicate IDs |
| `properties` | natural key derived from name + URL, with conservative fallbacks | one shared `used` set prevents one incoming row from matching multiple records |
| `dev-projects` | stable ID/natural key | preserve records absent from a partial import |
| `audit-log` | append-only ID | never rewritten by sync |
| `sync-conflicts` | `entity::entityId::field` | one open/acknowledged record per key; occurrence count increments |

The real-sync identity fixes are important: before them, 15 tasks were reported
as removed and duplicate IDs could be created. After the fix, the real sync
preserved **187 unique task IDs** and **92 property records**, with no removals.

### C2. Provenance

Imported records retain:

```text
source:       "sheet:CW_MAINTENANCE" | "sheet:RM_MAINTENANCE" | "sheet:DAILY_REVIEW"
sourceTab:    source tab title
sourceRow:    1-based sheet row
lastSeenAt:   last successful import that saw the record
```

Daily-review write-back additionally persists:

```text
rowIndex:             actual sheet row number
sourceTab:            user tab name
sourceRow:            row number used for provenance
sheetSpreadsheetId:   credential-resolved spreadsheet ID
```

These fields are informational and never block a legitimate update. Missing
provenance means **unknown**, never a fabricated value.

---

## D. Synchronization model

### D1. Ownership

| Data | Owner | Rule |
|---|---|---|
| Site identity and sheet-maintained fields | Sheet | import refreshes them, with blank/nonblank preservation rules |
| Assignments and UI-entered completion values | Database/UI | commit to DB, then project to the user's tab |
| GA4/newsletter/forms/booking/Cloudflare/ClickUp/client response/uptime | Sheet, UI-augmentable | sheet value wins; blank sheet cell preserves DB value |
| Audit and conflict state | Database | append-only; never synchronized away |

### D2. Merge and safety rules

- Existing natural-key records keep their IDs and DB-owned fields.
- A failed, empty, partial, or skipped import preserves records that were not
  observed; it never deletes them.
- A blank incoming sheet cell does not erase a nonblank DB value.
- Sheet/DB divergence is recorded, not silently resolved. The sheet value may
  win for the operational projection, but both values and the policy are
  auditable.
- `syncAll({ dryRun: true })` performs the read and conflict calculation in
  memory and writes nothing: no seed, collection save, audit record, or
  conflict file. `?dryRun=1` is honored by the route and reported through the
  normal JSON/SSE report.
- Real syncs report the same conflict count that they persist.

### D3. Caching, rate limits, and concurrency

- Sheet reads use the five-minute cache and a serial queue with in-flight
  deduplication. A 429 triggers bounded backoff/retry.
- `GET /api/master/sheets/cache-status?role=admin` exposes cache status to
  admin+ callers; the route is gated.
- `assertRecordFresh()` supports optimistic locking. A stale
  `expectedUpdatedAt` returns `409 STALE_VERSION` and the current record; a
  request without an expectation preserves compatibility.

---

## E. Assignment flow and Daily Review write-back

### E1. Entry points

All three routes use the same DB-first contract:

- `POST /api/master/sites/bulk-assign`
- `POST /api/master/sites/:id/assign`
- `PUT /api/master/sites/:id`

Each validates input, checks optimistic-lock expectations, commits the site
assignment and daily-review records through `db.js`, audits the change, and
then invokes `syncAssignmentToUserTabs()` from
`src/assignmentWriteBack.js`.

If a sheet operation fails, the committed DB assignment is not rolled back or
hidden. The failure is audited and recorded as a manual conflict.

### E2. Adding an assignee

`ensureSiteRowInUserTab()` is idempotent:

1. Resolve the user's real tab through `resolveUserByName()`; never fabricate a
   tab for an unknown identity.
2. Skip inactive users explicitly (`inactive-user`).
3. Resolve the website column through `columnMap.resolveUserTabUrlColumn()`.
4. Search the resolved column for a normalized URL match. An existing row is
   reported as `exists`; it is not duplicated.
5. Otherwise append exactly one row. The row contains:
   - the website in the resolved URL column;
   - the site's DB-known account label (`CW`/`RM`) when the tab has an account
     column;
   - `Assigned` in the Assignment marker column;
   - every other recognized column that the DB has real data for (see E4);
   - blank cells wherever the DB has no data.
6. Recover the actual row number from the Sheets response when possible. The
   live API has returned an unusable `updatedRange`, so the writer re-scans the
   tab and records `rowNumberFrom: 'tab-rescan'` when it must do so.
7. Persist the row location and provenance with
   `db.attachDailyReviewSheetRow()`.

The account value comes from the site's own record, never from a guess. A
pre-existing blank account cell is not overwritten by the normal write path.

### E3. Assignment marker column

The marker vocabulary is intentionally narrow: `assignment`, `assigned`, and
`assignment status`. Generic `status` is not accepted. The column is located
only when the header is empty across the header and every data row, preventing
an unrelated populated column from being overwritten.

`appendSheetColumn()` is not used for this migration: it derives a target from
`headers.length`, while Sheets can trim trailing empty headers and still retain
stray cells. The safe slot was measured on every live tab.

| User tab | Marker column | Letter |
|---|---:|---|
| Toufiq | 12 | M |
| Sabbir | 10 | K |
| Taion | 10 | K |
| Medul | 11 | L |
| Saiful | 10 | K |
| Tarikul | 11 | L |
| Roeich | 10 | K |
| Asif | 4 | E |

Only new rows are stamped `Assigned`; pre-existing rows remain blank because
their assignment state is not inferred.

### E4. Smart column fill (new rows carry all known data)

An appended row used to contain only the website, the account label and the
assignment marker, leaving every checklist cell blank even when the database
already held the values. The writer now fills each column the DB can speak to.

`columnMap.resolveUserTabDataColumns()` maps a tab's own header row to canonical
fields. Matching is **exact after normalization** (`headerKey`), because a
substring match would confuse `Maintenance` with `Maintenance Report Sent` and
put a report status in the maintenance checklist. The resolver never creates a
header and never guesses a position: a field the tab does not have is simply
absent from the result and its cell stays blank.

Recognized fields: `company`, `contact`, `accountManager`, `maintenance`,
`reportSent`, `clickup`, `ga4`, `newsletter`, `formSubmission`, `clientResponse`,
`booking`, `uptime`, `cloudflare`, `formName`.

Values come from the site record plus the daily-review record created at
assignment time. When the site has no value for a field, the cell is left empty
rather than filled with a placeholder — the sheet never receives invented data.

Columns resolved per live tab (measured 2026-09-26):

| Tab | Recognized fields |
|---|---:|
| Toufiq | 10 |
| Sabbir | 8 |
| Taion | 7 |
| Medul | 8 |
| Saiful | 8 |
| Tarikul | 8 |
| Roeich | 8 |
| Asif | 2 |

Asif is intentionally low: its tab only carries `Newsletter Mail` and
`Form Submission Mail` under real headers. Its column 3 holds 18 live booking
URLs with a blank header, and the writer refuses to claim a position it cannot
prove, so that column is left alone.

The URL column, the account column and the assignment marker column are resolved
separately and are never overwritten by the fill pass.

### E4. Removing an assignee

Unassign calls `softRemoveSiteRowFromUserTab()`:

- the row, URL, account, and provenance are retained;
- the marker becomes `Unassigned`;
- the row is **tinted** so the change is visible at a glance — see E13;
- no row is deleted and no unrelated cell is touched;
- the daily-review assignment record is removed from the DB as part of the
  canonical assignment change.

This is intentionally different from a destructive sheet delete.

The marker write and the tint are two API calls. If the tint fails, the unassign
still stands and the failure is reported rather than rolled back: a missing colour
must never cost someone their unassign.

**Unassigning never logs `[batch-sync] … wrote N cell(s)`.** That line comes from
`batchUpdateDailyReviewTab()`, which the unassign path does not call — unassign
writes the marker column through a different function. Seeing the two together is
a timing coincidence: removing an assignee makes the UI refresh, the refresh
issues `GET /api/master/daily-review?month=…`, and that request's reconcile sweep
(see E11) happens to run in the same breath. To tell them apart, look at what is
named: the reconcile logs `[reconcile] <user>: N mismatched row(s) for "<month>"`
immediately before the `[batch-sync]` line, and the unassign logs an audit entry
with `action: user-tab:soft-removed`.

### E5. Status vocabulary

The DB stores a normalized enum (`todo`, `in_progress`, `completed`, `pending`,
`yes`, `no`) beside the human text it was parsed from. The enums are internal
tokens and must never be written into a sheet: every existing row reads
`To Do` / `In Progress` / `Completed` / `No` / `Yes`.

`sheets.dailyReviewMaintenanceCellValue()` and
`sheets.dailyReviewReportSentCellValue()` are the single mappers, extracted so
the assignment write-back and the batch Daily Review sync cannot drift apart.
Both prefer the human raw text and only fall back to the enum's label.

This exposed a latent bug in the pre-existing report-sent fallback, which
compared only against `'sent'`. The live DB stores `yes` (measured: `no` 75,
`pending` 62, `todo` 23, `yes` 23, and zero `sent`), so every `yes` record would
have been written as `No`. The mapper now accepts both `yes` and `sent`.

The account-sheet month columns keep their own wording (`Updated & Backup`),
because that is what those columns already contain. Inside a Daily Review tab
the team treats `Updated & Backup` and `Completed` as the same state and
prefers `Completed`, so the tab mapper folds one onto the other — see E5a.

### E5a. One wording per state (confirmed 2026-09-26)

A dry run of the existing-row backfill surfaced that the tabs disagreed with
*themselves* about the same state: Taion wrote `Updated & Backup` where Roeich
wrote `Completed`, and `inprogress` appeared where `In Progress` was meant. The
cause is that `maintenanceRaw` was stored per record but captured from the
account sheet's month column, so 15 records across three tabs carried the
account wording regardless of what that user's tab actually said.

The team confirmed `Updated & Backup` and `Completed` are the same state and
that `Completed` is the preferred wording. `normalizeMaintenanceStatusText()`
now folds every spelling of a state onto one canonical label:

| Any spelling of | Canonical |
|---|---|
| `Completed`, `complete`, `done`, `Updated & Backup`, `updated and backup` | `Completed` |
| `inprogress`, `in_progress`, `In Progress` | `In Progress` |
| `todo`, `To Do`, `to-do` | `To Do` |
| `pending` | `Pending` |
| anything else | returned **verbatim** |

Unrecognized wording is never rewritten. Normalization must not invent a status
for text it does not understand.

### E5b. Conflict resolution for the backfill

`sheets.maintenanceStatusRank()` gives a state its distance along
(`To Do` 1 < `In Progress`/`Pending` 2 < `Completed` 3; unknown 0). The
backfill uses it so a disagreement can never silently downgrade work:

1. **Blank cell** → fill from the DB. Loses nothing.
2. **Same state, different spelling** → rewrite to the canonical label.
3. **DB is ahead** → move the sheet forward. Progress only.
4. **Sheet is ahead** → leave it. "Higher wins"; a `Completed` cell is never
   overwritten with `To Do` just because the DB is behind.
5. **Non-status columns** (links, mail addresses, notes) → a non-blank cell is
   somebody's edit and is never overwritten.

The driver is `scratch/backfill-existing-row-fills.mjs`; it is a dry run unless
given `--apply`, and every write is audited and re-read afterwards.

### E6. Active assignees only

Assignment targets must be real, active users. The Team Progress assignee
picker filters to `active !== false`, and the API enforces the same rule via
`assertActiveAssignees()` on all three write entry points (bulk assign, quick
assign, site update), answering `400 INACTIVE_ASSIGNEE`.

`mode: 'remove'` is deliberately still allowed to name an inactive user:
unassigning an old inactive assignment is cleanup, not a new assignment.

### E7. Verification record (2026-09-26)

| Suite | Result |
|---|---|
| `scratch/verify-smart-fill.mjs` (resolver vs live headers) | 195 / 195 |
| isolated write-path suite (`%TEMP%\opencode\mm-wb-offline`) | 64 / 64 |
| `scratch/verify-assign-dryrun.mjs` (3 live routes) | 16 / 16 |
| `scratch/verify-daily-review-writer.mjs` (credential probe) | `written: 0`, tab byte-identical |
| active-assignee guard (Tarikul, Asif x 3 routes) | 6 x `400`, no state change |
| `cache-status` gating | admin `200`, no role `403` |
| `scratch/verify-backfill-result.mjs` (post-backfill, 655 cells) | 562 / 562 |

### E7a. Backfill applied (2026-09-26)

The existing-row backfill was run with `--apply` after the dry run matched the
approved rules exactly. **106 cells written in total, in two passes:**

| Pass | Writes | Detail |
|---|---|---|
| 1 | 105 | 99 blank-cell fills + 6 vocabulary/casing renames |
| 2 | 1 | `Roeich!C9` casing only, status unchanged |

Per-tab blank fills: Toufiq 46, Saiful 21, Roeich 25, Taion 4, Sabbir 3.

Post-conditions, all re-read from the live sheet:

- 0 DB-backed cells still blank;
- 0 vocabulary mismatches remaining;
- 4 cells still legitimately ahead of the DB (`Taion!C21`, `Roeich!C7`, `Roeich!C8`,
  `Roeich!C9`) — not downgraded;
- URL, account and Assignment columns never written (asserted per row);
- a re-run plans **0** writes, so the pass is idempotent.

Two account-column findings were recorded and deliberately **not** written,
because the account column is outside the fill pass's scope and there is no
defensible winner:

- `Taion` rows 26–28 have a blank account cell although the site has one.
- 5 rows across Toufiq/Taion/Roeich read `RM` where `site.account` says `CW` —
  but only 4 of the 104 sites have `account="CW"` alongside `company="CM"`, so
  the DB disagrees with *itself*. Sheet `RM` / DB `CW` / DB `CM` is a three-way
  tie.

### E8. Site facts vs per-user work (found 2026-09-26)

A new row came out nearly empty for `governorsinnnd.com` on Taion's tab while
Medul's row for the same site was fully populated. Two separate causes:

**1. Site facts are stored per user.** `db.js` creates the assignment record with
`ga4`, `newsletterMail`, `formSubmissionMail`, `bookingLink`, `clientResponse`
all empty, and the write-back reads only the assigned user's own record
(`assignmentWriteBack.js`). Those fields describe the SITE, so the second person
assigned to a site starts blind even though the answer is already in the DB
under a different user.

**2. The record was seeded with two hardcoded fabrications:**

```js
cloudflare: 'No',      // asserted "no Cloudflare issues" without checking
uptimeRobot: 'Yes',    // asserted uptime monitoring, and drove uptimeStatus='online'
```

Nothing had observed either. The sheet write-back then published them, so 3
cells asserted a Cloudflare finding that existed nowhere in the data. Both
defaults are now `''` in both creation sites, with a comment saying why.

A retraction pass cleared every value that no *sheet-sourced* record corroborated.
Note the guard deliberately ignores other `app:assign` records: two records that
were both invented by the same bug agreeing with each other is circular, not
corroboration. Three of the values looked corroborated until that was tightened.

Retracted: `Toufiq!L27`, `Toufiq!L28`, `Taion!I30` (Cloudflare), and 5 DB-only
`uptimeRobot` values. Kept: 3 `cloudflare: 'No'` values that Medul genuinely
recorded from a tab.

Taion's row 31 was then filled with the 3 values his tab HAS columns for, taken
from Medul's sheet-sourced record after rejecting placeholder text. The 2 values
his tab has no column for (`GA4 Report`, `SMTP/Client Response`) were left alone —
adding a column is a separate decision, and the repair script refuses to invent
one.

**Still open:** the general fix is to promote these site facts onto the site
record so any assignee inherits them. That was measured at 215 fillable cells in
68 rows and deliberately NOT mass-applied, because the donor values are not all
clean — they include template placeholders (`"{admin_email}"`), wrong-kind links
(a HubSpot meeting link in a `Booking Engine` column), and per-tab vocabulary
drift (`"Completed"` vs `"Yes"` for GA4).

### E9. Site facts are inherited on assignment (confirmed 2026-09-26)

The team asked that assigning a site to a second person carry over the
information the first person already recorded. `db.collectInheritedSiteFacts()`
does this at record-creation time, in both creation sites
(`assignUsersToSite()` and the `getDailyReview()` ensure-path), so the value is
in the database before the sheet row is built and reaches the tab for free.

Three rules stop it manufacturing data:

1. **Only tab-read records donate.** `app:assign` records carry no observation.
   Two of them "agreeing" is circular — the same code invented both.
2. **Only active users donate.** An inactive user's row is usually a stale copy
   of somebody else's. This is not theoretical: `hotelsheldon.com` is held only
   by Toufiq and by Asif, who is inactive and whose values are a copy of
   Toufiq's. Without this rule that stale duplicate would flow forward.
3. **Per-person work is never inherited.** `maintenanceStatus`,
   `reportSentStatus` and their raw text stay fresh per person.

Where donors disagree, the majority wins so one typo cannot beat a value several
people agree on, and the donor is recorded per field in `siteFactsFrom` with
`agreeCount`, `contested` and the losing alternatives — so any inherited value
can be traced back to whoever actually recorded it.

Literal template placeholders (`"{admin_email}"`) are refused rather than copied,
since duplicating one just spreads it to another tab.

Verified: 12/12 on the real `governorsinnnd.com` records, 6/6 on the
inactive-donor case including a counter-test proving the rule is load-bearing.
Dry run confirms a new assignee of that site now receives 5 of the 6 site facts
on the appended row; `SMTP/Client Response` is skipped only because Roeich's tab
has no such column.

**Known consequence:** inheritance copies what the source recorded, including its
mistakes. The only pattern worth a human look is one email address sitting in
*both* the Newsletter and Form Submission columns, which are different questions.
Measured across all 184 records, that is 7 records on 4 sites
(`hotelsheldon.com`, `rev-mm.com`, `foresthallmilford.com`, `duneclimbinn.com`).
**No assignment pending today would copy one.** Fixing it means correcting the
source row, not the copies — which column is correct cannot be inferred from the
data. Note that an address in the Newsletter column is *not* on its own
suspicious: 26 of 73 filled Newsletter cells are addresses, so the column
legitimately holds both tool names and mailboxes.

### E10. Data-quality check runs on every sync (added 2026-09-26)

`src/dataQuality.js` runs as **step 4b of `syncAll()`**, between the daily-review
import and the tasks import, and reports into the operator-visible sync log plus
the returned payload (`dataQuality` on both the dry-run and real returns).

**It is advisory and cannot block a sync.** A value that merely looks wrong is a
question for a human, not grounds to refuse an import — refusing would mean
losing real data over a formatting suspicion. It is wrapped in its own
try/catch, and the checker itself returns `{ok:false}` instead of throwing, so a
bug in the check degrades to a missing warning rather than a failed sync. It
writes nothing: not the DB, not the sheets, not a file.

Two checks:

1. **Duplicated mail address** — one address in *both* `newsletterMail` and
   `formSubmissionMail`. Deliberately narrow. An earlier detector used "same
   string in 2+ site-fact fields" and fired on **44 of 184 records**, because
   `ga4`/`cloudflare`/`clientResponse` are three different questions that
   legitimately all answer `No`. That check was worthless and was thrown away.
   `N/A` in both columns is also not reported — a site can genuinely have
   neither.
2. **Address spread across 3+ site-fact fields** — at least one of those columns
   cannot want it.

**The LIVE / DORMANT distinction is the load-bearing part.** For each affected
site the check asks whether an *active* holder could donate the value:

- **LIVE** — an active holder exists, so assigning somebody new to that site
  would hand them the address. A human should fix the source row.
- **DORMANT** — every holder is inactive, so `collectInheritedSiteFacts()`
  refuses them as donors (rule 2) and the value cannot reach anybody.

`duneclimbinn.com` is DORMANT: its only holder of `info@duneclimbinn.com` is an
inactive user. That safety is a property of the *user's status*, not of the data,
so it does not hold forever. Reactivating that user — or adding any second active
holder of the site — makes it LIVE immediately, and nothing in the assignment
path will complain, because an active donor is a perfectly good source by its
own lights. Re-evaluating this on every sync is what catches that; a comment
alone would have gone stale. The report also states, per site, whether a *pending*
assignee would actually receive the value, which is currently none.

Verified by `scratch/verify-data-quality-check.mjs` (22 checks, including a
counter-test that reactivating the holder flips DORMANT → LIVE, and hostile-input
cases) and `scratch/verify-sync-dataquality.mjs` (real dry run: the check fires
mid-pipeline, and all 22 files in `data/` are byte-identical afterwards).
`scratch/explain-duplicated-addresses.mjs` narrates the output and holds no
detection logic of its own, so it cannot drift from production behaviour.



### E11. The monthly reconcile can never downgrade (fixed 2026-09-26)

`GET /api/master/daily-review?month=…` does two things: it overlays the
maintenance status from the site's `monthlyHistory`, and it **writes** that status
back into the Daily Review tab via `batchUpdateDailyReviewTab()`. So a wrong
month lookup here is a data-loss bug, not a display bug.

**The bug.** The month lookup was three substring tests. Asking for `"sep"` found
no exact match, fell through to `h.month.includes("sep")`, and matched
**`"September 22"`** — a *2022* entry whose status is empty. Empty was then read
as "not done", and the writer stamped **`To Do`** over cells reading
**`Updated & Backup`**: rank 3 → rank 1.

A second, latent defect sat in the same three lines: the final fallback was
`m.includes(h.month)`, and `"anything".includes("")` is `true`, so an entry with a
missing month label matched **every** query.

Measured on real data: **42 (site, user) rows** exposed, five of them Taion's at
rank 3. Nothing had been overwritten at the time of the fix.

**Three fixes, in `src/maintenanceStatus.js`:**

1. **Strict month matching** — `findMonthlyHistoryEntry()`. Labels are parsed into
   `{name, year}` so `"September 26"`, `"september 2026"` and `"2026-09"` compare
   equal. Preference: exact label → same name+year → same name, neither yeared →
   same name, query yeared and entry not. The load-bearing exclusion is the one
   case *not* allowed: **a year-qualified entry may never satisfy a bare query**,
   because a bare query carries no year and so cannot be known to mean it. That
   single rule is what stops `"sep"` reaching `"September 22"`. No match returns
   `null`, and every caller treats `null` as "leave the row alone" — not
   reconciling costs a stale cell, reconciling wrongly costs recorded work.
2. **An empty status is not "not done"** — enforced by the rank guard, since blank
   ranks 0 and therefore cannot displace any real status.
3. **The rank guard in the writer** — `shouldWriteReconciledStatus()`. "Higher
   wins": if the cell already records further-along work, the cell is kept and the
   row is logged, not overwritten.

**The guard covers the whole path, not just the write.** A refused downgrade also
restores the recorded value onto the row returned to the client, and is refused
again on the DB persist. Skipping only the sheet write would have left the UI
displaying "To Do" for a cell that says "Completed" — and persisting it would have
made the loss permanent on the next read.

**Also fixed:** a third copy of the same loose lookup, in
`GET /api/master/sites`, which reported the 2022 status as `latestMonthStatus` for
a "sep" query. Read-only, but it fed the same wrong month to the screen.

The vocabulary (`normalizeMaintenanceStatusText`, `maintenanceStatusRank`) moved
from `sheets.js` into `src/maintenanceStatus.js` so `server.js` can import it
statically — `sheets.js` loads `googleapis` at the top, and `server.js` reaches it
through a dynamic import after a missing import there once silently killed every
Daily Review write. `sheets.js` imports and re-exports them, so there is one
implementation, not two. The duplicate local `MAINTENANCE_DONE_WORDS` in
`sheets.js` was deleted for the same reason.

Verified by `scratch/verify-reconcile-guard.mjs` (33 checks, anchored to the real
`hqdallasrooftop.com` / `September 22` pair, including the ten rank-guard cases and
a re-scan that now reports **0** exposed rows where it previously reported 42).

### E12. Dry-run assignment routes

`dryRun` on an assignment route means **no DB write and no sheet write**. Each
route returns the planned result and an explicit note. This was corrected after
verification found that the old implementation suppressed only the sheet side
while still committing the DB assignment.

### E13. The unassigned row is tinted (added 2026-09-26)

Unassign used to change one cell. The row then looked identical to an active row
apart from a single word, which is easy to miss in a 30-row tab. The marker cell
stays the truth; the tint only renders it.

**Colour: `#FCE5CD`, a light orange.** Chosen against the measured palette, not
by taste. The tabs already use blue *structurally* — `#3c78d8` is the header fill
and `#cfe2f3` is row banding (288 cells in Toufiq, 1593 in Asif) — so a blue row
would read as part of the sheet's chrome rather than as a flag. The existing reds
(`#f44834`, `#ea4335`) are vivid and sit on other columns. `#FCE5CD` is unused,
distinguishable from both, and light enough to keep the row's black text legible.

The meaning of the existing red cells is **not known** and was deliberately not
guessed at when choosing the colour.

#### The colour is derived state, and that dictates three rules

1. A row is tinted because its marker reads `Unassigned` — never the reverse.
   Colour alone would be unreadable and un-auditable.
2. Re-assigning **must clear** the tint, or a site that returns to the team stays
   orange forever while being actively worked.
3. The paint must not destroy meaning already in the row.

Rule 3 is load-bearing, and the first draft got it wrong. A literal whole-row fill
overwrites the **account/company cell**, whose fill is a company colour
(`#8e7cc3` / `#b4a7d6` / `#93c47d` on the `CW` cell) identifying which account a
site sits under. Measured: 3 of the 6 target rows carry one. So the paint is
emitted as up to two ranges, skipping the account column, which is resolved
through the canonical `columnMap.resolveUserTabAccountColumn()` — the same
resolver the writer stamps the account into, so the protected column cannot drift
from the real one.

#### A fill we did not put there is not ours to remove

`syncTabRowHighlights()` originally cleared any fill on a row whose marker said
`Assigned`. The dry run caught this immediately: it wanted to clear `Toufiq!27`
and `Toufiq!28`, which are filled `#CFE2F3` — this workbook's **row banding**,
identical to row 26, which has a blank marker. The first draft would have stripped
the team's banding off two live rows on the strength of a guess.

The rule is now: **only `#FCE5CD` may be removed.** Any other fill is reported and
left alone. A band colour is not a leftover tint, and a highlight a human applied
by hand is not ours to erase.

The same reasoning runs the other way. An `Unassigned` row whose *paintable* cells
already carry a foreign colour is reported as a **conflict** and left alone: if the
tint were later cleared, the original would be gone for good. Zero such rows exist
today.

#### The re-assign marker bug this exposed

`ASSIGNMENT_MARKER_ON_ASSIGN` was written in exactly one place — `buildAppendRow()`
— i.e. only for rows that were **appended**. There was no path that reset an
existing row from `Unassigned` back to `Assigned`.

Because a soft-remove keeps the row, re-assigning the same site lands on the
"already present" path, which returned early without touching the marker. So a
re-assigned site stayed marked `Unassigned` **forever** while the DB listed it as
actively assigned — the sheet contradicting the source of truth. Before this
change that was a stale word in a cell; with the tint it would also have been a
permanently orange row for a live assignment. `ensureSiteRowInUserTab()` now
rewrites that one cell and clears the tint. Only that cell is touched.

#### Layout

- `src/rowHighlight.js` — **pure, no I/O.** Turns a row number and column span
  into `repeatCell` requests. Pure so the dry run and the real write share one
  implementation and cannot diverge, the rule that governs `proposeFieldFills` and
  `normalizeMaintenanceStatusText`.
- `src/sheets.js` — `getTabSheetId()`, `applyRowBackgrounds()`,
  `getRangeBackgroundColors()`. `applyRowBackgrounds` takes the planner's output
  verbatim rather than rebuilding ranges.
- `src/userTabWriteBack.js` — `rowHighlightColumns()`, `applyRowHighlights()`,
  `syncTabRowHighlights()`; the tint is applied by the unassign path and cleared by
  the re-assign path.

`syncTabRowHighlights()` is idempotent by construction: it reads current fills
first and plans only rows that actually disagree, so a second run writes nothing.
That matters because it is a write path over a live shared sheet.

Clearing uses `backgroundColor: null`, the documented single-field unset. The
verify script **re-reads the cells** afterwards, because "the request was accepted"
is not the same claim as "the fill is gone".

#### Two API quirks, both of which fail silently

Found while building this and baked into the code with comments:

- `spreadsheets.get` with `includeGridData` and **no `fields`** returns
  `rowData.userEnteredFormat` but **no values**. That made all 8 tabs read as
  empty and the marker column look absent — contradicted by the audit log, which
  names cells like `Taion!K32`. A field mask is mandatory.
- The same unbounded read is **rejected outright**; a `ranges` scope is
  mandatory. `userEnteredFormat` is a subfield of `CellData`, so the mask must
  nest inside `values(...)`.

`repeatCell` also needs the **numeric** tab id from
`sheets[].properties.sheetId` — not the spreadsheet id and not the tab name.

---

### E14. The guard was being fed a fabricated status (found 2026-09-27)

E11 made the reconcile refuse downgrades. E14 is the discovery that **E11's guard
was unreachable for the exact case it was written for**, so the protection was
theoretical. Found while investigating an alarming log line, not by a test.

**Symptom.** After a Quick assign, the log showed

```
[reconcile] Saiful: 1 mismatched row(s) for "September 26" — 1 batch call
[batch-sync] ✅ Saiful tab: wrote 1 cell(s) in 1 API call
```

E11 says a downgrade is refused *and logged as kept*. Instead it reported a
successful write. So either E11 had regressed, or something was writing without
passing the guard. **The reconcile path had not been touched** — `server.js` and
`maintenanceStatus.js` still carried their 21:30 timestamps, and the new row-tint
work was in other files. That ruled out a revert and pointed at the guard itself.

**The bug.** The month overlay (`server.js`) sets two fields from one source:

```js
const rawVal  = (entry.status || '').trim();        // ""  — honest: the column is blank
const normVal = normMap[rawVal.toLowerCase()] || 'todo';
return { ...row, maintenanceStatus: normVal,        // "todo" — FABRICATED
                  maintenanceRaw: rawVal || '', ... };
```

`maintenanceRaw` is blank, so the source *is* honestly reported. But
`maintenanceStatus` is set to `"todo"` so the UI has something to render, and the
guard call then passed that fabricated value as `incomingStatus`. The guard refuses
empty sources on `if (!inRaw && !incomingStatus)` — a truthy `"todo"` skips that
branch, and control reaches the rank compare:

```
from = rank("To Do")  = 1
to   = rank("" || "todo") = rank("todo") = 1
1 < 1  ->  false  ->  { write: true }
```

The blank was laundered into a real `todo` that ranked **equal** to the work it
was overwriting, so the "higher wins" rule saw nothing to refuse. The writer then
received `maintenanceRaw: ""` and **blanked the cell**. Confirmed on
`Saiful!21` (`qualityinnparkersburg.com`): `"To Do"` → `""`.

The general shape: a placeholder outranks nothing and overwrites everything. The
guard was correct; it had simply never been shown that the source said nothing.

**Why E11's own test missed it.** `verify-reconcile-guard.mjs` asserted that
`{ incomingRaw: '', incomingStatus: 'todo', currentRaw: 'Updated & Backup' }` is
refused — and it passed, but on `downgrade-refused` (rank 1 < 3), **not** on the
empty-source branch. The damage needs the ranks to be *equal*, which means a
rank-1 cell. `"Updated & Backup"` can never reproduce it; only `"To Do"` can.

**Three fixes, in `src/server.js`:**

1. **The honest source reaches the guard** —
   `incomingStatus: newRaw ? row.maintenanceStatus : null`. A blank source now
   arrives as a blank status, so `empty-source-would-downgrade` can actually fire.
   The UI still renders `"todo"`; only the *decision* is un-fabricated.
2. **Only approved rows reach the writer, and every refusal is restored.** Two
   defects in three lines:
   - `return decision.write ? { row, decision } : { row, decision };` — both arms
     were **identical**, so the ternary was dead and refused rows survived
     `.filter(Boolean)` and were still handed to the writer. They happened to be
     harmless only because the restore block had already put the old value back,
     so they were written as no-ops. Now: `.filter(d => d.decision.write)`.
   - The restore list matched `reason === 'downgrade-refused'` only, so
     `empty-source-*` refusals would have skipped the restore and kept the blank.
     Now: every `!decision.write`.
3. **The refusal log says what happened.** It printed `${from} -> ${to}`, which is
   `undefined` for an empty-source refusal — the vaguer the log, the less likely
   anyone reads it, on the one case that was silently destructive. The overlay now
   carries `_monthLabel` so the refusal can name its month.

**Measured before and after** (`scratch/verify-reconcile-guard-fix.mjs`, real data):
1-`-` 54 destructive writes → **0**; total allowed writes 4322 → 4268, i.e. exactly
the 54 destructive ones stopped. Legitimate forward progress is unaffected:
**22 upgrades still written** (e.g. `"In Progress"` → `"Updated & Backup"`). A fix
that blocked everything would be an outage, not a fix, so the suite asserts both.

**Live verification (2026-09-27).** `GET /api/master/daily-review?user=Saiful&month=September 26`
on the restarted server:

```
[reconcile] keeping "To Do" on Saiful (row 21): month column "September 26" is blank,
which is not "not done" (no information in the month column) [empty-source-would-downgrade]
```

No `mismatched row(s)` line and no `wrote N cell(s)` line — nothing was queued, so
no write was issued. The cell reads `"To Do"` on a fresh read.

**One cell was affected, and it was not obviously broken.** The single blanked cell
(`Saiful!21`) read `"To Do"` again within ~3s, but only because the user's own Quick
assign re-created the row and rewrote that cell afterwards (record `createdAt
03:24:32Z`, source `app:assign`). The loss was repaired by unrelated activity, not
by the system. The 54-pair figure is one *cell* seen across 54 selectable month
labels, not 54 cells.

**Collateral: five scratch suites fail, none from this change.** They import
`db.js` and `src/` helpers but never `server.js`, so the edited file cannot reach
them; `maintenanceStatus.js` was not touched. Causes, all pre-existing:
`verify-user-tab-columns`, `verify-writeback` and `verify-writeback-dryrun` assert
that a **deactivated** user is skipped and hardcode **Toufiq**, who is
`active: true` — the guard is right to not skip him (it correctly skips Tarikul and
Asif). `verify-backfill-result` (`remainingBlank: 1`) and `verify-importer-parity`
read `data/`, which changed at 09:23–09:24 from the app's own operations. These
five were **not** part of the 230-check regression set recorded in section I.

`verify-reconcile-guard.mjs` itself needed a corrected assertion. It measured
"no month match is *capable* of cutting work" (a bare rank comparison) rather than
"the guard refuses it", so it failed on a row the system protects, and it drifted
on every new assignment. It now counts *destructive writes the guard allows* —
which must be 0 — and prints the rank-visible and blank-over-filled counts as
informational. A first attempt at that rewrite counted every allowed write and
flagged **22 legitimate upgrades** as damage; exposure means a destructive write
getting through, not a write happening.

---

### E15. Five failing suites: three stale fixtures, and one that measured nothing (2026-09-27)

The five suites named in E14 were repaired. **No product code changed** — in every
case the product was right and the test was wrong, which is worth stating plainly
because the opposite is the usual assumption. Two of the five, however, were not
merely stale: they were **passing while testing the wrong thing**, which is worse
than failing.

#### The parity test was blind (`verify-importer-parity.mjs`)

It compares the pre-refactor importer against the refactored one and asserts both
yield the same value — a genuinely valuable invariant, over 192 live rows. It
called:

```js
resolveUserTabUrlColumn({ header: h, rows: data, ... })     // singular
```

The signature is `{ headers = [], ... }` (**plural**, `columnMap.js:120`). The
destructuring default silently turned `header` into `headers = []`, so the "new"
side resolved with **no header text at all**. It survived on the data-grounded path
plus `getUserTabFallbackUrlColumn`, and that fallback is documented for **Sabbir and
Taion only** (`USER_TAB_DOCUMENTED_URL_COLUMNS = { sabbir: 0, taion: 0 }`) — which
is exactly why Toufiq fell through to `-1` and failed while six other tabs happened
to agree by luck. A parity test whose new side is blind reports parity it never
measured. Fixed to `headers: h`; now **16/16**, every tab resolving via `data`.

#### Header-only column resolution is not trustworthy (`verify-writeback.mjs`)

Same root cause, different symptom. It harvested "a real existing URL" using
`findUrlColumn(headers)` — header text only. **Sabbir's and Taion's column A header
is a single space `" "`**, so `findUrlColumn` returns **1** for Sabbir (the
`"Website"` *account-label* column) and **7** for Taion (`Booking / Reservation
Link`). The "real URL" it collected was therefore the string **`"CW"`**. The
idempotency check then asked the product to find `"CW"` in the Sabbir tab, the
product correctly reported it absent, and the suite failed for being right.

Its section-2 assertion was `col >= 0`, which passed while pointing at the wrong
column — a green test proving nothing. Both now resolve through
`readAndResolveTab()` (the product's own path) and assert the chosen column
**actually holds domains** (Taion 28/31, Sabbir 24/24, Toufiq 27/27), with
header-only resolution kept only as a printed contrast. The planned-row assertion
now indexes by the resolver's **own reported** `urlCol` instead of a separately
computed one. **16/16.**

#### Stale "deactivated user" fixtures (`verify-user-tab-columns.mjs`, `verify-writeback-dryrun.mjs`)

Both hardcoded `Toufiq` as `active: false`. Toufiq has since been reactivated, so
both failed for a user the guard was **right** to accept (it correctly skips Tarikul
and Asif). Substituting a different name would only re-arm the trap at the next
reactivation, so both now **derive the inactive user from `db.getUsers()`** and
assert one exists — so the skip path can never silently stop being tested.

`verify-user-tab-columns.mjs` also asserted `action === 'exists'` for a present row.
That was correct until the marker-restore path was added: a row that is present but
still says `Unassigned` is reported in a dry run as `would-restore-marker`
(`userTabWriteBack.js:555`, dry-run only — the live path returns `exists` with
reason `already-present-marker-restored`). The assertion now states its actual
claim, **presence**, and accepts either. **43/43**, 13/13.

#### A backfill assertion that had outgrown its scope (`verify-backfill-result.mjs`)

`no DB-backed cell is still blank after the backfill` reported one gap:
`Saiful` col 3 (`Maintenance Report Sent`), row 21, blank in the sheet and `"No"`
in the DB. That is the row **quick-assigned on 2026-09-27**, i.e. created *after*
the backfill was applied (2026-09-26, E7a). Site-fact inheritance runs at
assignment time, so a brand-new row legitimately starts with the sheet's prior
contents; the backfill was never asked to fill it. The suite was reporting a
completed backfill as incomplete, and would do so on **every future assignment**.

Blank cells are now split by whether the record predates an explicit
`BACKFILL_APPLIED` constant: in-scope gaps still **fail loudly**, post-backfill gaps
are **printed individually with their record's `createdAt` and `source`** and
counted — reported, not silently ignored, and not a pass. **554/0.** (Filling those
~206 cells is a separate pass and separately approved; see the open items.)

#### Standing lesson

Three of the five asserted on **hardcoded environment facts** — a user's active
flag, a backfill date, a specific action string. All three are now derived from the
source of truth, because a fixture that encodes a *moment* fails the moment the
moment passes, and fails while pointing at the code that is actually correct. The
two worst offenders were not the stale ones but the two that were **green** while
resolving the wrong column.

### E16. Deactivated users were offered in the assignee pickers (fixed 2026-09-27)

Reported as "a deactivated user shows up when I assign a website to somebody".
Tarikul and Asif are `active:false` (derived from `db.getUsers()`, not hardcoded —
6 active: Toufiq, Sabbir, Taion, Medul, Saiful, Roeich) yet every site-assignee
picker listed them as ordinary candidates. This turned out to be **three linked
defects**, and the visible symptom was the mildest of them.

**1. The UI offered exactly what the server refuses.** `assertActiveAssignees`
(`server.js:149`) answers `400 INACTIVE_ASSIGNEE` — *"Cannot assign to unknown or
inactive user(s): Tarikul. Choose an active user."* It has exactly four
appearances in the server: the definition plus three site-assignment routes
(`:592` bulk assign, `:796` PUT site, `:887` POST assign). It refuses **the whole
request**, so a single inactive name in the grid blocked *every other assignee in
the same save* — not just itself. The picker was selling a choice the system
guarantees to reject.

**2. The client threw the explanation away.** `api()` did
`new Error(data.error || ...)`, so the server's carefully written `message` was
discarded in favour of the machine code and the toast read **`INACTIVE_ASSIGNEE`**.
That is why the failure looked mysterious. Now
`new Error(data.message || data.error || \`HTTP ${r.status}\`)` with the code
preserved on `e.code` (`master-app.js:44-45`); nothing compared on `err.message`
before, and the 409 `STALE_VERSION` path is unchanged.

**3. The obvious fix is a data-loss trap.** All four site-assignee grids submit the
**complete set of checked boxes** as the new `assignedUsers`. So the naive repair —
filter `S.users` to active users — would silently **unassign** any already-assigned
deactivated user the next time somebody saved an unrelated field (company, A/C
manager) on that site. `editSiteModal` is the worst case: a `PUT` that edits the
company and also rewrites the whole assignee list.

So display was split from choice. One rule, in one place
(`isActiveUser` :223, `assigneeCheckState` :229, `assigneeInputAttrs` :239), applied
by all four grids — quick-assign (:3687), new site (:4178), assign modal (:4246),
edit site (:4397):

| user | state | rendered |
|---|---|---|
| active | any | ordinary enabled checkbox |
| inactive | not assigned | **disabled**, labelled `(deactivated)` — cannot be added |
| inactive | **already assigned** | **checked and still enabled**, labelled `(deactivated)` |

That third row is the whole point. A `disabled` **and** `checked** box is a dead
control — the user can neither keep it nor remove it, and a save would still
submit it. Leaving assigned-but-inactive users enabled means they survive an
unrelated save *and* can be deliberately unassigned by unticking the box or with
`Clear All`, which is intentionally left clearing disabled boxes too. The suite
asserts the design never produces a disabled-and-checked box.

`Select All` (`:4281`) now skips `disabled` boxes. This is not cosmetic: assigning
`.checked` from script **works on a disabled input** — the attribute only blocks the
user — so without the guard one click would tick every deactivated user and return
the 400, taking the whole assignment with it.

**Deliberately not changed.** The task assignee (`:4532`), SEO/Web assignee
(`:4848`, `:4853`) and the sheet-credential grid (`:7601`) still list everyone,
because those records are **not** guarded — `assertActiveAssignees` appears nowhere
near them, so the server does not refuse and there is no defect to fix. The task
assignee *filter* must keep inactive users so historical tasks stay findable.
`userOptions()` (`:187`, currently unused) was corrected anyway so it cannot become
a footgun if wired up later.

`GET /api/master/users` still returns every user unfiltered. That is correct for a
management endpoint; the defect was entirely frontend-side, so no backend change and
no restart was needed for this fix to take effect.

**Verified:** `scratch/verify-assignee-picker.mjs` — **47/0**. It does not test a
copy: it *extracts and evaluates the real functions out of the deployed
`public/master-app.js`* (parameter lists are paren-matched before the body's `{`,
or `api(url, opts = {})` yields a truncated stub), exercises the full truth table
over the real roster, and asserts the wiring. It was **mutation-tested** — three
deliberate regressions (`locked: !isAssigned` → `false`, dropping the
`if (!cb.disabled)` guard, restoring the bare `data.error`) were each caught, and
the file was restored byte-identically (SHA256 match) after every one.

### E17. The E14 fixture was pinned to a coordinate the app legitimately moved (2026-09-27)

`verify-reconcile-guard-fix.mjs` asserted a hardcoded incident: daily-review
`rowIndex 21`, `userName 'saiful'`, month `September 26`. At 10:41 the operator
removed **both** assignees from `qualityinnparkersburg.com` via Quick assign
(`assignment:replace` → `user-tab:soft-removed` for `Saiful!K21` and
`Roeich!K27`). The soft-remove deletes the daily-review record, so the fixture
became unfindable and the suite failed — for a reason that had nothing to do with
E14. The other 30 assertions, including the exhaustive destructive-write count,
still passed.

Pinning a `(row, month)` coordinate was the same mistake as E15's hardcoded active
flag, one level deeper: it encoded not just a moment but an *artefact of that
moment's row numbering*. The claim is now **derived** — every real `(row, month)`
pair whose month column carries no information while the cell records work. There
are **550** such pairs in live data, and two aggregate assertions cover all of them
(none allowed to overwrite; every refusal for the right reason). The first draft
asserted per pair and printed 1100 lines; aggregation keeps identical coverage
readable, and a failure names every offender. The originally damaged cell is now a
printed **note**, not an assertion, because the app moving it is correct behaviour
this fix must not try to prevent. A2 still locks the shape down at unit level.

**32/0** (was 34/0 with one fixture-dependent assertion).

---

### E18. A condition the report tab declares, and an email paragraph it unlocks (2026-09-30)

The operator wanted a sentence in client emails that depends on the sheet rather
than being typed by hand each month, keyed off a condition they choose. The
example they gave: when a report tab mentions `a11y`, the email should carry

> We reviewed the latest ADA accessibility audit and implemented custom fixes for
> the related issues identified. The full audit findings and remediation details
> are available here…

with the link coming from the sheet, not from the dashboard.

#### The trigger is already in the sheet, and already invisible

`ocalaflevents.com` (CW master row 74, stored as `https://ocalaflevents.com/`;
report tab `https://ocalaflevents.com`) contains exactly one such cell — row 24,
column B:

```
a11y:https://docs.google.com/document/d/1WolHnCP5oDPPvVdAbtRUDLbw6crZ4g7NfcIVHxmHW-g/edit?tab=t.0#heading=h.6fwf6gxl58vz
```

So the cell is a **`condition:link` pair**: the key before the colon, the link
after it. That is why the link is *extracted* rather than typed — each site links
to its own document and the tab stays the single source of truth.

That cell currently reaches nobody. `parseReportSections` closes a section band
after two blank rows, and rows 22–23 are blank, so row 24 is orphaned:
`additional_issue` parses with **0 rows** and `reportHtml` contains neither `a11y`
nor the document id. The operator's note was silently dropped from every email.

One constraint worth recording: the product fetches **`A1:D200`**, while this tab
is actually 12 columns wide. A trigger beyond column D would never be seen.

#### Design, and why each decision

- **Registry, not a hardcoded section.** `data/email-conditional-notes.json`,
  one record per condition **per account** — CW and RM clients get their own
  wording. CRUD in `db.js` alongside `getNotices`, with `appendAuditLog` on every
  mutation. The dashboard panel at `/mailer` manages it.
- **Message text is stored exactly as it should read.** The link attaches to the
  **last standalone `here`**, so the stored sentence is the finished sentence and
  there is no placeholder to keep in sync. If there is no `here` and a link
  exists, the link is appended as its own sentence rather than dropped. If there
  is no link, the message still renders — a real condition is not withheld
  because a URL was forgotten.
- **Placement: immediately before `<p>Best Regards,</p>`**, as specified, after
  "Everything is running smoothly…". Verified by asserting the note's index falls
  between those two anchors.
- **Escaping and URL safety.** The message is operator-authored text held in the
  DB, so it is HTML-escaped *before* the anchor is inserted. The URL comes from a
  cell a human typed into a spreadsheet and is therefore untrusted: `safeExternalUrl`
  admits **http(s) only**. `javascript:`, `data:` and `ftp:` are rejected —
  otherwise a `javascript:` URL in a sheet would be a stored-injection vector into
  every recipient's mail client. Quotes and angle brackets in a surviving URL are
  percent-encoded by `URL.toString()`, so the `href="…"` attribute cannot be
  broken out of; this was checked, not assumed.

#### Detection is narrow on purpose

After the 44/184 false-alarm episode, loose matching is not acceptable. A cell
matches only when, in full, it is `"<condition>:<link>"` or the bare
`"<condition>"`. Consequences, each pinned by a test:

- A registered condition `Update` does **not** fire on the ordinary
  `Update | Theme | To Version` row — no colon after the word.
- `we fixed a11y:…` and `a11y review done` are prose, not triggers.
- A plugin literally named `a11y` does **not** fire. The bare form has no colon
  to narrow it and single words collide with real sheet content — `Update` is the
  first cell of a genuine Other-section row — so the bare form is only trusted
  when the cell **stands alone in its row**, counting filled cells rather than
  grid position. This rule was added after the suite caught both collisions.
- The whole grid is scanned, not just the parsed sections, which is precisely what
  makes the orphaned row 24 detectable.
- `enabled: false` is honoured by the resolver itself, not only by the caller's
  `enabledOnly` filter, so switching a condition off cannot be defeated by a
  caller that forgets to filter.

Both send paths are wired: `getSitePreview` and `generateAllPreviews` in
`dashboardApi.js`, and the CLI send in `index.js`. The preview response also
returns which conditions fired and the **source cell** each link came from, so the
operator can see *why* a paragraph appeared.

#### A sibling feature that was left alone

`public/app.js` already has a custom-injection mechanism (`extractCustomInjection`
/ `reapplyInjection`, :1090–1245): the operator hand-edits a preview and the app
re-injects the difference at an anchor. It is **in-memory only**, unconditional,
and not sheet-driven. It is a sibling of this feature, not the mechanism for it.
The new paragraph sits in the template, so it is present in `baseHtml` and cannot
be mistaken for an operator injection.

#### The routes have no auth gate, deliberately

The first draft gated the four new routes behind an `isAdminRole` helper. That
helper does not exist, and — more importantly — **no route in `server.js` has any
auth gate**. Gating only these four would imply a protection the rest of the app
does not have. They were rewritten to match the file's real convention:
`actorFrom(req, body, reqUrl)` for attribution, and an audit-log entry on every
mutation. The gap is a property of the whole app, not something this feature
introduced, and it is recorded here rather than papered over.

#### Tests

`scratch/verify-conditional-notes.mjs` - **128/0** at the time of E18. Runs the
real exported functions against the real transcribed cell, and pins the negative
cases above. **Superseded by E19 (193/0) and then by E20 (274/0)** — the numbers
below are E18's record, not the current suite.

`scratch/verify-conditional-notes-live.mjs` — **23/0**. Fetches the operator's
*actual* tab and proves the real cell fires, the real link is the href, and the
real condition is dropped by the pre-existing parser. A hand-typed fixture can
drift from reality unnoticed; this cannot. **Superseded by E20 (27/0)**, which also
stops hardcoding the keyword — the operator renamed it mid-workstream and the old
version failed on a rename the product handles correctly.

Mutation-tested: **8 deliberate regressions** at the time of E18, each caught —
moving the paragraph after the sign-off, removing the lone-cell guard, removing
the scheme allowlist, linking the first `here` instead of the last, dropping the
`enabled` check, making detection prefix-only, taking the link from the cell
prefix, and dropping the audit write. (E19 raised this to 20.) All three touched
files restored byte-identically afterwards.

#### One mistake worth recording

The suite's first version snapshotted the live files it wrote and restored them in
a `finally`. That leaked: `data/email-conditional-notes.json` survived with test
fixtures in it (one literally the string `"RM wording"`), and the audit log grew
70 → 80 with five fake entries. The root cause was not the restore logic but that
`db.js` hardcoded `DATA_DIR`, which is the only reason a test can reach production
data at all.

`db.js` now honours `OFFICEOS_DATA_DIR`, unset in every real process so production
behaviour is unchanged. The suites run against a throwaway directory and then hash
every live `data/*.json` file to assert not one byte moved — a stronger guarantee
than restoring what you touched, because it catches writes you did not anticipate.
A child process with the variable unset confirms the default is still `./data`.
Live data was restored to 75 audit entries and the fixture file deleted; a
purpose-built cleanup script refused to run until every entry it was about to
delete was provably test residue.

---

### E19. The link goes where the operator says, and any keyword works (2026-09-30)

E18 shipped the mechanism but hardcoded two things, both of which were wrong in the
same way: the **link could only ever attach to the last standalone `here`**, and the
wording implied `a11y` was a special keyword rather than one the operator happened
to register first. Neither was a design necessity.

#### The link is placed by a marker, not by a word

The message is written however it should read, and the operator marks the spot:

    …remediation details are available {{link:here}}.
    Read more at {{link:the security advisory}} for context.
    Click {{link}} to open it.                        → reads "here"
    {{link:Full audit report}} was published today.    → link at the very start

The label is optional so a sentence can read naturally whether or not the author
wants the word `here`, and every marker in a message is honoured, so one sentence
can link the same document twice. Nothing is positional or hardcoded.

- **No marker anywhere** → the E18 fallback still applies: the last standalone
  `here`, else the link appended as its own sentence. The message already
  registered in `data/` was deliberately left untouched, so it kept working.
- **A marker, but the cell had no link** → the marker degrades to its own label, so
  the sentence still reads and no dead `href` is promised. `{{link}}` degrades to
  the word `here`.
- **A malformed marker** (`{{link:oops`, no closing braces) is left as typed. A
  visible typo beats a message silently rewritten.

#### Any message shape

A blank line starts a new `<p>`; a single newline becomes `<br/>`. So the message
can be one paragraph, a list of lines, or several. Splitting happens *after* the
links are placed, which is only safe because a marker label is collapsed to a
single line and a URL cannot contain a raw newline — an anchor can never be torn
in half by a paragraph break. Both properties are pinned by tests.

**The first attempt got this wrong and the probe caught it.** Deciding
"marker present → place it, else fall back" per *paragraph* gave every unmarked
paragraph its own appended link, so a two-paragraph message with one marker
produced two links. Link placement is now decided for the whole message.

#### Any keyword, and the two ways to get it wrong

The condition was always generic; it just never looked it. `a11y`, `link`,
`ADA Review`, `sec-fix` all match, case-insensitively, still prefix-anchored to
the whole cell so prose cannot trigger them. Two footguns are now closed:

- **A trailing colon is stripped.** The cell format is `<condition>:<link>`, so
  typing `a11y:` is the obvious slip. Stored as-is it would be a key that *no cell
  could ever match* — a condition that looks registered and silently does nothing.
- **A condition containing a URL is refused** (HTTP 400, with a message saying
  what to do instead). Pasting the whole `a11y:https://…` cell into the Condition
  box would otherwise store happily and then never match.

#### The href is validated where it is written

`safeExternalUrl` is now called at the point the `href` is built in `mailer.js`,
not only upstream in the resolver. The guarantee lives where the `href` is written,
so a future caller cannot defeat it. Consequence: the renderer now also inherits
the URL parser's normalisation, which the resolver was already applying — pinned by
a test so the two cannot drift apart.

#### Tests

`scratch/verify-conditional-notes.mjs` - **193/0** (was 128/0). New sections: marker
placement anywhere, marker degradation without a link, arbitrary message shape, the
href being safe for hand-built notes, arbitrary keywords end to end, and condition
normalisation plus both refusals. **Superseded by E20, which extended it to 274/0.**

Mutation-tested: **20 deliberate regressions**, each caught (was 8). The new twelve
include ignoring the marker, discarding its label, honouring only the first marker,
rendering a dead href when no link exists, collapsing paragraphs, dropping the
`<br/>`, deciding link placement per paragraph, not collapsing a label, removing the
href validation, not stripping the trailing colon, accepting a URL as a condition,
and not lowercasing. Two anchors were initially wrong (one missed a `const out =`
prefix, one had lost a `\s`); a third was a **no-op mutation** that survived because
`String.replace` manages `lastIndex` itself — replacing the `/g` flag was the real
mutation. All three touched files restored byte-identically.

The new db section had to be moved *after* the isolation section: it writes to the
throwaway directory, and running it first broke the pre-existing assertion that the
temp dir starts empty. Test ordering is part of the isolation guarantee, not a
detail.

#### Live confirmation (real sheet, isolated data dir)

Run against a second instance on `:3005` with `OFFICEOS_DATA_DIR` pointed at a
temp directory, so nothing here touched live data. The real `ocalaflevents.com`
report tab was fetched:

- `POST /api/conditional-notes` with condition `link` → 200, stored `link`.
- The real cell `B24` fired `a11y`; the message contained **no `here` at all**, and
  the link landed on the operator's own words: `available in the audit report`, with
  the href taken from the cell. Two paragraphs rendered in order (indices 6 and 7),
  sign-off at 8.
- `a11y:https://example.com` as a condition → **400** with guidance.
- `"  ADA Review:  "` → 200, stored `ada review`.
- Three other real sites: 0 conditions fired and no `{{link` text leaked — the new
  `link` keyword did not false-positive on real sheet content.

To watch a real site fire on a keyword other than `a11y`, someone has to write
`link:https://…` into that site's report cell. That is a live-sheet write and was
not performed unasked.

---

### E20. Proved: *any* keyword, on the operator's real sheet (2026-09-30)

Asked directly — *"make sure it can detect any condition I give, even a name or
something gibberish like `alsdjflaksf`."* E19 made the code generic; this proves
it and closes a hole in the proof itself.

#### The two normalisers could have drifted

`db.js` strips a trailing colon from a condition before storing it. The resolver in
`reportUtils.js` had its own, narrower rule (`trim().toLowerCase()`). In production
that never shows, because notes always arrive from `getConditionalNotes()` already
normalised — so the divergence was invisible. But a caller handing the resolver a
raw registry entry would get `"  G112:  "` → `g112:`, a key **no cell can match**:
registered, and silently dead. Exactly the failure mode E19 removed for trailing
colons.

`normaliseConditionKey()` in `reportUtils.js` now repeats the full rule. It
deliberately does not import `db.js` — the pure layer must not pull in the data
layer. Two copies of one rule is only safe while they agree, so a test pins the
agreement across 13 inputs rather than trusting it.

#### Proved on the real sheet, not just a fixture

The operator renamed the live condition while this work was in flight — the real
cell in `B24` and the registered key both changed, to an arbitrary word, and the
feature fired correctly on the first try. That is the strongest available evidence
that no allowlist exists, and it came from the product's own code path against the
real spreadsheet:

    cell B24      <keyword>:https://docs.google.com/document/d/1WolHnCP5…#heading=h.6fwf6gxl58vz
    → 1 note      condition=<keyword>  url=<the doc>  sourceCell=B24
    → email       …remediation details are <a href="https://docs.google.com/document/d/1WolHnCP5…"
                   style="color:#1155cc;text-decoration:underline">available</a> here.

The marker worked too: the link sits on the operator's own word **"available"**,
not on a hardcoded `here`.

#### The live suite was asserting a coincidence

`verify-conditional-notes-live.mjs` hardcoded `a11y` and row 24. It therefore
**failed the moment the operator renamed the condition** — not because the product
was wrong, but because the test pinned a value the operator is entitled to change.
Worse, it would have kept passing if detection were broken for any other keyword.
It now discovers the cell in the trigger shape, takes whatever keyword the sheet
actually uses, and proves *that* keyword works — plus, on the real grid, that a
different arbitrary keyword does **not** fire. 23/0 → **27/0**.

#### The pattern is the contract, not a keyword list

The operator's framing, stated precisely: **the cell is `<variable>:<link>`.** The
variable name is *data*, not configuration. The cell supplies the name and the
link; the registry supplies the message; the marker inside the message decides
where the link lands. So there is no list of names that could fall out of date,
and adding a variable is a dashboard action, not a deploy.

Verified in the exact forms the operator typed, including `a11y: https://…` with a
space after the colon — the colon is the separator, so whitespace around it must
not become part of the variable name:

| cell in the sheet | variable | message that fires | link label | href from |
|---|---|---|---|---|
| `g112:https://…` | `g112` | the `g112` message | `the brief` | that cell |
| `hello:https://…` | `hello` | the `hello` message | `the advisory` | that cell |
| `a11y: https://…` | `a11y` | the `a11y` message | `available` | that cell |
| `A11Y:https://…` | `a11y` | the `a11y` message | `available` | that cell |
| `  hello:https://…  ` | `hello` | the `hello` message | `the advisory` | that cell |
| `alsdjflaksf:https://…` | *unregistered* | **nothing** | — | — |

The last row matters: a variable nobody registered stays silent, so the pattern
does not fire on any cell that merely looks like a URL.

#### Live demo

Registered `g112`, `hello` and `a11y` through the real
`POST /api/conditional-notes` route on an isolated instance (pid 2408, `:3005`,
`OFFICEOS_DATA_DIR` in a temp directory), then fed the cells above to the real
resolver and the real mailer. All six rows behaved as the table shows; anchors
read back as `example.com/plan`→"the brief", `example.com/notice`→"the advisory",
the ADA Doc→"available", `example.com/upper`→"available",
`example.com/padded`→"the advisory". Both throwaway servers stopped; only `:3000`
remains. Live `data/` untouched — still 1 note, 78 audit entries.

#### Tests

`scratch/verify-conditional-notes.mjs` — **303/0** (was 274/0). Adds the pattern
section above: nine cell spellings, three variables each selecting its own message
and its own link, and the two negatives (unregistered variable, bare URL with no
variable).

Mutations **24 → 28**, all caught. The four new ones break exactly what the
pattern section asserts: whitespace around the colon no longer tolerated, the link
swallowed into the variable name, the variable no longer anchored to the start of
the cell (so any cell merely *containing* it would fire), and the trailing-colon
strip widened to strip every colon. One of the four initially reported `SKIP` —
its anchor was double-escaped and matched the file zero times. The harness is
right to refuse to judge a mutation whose anchor does not land; the fix was to
correct the anchor, never to relax the check.

Full sweep **21/21 project suites + 2/2 offline harness, 0 failing**.

---

### E21. One note can cover both sheets (2026-09-30)

Asked for: *"make sure there's option to make both side, like cw and rm two
sheet."* The panel already had an **"Applies to"** dropdown listing CW and RM — but
it was a single `<select>`, so covering both sheets meant adding the note twice and
editing it twice, with nothing to stop the two copies drifting apart.

#### One action, one record per sheet

`db.setConditionalNoteForAccounts({ accounts, condition, message })` fans a single
action out to **one record per sheet**. A sheet that already has the condition is
**updated**, so one edit reaches every sheet ticked; one that does not gets a new
record. Re-running is therefore idempotent rather than a duplicate-row error.

The panel's dropdown became a checkbox per sheet plus a **Both sheets** toggle.
Adding or editing posts the whole ticked set in one action. The table now groups
by condition and shows a **Sheets** badge column, so "this note is on both" is
visible rather than inferred from a duplicated row.

**One record per sheet, not a single record with account `ALL`.** Deliberate:

- a record still belongs to exactly one account, so `getConditionalNotes` needs no
  new matching rule and a message cannot reach a sheet it was not chosen for;
- a future third account does not silently inherit every existing note, which is
  what an `ALL` scope would do;
- the record shape is unchanged, so nothing migrates and the live note is
  untouched;
- each record keeps its own stable id and its own audit entry, which is what the
  audit log has always meant.

#### Three ways the copies could still drift, and what closes each

| Risk | What prevents it |
|---|---|
| Edit one sheet, forget the other | One action writes every ticked sheet. Verified live: one reword moved both records, count stayed at 2. |
| Unticking a sheet silently deletes it | `setConditionalNoteForAccounts` never deletes. Unticking and saving leaves the other sheet's record exactly as it was, pinned by a test. The panel says so in the help text, and **Remove** is the explicit way to take a note off a sheet. |
| The two messages differ for a real reason (CW and RM clients get different wording) | The grouped row shows **⚠ messages differ** rather than quietly displaying one of them. Verified live by diverging RM behind the panel's back. |

Editing is two server calls on purpose. The sheets that already have the condition
are updated **by id** — which is what makes a condition *rename* work — and a newly
ticked sheet gets its own record via the create-or-update path. Posting the whole
set to the create route on an edit would have created a second record under the new
name and left the old one orphaned and still firing.

#### Tests

`scratch/verify-conditional-notes.mjs` — **334/0** (was 303/0). New section: one
action over both sheets; one record per sheet with distinct ids; `CW` never handed
`RM`'s record and vice versa; a CW-only condition does not fire for an RM email;
re-running updates instead of duplicating; one edit moves both; unticking leaves
the other sheet alone; empty and blank sheet lists refused; a bad condition
refused with **no** sheet written; and one audit entry per record per action.

Mutations **28 → 33**, all caught. Four of the five new ones died immediately. The
fifth — dropping the upper-casing of sheet names — **survived, and it was the tests
that were incomplete rather than the code being wrong**: the CRUD below normalises
on its own, so the writes still landed on CW and RM. But the *reported* sheet list
would have claimed three sheets when two were touched, and the panel renders that
response. A test now pins the reported list, and the mutation dies.

Full sweep **21/21 project suites + 2/2 offline harness, 0 failing**.

---

### E22. The ClickUp Time Track column (2026-09-30)

Asked for: a **Time Track** column on the `/mailer` per-site table. The master sheet
already carried the data — the column headed **"Maintenance time tracking ClickUp
URL"** — and the mailer already knew where it was. It simply never read the value.

#### The index comes from the resolver, never from a constant

`detectColumns` / `resolveColumns` in `src/reportUtils.js` already mapped
`TIME_TRACK_URL` (via the `clickupTimeTrackUrl` aliases in `src/columnMap.js`), so the
index was already being computed on every sync and then thrown away. The read uses the
resolved index:

```js
const timeTrackUrl = String(row[cols.TIME_TRACK_URL] ?? '').trim();
```

Hardcoding a position would have been wrong on the evidence, not merely fragile: **CW**
resolves to index **7** (column H) and **RM** to index **6** (column G). A hardcoded
`7` therefore returns **RM's *Task* link** — a plausible-looking, confidently wrong
value in a column labelled Time Track. RM also has an empty header cell at index 0 and
no `Note`, `Maintenance Report URL` or `Backup URL` columns at all, so nothing about
its layout can be inferred from CW's.

#### A cell is data, not code

The value is written into an `href`, and `escapeHtml` does **not** stop a
`javascript:` URL — escaping quotes produces a harmless *attribute* containing a live
URL, which still executes on click. So `public/app.js` gained a `safeExternalUrl()`
that deliberately mirrors the server's rule in `src/reportUtils.js`: **http or https,
or nothing**. This is the browser-side half of one rule, not a second, looser one.

What the column shows is then a claim it can back up:

| the cell holds | the column shows |
|---|---|
| a usable `http(s)` URL | a `Time Track` link |
| anything else that is non-empty | `Not a link` |
| empty | `—` |

`—` is an honest "there is nothing here". A placeholder URL would not be. `target`,
`rel="noopener noreferrer"`, `href` and `title` are all escaped; the anchor opens in a
new tab because the destination is someone else's site.

Layout: `<th class="col-timetrack">` in `index.html`, the `<td>` between **Report Tab**
and **CMS/AM**, `.col-timetrack` pinned to 96px `nowrap` in `dashboard.css`, and the
one `colspan` in the table's three row/placeholder templates bumped `9 → 10`.

#### Tests

Three suites, because the feature has three separate claims and one of them is easy to
assert in a way that proves nothing.

- `scratch/verify-timetrack-column.mjs` — **15/0**. Owns the **index** question only:
  the column is read by resolved name, and both real layouts resolve as above. It
  originally re-implemented `readAt` against a literal `7`, which would have passed
  while the product was broken; it was rewritten to assert on the resolved index.
- `scratch/verify-timetrack-live.mjs` — **19/0**. Drives the real `getOverviewData`
  over fixture sheets carrying the real CW and RM layouts, so the read *expression*
  is covered here and nowhere else.
- `scratch/verify-timetrack-href.mjs` — **37/0**. Extracts the real `safeExternalUrl`
  out of the served `public/app.js` and pins the anchor markup, so the client rule is
  tested against the bytes that are actually shipped rather than a copy of them.

`scratch/mutation-timetrack.mjs` — **14 mutations across `reportUtils.js`,
`dashboardApi.js` and `app.js`, all caught**, with each target's pristine source and
each file's own line ending (`src/reportUtils.js` and `src/dashboardApi.js` are CRLF,
`public/app.js` is LF) restored after every mutant. Two candidates were recorded as
genuine **no-ops** — deleting the `.trim()`, and replacing the allowlist with a
regex that kept the protocol check — and were replaced by detectable mutations rather
than quietly counted as caught.

#### Live

Read-only. `TIME_TRACK_URL` resolves to 7 (CW) and 6 (RM) against the real sheets, and
the value on the page equals the value in the sheet on **10 of 10** filled rows (CW 9,
RM 1) with **0 mismatches**. The single row where the Time Track and Task values are
identical is identical *in the sheet*. The other 93 sites have an empty cell and render
`—`. In the browser: 10 headers with `Time Track` at index 7, 103 rows, every link an
`https://app.clickup.com/…` URL carrying `rel="noopener noreferrer"`, and
`javascript:` / `JaVaScRiPt:` / `data:` / `vbscript:` / `file:` / unparseable / empty
all rendering as not-a-link.

Full sweep **24/24 project suites, 0 failing, 1490 assertions counted**. That count
covers `verify-columnmap-offline` (22/0), the no-network suite; the earlier entries in
this document that cite a separate "2/2 offline harness" refer to a script that is not
in `package.json` and could not be located, so treat those as unverified.

#### A correction to E21's own verification claim

`verify-conditional-notes.mjs` was reported at **334/0** throughout E21 and again in the
E22 sweep. Re-running it later the same day returned **319 passed / 15 failed**, and
all 15 were the same defect in the *suite*: they counted `<a href=` across the whole
email and expected 1, while the shipped CW signature contributes **4** of its own
(support mailbox, company site, logo, newsletter sign-up). An absolute count of the
whole email can never say anything about the note. `renderCwSignature()` is a static
literal, so this was not a regression in the product and not a broken restore — the
expectations were simply wrong, and the 334/0 figure recorded above is **not
reproducible** and should not be relied on.

The fix derives a `BASE_A` anchor baseline from a note-free render, exactly as the
suite already did for `BASE_P`, and makes every one of the 15 relative to it. That is
what the claim is actually about — *how many links the note adds* — and it still fails
on a duplicate. `mutation-conditional-notes.mjs` then re-proved it: **33 mutations,
all caught, tree byte-identical**, including "link placement is decided per paragraph"
(332/2), "the marker label is not collapsed" (332/2) and "the href is no longer
validated where it is written" (324/10). Suite total is unchanged at 334 — no
assertion was added, removed or softened, only 15 wrong expectations corrected.

---

## F. Audit and conflict model

### Audit log

`data/audit-log.json` is append-only and bounded to approximately 10,000 newest
entries. Meaningful changes record:

```text
timestamp | actor / actorId | action | entity / entityId
field: oldValue → newValue | source | reason
```

Wired audit hooks include assignment routes, site edit/status, daily-review
updates, user administration, schema additions, sheet-cell corrections, and
write-back append/soft-remove actions.

### Conflicts

`data/sync-conflicts.json` is a durable, bounded (approximately 5,000 entry),
deduplicated queue. Each record contains the entity, field, observed values,
policy, state (`open` or `acknowledged`), occurrence count, and audit linkage.
The current real sync retained 15 conflicts: 2 site/clickup URL divergences and
13 daily-review maintenance divergences. No conflict is silently resolved.

A write-back failure uses `policy: 'manual'`: the DB assignment remains the
truth, while the operator receives a visible conflict and audit record.

---

## G. Migration path to Cloudflare D1

The current implementation deliberately remains local JSON. The later D1 phase
should:

1. Define a repository interface matching the current `db.js` operations.
2. Provide `FsRepo` (current behavior) and `D1Repo` implementations.
3. Mirror the existing collections, audit log, conflict queue, stable IDs, and
   natural-key merge rules in SQLite.
4. Add an idempotent migration that reads `data/*.json`, upserts by stable ID,
   prints a migration report, and supports `--dry-run`.
5. Keep Sheets as an operational interface only; run periodic/on-demand sync
   with the same merge and conflict semantics.
6. Use D1 exports as point-in-time rollback artifacts.

No destructive migration is implied by this document.

---

## H. Implementation status

| Area | Status |
|---|---|
| Stable site/daily-review IDs and natural-key merge | done |
| Empty/partial import preservation and blank-cell merge rule | done |
| Provenance on imported and write-back rows | done |
| Audit log and admin+ audit endpoints | done |
| Durable conflict queue and acknowledgement state | done |
| Zero-write sync and assignment dry-run modes | done |
| Optimistic locking / `STALE_VERSION` | done |
| Canonical column resolver and account-column resolution | done |
| Assignment append, idempotency, provenance, and soft-remove | done |
| Assignment marker column on all 8 live tabs | done |
| Unassigned row tint (`#FCE5CD`), with clear-on-re-assign | done (applied to 6 live rows 2026-09-26) |
| Reconcile guard fed the honest source (no fabricated `todo`) | done (fixed 2026-09-27, E14) |
| Deactivated users locked out of site-assignee pickers, kept if already assigned | done (fixed 2026-09-27, E16) |
| Client surfaces the server's refusal message, not the bare error code | done (fixed 2026-09-27, E16) |
| Sheet-manager credential resolution with no hardcoded fallback | done |
| Conditional email notes: condition in the report tab → paragraph above the sign-off, link extracted from the cell | done (added 2026-09-30, E18) |
| Per-account condition→message registry with audited CRUD and a `/mailer` panel | done (E18) |
| Link placed by `{{link:…}}` marker anywhere in the message; any message shape | done (added 2026-09-30, E19) |
| Any condition keyword accepted; trailing colon stripped, URL-in-condition refused | done (E19) |
| Cache status endpoint and rate-limit/backoff protection | done |
| Offline verification suites | done (23 suites, 0 failing 2026-09-30) |
| Cloudflare D1 repository/backend | future phase |
| Conflict-resolution UI | future phase |
| Formal field-validation module | future phase |

---

## I. Verification log — 2026-09-25

### Offline and isolated suites

- `verify-columnmap-offline.mjs` — **22/22**.
- `verify-importer-parity.mjs` — **16/16**; all live rows import the same
  website/company cells before and after resolver refactoring.
- `verify-user-tab-columns.mjs` — **42/42** live read-only checks, including
  the append-plan shape, `Assigned` marker, account label, and blank checklist
  cells.
- `verify-writeback-dryrun.mjs` — **12/12**.
- Isolated fake-Sheets write path (`mm-wb-offline/verify-writeback.mjs`) —
  **47/47**, run twice with identical results.
- `verify-assign-dryrun.mjs` — **16/16** against the running server: all three
  assignment routes returned plans, the committed assignment stayed unchanged,
  all 22 `data/*.json` hashes stayed identical, and the Medul tab stayed
  byte-identical.
- `verify-daily-review-writer.mjs` — credential-resolution path exercised with
  a deliberately absent target; writer returned `written: 0` and the Sabbir
  tab stayed byte-identical.

### Live sync and data integrity

- Live daily-review spreadsheet: credential-managed ID
  `1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I`, 8 tabs, header row 1.
- Real sync preserved all seven collection ID sets: 0 lost, 0 new, identical
  counts; 104 sites and 181 daily-review rows remained.
- Tasks: 187 unique IDs, 0 removed (the prior first-wins matcher had reported
  15 removals and could generate duplicates).
- Properties: 92 kept, 0 added, 0 removed (the prior run reported 92 added,
  92 removed, 0 kept).
- 15 sync divergences were persisted and audited rather than silently resolved.
- Dry-run sync wrote no `data/` file; the real sync was the only approved data
  merge run.

### Live assignment verification

- Backfilled the two missing active-user pairs: Sabbir /
  `cogwheelmarketing.com` at row 25 and Taion /
  `https://thesagaponackny.com/` at row 29.
- After the operator re-activated Toufiq, backfilled its two newly visible
  gaps: `https://toastedbarrelbar.com/` at row 27 and `hotelperla.com` at
  row 28. All four rows carry the DB-known account `CW` and the `Assigned`
  marker; all checklist cells are blank.
- Every backfill had an idempotency re-run that reported `existing=1` and
  appended no duplicate.
- Active-user gap report after re-activation: **181 assigned pairs, 0 missing**
  across all six active users. Tarikul and Asif remain explicitly reported as
  `inactive-user`, not treated as write-back failures.
- A live HTTP round trip on `qualityinnparkersburg.com` → Saiful verified the
  complete path: append at row 21, then soft-remove to `Unassigned`, with the
  committed DB assignment restored exactly to its starting empty state.

### Row-tint verification (2026-09-26)

- `verify-row-highlight.mjs` — **51/51 offline**, no network, no writes. Covers
  segment maths, the `repeatCell` shape (0-based half-open indices, numeric
  `sheetId`, background field only), refusal of a non-numeric `sheetId` / row 0 /
  fractional row / unknown mode, row de-duplication, and marker→mode mapping.
  Includes an assertion that **no emitted request covers the company column**.
- The isolated fake-Sheets suite was re-run after the change — **64/64** — with
  the fake's `getTabSheetId` / `applyRowBackgrounds` / `getRangeBackgroundColors`
  made *functional* rather than no-ops, so fill → read-back → clear is proven to
  round-trip.
- `verify-marker-restore.mjs` (harness) — **44/44**. The marker restore is a
  **new write on a path that used to be strictly read-only**, so it needed its own
  proof. It asserts the three things that must *not* happen as loudly as the one
  that must: a row already marked `Assigned` gets **zero** cell writes and zero
  background writes; a blank marker is never guessed into `Assigned`; and
  `Pending review` — an unrecognised human value — is never overwritten. Plus the
  full round trip: unassign tints, re-assign restores the marker **and** removes
  the tint.
- That suite's first two drafts failed for reasons worth recording, because both
  look like product bugs and are not: Tarikul is **inactive**, so
  `assertActiveAssignees()` refused every call (the guard working); and a
  single-row tab is not a valid fixture, because `resolveUserTabUrlColumn()` needs
  `minDomains: 3` to identify the URL column — without filler domain rows the
  resolver gave up and the code dutifully appended a duplicate instead of finding
  the row.
- Regression after the change: `verify-data-quality-check.mjs` **22/22**,
  `verify-reconcile-guard.mjs` **33/33**, `verify-assign-dryrun.mjs` **16/16**
  against the live server with all 22 `data/*.json` hashes and the Medul tab
  byte-identical.
- `dry-run-row-highlight.mjs` across all 8 tabs: **6 rows to paint**
  (`Sabbir!25`, `Taion!30/31/32`, `Saiful!21/22`), 0 to clear, 1 already correct,
  **0 conflicts**, 12 `repeatCell` requests in 3 `batchUpdate` calls, 0 errors.
- The dry run is what exposed the banding hazard: it wanted to clear
  `Toufiq!27` and `!28`, which are `#CFE2F3` **row banding**, not a tint. Both are
  now reported as `NOT OURS` and left alone. Without the dry run this would have
  shipped as a silent strip of the team's formatting.
- **The tint was applied to the live sheet on 2026-09-26, with approval.** Six
  rows, 3 `batchUpdate` calls, 12 `repeatCell` requests:
  `Sabbir!25`, `Taion!30`, `Taion!31`, `Taion!32`, `Saiful!21`, `Saiful!22`.
  Verified against a **fresh** API read, not the write response: all six carry
  `#FCE5CD` across both paint ranges, and the three account cells kept their
  exact prior colours (`Sabbir!25` `#8E7CC3`, `Saiful!21` and `Saiful!22`
  `#B4A7D6`).
- Idempotence confirmed: re-running the dry run afterwards reports **0 to paint,
  0 to clear, 7 already correct**, and `Toufiq!27/28` are still reported as
  `NOT OURS` with their `#CFE2F3` banding intact.
- Undo is possible because a **pre-write snapshot** of every affected cell is at
  `scratch/row-highlight-before.json`, written before the first write rather than
  reconstructed afterwards. `scratch/apply-row-highlight.mjs` is snapshot → apply
  → verify in that order, so a background write is always recoverable.
- The server on port 3000 was restarted onto the new code (pid 19540) only after
  the paint was verified. It had been running pre-tint code, so an unassign
  performed before the restart wrote no tint — confirmed by reading the sheet,
  not assumed.

### Reconcile-guard verification (2026-09-27)

E14. Full record in section E14; the verification points:

- `scratch/verify-reconcile-guard-fix.mjs` — **34 passed, 0 failed**. Two halves:
  behaviour against real data, and assertions that `src/server.js` still carries
  the fix. The second half exists because a behaviour test that only exercises a
  hand-copy of a call site proves nothing about the file that actually runs; if
  someone reverts `server.js`, the suite fails even though the mirrored logic
  below it is still correct.
- Destructive writes the guard allows, over every `(row, month)` pair in the live
  data (10 317 pairs, 4 924 mismatches): **54 → 0**. Legitimate forward progress
  still written: **22**. A fix that blocked all writes would be an outage, so both
  directions are asserted.
- The exact damaged cell is asserted directly rather than inferred:
  `Saiful!21`'s `"September 26"` column really is blank, the write is refused, and
  the reason is `empty-source-would-downgrade` — not merely *some* refusal.
- `verify-reconcile-guard.mjs` — **33 passed, 0 failed** (see E14 for the corrected
  assertion).
- `verify-row-highlight.mjs` 51, `verify-data-quality-check.mjs` 22,
  `verify-columnmap-offline.mjs` 22, `verify-smart-fill.mjs` 195,
  `verify-inheritance.mjs` 12, `verify-inactive-donor-excluded.mjs` 6,
  `verify-assign-dryrun.mjs`, `verify-daily-review-writer.mjs` — all pass.
- Offline harness: `verify-writeback.mjs` 64, `verify-marker-restore.mjs` 44, both
  pass.
- **Live, on the restarted server:** the reconcile refused and **no write was
  issued** — no `mismatched row(s)` line and no `wrote N cell(s)` line, against a
  log that previously reported `wrote 1 cell(s)`. `Saiful!21!C21` reads `"To Do"`
  on a fresh read, marker `Assigned`, 0 cells carrying `#FCE5CD`, and
  `Saiful!22` still correctly tinted.
- The fix **performs no sheet writes of its own**; it can only stop them. Verified
  by the log containing no `batch-sync` line at all for the refused row.

### Test-suite repairs (2026-09-27)

E15. **20 suites, 0 failing** (18 project `scratch/`, 2 offline harness). No product
code changed; all five previously-failing suites were wrong, not the code.

| suite | was | now | cause |
|---|---|---|---|
| `verify-importer-parity` | 15/1 | **16/0** | passed `header:` to a `{headers}` param — the new side resolved blind |
| `verify-writeback` | 10/2 | **16/0** | harvested `"CW"` from the account column via header-only resolution |
| `verify-user-tab-columns` | 40/2 | **43/0** | hardcoded Toufiq inactive; stale `exists` action name |
| `verify-writeback-dryrun` | 11/1 | **13/0** | hardcoded Toufiq inactive |
| `verify-backfill-result` | 553/1 | **554/0** | asserted a post-backfill row was in the backfill's scope |

Two of these were **passing while testing the wrong thing**, which is the more
serious finding: `verify-importer-parity` was comparing against a resolver that had
been handed no headers, and `verify-writeback` asserted only `col >= 0` on a column
that pointed at the account labels. Both now assert against the product's own
resolution path, and the latter now proves the chosen column actually holds domains.

All three hardcoded environment facts (a user's `active` flag, the backfill date, an
action string) are now derived from the source of truth, so they cannot go stale
again. The two skip-path suites assert that an inactive user *exists*, so they cannot
silently stop testing the skip either.

`data/` was not modified by any of this: `audit-log.json` held at **70** entries
throughout, and `verify-writeback-dryrun` independently confirms every `data/` file
is byte-identical after its dry runs.

### Assignee-picker fix and a second fixture repair (2026-09-27)

E16. **Deactivated users were offered in the site-assignee pickers** (Tarikul, Asif —
derived from `db.getUsers()`, not hardcoded). Three linked defects: the picker sold a
choice the server refuses (`assertActiveAssignees` → 400, and it refuses the *whole*
save); the client discarded the server's explanation so the toast read
`INACTIVE_ASSIGNEE`; and the obvious repair — filtering the user list — would have
silently unassigned already-assigned deactivated users, because all four grids submit
the complete checked set. Fixed by splitting display from choice: inactive and
unassigned → disabled; inactive and already assigned → checked **and still enabled**,
so a disabled-and-checked dead control is never produced and `Clear All` can still
remove one. `Select All` now skips disabled boxes, because setting `.checked` from
script works on a disabled input.

Task/SEO/Web assignee and sheet-credential pickers were **left alone on purpose** —
`assertActiveAssignees` has exactly four appearances in the server (the definition
plus three site-assignment routes) and appears nowhere near them, so there is no
refusal to prevent.

E17. `verify-reconcile-guard-fix` pinned the E14 incident to `rowIndex 21 / saiful /
September 26`. The operator unassigned that site at 10:41, the soft-remove deleted
the daily-review record, and the fixture became unfindable — the same "pinned a
moment" error as E15. Now derived: all **550** real `(row, month)` pairs whose month
column carries no information while the cell records work, covered by two aggregate
assertions (a per-pair version printed 1100 lines). The damaged cell is a printed
note, not an assertion, because the app moving it is correct behaviour.

| suite | was | now | cause |
|---|---|---|---|
| `verify-assignee-picker` | — | **47/0** | new; extracts and evaluates the deployed functions, mutation-tested |
| `verify-reconcile-guard-fix` | 30/1 | **32/0** | pinned a `(row, month)` coordinate the app moved |

`verify-assignee-picker` does not test a copy — it extracts the real functions out of
`public/master-app.js` and runs them, so it fails if the deployed file stops carrying
the rule. It was mutation-tested: three deliberate regressions were each caught, and
the file was restored byte-identically (SHA256 match) after each.

### Conditional email notes (2026-09-30)

E18. See the full write-up above. Summary of what was verified, and how:

- `verify-conditional-notes.mjs` — **128/0** against the real exported functions.
  Covers the real trigger cell, the negative cases (registered `Update` vs the
  genuine `Update | Theme | To Version` row; a plugin literally named `a11y`;
  mid-cell and prose mentions), case/whitespace tolerance, missing and unsafe
  links (`javascript:`, `data:`, `ftp:` all rejected), `enabled: false`, registry
  ordering, HTML escaping, the last-`here` rule, coexistence with the existing
  `Premium Plugin` / `Additional Issues Fixed` paragraphs, and subject stability.
- `verify-conditional-notes-live.mjs` — **23/0** against the operator's real
  spreadsheet. Confirms `parseReportSections` drops the cell (0 rows in
  `additional_issue`) and that it is absent from the pre-existing report HTML,
  then registers the condition and asserts the real link becomes the `href` and
  the paragraph reads back as the operator's sentence.
- Mutation-tested: **8 deliberate regressions, 8 caught**; all three touched files
  restored byte-identically.
- **HTTP surface**, exercised end-to-end against an isolated instance on port
  3005 (pid 6184) so no live data was touched: create (with `"  A11Y  "` →
  normalised to `a11y`), GET filtered per account (CW sees it, RM does not),
  duplicate → **400**, update `enabled:false` → **200**, unknown id → **404**,
  delete → **200**, delete twice → **404**. The isolated audit log recorded
  `conditional-note:create` / `:update` / `:delete`.
- `/mailer` serves the panel (heading, both inputs, add button, table body,
  account selector, count badge), all inside `<main>`; `/` is the *master*
  dashboard and is unchanged.
- Encoding: `app.js`, `index.html`, `mailer.js`, `db.js`, `reportUtils.js` and
  `master-app.js` all valid UTF-8, no BOM, exact byte round-trip, CW/RM emoji
  intact. (A first encoding check reported a failure — the detector was flagging
  every multi-byte character, emoji included. Re-validated with a fatal whole-buffer
  decoder, which was itself self-checked against a deliberately broken sequence.)

| suite | was | now | cause |
|---|---|---|---|
| `verify-conditional-notes` | — | **128/0** | new; runs the real functions, mutation-tested |
| `verify-conditional-notes-live` | — | **23/0** | new; proves it against the operator's real tab |

Full sweep after the change: **23/23** (21 project suites in `scratch/`, 2 in the
offline harness), 0 failing. `verify-assign-dryrun` passed, which also confirms it
still genuinely requires the running server.

### Link placement anywhere, and any condition keyword (2026-09-30)

E19. See the full write-up above. What was verified, and how:

- `verify-conditional-notes.mjs` — **193/0** (was 128/0) against the real exported
  functions. New sections cover: the `{{link:…}}` marker placing the anchor
  mid-sentence, at the start, twice in one message, and with a custom label; a
  marker degrading to its own label when the cell has no link; blank line → new
  `<p>` and single newline → `<br/>`; a label wrapped across lines and a label
  containing a blank line both yielding one intact anchor; the href being safe
  (`javascript:`, `data:`, `ftp:`, and a quote-injection attempt all rejected at
  the point the `href` is written); arbitrary keywords `link` / `ADA Review` /
  `sec-fix` firing end to end; and condition normalisation plus both refusals.
- Mutation-tested: **20 deliberate regressions, 20 caught** (was 8); all three
  touched files restored byte-identically.
- **A bug the probe caught and the suite now guards.** Deciding
  "marker present → place it, else fall back" per *paragraph* gave every unmarked
  paragraph its own appended link, so a two-paragraph message with one marker
  produced two links. Placement is now decided for the whole message.
- **A no-op mutation that survived.** "Only the first marker is honoured" was
  first written as a `lastIndex` guard, which does nothing — `String.replace`
  manages `lastIndex` itself. Removing the `/g` flag was the real mutation, and it
  is caught. Two other anchors were wrong (one missed a `const out =` prefix, one
  had lost a `\s`); the harness refused to judge them rather than passing silently.
- **Test ordering is part of isolation.** The new db section writes to the
  throwaway directory, so running it before the isolation section broke the
  pre-existing assertion that the temp dir starts empty. It was moved after.
- **Live, against the real sheet, on an isolated instance** (`:3005`, pid 23152,
  `OFFICEOS_DATA_DIR` in a temp dir — no live data touched, instance stopped
  afterwards, stderr 0 bytes): condition `link` accepted through the real route
  (200, stored `link`); the real cell `B24` fired `a11y` from a message containing
  **no `here` at all**, with the link on the operator's own words
  (`available in the audit report`) and the href taken from the cell; two
  paragraphs in order (6, 7) with the sign-off at 8; `a11y:https://example.com` as
  a condition → **400** with guidance; `"  ADA Review:  "` → 200 stored
  `ada review`; three other real sites 0 fired with no `{{link` text leaked.
- Full sweep after the change: **23/23** (21 project suites in `scratch/`, 2 in
  the offline harness), 0 failing. `verify-conditional-notes-live` re-ran green at
  23/0 against the real spreadsheet.

| suite | was | now | cause |
|---|---|---|---|
| `verify-conditional-notes` | 128/0 | **193/0** | marker placement, any message shape, any keyword, href safety at the point of writing |
| `verify-conditional-notes-live` | 23/0 | **23/0** | unchanged, re-run green against the real tab |

**E20 status.** Operator asked for a guarantee that *any* keyword works, including
nonsense. Verified on the operator's own live edit, then hardened.

| suite | was | now | cause |
|---|---|---|---|
| `verify-conditional-notes` | 193/0 | **334/0** | the `<variable>:<link>` pattern in the operator's own spellings; 41 arbitrary keywords; metacharacters literal; no false positives on the real grid; the two condition-normalisers pinned to agree; one note across both sheets |
| `verify-conditional-notes-live` | 23/0 | **27/0** | discovers the live keyword instead of hardcoding `a11y`; proves a *different* arbitrary keyword does not fire |
| mutations | 20 | **33** | colon spacing, link swallowed into the variable, unanchored variable, over-eager colon strip, unescaped metachar, case-sensitive match, front-trim only, sheet dedupe/case/guard, create-vs-update — all caught |
| `src/reportUtils.js` | — | +12 lines | `normaliseConditionKey()`, so a raw registry entry cannot normalise to an unmatchable key |
| `src/db.js` | — | +1 function | `setConditionalNoteForAccounts()`, create-or-update across sheets |
| panel | single `<select>` | **checkbox per sheet + "Both sheets"** | one action covers every ticked sheet; table grouped by condition with a Sheets badge and a drift warning |
| full sweep | 23/23 | **21/21 project + 2/2 offline, 0 failing** | — |

> **Corrected 2026-09-30 by E22.** The `334/0` in the row above is **not
> reproducible**: 15 of those assertions counted `<a href=` across the whole email
> while ignoring the 4 anchors the account signature contributes, so the suite was
> really 319/15. The *expectations* were wrong, not the product. The suite derives a
> `BASE_A` baseline now and the total is again 334, with all 33 mutations still
> caught — but the 334/0 figure itself should not be cited as evidence.

**Deliberately not done (now moot):** writing `link:https://…` into a real report
cell to watch a non-`a11y` keyword fire on a live site. That is a live-sheet write
and was not performed unasked. **E20: the operator made that write themselves** —
see the known-live-state note below.

### Runtime verification

- The live listener on port 3000 is pid **24300**, restarted 2026-09-30 by
  `node src/server.js` so the E22 Time Track column was loaded; HTTP 200 on `/`,
  `/mailer`, `/app.js`, `/dashboard.css` and `/api/overview`, stderr empty (0 bytes),
  and **0** `[batch-sync]` lines in stdout — no sheet writes.
  It replaced pid 6376 (E21), which replaced pid 12804 (E20), which replaced pid
  38608 (E19), which replaced pid 4276 (E18). The entry below refers to pid 2408;
  the ones below that to 23152, 28308 and 24500 (2026-09-27); all are gone.
- The E19 demonstration ran on a **second** instance, pid 23152 on `:3005` with
  `OFFICEOS_DATA_DIR` pointed at a temp directory, and was stopped afterwards
  (stderr 0 bytes throughout). No live data file was touched by it.
- `cache-status?role=admin` returned HTTP 200; the same route without the
  admin role returned HTTP 403.
- A missing `getSheetCredentials` import in `src/sheets.js` was found in the
  reconcile logs and fixed. The credential-resolution writer probe above now
  passes without a sheet write.

### Known live state and intentionally retained items

- The deliberate Saiful round-trip test left one visible row at
  `qualityinnparkersburg.com` with marker `Unassigned`; this is the documented
  soft-remove behavior, not a deletion. **Superseded 2026-09-27:** the user
  quick-assigned that site back to Saiful, so `Saiful!21` is now a normal
  `Assigned` row with its tint cleared and its account cell `#B4A7D6` intact. It
  was also the single cell E14 blanked and then saw restored. The retained
  *unassigned* row is `Saiful!22` (`cogwheelmarketing.com`), still tinted.
- **Superseded again 2026-09-27 10:41:** the operator removed *both* assignees
  from `qualityinnparkersburg.com` via Quick assign (`assignment:replace` →
  `user-tab:soft-removed` for `Saiful!K21` and `Roeich!K27`). The site now has
  `assignedUsers: []` and both rows read `Unassigned` (tint retained, rows kept,
  nothing deleted) — the documented soft-remove outcome, not a regression. This
  is what invalidated the `verify-reconcile-guard-fix` fixture described in E17.
  The site remains available to re-assign from the normal UI.
- Two account cells on the earlier backfilled rows were filled from the DB
  account value (`CW`) after the account-column bug was fixed. The correction
  is audited as `sheet:cell-correct`.
- Toufiq was re-activated at the operator's request; Tarikul and Asif remain
  `active:false`, so their write-back is skipped and reported as
  `inactive-user`. No further activation was made. The E16 picker fix makes this
  consistent in the UI as well: they are now visibly unavailable in the
  site-assignee grids instead of being offered and then refused.
- The retained Saiful `Unassigned` row was **not** deleted, and Tarikul/Asif were
  **not** re-activated, as instructed.
- **`data/email-conditional-notes.json` held exactly one condition** for CW,
  created 2026-09-30 via the `/mailer` panel and then **edited twice by the
  operator**, both audited:
  1. `conditional-note:create` — condition `a11y`, the ADA sentence verbatim.
  2. `conditional-note:update` 04:32 — message changed to use the E19 marker:
     `…remediation details are {{link:available}} here.`
  3. `conditional-note:update` 04:33 — **condition renamed**, the operator's own
     choice of keyword. The live sheet cell `B24` was changed to the same keyword
     by the operator, so cell and registry agree and the note fires. Verified
     through the running product: 1 note, `sourceCell=B24`, link taken from the
     cell, anchor on the word **"available"**.
- **Flagged to the operator (2026-09-30):** that keyword is a racial slur. Nothing
  in the system objects — the feature is deliberately keyword-agnostic, so it
  registered and fired like any other word, which is the requested behaviour. The
  concern is editorial, not technical: the word sits in a client's own report tab,
  and if the note were ever left in a preview, a client would see it. The
  operator's stated intent is the keyword `g112`; changing the sheet cell to
  `g112:` is a live-sheet write and was **not** performed unasked.
  **Still awaiting that decision as of 2026-09-30 14:05.**
- The audit log held **78** entries through the operator's edits above; the last two
  are the operator's message and condition edits. `Disable` / `Delete` in the panel
  removes the condition, and the audit entries stay.
  It was previously recorded here as "does not exist" — that was accurate when E18
  shipped and registering a condition was left as the operator's decision.
- **Unapproved live write, 2026-09-30 14:03:35 — disclosed, not reverted.** The
  registry now holds **two** records, not one. A `conditional-note:create` added
  `873a7646-b385-4066-a7bf-5e0af03d8c41` for **RM**, an exact clone of the CW record
  (same keyword, same ADA message), bringing the audit log to **79**. The CW record's
  `updatedAt` moved in the same operation but produced no audit entry, which is
  correct: `updateConditionalNote` computed `changed === []` because the values were
  identical, so nothing meaningful changed and nothing was logged.
  The only caller of `setConditionalNoteForAccounts` is the
  `POST /api/conditional-notes` route, and `source: 'app'` is a hardcoded default in
  `db.js`, so the entry does **not** distinguish an HTTP caller from a direct call —
  it is not evidence either way. The one `/mailer` tab open at the time had **both**
  sheet boxes ticked, consistent with the panel's "Both sheets" save, but the specific
  POST was not captured and **the operator has not been asked about it**.
  **No sheet was written and nothing was deleted.** Left in place deliberately:
  removing it is itself a live change and needs the same explicit decision. The RM
  record is inert on its own — no RM report cell carries the keyword — so no email
  changes today.
- `db.js` now honours `OFFICEOS_DATA_DIR` for test isolation. It is unset in
  every real process, so live behaviour is unchanged; a child process with it
  unset is asserted to resolve `./data`.
- Four pre-existing `.tmp-*.mjs` files in the project root were not touched;
  one can rewrite `public/master-app.js` and must not be run accidentally.
- No further live-sheet write is implied by this document. Any cleanup of the
  disclosed Saiful residue, re-activation, or deletion of temporary scripts
  requires an explicit operator decision.
