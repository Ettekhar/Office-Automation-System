/**
 * dataQuality.js - read-only data-quality checks over the daily-review records.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first detector for "a value was copied into the wrong column" was
 * "same string appears in 2+ site-fact fields". It fired on 44 of 184 records
 * and was worthless: ga4=No / cloudflare=No / clientResponse=No are three
 * DIFFERENT questions that legitimately share the answer "No".
 *
 * The pattern that actually means something is narrower - one email address
 * sitting in BOTH the Newsletter and Form Submission columns, which ask
 * different things ("where does the newsletter go?" vs "where do form
 * submissions land?"). Measured 2026-09-26 that is 7 records on 4 sites.
 *
 * WHY IT MATTERS NOW
 * ------------------
 * Site facts are inherited on assignment (db.collectInheritedSiteFacts), so a
 * mistaken value is copied rather than re-derived. The second job of this
 * module is therefore to keep re-checking the SAFETY INVARIANT, not just the
 * smell: for every site carrying a duplicated address, is there still an ACTIVE
 * holder who could donate it?
 *
 *   - active donor present   -> the risk is LIVE. A future assignee inherits it.
 *   - inactive-only donors   -> the risk is DORMANT and rule 2 of the
 *                               inheritance filters currently blocks it. If
 *                               that user is ever reactivated, this check is
 *                               what will notice, because nothing else will.
 *
 * duneclimbinn.com is the dormant case as of 2026-09-26: its only holder of
 * info@duneclimbinn.com is inactive.
 *
 * NOTHING HERE WRITES. Not the database, not the sheets, not a file. These are
 * observations to surface, and a smell must never block a legitimate sync.
 */

const MAIL_FIELDS = ['newsletterMail', 'formSubmissionMail'];
const ALL_FACT_FIELDS = [
  'ga4', 'newsletterMail', 'formSubmissionMail', 'bookingLink',
  'clientResponse', 'cloudflare', 'uptimeRobot',
];

// Deliberately conservative: one @, no whitespace, a dot in the domain.
// Anything more permissive starts matching prose.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const isEmail = (v) => EMAIL.test(String(v || '').trim());

/**
 * Records where one address occupies more than one of the two "where does mail
 * go" columns. "N/A" in both is NOT reported: a site can genuinely have neither,
 * and flagging it would be the same false-alarm mistake as the old detector.
 */
export function findDuplicatedMailAddresses(drRows) {
  const out = [];
  for (const r of drRows || []) {
    if (!r || typeof r !== 'object') continue;   // tolerate holes in imported data
    const values = MAIL_FIELDS.map((f) => [f, String(r[f] || '').trim()]);
    const present = values.filter(([, v]) => v);
    if (present.length < MAIL_FIELDS.length) continue;
    const distinct = new Set(present.map(([, v]) => v));
    if (distinct.size !== 1) continue;
    const value = present[0][1];
    if (!isEmail(value)) continue;               // N/A and friends are fine
    out.push({
      recordId: r.id,
      userId: r.userId,
      userName: r.userName,
      siteId: r.siteId,
      value,
      fields: present.map(([f]) => f),
    });
  }
  return out;
}

/**
 * An address in 3+ site-fact fields is a stronger smell than 2, because at
 * least one of those columns cannot want it. Reported separately so the
 * severity is visible rather than averaged away.
 */
export function findAddressSpreadAcrossFields(drRows) {
  const out = [];
  for (const r of drRows || []) {
    if (!r || typeof r !== 'object') continue;
    const hits = ALL_FACT_FIELDS
      .map((f) => [f, String(r[f] || '').trim()])
      .filter(([, v]) => isEmail(v));
    const counts = new Map();
    for (const [, v] of hits) counts.set(v, (counts.get(v) || 0) + 1);
    for (const [value, n] of counts) {
      if (n < 3) continue;
      out.push({
        recordId: r.id, userName: r.userName, siteId: r.siteId, value, fields: n,
      });
    }
  }
  return out;
}

/**
 * For each site carrying a duplicated address, decide whether the value could
 * actually reach a future assignee today.
 *
 * This is the standing version of the question that was previously answered by
 * hand once. A site is only safe-by-default if EVERY holder of the value is
 * inactive, because collectInheritedSiteFacts() refuses inactive donors.
 */
export function assessDuplicatedAddressRisk(drRows, sites, usersById) {
  const dupes = findDuplicatedMailAddresses(drRows);
  const bySite = new Map();
  for (const d of dupes) {
    if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
    bySite.get(d.siteId).push(d);
  }

  const siteUrl = new Map((sites || []).map((s) => [s.id, s.url]));
  const out = [];
  for (const [siteId, recs] of bySite) {
    const value = recs[0].value;
    const holders = recs.map((r) => ({
      userName: r.userName,
      active: usersById[r.userId]?.active !== false,
    }));
    const activeHolders = holders.filter((h) => h.active);

    // A pending assignment is the thing that would actually fire the copy.
    //
    // "Pending" must be judged against EVERY record for the site, not just the
    // records that happen to carry the duplicated address. A user who already
    // has a row for this site - even one whose Newsletter and Form Submission
    // cells are empty - will NOT be given a new record, so the value cannot
    // reach them. Judging it against `recs` alone counted those users as
    // pending and produced a false "would reach" for sites where nothing would.
    const site = (sites || []).find((s) => s.id === siteId);
    const existingUserIds = new Set(
      (drRows || []).filter((r) => r && r.siteId === siteId).map((r) => r.userId),
    );
    const pending = (site?.assignedUsers || [])
      .filter((uid) => usersById[uid] && usersById[uid].active !== false && !existingUserIds.has(uid))
      .map((uid) => usersById[uid].name);

    out.push({
      siteId,
      siteUrl: siteUrl.get(siteId) || '(unknown site)',
      value,
      holders,
      // LIVE means an active holder exists. DORMANT means every holder is
      // inactive, so the inheritance filters block it for now.
      status: activeHolders.length ? 'live' : 'dormant',
      activeHolders: activeHolders.map((h) => h.userName),
      dormantBecause:
        activeHolders.length
          ? null
          : `every holder is inactive (${holders.map((h) => h.userName).join(', ')}), so collectInheritedSiteFacts() refuses them as donors`,
      pendingAssignees: pending,
      wouldReachPendingAssignee: pending.length > 0 && activeHolders.length > 0,
    });
  }
  return out;
}

/**
 * The full check, as one report object. Safe to call with partial or empty
 * input - it reports what it can and never throws on missing data, because a
 * data-quality smell must not be able to break a sync.
 */
export function runDataQualityChecks(drRows, sites, usersById) {
  try {
    const rows = Array.isArray(drRows) ? drRows : [];
    const risk = assessDuplicatedAddressRisk(rows, sites || [], usersById || {});
    const spread = findAddressSpreadAcrossFields(rows);
    return {
      ok: true,
      duplicatedMailAddresses: risk,
      liveRiskCount: risk.filter((r) => r.status === 'live').length,
      dormantRiskCount: risk.filter((r) => r.status === 'dormant').length,
      wouldReachPendingAssignee: risk.filter((r) => r.wouldReachPendingAssignee).map((r) => r.siteUrl),
      addressSpreadAcrossFields: spread,
      // One-line summary an operator can read without scrolling.
      summary:
        risk.length === 0
          ? 'no duplicated mail addresses'
          : `${risk.length} site(s) with a duplicated mail address: ` +
            `${risk.filter((r) => r.status === 'live').length} live, ` +
            `${risk.filter((r) => r.status === 'dormant').length} dormant (all holders inactive)`,
    };
  } catch (e) {
    // Never propagate. A broken check is a missing warning, which is strictly
    // better than a failed sync.
    return { ok: false, error: String(e && e.message || e), summary: 'data-quality check failed (non-fatal)' };
  }
}

/**
 * Render the report for the sync log. Advisory only - these are observations,
 * and a value that looks wrong is a question for a human, not a reason to
 * refuse to sync.
 */
export function formatDataQualityReport(dq) {
  if (!dq || dq.ok === false) return `[sync] data-quality check skipped: ${dq && dq.error}`;
  if (!dq.duplicatedMailAddresses.length) return `[sync] data-quality: ${dq.summary}`;

  const lines = [`[sync] data-quality: ${dq.summary}`];
  for (const r of dq.duplicatedMailAddresses) {
    lines.push(
      `[sync]   ${r.siteUrl}  "${r.value}"  in ${r.holders.map((h) => h.userName + (h.active ? '' : ' (inactive)')).join(' + ')}`,
    );
    lines.push(
      r.status === 'live'
        ? `[sync]     -> LIVE: ${r.activeHolders.join(', ')} could donate this to a new assignee`
        : `[sync]     -> DORMANT: ${r.dormantBecause}`,
    );
    if (r.pendingAssignees.length) {
      lines.push(
        r.wouldReachPendingAssignee
          ? `[sync]     -> would reach a pending assignee: ${r.pendingAssignees.join(', ')}`
          : `[sync]     -> pending assignee(s) ${r.pendingAssignees.join(', ')} NOT affected while every holder stays inactive`,
      );
    }
  }
  for (const s of dq.addressSpreadAcrossFields) {
    lines.push(`[sync]   ${s.userName}: "${s.value}" fills ${s.fields} columns - likely a stray paste`);
  }
  return lines.join('\n');
}
