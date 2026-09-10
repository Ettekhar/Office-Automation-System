# Maintenance Report Mailer

Reads your "Website List" Google Sheet, finds every **Active** site marked
**"Updated & Backup"** for the current month, pulls that site's own report tab
(the per-site tabs like `thewentworthrestaurants.com` shown in your
screenshot), and emails the report to that site's contact(s).

**Safety default:** every run is a **dry run** unless you explicitly pass
`--send`. Dry runs print exactly what *would* be sent — no email leaves your
SMTP server until you confirm and add `--send`.

---

## 1. Google Sheets API access (service account)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create
   a project (or reuse one).
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service Account**.
   Give it any name (e.g. `maintenance-mailer`). No special roles needed.
4. Open the new service account → **Keys → Add Key → Create new key → JSON**.
   This downloads a `.json` file — save it as `service-account.json` in this
   project folder (it's already in `.gitignore`, so it won't get committed).
5. Copy the service account's email address (looks like
   `maintenance-mailer@your-project.iam.gserviceaccount.com`).
6. Open your Google Sheet → **Share** → paste that email in → give it
   **Viewer** access. That's it — no OAuth login flow needed, and it never
   expires on its own.

## 2. SMTP (sending from your own email)

Get these four values from whoever manages your email (Google Workspace,
cPanel, Outlook, etc.):

- SMTP host (e.g. `smtp.gmail.com` or `mail.yourdomain.com`)
- SMTP port (usually `587`)
- Username (usually your full email address)
- Password — **for Gmail/Workspace you must use an
  [App Password](https://myaccount.google.com/apppasswords)**, not your normal
  login password (requires 2FA to be enabled first).

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:
- `SPREADSHEET_ID` — already pre-filled with the ID from your sheet URL.
- `MASTER_TAB_NAME` — the tab with the Active/Deactive table (default
  `Website List`, matches your screenshot).
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` — path to the JSON file from step 1.
- `SMTP_*`, `FROM_EMAIL`, `FROM_NAME` — from step 2.
- `BCC_EMAIL` (optional) — set this to your own address to get a copy of
  every email sent, for your records.
- `MAX_EMAILS_PER_RUN` (optional) — set to e.g. `3` the first few times you
  test with `--send`, so you don't accidentally blast the whole client list.

## 4. Install & run locally

```bash
npm install

# 1. Dry run first — always. Prints who it WOULD email, no sending.
npm run dry-run

# 2. When the dry-run output looks right, actually send:
npm run send
```

Read the summary at the end of each run — it tells you how many rows were
skipped and why (inactive, not marked done this month, no contact email, or
no matching report tab found), so you can spot data issues in the sheet
before anything gets sent.

### If a site gets skipped with "no matching report tab"

This script finds each site's report by looking for a **tab whose name
matches the Website URL** (exactly like your screenshot: a tab literally
named `https://thewentworthrestaurants.com/`). If a row is active and marked
done but has no such tab, it's skipped and logged — nothing is guessed or
sent blank. Rename/add the tab to match the URL and re-run.

---

## 5. Deploying later

**Vercel (recommended, works out of the box with SMTP):**
1. Push this folder to a GitHub repo, import it in Vercel.
2. In Vercel → Project → Settings → Environment Variables, add everything
   from your `.env`, **except** `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` — instead
   add `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` and paste the *entire contents* of
   `service-account.json` as the value (Vercel has no file uploads for env
   vars). The code already checks for this automatically.
3. Add a `CRON_SECRET` env var (any random string) — this protects
   `/api/send-reports` from being triggered by randoms on the internet.
4. `vercel.json` is already set up to run automatically on the 28th of each
   month at 9am UTC via Vercel Cron. Adjust the cron schedule to taste.
5. Trigger manually any time:
   `https://your-app.vercel.app/api/send-reports?secret=YOUR_CRON_SECRET`
   (dry run) or add `&send=1` to actually send.

**Cloudflare Workers — one real limitation to know about:** Workers can't
open a raw SMTP/TCP connection the way `nodemailer` does here, so this exact
SMTP setup won't run on Cloudflare as-is. If you want Cloudflare specifically
(e.g. for the CV/portfolio angle), the fix is straightforward: swap
`src/mailer.js` to call an HTTP email API instead of SMTP — e.g.
[Resend](https://resend.com) or [MailChannels](https://mailchannels.com),
both of which are simple `fetch()` calls and work great in Workers. Everything
else (Sheets reading, matching, HTML building) stays identical. Happy to build
that variant too if you want both versions for your portfolio.

---

## Project structure

```
src/
  config.js        - env vars + column mapping for the sheet
  sheets.js         - Google Sheets API client (service account auth)
  reportUtils.js    - matching/parsing logic (status, month, tab lookup, HTML table)
  mailer.js         - SMTP sending via nodemailer
  index.js          - CLI entry point (local / cron use)
api/
  send-reports.js   - same logic as an HTTP endpoint, for Vercel Cron
vercel.json          - monthly cron schedule
```
