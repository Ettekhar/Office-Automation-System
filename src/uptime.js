/**
 * uptime.js — one reachability check per site URL.
 *
 * A single HEAD request is the cheap, obvious check, and it is still the first
 * thing we try — but it is not enough on its own, because real sites in this list
 * are not well-behaved:
 *
 *   - Some servers HANG on HEAD (or answer 405) and are perfectly healthy on GET.
 *   - Some list a deep path, e.g. `https://example.com/wp-admin/`, which the site
 *     guards against non-browser clients. The site is up; that one path is not
 *     answerable. Reporting the whole site as down for that is a false alarm the
 *     operator cannot act on — so we fall back to the site root and say so.
 *
 * The escalation is deliberately narrow and ordered, so an ordinary healthy site
 * still costs exactly one HEAD request:
 *   1. HEAD on the listed URL          (the common case, nothing else runs)
 *   2. GET with Range: bytes=0-0       (HEAD-hostile servers)
 *   3. GET on the site root            (guarded sub-path; result carries a note)
 *
 * Redirects are NOT followed. On Cloudflare Workers every redirect hop is a
 * separate subrequest, and the free plan caps one invocation at 50 — a batch of
 * redirect-y sites (http -> https -> www is common) could blow the cap halfway
 * through a sweep. The origin answering with a 3xx still proves it is serving,
 * so a redirect counts as online and costs exactly one subrequest.
 *
 * Anything that still fails is offline, and the error we report is from the
 * listed URL — that is the thing the operator cares about.
 */

import { URL } from 'url';

/** Per-probe ceiling. Env-tunable so tests can exercise the ladder quickly. */
const TIMEOUT_MS = Number(process.env.UPTIME_PROBE_TIMEOUT_MS || 7000);
const USER_AGENT = 'Mozilla/5.0 (compatible; OfficeDashboard/1.0)';

/**
 * Pull a usable URL out of a spreadsheet cell.
 *
 * Real cells carry junk around the URL: "Note:https://x.com/", "https://x.com
 * (main)", stray spaces, quotes or angle brackets. Feeding any of that to
 * `new URL()` fails, and the failure was reported as an OUTAGE — a note-prefixed
 * cell looked like a dead site. Extracting the first URL-looking token (and
 * trimming punctuation that often trails a pasted link) keeps the check honest.
 */
export function sanitizeUrl(raw) {
  let u = String(raw || '').trim();
  const m = u.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) u = m[0];
  return u.replace(/[),.;]+$/, '');
}

/**
 * Does this error describe the MONITOR failing rather than the site?
 *
 * These are runtime/platform strings, not origin strings. The one that matters
 * in production is the Workers free-plan cap: once an invocation has spent its
 * 50 subrequests every later fetch throws "Too many subrequests by single
 * Worker invocation", which used to be recorded as a site failure and pushed
 * healthy sites through the 2-fail hysteresis to DOWN (2026-10-19:
 * theguildhotel.com, reitzunionhotel.com, miamikdistribution.com).
 *
 * A probe that fails this way still returns a result; checkSite() marks it
 * `infra` and the sweep drops it instead of applying it (see sweepTargets in
 * uptimeMonitor.js). "fetch failed", DNS, TLS and timeout errors are NOT infra
 * — those are genuine evidence about the site.
 */
const INFRA_ERROR_RE = /too many subrequests|exceeded (?:its )?cpu time|worker exceeded|error 110[12]|network connection lost|the script will never generate a response/i;
export const isInfraError = (msg) => INFRA_ERROR_RE.test(String(msg || ''));

/**
 * One HTTP attempt. Never throws: a failure is a result, because every failure
 * here is a data point about the site rather than an error in the monitor.
 */
async function probe(target, method, { range = false, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(target, {
      method,
      signal: controller.signal,
      // One subrequest per probe, always — see the header note. A 3xx is still
      // an answer from the origin, so it counts as serving below.
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        ...(range ? { Range: 'bytes=0-0' } : {}),
      },
    });
    // Release the socket. A server that ignores Range would otherwise stream a
    // whole page into a body nobody reads.
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* already closed */ }
    return { ok: true, statusCode: res.status || 0, responseTime: Date.now() - start };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Timeout' : (err && err.message) || 'Request failed';
    return {
      ok: false,
      error: message,
      // A timeout is evidence about the site; a platform error is evidence
      // about the monitor's budget. Never conflate the two.
      infra: !(err && err.name === 'AbortError') && isInfraError(message),
      responseTime: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The existing rule, unchanged: a response below 500 means something is serving. */
const isServing = (code) => code >= 200 && code < 500;

/**
 * Did the origin answer us?
 *
 * `probe` resolves only when fetch returned a Response — network/DNS/TLS
 * failures throw and come back as `ok: false`. With `redirect: 'manual'` a
 * redirect can surface as the real 3xx (Node, Workers) or as an opaque response
 * with status 0 (spec behaviour in some runtimes), and both mean "the server is
 * there". Treating status 0 as serving is what keeps a redirect from being
 * misread as an outage.
 */
const answered = (result) => !!result.ok && (result.statusCode === 0 || isServing(result.statusCode));

/**
 * The probe never reached a verdict about the site: the runtime that made the
 * request failed. 'unknown' is not a status the hysteresis acts on — the sweep
 * drops these results (sweepTargets in uptimeMonitor.js), so a budget overrun
 * can never mark a site down.
 */
const infraResult = (p, checkedAt) => ({
  status: 'unknown', infra: true, error: p.error, checkedAt,
});

/**
 * Check if a single URL is reachable.
 * @returns {Promise<{ status: 'online'|'offline'|'unknown', infra?: boolean, statusCode?: number, responseTime?: number, checkedAt: string, error?: string, note?: string }>}
 */
export async function checkSite(rawUrl) {
  const checkedAt = new Date().toISOString();
  let url;
  try {
    let u = sanitizeUrl(rawUrl);
    if (!u.startsWith('http')) u = 'https://' + u.replace(/^www\./, 'www.');
    url = new URL(u);
  } catch {
    return { status: 'offline', error: 'Invalid URL', checkedAt };
  }

  const target = url.toString();

  // 1. HEAD — one request for the overwhelmingly common healthy case.
  let result = await probe(target, 'HEAD');
  if (result.infra) return infraResult(result, checkedAt);
  if (answered(result)) {
    return { status: 'online', statusCode: result.statusCode, responseTime: result.responseTime, checkedAt };
  }

  // 2. GET with a 1-byte range — servers that dislike HEAD.
  if (!result.ok) {
    const viaGet = await probe(target, 'GET', { range: true });
    if (viaGet.infra) return infraResult(viaGet, checkedAt);
    if (answered(viaGet)) {
      return { status: 'online', statusCode: viaGet.statusCode, responseTime: viaGet.responseTime, checkedAt };
    }
    result = viaGet;
  }

  // 3. Site root — the listed path may simply be one the site will not serve to
  //    us. Still report it as up (the operator's site IS up), but say why, so
  //    the row can explain itself instead of being silently misleading.
  const root = `${url.protocol}//${url.host}/`;
  if (root !== target) {
    const viaRoot = await probe(root, 'GET', { range: true });
    if (viaRoot.infra) return infraResult(viaRoot, checkedAt);
    if (answered(viaRoot)) {
      const reason = result.error || `HTTP ${result.statusCode}`;
      return {
        status: 'online',
        statusCode: viaRoot.statusCode,
        responseTime: viaRoot.responseTime,
        checkedAt,
        note: `${url.pathname} did not answer (${reason}); site root is up.`,
      };
    }
  }

  return {
    status: 'offline',
    statusCode: result.statusCode,
    responseTime: result.responseTime,
    error: result.error || `HTTP ${result.statusCode}`,
    checkedAt,
  };
}

/**
 * Check a batch of URLs concurrently (max 10 at a time to avoid overwhelming the network).
 * @param {string[]} urls
 * @param {(url: string, result: object) => void} onResult - called as each result comes in
 */
export async function checkSitesBatch(urls, onResult = () => {}) {
  const BATCH_SIZE = 10;
  const results = {};

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const result = await checkSite(url);
        onResult(url, result);
        return { url, result };
      })
    );
    batchResults.forEach(({ url, result }) => { results[url] = result; });
  }

  return results;
}
