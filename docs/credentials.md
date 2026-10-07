# Credential handling

Two rules, enforced by tooling rather than discipline:

| | rule | enforced by |
|---|---|---|
| **git** | no credential is ever recorded | `.gitignore` + `scratch/verify-no-credentials.mjs` on every commit |
| **deploy** | credentials come from Cloudflare's secret store | `wrangler secret put` + `scratch/verify-deploy-secrets.mjs` |

The repo is **public**.

---

## Never commit

`.env`, `service-account.json`, `.dev.vars` and the live `data/` files
(`audit-log`, `rag-index`, `sheet-credentials`, `email-conditional-notes`, …)
are gitignored. `.gitignore` is only a guard against paths someone anticipated,
so `verify-no-credentials.mjs` also checks the **staged content** — which is what
a commit actually records — for:

1. the **literal live value** of anything in `.env` or `service-account.json`
   (exact match, so it cannot miss);
2. **credential shapes**: PEM keys, service-account JSON, Gemini/Groq/
   OpenRouter/ClickUp keys, Slack webhooks, npm and GitHub tokens, JWTs, tokens
   in URLs, SMTP password literals;
3. **credential filenames**, even when staged with `git add -f`.

Findings report file, line and *kind* — never the value. A scanner that leaks
what it found is a second copy of the leak.

```bash
npm run test:secrets              # scan the staged set
npm run test:secrets:mutation     # prove it can actually block (13 probes)
```

### Install the hook

```bash
npm run hooks:install
```

This sets `core.hooksPath=.githooks` and then **verifies the gate blocks** a
planted credential. `core.hooksPath` is local and not committed, so **each clone
needs this once** — that is why the hook script lives in `.githooks/` where it
is version-controlled, with a signpost in `.git/hooks/`.

Emergency bypass: `git commit --no-verify`.

---

## Deploy

`wrangler deploy` sends only the config. Secrets live server-side in
Cloudflare's store and are never in the repo:

```bash
npx wrangler secret put ADMIN_TOKEN --config cloudflare-worker/dashboard-wrangler.toml
```

Current state, verified by `npm run test:deploy:secrets`:

| Worker | secrets set |
|---|---|
| `officeos-dashboard` | `ADMIN_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON` |
| `officeos-mailer` | `ADMIN_TOKEN`, `RELAY_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON` |

Wrangler authenticates with the **OAuth login**, so no `CLOUDFLARE_API_TOKEN`
is needed — and none is present in `.env`. Deploy works from a fresh clone with
no credential in the repo at all.

`verify-deploy-secrets.mjs` also asserts no credential is embedded in any
wrangler toml, that required secrets are set (by name), and that both Workers
still **fail closed** — public health answers 200, a protected route answers 401.

---

## Three bugs this tooling caught in itself

Worth recording, because each would have made a gate that *looked* fine:

1. **The scanner read zero secrets.** `.env` on Windows has CRLF line endings,
   and in JS `$` does not match before a trailing `\r` — so the parse silently
   yielded nothing and the scanner reported "nothing found" while checking
   nothing. It collected 5 values instead of 12.
2. **Three shape patterns matched nothing real.** Checked against the actual
   keys in `.env`, the first list caught **none** of them. Provider key shapes
   were then added from measured prefix + length.
3. **The hook self-test committed to the live branch.** The installer ran a real
   `git commit`; it created a commit on `main` that then had to be reset out
   again. It now uses `sh <hook>` — the exact code path git uses — which cannot
   create a commit. (`git commit --dry-run` is *not* a substitute: it skips
   pre-commit entirely, so it reported a working gate as broken.)

The mutation harness exists because of #1 and #2: `npm run
test:secrets:mutation` plants each class of leak and asserts each is blocked,
**and** asserts clean source is *not* blocked — a gate that cries wolf gets
bypassed, and then protects nothing.

---

## Still open

`data/*.json` and `src/` contain **pre-existing** sheet-id and client-data
exposure, already pushed in 10+ commits. A commit cannot undo that; it needs a
history rewrite, which is the operator's decision. `npm run test:dashboard`
prints the full list on every run.