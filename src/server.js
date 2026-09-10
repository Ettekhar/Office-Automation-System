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
    // Master Dashboard API  — full CRUD, relational model
    // ═══════════════════════════════════════════════════════════
    if (pathname.startsWith('/api/master/')) {
      const db = await import('./db.js');

      // Helper: parse body, send JSON
      const body  = async () => (method === 'GET' ? {} : await parseBody(req));
      const ok    = (data) => sendJson(res, 200, data);
      const err   = (code, msg) => { sendJson(res, code, { error: msg }); };

      // ── DB Status & Stats ─────────────────────────────────────
      if (pathname === '/api/master/db-status' && method === 'GET') {
        return ok(db.getDbStats());
      }
      if (pathname === '/api/master/stats' && method === 'GET') {
        return ok(db.getDbStats());
      }

      // ── SYNC (Superadmin) ─────────────────────────────────────
      if (pathname === '/api/master/sync' && method === 'POST') {
        const isSSE = req.headers.accept?.includes('text/event-stream');
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*', Connection: 'keep-alive',
          });
          const { syncAll, onProgress } = await import('./syncFromSheets.js');
          onProgress((step, pct) => res.write(`data: ${JSON.stringify({ step, pct })}\n\n`));
          try {
            const result = await syncAll();
            res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);
          } catch (e) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); }
          return res.end();
        }
        const { syncAll } = await import('./syncFromSheets.js');
        try { return ok(await syncAll()); }
        catch (e) { return err(500, e.message); }
      }

      // ── USERS ──────────────────────────────────────────────────
      // GET /api/master/users
      if (pathname === '/api/master/users' && method === 'GET') {
        return ok({ users: db.getUsers() });
      }
      // POST /api/master/users  (superadmin)
      if (pathname === '/api/master/users' && method === 'POST') {
        const b = await body();
        if (!b.name) return err(400, 'name required');
        try { return ok({ user: db.createUser(b) }); }
        catch (e) { return err(400, e.message); }
      }
      // PUT /api/master/users/:id  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ user: db.updateUser(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/users/:id  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteUser(id);
        return ok({ success: true });
      }

      // ── SITES ──────────────────────────────────────────────────
      // GET /api/master/sites?userId=&account=
      if (pathname === '/api/master/sites' && method === 'GET') {
        const userId  = reqUrl.searchParams.get('userId');
        const account = reqUrl.searchParams.get('account');
        return ok({ sites: db.getSites({ userId, account }) });
      }
      // PUT /api/master/sites/:id  (admin+)
      if (/^\/api\/master\/sites\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ site: db.updateSite(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // POST /api/master/sites/:id/assign — assign users to a site (admin+)
      if (/^\/api\/master\/sites\/([^/]+)\/assign$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const b = await body();
        if (!Array.isArray(b.userIds)) return err(400, 'userIds array required');
        try { return ok({ site: db.assignUsersToSite(id, b.userIds) }); }
        catch (e) { return err(404, e.message); }
      }

      // ── DAILY REVIEW ───────────────────────────────────────────
      // GET /api/master/daily-review?userId=&userName=
      if (pathname === '/api/master/daily-review' && method === 'GET') {
        const userId   = reqUrl.searchParams.get('userId');
        const userName = reqUrl.searchParams.get('user') || reqUrl.searchParams.get('userName');
        return ok({ rows: db.getDailyReview({ userId, userName }) });
      }
      // GET /api/master/daily-review-all
      if (pathname === '/api/master/daily-review-all' && method === 'GET') {
        const rows = db.getDailyReview();
        // Group by userName
        const byUser = {};
        rows.forEach(r => { (byUser[r.userName] = byUser[r.userName] || []).push(r); });
        return ok(byUser);
      }
      // GET /api/master/summary — per-user completion stats
      if (pathname === '/api/master/summary' && method === 'GET') {
        const rows = db.getDailyReview();
        const users = db.getUsers();
        const summary = users.map(u => {
          const uRows = rows.filter(r => r.userId === u.id);
          const completed = uRows.filter(r => r.maintenanceStatus === 'completed').length;
          return {
            userId: u.id, user: u.name, role: u.role,
            total: uRows.length,
            completed,
            inProgress: uRows.filter(r => r.maintenanceStatus === 'in_progress').length,
            pending: uRows.filter(r => !['completed','in_progress'].includes(r.maintenanceStatus)).length,
            reportSent: uRows.filter(r => r.reportSentRaw?.toLowerCase() === 'yes').length,
            pct: uRows.length ? Math.round(completed / uRows.length * 100) : 0,
          };
        });
        return ok({ summary });
      }
      // PUT /api/master/daily-review/:id  (user: their own row)
      if (/^\/api\/master\/daily-review\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ row: db.updateDailyReviewRow(id, b) }); }
        catch (e) { return err(404, e.message); }
      }

      // ── TASKS ──────────────────────────────────────────────────
      // GET /api/master/tasks?assigneeId=&status=
      if (pathname === '/api/master/tasks' && method === 'GET') {
        const filter = {
          assigneeId: reqUrl.searchParams.get('assigneeId') || undefined,
          status:     reqUrl.searchParams.get('status') || undefined,
        };
        return ok({ tasks: db.getTasks(filter) });
      }
      // POST /api/master/tasks  (admin+)
      if (pathname === '/api/master/tasks' && method === 'POST') {
        const b = await body();
        if (!b.taskName) return err(400, 'taskName required');
        // Resolve siteId from siteUrl if provided
        if (b.siteUrl && !b.siteId) {
          const site = db.getSiteByUrl(b.siteUrl);
          b.siteId = site?.id || null;
        }
        // Resolve assigneeId from assigneeName if provided
        if (b.assigneeName && !b.assigneeId) {
          const user = db.getUserByName(b.assigneeName);
          b.assigneeId = user?.id || null;
        }
        return ok({ task: db.createTask(b) });
      }
      // PUT /api/master/tasks/:id  (admin+)
      if (/^\/api\/master\/tasks\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ task: db.updateTask(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/tasks/:id  (admin+)
      if (/^\/api\/master\/tasks\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteTask(id);
        return ok({ success: true });
      }

      // ── PROPERTIES ─────────────────────────────────────────────
      // GET /api/master/properties
      if (pathname === '/api/master/properties' && method === 'GET') {
        return ok({ properties: db.getProperties() });
      }
      // PUT /api/master/properties/:id  (superadmin)
      if (/^\/api\/master\/properties\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ property: db.updateProperty(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/properties/:id  (superadmin)
      if (/^\/api\/master\/properties\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        db.deleteProperty(pathname.split('/').pop());
        return ok({ success: true });
      }

      // ── DEV PROJECTS ───────────────────────────────────────────
      // GET /api/master/dev-projects
      if (pathname === '/api/master/dev-projects' && method === 'GET') {
        return ok({ projects: db.getDevProjects() });
      }
      // PUT /api/master/dev-projects/:id/items/:idx  (superadmin)
      if (/^\/api\/master\/dev-projects\/[^/]+\/items\/\d+$/.test(pathname) && method === 'PUT') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const itemIdx = parseInt(parts[6], 10);
        const b = await body();
        try { return ok({ project: db.updateDevProjectItem(projId, itemIdx, b) }); }
        catch (e) { return err(404, e.message); }
      }

      // ── DOMAIN EXPIRY (read from sites) ────────────────────────
      if (pathname === '/api/master/domain-expiry' && method === 'GET') {
        const sites = db.getSites().filter(s => s.domainExpiry);
        const domains = sites.map(s => ({
          siteId: s.id, url: s.url, company: s.company, account: s.account,
          accountManager: s.accountManager, contact: s.contact, cms: s.cms,
          expiryDate: s.domainExpiry, daysLeft: s.daysLeft,
          urgent: s.daysLeft !== null && s.daysLeft <= 30,
          warning: s.daysLeft !== null && s.daysLeft > 30 && s.daysLeft <= 90,
        }));
        domains.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
        return ok({ domains });
      }

      // ── UPTIME CHECK ───────────────────────────────────────────
      // POST /api/master/check-uptime  body: { siteId? } (all if omitted)
      if (pathname === '/api/master/check-uptime' && method === 'POST') {
        const b = await body();
        const { checkSite, checkSitesBatch } = await import('./uptime.js');
        const sites = db.getSites();

        if (b.siteId) {
          const site = db.getSiteById(b.siteId);
          if (!site) return err(404, 'Site not found');
          const result = await checkSite(site.url);
          const updated = db.updateSite(site.id, {
            uptimeStatus: result.status,
            uptimeStatusCode: result.statusCode,
            uptimeResponseTime: result.responseTime,
            lastUptimeCheck: result.checkedAt,
          });
          return ok({ site: updated, result });
        }

        // Check all (stream progress via SSE)
        const isSSE = req.headers.accept?.includes('text/event-stream');
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*', Connection: 'keep-alive',
          });
          let done = 0;
          await checkSitesBatch(sites.map(s => s.url), (url, result) => {
            const site = sites.find(s => s.url === url);
            if (site) {
              db.updateSite(site.id, {
                uptimeStatus: result.status,
                uptimeStatusCode: result.statusCode,
                uptimeResponseTime: result.responseTime,
                lastUptimeCheck: result.checkedAt,
              });
            }
            done++;
            res.write(`data: ${JSON.stringify({ url, result, done, total: sites.length })}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ complete: true, total: sites.length })}\n\n`);
          return res.end();
        }
        // Non-SSE: just run and return summary
        await checkSitesBatch(sites.map(s => s.url), (url, result) => {
          const site = sites.find(s => s.url === url);
          if (site) db.updateSite(site.id, { uptimeStatus: result.status, lastUptimeCheck: result.checkedAt });
        });
        const updated = db.getSites();
        return ok({ online: updated.filter(s => s.uptimeStatus === 'online').length,
          offline: updated.filter(s => s.uptimeStatus === 'offline').length });
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

