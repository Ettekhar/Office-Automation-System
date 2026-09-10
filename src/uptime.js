/**
 * uptime.js — HTTP HEAD check per site URL
 * Checks if a site is online by sending a HEAD request with a 7s timeout.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const TIMEOUT_MS = 7000;

/**
 * Check if a single URL is reachable.
 * @returns {{ status: 'online'|'offline', statusCode?: number, responseTime?: number, checkedAt: string, error?: string }}
 */
export function checkSite(rawUrl) {
  return new Promise((resolve) => {
    const checkedAt = new Date().toISOString();
    let url;
    try {
      // Normalise URL
      let u = rawUrl.trim();
      if (!u.startsWith('http')) u = 'https://' + u.replace(/^www\./, 'www.');
      url = new URL(u);
    } catch {
      return resolve({ status: 'offline', error: 'Invalid URL', checkedAt });
    }

    const start = Date.now();
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname || '/',
        method: 'HEAD',
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OfficeDashboard/1.0)',
          Accept: 'text/html',
        },
        rejectUnauthorized: false, // tolerate self-signed certs
      },
      (res) => {
        req.destroy();
        const responseTime = Date.now() - start;
        const code = res.statusCode || 0;
        // 2xx, 3xx = online; 4xx some are also "online" (page exists)
        const online = code >= 200 && code < 500;
        resolve({ status: online ? 'online' : 'offline', statusCode: code, responseTime, checkedAt });
      }
    );

    req.on('timeout', () => { req.destroy(); resolve({ status: 'offline', error: 'Timeout', checkedAt }); });
    req.on('error', (err) => resolve({ status: 'offline', error: err.message, checkedAt }));
    req.end();
  });
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
