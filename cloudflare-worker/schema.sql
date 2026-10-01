-- ═══════════════════════════════════════════════════════════════════════════
-- officeos-mailer  —  D1 schema
--
-- One row per site per run. That single table is the answer to every question
-- the operator asks after a send:
--
--   who got mail          status='sent'            + message_id
--   who did not           status='failed'/'skipped' + error / skip_reason
--   what message          subject + html           (the exact bytes sent)
--   who sent ClickUp      clickup_status + clickup_detail
--
-- Nothing here is ever updated in place except the lifecycle columns
-- (status/claimed_at/finished_at). The full rendered email is written once,
-- when it is known, and never rewritten — so the ledger is an append-shaped
-- record rather than a mutable view.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  account       TEXT,                    -- 'CW' | 'RM' | 'both'
  month         TEXT,                    -- e.g. 'September'
  dry_run       INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT,                    -- 'api' | 'cron' | 'local'
  stats         TEXT                     -- JSON summary, frozen at close
);

CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs (id),
  seq             INTEGER NOT NULL,       -- original sheet order
  account         TEXT NOT NULL,
  account_name    TEXT,
  website_url     TEXT NOT NULL,
  matched_tab     TEXT,
  -- Nullable on purpose. A queued job always has recipients, but a site skipped
  -- before the contact column was ever read genuinely has none, and NOT NULL
  -- would make that row unrecordable — which is exactly the row the operator
  -- most wants to see. Where recipients WERE resolved and the site was skipped
  -- later (no report tab), they are stored, so the report can say who would have
  -- been emailed.
  recipients      TEXT,                   -- JSON array
  month           TEXT,
  month_lower     TEXT,
  year            TEXT,
  time_track_url  TEXT,
  account_manager TEXT,

  status          TEXT NOT NULL DEFAULT 'pending',
                  -- pending  queued, not yet claimed by any agent
                  -- claimed  an agent is working on it
                  -- sent     SMTP accepted it (message_id recorded)
                  -- failed   SMTP or rendering threw
                  -- skipped  never attempted; skip_reason says why
  skip_reason     TEXT,
  message_id      TEXT,
  error           TEXT,

  clickup_status  TEXT,                  -- sent | skipped | dry-run | failed | none
                  -- 'dry-run' is kept distinct from 'sent' on purpose:
                  -- completeClickUpMaintenanceTask returns without changing
                  -- anything when CLICKUP_AUTO_CLOSE_ENABLED is off, and
                  -- recording that as "sent" would be a false tick in the
                  -- report that exists to say who did NOT get theirs.
  clickup_detail  TEXT,                  -- JSON: taskId, status, commentId, reason

  subject         TEXT,
  html            TEXT,                  -- the exact body handed to SMTP

  queued_at       TEXT NOT NULL,
  claimed_at      TEXT,
  claimed_by      TEXT,
  finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_run    ON jobs (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_site   ON jobs (account, website_url);

-- Append-only transition log. If a job's final row is ever wrong, this is the
-- history that says what happened and in which order.
CREATE TABLE IF NOT EXISTS events (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  run_id  TEXT,
  job_id  TEXT,
  kind    TEXT NOT NULL,                 -- run.created, job.queued, job.claimed,
                                         -- job.sent, job.failed, job.skipped,
                                         -- clickup.sent, clickup.skipped, ...
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, at);
CREATE INDEX IF NOT EXISTS idx_events_job ON events (job_id, at);

-- Conditional notes mirrored from the local database so the Worker-side report
-- can explain *why* a paragraph was added to an email without calling home.
CREATE TABLE IF NOT EXISTS conditional_notes (
  id        TEXT PRIMARY KEY,
  account   TEXT NOT NULL,
  condition TEXT NOT NULL,
  message   TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (account, condition)
);