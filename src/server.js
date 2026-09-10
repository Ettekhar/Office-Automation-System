import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getOverviewData,
  getSitePreview,
  generateAllPreviews,
  sendSingleEmail,
} from './dashboardApi.js';
import { invalidateCache, getCacheStatus } from './sheetsCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEFAULT_PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // API Route: Accounts Config (sender info for UI)
    if (pathname === '/api/accounts' && method === 'GET') {
      const { getAllAccountConfigs } = await import('./config.js');
      const allConfigs = getAllAccountConfigs();
      const safeAccounts = allConfigs.map((a) => ({
        key: a.key,
        name: a.name,
        fromEmail: a.fromEmail,
        fromName: a.fromName,
        smtpHost: a.smtp.host,
        smtpPort: a.smtp.port,
      }));
      sendJson(res, 200, { accounts: safeAccounts });
      return;
    }

    // API Route: Overview Data
    if (pathname === '/api/overview' && method === 'GET') {
      const month = reqUrl.searchParams.get('month') || null;
      const account = reqUrl.searchParams.get('account') || 'all';
      const data = await getOverviewData(month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Preview single site
    if (pathname === '/api/preview' && method === 'GET') {
      const websiteUrl = reqUrl.searchParams.get('websiteUrl');
      const month = reqUrl.searchParams.get('month') || null;
      const account = reqUrl.searchParams.get('account') || null;
      if (!websiteUrl) {
        sendJson(res, 400, { error: 'websiteUrl query param is required' });
        return;
      }
      const data = await getSitePreview(websiteUrl, month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Generate all previews
    if (pathname === '/api/generate-all' && method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      const month = body.month || reqUrl.searchParams.get('month') || null;
      const account = body.account || reqUrl.searchParams.get('account') || 'all';
      const data = await generateAllPreviews(month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Send single email
    if (pathname === '/api/send-single' && method === 'POST') {
      const body = await parseBody(req);
      const result = await sendSingleEmail({
        to: body.to,
        subject: body.subject,
        html: body.html,
        dryRun: Boolean(body.dryRun),
        accountKey: body.account || body.accountKey || 'CW',
      });
      sendJson(res, 200, result);
      return;
    }

    // API Route: Send batch emails
    if (pathname === '/api/send-batch' && method === 'POST') {
      const body = await parseBody(req);
      const { emails, dryRun = false } = body;
      if (!Array.isArray(emails) || emails.length === 0) {
        sendJson(res, 400, { error: 'emails array is required' });
        return;
      }

      const results = [];
      for (const item of emails) {
        try {
          const sent = await sendSingleEmail({
            to: item.to,
            subject: item.subject,
            html: item.html,
            dryRun,
            accountKey: item.account || item.accountKey || 'CW',
          });
          results.push({
            websiteUrl: item.websiteUrl,
            account: item.account || 'CW',
            success: true,
            to: item.to,
          });
        } catch (err) {
          results.push({
            websiteUrl: item.websiteUrl,
            account: item.account || 'CW',
            success: false,
            error: err.message,
          });
        }
        // Small pacing delay
        await new Promise((r) => setTimeout(r, 200));
      }

      sendJson(res, 200, { success: true, results });
      return;
    }

    // API Route: Cache status
    if (pathname === '/api/cache/status' && method === 'GET') {
      sendJson(res, 200, getCacheStatus());
      return;
    }

    // API Route: Invalidate cache (force fresh fetch from Sheets on next request)
    if (pathname === '/api/cache/invalidate' && method === 'POST') {
      invalidateCache();
      sendJson(res, 200, { success: true, message: 'Cache cleared. Next request will fetch fresh data from Google Sheets.' });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Master Dashboard API routes  (/api/master/*)
    // All reads → local JSON (data/*.json), no Sheets API on reads.
    // POST /api/master/sync → triggers full import from all 6 sheets.
    // ═══════════════════════════════════════════════════════════
    if (pathname.startsWith('/api/master/')) {
      const db = await import('./db.js');
      const {
        DAILY_REVIEW_USERS,
        getDailyReviewForUser,
        getDailyReviewSummary,
        getAllDailyReview,
        getDomainExpiry,
        getDistributionSheet,
        getPropertyRegistry,
        getDevTrackerData,
        getMaintenanceOverview,
        getDashboardStats,
      } = await import('./masterApi.js');

      // ── GET /api/master/db-status ─────────────────────────────
      if (pathname === '/api/master/db-status' && method === 'GET') {
        sendJson(res, 200, db.getDbStats());
        return;
      }

      // ── POST /api/master/sync — full import from all 6 sheets ─
      if (pathname === '/api/master/sync' && method === 'POST') {
        // Stream progress via SSE if requested, otherwise plain JSON
        const isSSE = req.headers.accept?.includes('text/event-stream');
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            Connection: 'keep-alive',
          });
          const { syncAll, onProgress } = await import('./syncFromSheets.js');
          onProgress((step, pct) => res.write(`data: ${JSON.stringify({ step, pct })}\n\n`));
          try {
            const result = await syncAll();
            res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);
          } catch (err) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          }
          res.end();
        } else {
          const { syncAll } = await import('./syncFromSheets.js');
          try {
            const result = await syncAll();
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 500, { error: err.message });
          }
        }
        return;
      }

      // ── GET /api/master/stats ─────────────────────────────────
      if (pathname === '/api/master/stats' && method === 'GET') {
        sendJson(res, 200, getDashboardStats());
        return;
      }

      // ── GET /api/master/users ─────────────────────────────────
      if (pathname === '/api/master/users' && method === 'GET') {
        sendJson(res, 200, { users: DAILY_REVIEW_USERS });
        return;
      }

      // ── GET /api/master/daily-review?user=X ──────────────────
      if (pathname === '/api/master/daily-review' && method === 'GET') {
        const user = reqUrl.searchParams.get('user');
        if (!user) { sendJson(res, 400, { error: 'user param required' }); return; }
        sendJson(res, 200, { user, sites: getDailyReviewForUser(user) });
        return;
      }

      // ── GET /api/master/daily-review-all ─────────────────────
      if (pathname === '/api/master/daily-review-all' && method === 'GET') {
        sendJson(res, 200, getAllDailyReview());
        return;
      }

      // ── GET /api/master/summary ───────────────────────────────
      if (pathname === '/api/master/summary' && method === 'GET') {
        sendJson(res, 200, { summary: getDailyReviewSummary() });
        return;
      }

      // ── POST /api/master/update-row — update a daily review row locally ──
      if (pathname === '/api/master/update-row' && method === 'POST') {
        const body = await parseBody(req);
        const { user, url, updates } = body;
        if (!user || !url || !updates) {
          sendJson(res, 400, { error: 'user, url, updates required' });
          return;
        }
        try {
          const updated = db.updateDailyReviewRow(user, url, updates);
          sendJson(res, 200, { success: true, row: updated });
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      // ── GET /api/master/domain-expiry ─────────────────────────
      if (pathname === '/api/master/domain-expiry' && method === 'GET') {
        sendJson(res, 200, { domains: getDomainExpiry() });
        return;
      }

      // ── GET /api/master/distribution ──────────────────────────
      if (pathname === '/api/master/distribution' && method === 'GET') {
        const { tasks, taskLoad } = getDistributionSheet();
        sendJson(res, 200, { tasks, taskLoad });
        return;
      }

      // ── GET /api/master/dev-tracker ───────────────────────────
      if (pathname === '/api/master/dev-tracker' && method === 'GET') {
        sendJson(res, 200, { projects: getDevTrackerData() });
        return;
      }

      // ── GET /api/master/properties ────────────────────────────
      if (pathname === '/api/master/properties' && method === 'GET') {
        sendJson(res, 200, { properties: getPropertyRegistry() });
        return;
      }

      // ── POST /api/master/update-property ─────────────────────
      if (pathname === '/api/master/update-property' && method === 'POST') {
        const body = await parseBody(req);
        const { url, updates } = body;
        if (!url || !updates) { sendJson(res, 400, { error: 'url, updates required' }); return; }
        try {
          const updated = db.updateProperty(url, updates);
          sendJson(res, 200, { success: true, property: updated });
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      // ── GET /api/master/maintenance-overview ──────────────────
      if (pathname === '/api/master/maintenance-overview' && method === 'GET') {
        sendJson(res, 200, { sites: getMaintenanceOverview() });
        return;
      }

      // ── POST /api/master/update-site ──────────────────────────
      if (pathname === '/api/master/update-site' && method === 'POST') {
        const body = await parseBody(req);
        const { url, updates } = body;
        if (!url || !updates) { sendJson(res, 400, { error: 'url, updates required' }); return; }
        try {
          const updated = db.updateSite(url, updates);
          sendJson(res, 200, { success: true, site: updated });
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      sendJson(res, 404, { error: 'Master API route not found' });
      return;
    }



    // Static Files
    let filePath = path.join(PUBLIC_DIR,
      pathname === '/'        ? 'index.html'  :
      pathname === '/master'  ? 'master.html' :
      pathname
    );
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    serveStatic(res, filePath);
  } catch (err) {
    console.error('Server error on', pathname, ':', err);
    sendJson(res, 500, { error: err.message });
  }
});

function startServer(port, maxTries = 5) {
  server.listen(port, () => {
    console.log(`\n🚀 Maintenance Mailer Dashboard is running!`);
    console.log(`👉 Open in browser: http://localhost:${port}`);
    console.log(`Press Ctrl+C to stop.\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxTries > 0) {
      console.warn(`Port ${port} is currently in use. Trying port ${port + 1}...`);
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
      startServer(port + 1, maxTries - 1);
    } else {
      console.error('Server failed to start:', err);
      process.exit(1);
    }
  });
}

startServer(DEFAULT_PORT);

