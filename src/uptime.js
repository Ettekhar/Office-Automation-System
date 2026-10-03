/**
 * uptime.js — HTTP HEAD check per site URL
 * Checks if a site is online by sending a HEAD request with a 7s timeout.
 */

import { URL } from 'url';

const TIMEOUT_MS = 7000;

/**
 * Check if a single URL is reachable.
 * @returns {Promise<{ status: 'online'|'offline', statusCode?: number, responseTime?: number, checkedAt: string, error?: string }>}
 */
export async function checkSite(rawUrl) {
  const checkedAt = new Date().toISOString();
  let url;
  try {
    let u = (rawUrl || '').trim();
    if (!u.startsWith('http')) u = 'https://' + u.replace(/^www\./, 'www.');
    url = new URL(u);
  } catch {
    return { status: 'offline', error: 'Invalid URL', checkedAt };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OfficeDashboard/1.0)',
        Accept: 'text/html',
      },
    });
    clearTimeout(timer);
    const responseTime = Date.now() - start;
    const code = res.status || 0;
    const online = code >= 200 && code < 500;
    return { status: online ? 'online' : 'offline', statusCode: code, responseTime, checkedAt };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err && err.name === 'AbortError';
    return { status: 'offline', error: isTimeout ? 'Timeout' : (err && err.message) || 'Request failed', checkedAt };
  }
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
