# ClickUp Close-out — Postmortem & Operating Guide

> Written 2026-10-10, covering the events of 2026-10-09: the batch close-out,
> the failed "update the sent message" pass, the corrective cleanup, and the
> follow-up system integration.

---

## 1. Timeline of what actually happened

| Step | What happened |
|---|---|
| 1. Audit (read-only) | 103 sheet rows; 79 with ClickUp time-track links (79/79 readable); statuses at the time: 74 `in progress`, 3 `to do`, 2 `closed` (tanresorts duplicated → same task `868e2ppjj`). |
| 2. Batch close (live) | Per instruction, acted **only** on `in progress`: closed + commented **65** tasks (no account manager in the comment, as instructed), skipped 1 already-closed + 12 `to do`/`Open` untouched. |
| 3. "Update the message" | Operator asked to add the account-manager mention to the already-sent messages — **no follow-up comment**, **no status change**. |
| 4. Update pass (live) | Posted the corrected (AM-mention) comment per task **but** the delete used the **wrong endpoint** (`DELETE /task/{id}/comment/{id}` → 404), which the script wrongly treated as "already gone" → the old comment was never removed → **56 tasks ended up with a duplicate comment** (old no-AM + new with-AM). |
| 5. Corrective cleanup (live) | Found the **correct** endpoint (`DELETE /comment/{id}`); deleted the 54 remaining old duplicates (2 were already gone); full verification: **56/56 tasks have exactly one comment carrying the AM tag + Ovi tag**, status untouched. |
| 6. System integration | Built the gate + batch service + API route + dashboard UI so "next month" is a safe one-click flow (see §3). |
| 7. Post-state check | Fresh reads on 2026-10-10: **65 tasks read `to do`, 12 read `Open`, 1 `Closed`, 0 `in progress`**. Also: `.env` now has `CLICKUP_AUTO_CLOSE_ENABLED=true` (see §2.5 and §5.1). |

---

## 2. What went wrong — root causes & lessons

### 2.1 The duplicate-comment failure (update pass) — ENDPOINT MISMATCH

The update pass called `DELETE /api/v2/task/{task_id}/comment/{comment_id}`.
ClickUp answered **`404 page not found`** — the endpoint does not exist.
The script's error handling was:

```js
if (!del.ok && del.status !== 404) throw ...   // 404 forgiven as "already gone"
```

so it considered "not deletable" a success and **posted the new comment anyway** →
old + new comment on the same task.

**Lesson:** a `404` on a resource that should exist usually means *wrong path*, not
"nothing to do". Forge nothing: capture and inspect non-2xx statuses and response
bodies in write paths, and verify the resource state **after** the call (a follow-up
`GET` that confirms the mutation) instead of trusting the status code alone.

### 2.2 No status gate in the close path — "it failed when we clicked"

`completeClickUpMaintenanceTask` posted the comment and set `Closed` **without ever
reading the task's current status**. Clicking the sync/complete button on a task that
was already closed → duplicate comment + re-touching a closed task. The batch had
worked around this by manually fresh-checking status first, but the single-task
"click" path the operator uses did not.

**Lesson:** any operation that ends in a write must gate on a **fresh** API read of
the thing it is about to mutate — never on a cache, never on the last thing someone
else printed.

### 2.3 Cache vs. fresh status

The preview path (`getClickUpTaskPreview`) serves status from a **5-minute cache**.
That is fine for display, **never** for a decision that results in a comment/status
write. The fix introduced a dedicated no-cache reader (`getClickUpFreshStatus`).

### 2.4 ClickUp comment API facts (verified 2026-10-09, by probing + docs)

- **Create**: `POST /api/v2/task/{task_id}/comment` — body must put the mention
  **blocks at the root** as a `comment` array:
  `[{type:'tag',user:{id:AM}}, {text:' … FYI '}, {type:'tag',user:{id:49039188}}]`.
  Using `comment_text` with `@id` strings stores **literal text** — no mention tag,
  no notification. `notify_all:false` still notifies mentioned users.
- **Delete**: `DELETE /api/v2/comment/{comment_id}` — **not** under
  `/task/{task_id}/...`. Returns `200 {}`.
- **Update / "edit a sent message"**: the documented endpoint
  `PUT /api/v2/comment/{comment_id}` only accepts plain **`comment_text`** (plus
  assignee/resolved flags). It rewrites text and strips rich mentions — the mention
  becomes literal `@id` text and **no notification fires**. There is **no in-place
  rich-text edit** in the API.
- **Implication**: the only faithful way to "update a sent message that mentions
  someone" is **delete + re-post** — the replacement comment gets a new id, lands at
  the end of the thread, and re-notifies everyone mentioned. That is the correct
  behavior to build into any future "edit comment" feature.
- **List**: `GET /api/v2/task/{task_id}/comment` returns newest-first, 25 per page
  (page deeper with `start` + `start_id`).
- The repo's code comments reference `clickup-comment-with-mention.md` — **that file
  is not checked in**. The facts above need recording in-repo (see §5.5).

### 2.5 Guard-state drift

`CLICKUP_AUTO_CLOSE_ENABLED` is now `true` in the local `.env` (set via the console
Save / cloud-sync path — not by any script here). Meanwhile the cloud KV copy may
still hold `false`, and the app overwrites local env from cloud on start and every
10 minutes — so the effective guard can flip without anyone editing `.env` by hand.
A live batch run is currently *permitted*; always confirm the effective toggle state
before a run and treat it as shared, drifting state.

### 2.6 Status post-state anomaly — RESOLVED: ClickUp recurrence

The 65 tasks closed on 10-09 now read `to do` on fresh API reads (65 `to do`,
12 `Open`, 1 `Closed`, 0 `in progress`). This is **not a defect**:

**ClickUp's auto-scheduling (recurrence):** when a *recurrent* task is closed,
ClickUp automatically rolls it into the next cycle and its status returns to
`to do`. The Close `PUT` did stick on 10-09 — the list then advanced to the next
recurrence. The 12 `Open` + 1 `Closed` are non-recurrent (or differently
scheduled) tasks. **Implication for the close-out:** at month end the current
cycle's tasks are `in progress` (that is when the run happens); after the run
they roll to `to do` for the next month. The `in progress`-only gate is exactly
right for this lifecycle.

### 2.7 The valuable lesson: batches must be safe to RE-RUN

A close-out posts 60–70 messages. If the first run fails partway (e.g. the
comment posted but the status `PUT` failed, leaving the task `in progress`), a
naive re-run would post the **same message a second time**. The operator's rule
is exactly right: *on re-run, check the task's current status — if `in
progress`, send; otherwise don't.* That rule is now enforced with a
**duplicate-comment guard** (in addition to the status gate):

- Before posting, the task's existing comments are read and checked for this
  month's completion message (matched on **month + site** text — `completed
  maintenance for the month of <month> and sent email to clients for <site>`).
- Found → the POST is skipped and the run only finishes the close
  (`alreadyCommented: true` in the report, counted as `reusedComments`).
- A previous month's identical-looking comment names an earlier month, so it
  never suppresses the current month's notification.
- If the comment-read itself fails, the run falls through to a normal POST —
  a read failure can never block the close.

---

## 3. What was fixed — the integrated system

| File | Change |
|---|---|
| `src/clickup.js` | **Status gate inside `completeClickUpMaintenanceTask`**: fresh (no-cache) status read immediately before any write; task not exactly `in progress` → returns `{skipped}` and **posts nothing**. **Duplicate-comment guard (re-run safe)**: before posting, checks for *this month's* completion message (month + site match) and skips the POST if it already exists — a 60–70 message batch is idempotent after a partial failure. **Roster-first AM resolution**: `resolveAccountManager` now accepts a live roster context — sheet AM names are auto-@mentioned on strong matches (email / exact / full), weak first-name-only matches go to `rosterWeak` (surfaced for promotion, never mentioned), runtime-promoted pairs override everything, and `AM_DIRECTORY` is demoted to the pin/override list instead of the whole catalog. Exported `taskIdFromUrl`, `getClickUpFreshStatus()`, `getAmMentionContext()`. `AM_DIRECTORY` includes **Shelley Warsaw** (id `87477102`). |
| `src/clickupCloseout.js` *(new)* | `runClickUpCloseout({dryRun})`: sheet-overview-driven, deduped by task id, fresh status per task, classifies `close` / `skip-closed` / `skip-not-in-progress` / `skip-error`, refuses live runs while the toggle is off, retries 429s, paces requests, returns a full per-task report. Plan previews use the same roster-first context as live runs. |
| `src/server.js` | `POST /api/clickup/closeout` — defaults to a **read-only plan** (`dryRun`); a live pass additionally requires `CLICKUP_AUTO_CLOSE_ENABLED=true`. `GET /api/clickup/account-managers` now merges promoted pairs; new `POST|DELETE /api/clickup/account-managers/promote` writes/removes a runtime pairing (id cross-checked against the live roster). |
| `public/master-app.js` | Settings → Integrations & Limits → **Monthly ClickUp Close-out**: `🔍 Preview` (read-only plan) and `▶ Run close-out` (confirm dialog; refused while toggle off), with a status panel showing counts. |
| `public/app.js` + `public/index.html` | **👥 View All AMs** gains an **Action** column: `✅ Link` promotes a suggested roster match to a verified pairing (runtime data, no source edit), `↩︎ Unlink` removes it. Status tooltips explain each state. |
| `docs/credentials.md` | Operator note on close-out behavior + guard. |
| `docs/clickup-closeout-postmortem.md` | This document. |

Guarantees of the integrated flow:

- **Only `in progress` tasks are ever touched** — enforced twice: in the plan pass
  (fresh status) and inside `completeClickUpMaintenanceTask` right before any write
  (covers the race).
- Already-closed / `to do` / `Open` / lookup-error tasks are skipped untouched —
  never commented, never written.
- Comment = standard message with the sheet's account manager (real ClickUp id,
  resolved roster-first: strong roster match ⇒ auto-mentioned, weak ⇒ FYI-only
  until promoted at runtime; ids are never fabricated) + Ovi tag.
- No emails, no sheets — ClickUp only.
- Live runs are refused while the toggle is off; the preview still works.

---

## 4. Verification performed

- `node --check` — all changed files clean.
- `scratch/verify-am-directory.mjs` — **PASSED 41, FAILURES 0** (AM resolution /
  mention builders unchanged, roster-first + promoted-pair tests, Shelley
  Warsaw now resolves to `87477102`).
- End-to-end **read-only** plan through the new service: month **September**;
  **0 in progress** → 0 writes; 1 already-closed + 77 not-in-progress classified,
  0 errors.
- Full comment-state verification after cleanup: **56/56 tasks** carry exactly one
  comment with both AM tag and Ovi tag; old duplicates gone.

---

## 5. What's still missing / open on our side (prioritized)

Resolved this session: **(a)** the 65-task mystery is ClickUp recurrence on
closed recurrent tasks (§2.6) — the 10-09 closes did stick; **(b)** Shelley
Warsaw is now in `AM_DIRECTORY` (real id `87477102`); **(c)** re-runs are now
idempotent via the duplicate-comment guard (§2.7); **(d)** the AM mention system
is **roster-first** — sheet AMs auto-@mention on strong ClickUp-roster matches
(email / exact / full), weak matches are surfaced for one-time **promotion at
runtime** (no source edits), and `AM_DIRECTORY` is only the pin/override list
(see the §3 table). Remaining open items:

1. **Make the feature live.** The new route + UI only take effect after the
   dashboard server restarts. A restart runs the startup cloud pull, which may
   rewrite `.env` (see the toggle item below). Deploy/restart is an operator
   decision — has not been done.
2. **Resolve the toggle mismatch.** Local `.env` `CLICKUP_AUTO_CLOSE_ENABLED=true`
   vs. cloud KV (likely `false`). Decide the intended resting state; only turn it
   on deliberately and immediately before a live run.
3. **Exercise the re-run guard once, staged.** Before relying on it for next
   month, confirm `alreadyCommented` behaves on a real task (e.g. a task that
   already carries this month's message) in a read-only or single-task test, so
   the `reusedComments` path is proven, not just reviewed.
4. **Record the ClickUp comment endpoint facts in-repo.** The referenced
   `clickup-comment-with-mention.md` is not checked in; add it (or a section here)
   with the create/delete/update facts from §2.4 so future work doesn't re-learn
   them the hard way.
5. **Optional hardening.**
   - A gate regression test (fetch stubbed) asserting: `in progress` → proceeds;
     `Closed` / `to do` → `{skipped}` with no writes; and a re-run with a
     matching existing comment → no POST, `alreadyCommented: true`.
   - Post-run re-verify pass (fresh GET after the run confirming status + comment),
     like the manual verification we did on 10-09.
   - Per-task detail panel in the close-out UI (sites + skip reasons).
   - Retire the scratch batch scripts (`batch-close-clickup.mjs`,
     `update-clickup-comment-am.mjs`, `cleanup-am-comment-duplicates.mjs`) now that
     the integrated endpoint supersedes them, or keep them as read-only reference.
6. **Carried-over operator items (unrelated but open).** Push the two unpushed
   commits (`c1d1eb6`, `001c7e5`) on go; fix the pre-existing
   `cuSyncSelectedBtn is not defined` `ReferenceError`; rotate the SMTP password
   that was pasted into chat earlier (rotation advised); prior checkpoint items
   (a)–(e).

---

## 6. How to operate the close-out next month (safe flow)

1. Confirm the effective toggle: **OFF unless you intend to close live**.
2. Dashboard → Settings → Integrations & Limits → **Monthly ClickUp Close-out →
   Preview**. Verify the month and the counts — only "in progress" should be > 0,
   and it should match your expectation for the month.
3. If the preview is surprising (e.g., tasks you expected closed are still
   `in progress`, or old months appear), investigate before running.
4. Enable "Allow ClickUp auto-close / close-out" + **Save**, then **Run** and
   confirm the dialog.
5. Read the summary; spot-check 2–3 tasks in ClickUp (comment shows AM + Ovi tag,
   status = Closed).
6. Turn the toggle back **off** (or set the intended resting state) so the next
   month starts dry-run again.