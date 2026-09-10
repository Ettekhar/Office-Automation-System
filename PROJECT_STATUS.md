# PROJECT STATUS — Maintenance Report Mailer

**Purpose of this file:** context for any AI/agent picking this project up cold.
It explains what this project does, why it's built the way it is, exactly what
each file does, what's been tested vs. not, and what's still open. Read this
before touching the code.

Last updated: 2026-08-29 (by Claude, in a chat session with the project owner).

---

## 1. What this project does

The client runs a Google Sheet (`Website List` tab) tracking monthly WordPress
maintenance across ~70 client websites. This project automates step 2 of
their workflow: **after maintenance is marked done for a site, email that
site's report to the client contact automatically.**

Flow:
1. Read the `Website List` tab. It has one row per website with a Status
   column (Active/Deactive), a Contact column (client emails), a Website URL
   column, and one column per month (April, May, June, ... appended over time)
   marked `"Updated & Backup"` once that month's maintenance is done.
2. The **same spreadsheet** also has one tab per website, named exactly like
   the site's URL (e.g. a tab literally titled `themenhaden.com` or
   `https://www.thewentworth.com/`). That tab holds the actual report content
   — a small table with sections "Plugin Updated", "Other" (backup date),
   "Deactivated", "Additional Issue Fixed" — see the screenshots referenced in
   chat history for the exact shape (columns A–D only; columns F onward on
   that tab hold unrelated internal tracking like Domain Expiry/GA4/GTM/GSC —
   those are deliberately NOT included in the email).
3. For every row where Status = Active **and** the relevant month column says
   "Updated & Backup": find that site's per-URL tab, pull its A1:D200 grid,
   drop it verbatim into a fixed email template, and send it via SMTP to the
   row's contact email(s).

### Important business rule: report month = PREVIOUS month
Maintenance for July gets marked done in the sheet, then the report goes out
in August. So when the script runs in August, it:
- Checks the **July** column (not August) for the "Updated & Backup" marker
- Uses "july-2026" (lowercase month + year) in the subject line, not the
  month the script is actually running in

This was a specific correction from the client mid-build — the very first
version of this script checked the *current* month's column, which was wrong.
See `getReportMonthInfo()` in `src/reportUtils.js` — it always computes
`new Date(year, month - 1, 1)` off the run date. **Do not "fix" this back to
current-month logic without re-confirming with the client.**

### Exact email format (locked, confirmed by client — do not improvise wording)

Subject:
```
Website Maintenance Report for {website_url} ({month_lowercase}-{year})
```
e.g. `Website Maintenance Report for themenhaden.com (july-2026)`

Body (fixed boilerplate; only the table and website URL/date are dynamic):
```
Hi,

Maintenance Actions:
Plugin Updates: We updated all plugins to their latest versions to improve security, fix bugs and ensure optimal performance.

[full A1:D grid from that site's report tab, rendered as an actual HTML table — NOT an image, NOT summarized]

Additional Issues Fixed: Along with the scheduled maintenance, we resolved additional issues identified on the website.

Functionality Checks: We performed a quality assurance check to verify that all key website functions are working correctly.
Responsiveness: Tested the website's layout on various devices (Desktop, Tablet, Mobile – Android & iOS).
Forms: Confirmed that all contact forms and other forms are fully operational.

Everything is running smoothly. We'll continue to monitor your site for optimal performance.

Best Regards,
{FROM_NAME}
```
This is implemented in `buildEmail()` in `src/mailer.js`. A rendered visual
preview was generated during the build and confirmed to match the client's
sample email exactly (subject + boilerplate + real HTML table in the middle).

---

## 2. Current status

- ✅ Core logic (month math, active/done filtering, URL→tab matching, contact
  parsing, HTML table building) — **unit-tested with sample data shaped like
  the real sheet**, all passed. Test scripts were written ad hoc during the
  build and then deleted (not part of the shipped project — see "Testing"
  below for how to redo this if needed).
- ✅ Syntax-checked all files with `node --check`.
- ✅ Rendered a full email to an image (`wkhtmltoimage`) and visually confirmed
  it matches the client's provided sample email format exactly.
- ❌ **Never run against the real Google Sheet or real SMTP server.** The
  build sandbox's network is locked to package registries only (no Google
  APIs, no arbitrary SMTP) — this has ONLY been tested with synthetic/mock
  data. The client needs to run `npm run dry-run` themselves first and verify
  output before ever using `--send`.
- ❌ No automated test suite ships with the project (tests were throwaway
  scripts during development, deleted after use, not committed).
- ❌ Client has not yet confirmed: (a) that a service account has been created
  and shared on the real sheet, (b) real SMTP credentials, (c) that every
  per-site tab is actually named to exactly match its Website URL column
  (this was inferred from two screenshots showing tabs named
  `https://thewentworthrestaurants.com/` and `https://ocalaflevents.com` — not
  verified across all ~70 rows).

## 3. Known open questions / risks (flag to client if relevant)

1. **Tab-naming consistency**: `findMatchingTab()` in `reportUtils.js` does
   exact match first, then a loose substring fallback. If per-site tabs are
   inconsistently named (typos, missing `https://`, trailing slash mismatches,
   or simply don't exist for some sites), those rows get skipped and logged —
   never guessed. The client should check the dry-run's
   "Skipped (no matching report tab)" count on first run.
2. **Multiple contacts per row**: `Contact` column sometimes has 1–2 comma
   separated emails (confirmed from the real sheet data pasted in chat). All
   are added to the `To:` field. Not currently CC/BCC split by role.
3. **`Company` column is currently unused** in the email (dropped when the
   subject format was locked to use Website URL instead of Company name).
   It's still read in `COLS.COMPANY` but not referenced anywhere in
   `mailer.js` anymore — safe to ignore or remove later.
4. **No dedupe/send-log**: nothing currently records "this row was already
   emailed for July" — if the script is run twice in August, it will email
   the same set of rows twice. Not yet requested by the client, but worth
   flagging before this goes on an automated cron (`vercel.json` currently
   schedules it monthly, which is a reasonable mitigant, but a manual re-run
   in between would double-send). A cheap fix would be writing a
   "Report Sent" marker back to the sheet — **not implemented**, would need
   `spreadsheets.readonly` scope upgraded to write access if requested.
5. **Cloudflare Workers**: client asked about Cloudflare specifically (wants
   it for a CV/portfolio angle). Current code uses `nodemailer` over raw SMTP,
   which **does not run on Cloudflare Workers** (no persistent TCP sockets).
   `README.md` documents this and suggests swapping `src/mailer.js` to an
   HTTP email API (Resend/MailChannels) if the client wants a Cloudflare
   version — **not built yet**, only documented as a future option.

## 4. File-by-file breakdown

```
maintenance-mailer/
├── package.json          Dependencies: googleapis, google-auth-library,
│                          nodemailer, dotenv. ES modules ("type": "module").
│                          Scripts: `npm run dry-run` (default, safe),
│                          `npm run send` (adds --send flag).
│
├── .env.example           Template for required config. Copy to `.env`.
│                          Documents every var inline. See src/config.js for
│                          how these are consumed/validated.
│
├── .gitignore              Excludes node_modules, .env, service-account.json,
│                          .vercel — so secrets never get committed.
│
├── README.md               Human-facing setup guide: how to create a Google
│                          service account, share the sheet with it, get SMTP
│                          creds (incl. Gmail App Password note), install/run
│                          locally, and deploy to Vercel (with the Cloudflare
│                          SMTP limitation called out).
│
├── vercel.json              Vercel Cron config — hits /api/send-reports?send=1
│                          on the 28th of each month at 9am UTC. Adjust the
│                          cron string if the client wants a different day.
│
├── src/
│   ├── config.js            Loads .env via dotenv. Exports:
│   │                        - `config` object (spreadsheetId, masterTabName,
│   │                          SMTP settings, fromEmail/fromName, bcc,
│   │                          maxEmailsPerRun). Throws at import time if a
│   │                          required var is missing (except
│   │                          serviceAccountKeyPath, which is optional when
│   │                          GOOGLE_SERVICE_ACCOUNT_KEY_JSON is set instead
│   │                          — the Vercel path).
│   │                        - `COLS` — zero-based column index map for the
│   │                          master tab (STATUS=0, CMS=1, COMPANY=2,
│   │                          CONTACT=3, AM=4, NOTE=5, WEBSITE_URL=6,
│   │                          CLICKUP_URL=7, REPORT_URL=8, BACKUP_URL=9,
│   │                          FIRST_MONTH_COL=10). Update these if the sheet's
│   │                          column order ever changes.
│   │                        - `DONE_MARKER` = 'updated & backup' (lowercase,
│   │                          matched via `.includes()`, so "Updated &
│   │                          Backup" and similar all match).
│   │
│   ├── sheets.js             Google Sheets API wrapper (read-only scope).
│   │                        - `getSheetsClient()` — JWT auth via service
│   │                          account. Reads key from
│   │                          `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` env var
│   │                          (full JSON string, used on Vercel) OR falls
│   │                          back to reading a file at
│   │                          `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (local dev).
│   │                        - `listTabTitles()` — returns every tab name in
│   │                          the spreadsheet (used to find per-site tabs).
│   │                        - `getTabValues(tabName, range)` — raw 2D array
│   │                          of a tab's cell values (FORMATTED_VALUE render
│   │                          option, so dates/numbers come back as displayed
│   │                          strings, not raw serials).
│   │
│   ├── reportUtils.js         Pure logic, no I/O — the easiest file to unit
│   │                        test in isolation. Exports:
│   │                        - `normalizeUrl(url)` — strips protocol/www/
│   │                          trailing slash for comparing URLs.
│   │                        - `findMatchingTab(tabTitles, websiteUrl,
│   │                          masterTabName)` — exact match first, then
│   │                          substring fallback. Returns null if nothing
│   │                          matches (caller must handle — never guesses).
│   │                        - `getMonthColumnIndex(headerRow, firstMonthCol,
│   │                          monthName)` — finds which column index a given
│   │                          month name lives at in the header row.
│   │                        - `getReportMonthInfo(date = new Date())` —
│   │                          **the previous-month logic**. Returns
│   │                          `{ monthName, monthLower, year }` for the month
│   │                          BEFORE the given date's month. This is what
│   │                          drives both the sheet-column lookup and the
│   │                          subject line date.
│   │                        - `isActive(statusCell)` / `isMarkedDone(cell,
│   │                          marker)` — string-safe boolean checks (both
│   │                          coerce with `String(x ?? '')` after a real bug
│   │                          was hit where numeric cells crashed `.trim()`
│   │                          — keep that coercion, don't simplify it away).
│   │                        - `parseContacts(contactCell)` — splits on comma
│   │                          or semicolon, trims, filters to things that
│   │                          look like emails via regex.
│   │                        - `rowsToHtmlTable(rows)` — the "copy the
│   │                          spreadsheet, not a screenshot" requirement.
│   │                          Filters fully-empty rows, escapes HTML, returns
│   │                          an inline-styled `<table>` string ready to drop
│   │                          into an email body.
│   │
│   ├── mailer.js               nodemailer wrapper.
│   │                        - `buildEmail({ websiteUrl, reportMonth,
│   │                          reportHtml })` — the LOCKED template (section
│   │                          1 above). Do not change wording without client
│   │                          sign-off; this was iterated to match their
│   │                          exact sample email.
│   │                        - `sendReportEmail({ to, subject, html, dryRun })`
│   │                          — if `dryRun` is true, does NOT send — instead
│   │                          writes a full HTML preview file to
│   │                          `dry-run-previews/{sanitized-subject}.html`
│   │                          (gitignored) and logs its path, so the client
│   │                          can open it in a browser and see exactly what
│   │                          would be sent, including the real report table.
│   │                          If false, actually sends via SMTP, with
│   │                          optional BCC from config.
│   │
│   └── index.js                 CLI entry point — `node src/index.js` (dry
│                              run by default) or `node src/index.js --send`.
│                              Orchestration order:
│                              1. Compute `reportMonth` via
│                                 `getReportMonthInfo()` once at module load.
│                              2. Fetch tab titles + master tab rows in
│                                 parallel.
│                              3. Find the target month's column index; bail
│                                 with a clear error if that column doesn't
│                                 exist yet in the sheet.
│                              4. Loop every data row: skip blanks, skip
│                                 inactive, skip not-done-this-month, skip
│                                 no-contact, skip no-matching-tab (each with
│                                 a counted + logged reason) — then pull that
│                                 site's report tab, build the email, send (or
│                                 dry-run-log), with a 300ms sleep between
│                                 sends to be gentle on API rate limits.
│                              5. Print a summary (sent/skipped-by-reason/
│                                 errors) at the end. Respects
│                                 `MAX_EMAILS_PER_RUN` as a safety cap.
│
└── api/
    └── send-reports.js          Vercel serverless function version of the
                                same logic as src/index.js, as an HTTP
                                endpoint instead of a CLI script, for use with
                                vercel.json's cron. Differences from
                                src/index.js:
                                - Auth via `?secret=` query param or
                                  `x-cron-secret` header, checked against
                                  `CRON_SECRET` env var — unauthenticated
                                  requests get 401. **This must be set in
                                  Vercel env vars before deploying**, or the
                                  endpoint is wide open (it sends real client
                                  emails).
                                - `?send=1` query param instead of a CLI flag
                                  to leave dry-run mode.
                                - Returns JSON (`{ mode, reportMonth, sent,
                                  skipped, errors }`) instead of console logs,
                                  for programmatic/cron-log inspection.
                                - Uses the same imports from `../src/*` — this
                                  file has NO independent logic, it's a thin
                                  HTTP wrapper. Keep it in sync with
                                  src/index.js if the core logic changes.
```

## 5. How to pick this up and continue

1. Read `.env.example` and `README.md` first — they're the human-facing setup
   docs and won't be duplicated here.
2. If asked to change the email wording/format: **confirm with the client
   first**, it was explicitly locked down after iteration (see section 1).
3. If asked to change which month is checked/reported: re-read section 1's
   "previous month" explanation carefully before touching
   `getReportMonthInfo()` — this was a deliberate correction, not the
   original design.
4. If extending to write back to the sheet (e.g. a "Report Sent" marker per
   section 3, risk #4): the current service account only has
   `spreadsheets.readonly` scope in `src/sheets.js` — you'd need to add the
   write scope and re-share/re-auth.
5. Before any change that touches `mailer.js` or `reportUtils.js`, it's worth
   recreating a quick throwaway test script (see the git history / chat log
   for the pattern used: mock header + rows shaped like the real sheet, call
   the functions directly, `console.log` the output — no live Google/SMTP
   connection needed for this kind of check). Delete the test script after,
   as was done here — it's not meant to be a permanent test suite.
6. Real end-to-end validation (real sheet + real SMTP) has never happened.
   Do not assume it works beyond the logic level until the client reports
   back from a real `npm run dry-run`.
