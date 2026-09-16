import 'dotenv/config'; // ensure .env (AI provider keys, worker URL/token) is loaded for ALL routes
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
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

/**
 * Discovered-schema text for the Dev Assistant's data source.
 *
 * The assistant answers from the sheet(s) selected in AI Settings. New columns
 * and whole new tabs appear in those spreadsheets by hand, so before answering
 * we hand the model the auto-discovered layout of that source (tabSchema.js +
 * sheetSchema.js) as SECTION 5 of the RAG context. Discovery is cached (memory +
 * data/sheet-schema.json), so this is normally free.
 *
 * Never throws: any failure simply means "no SECTION 5" and the answer proceeds
 * with the same context as before.
 */
async function assistantSchemaText(config) {
  try {
    // Start with the configured source (the one the assistant is pointed at).
    const src = config?.source || {};
    let sheets = [];
    if (src.spreadsheetId) {
      const { getOrDiscoverSheetSchema } = await import('./sheetSchema.js');
      const schema = await getOrDiscoverSheetSchema(src.spreadsheetId, {
        tabs: Array.isArray(src.tabs) && src.tabs.length ? src.tabs : undefined,
        maxTabs: 14,
      });
      if (schema) sheets.push(schema);
    }
    // Also describe every other connected spreadsheet (CW, RM, dev tracker,
    // any credential-added sheet) so the chatbot can see columns across ALL
    // sheets the project reads — not just the single source. This is what
    // makes the dynamic-column guarantee cover every sheet, not one.
    if (!sheets.length) {
      const { getSchemaRegistry } = await import('./sheetSchema.js');
      const registry = await getSchemaRegistry({ refresh: false, maxTabs: 14 });
      sheets = registry.sheets;
    }
    const { describeSchemaForAssistant } = await import('./sheetSchema.js');
    return describeSchemaForAssistant(sheets, { maxTabs: 14, maxSheets: 8 });
  } catch (e) {
    console.warn('[sheet-schema] Could not build schema text for the assistant:', e.message);
    return '';
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
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

      // ── MONTHS ──────────────────────────────────────────────
      // GET /api/master/months — returns all month columns detected from CW sheet + active month
      if (pathname === '/api/master/months' && method === 'GET') {
        const activeMonth = db.getActiveMonth();
        // Try to fetch live month columns from the CW sheet header row
        let sheetMonths = [];
        try {
          const { getTabValues } = await import('./sheets.js');
          const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
          const rows = await getTabValues('Website List', 'A2:ZZ2', CW_ID);
          const headers = rows?.[0] || [];
          // Month columns: anything that looks like a month name (with optional year) after first 9 fixed columns
          sheetMonths = headers
            .filter((h, i) => i >= 9 && h && /[a-zA-Z]/.test(h) && /[a-zA-Z]+(\.?\s*\d{0,4})?/.test(h.trim()))
            .map(h => h.trim())
            .filter(Boolean);
        } catch (e) {
          console.warn('[months API] Could not fetch sheet columns:', e.message);
        }
        // Merge with db months (in case sheet fetch failed)
        const dbMonths = db.getAllMonths();
        const allSet = new Set([...sheetMonths, ...dbMonths]);
        // Remove very short or purely numeric entries
        const allMonths = Array.from(allSet).filter(m => m.length >= 3 && /[a-zA-Z]/.test(m));
        return ok({ activeMonth, months: allMonths, sheetMonths, dbMonths });
      }

      // POST /api/master/months/select — set active month (no sheet column creation)
      if (pathname === '/api/master/months/select' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const meta = db.getMeta();
        db.setMeta({ ...meta, activeMonth: b.monthName.trim() });
        return ok({ success: true, activeMonth: b.monthName.trim() });
      }

      // POST /api/master/add-month — create new column in CW & RM sheets + set as active
      if (pathname === '/api/master/add-month' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const { appendMonthColumn } = await import('./sheets.js');
        const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const RM_ID = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';
        try {
          const [cw, rm] = await Promise.all([
            appendMonthColumn(CW_ID, 'Website List', b.monthName),
            appendMonthColumn(RM_ID, 'Website List', b.monthName),
          ]);
          const result = db.addNewMonth(b.monthName);
          return ok({ success: true, cw, rm, ...result });
        } catch (e) { return err(500, e.message); }
      }

      // POST /api/master/cleanup-empty-columns — remove rogue columns after the last meaningful month.
      // Finds the rightmost non-empty header, then deletes everything that comes after it.
      // This fixes both truly-blank columns AND inherited-header rogue columns.
      if (pathname === '/api/master/cleanup-empty-columns' && method === 'POST') {
        const { getSheetsClient } = await import('./sheets.js');
        const { invalidateCache } = await import('./sheetsCache.js');
        const b = await parseBody(req).catch(() => ({}));
        const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const RM_ID = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';
        // Optional: caller can pass { keepMonth: "September 26" } to delete everything after that specific month
        const keepMonth = (b.keepMonth || '').trim().toLowerCase();

        async function cleanupSheet(spreadsheetId, tabName) {
          const sheets = await getSheetsClient();
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const sheetObj = meta.data.sheets.find((s) => s.properties.title === tabName);
          if (!sheetObj) return { error: `Tab "${tabName}" not found` };
          const sheetId = sheetObj.properties.sheetId;

          const headerRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${tabName}'!A2:ZZ2`,
          });
          const headers = headerRes.data.values?.[0] || [];

          // If a specific month was requested, delete everything after it
          let keepUpToIdx = -1;
          if (keepMonth) {
            for (let i = headers.length - 1; i >= 0; i--) {
              if ((headers[i] || '').trim().toLowerCase() === keepMonth) { keepUpToIdx = i; break; }
            }
          }
          // Otherwise find the rightmost non-empty header
          if (keepUpToIdx === -1) {
            for (let i = headers.length - 1; i >= 0; i--) {
              if ((headers[i] || '').trim() !== '') { keepUpToIdx = i; break; }
            }
          }

          const deleteFrom = keepUpToIdx + 1;
          const totalCols = headers.length;
          if (deleteFrom >= totalCols) return { deletedCount: 0, message: 'No rogue columns found', keptMonth: headers[keepUpToIdx] };

          const count = totalCols - deleteFrom;
          console.log(`[cleanup] Deleting ${count} col(s) after index ${keepUpToIdx} ("${headers[keepUpToIdx]}") in ${spreadsheetId}`);
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [{
                deleteDimension: {
                  range: { sheetId, dimension: 'COLUMNS', startIndex: deleteFrom, endIndex: totalCols },
                },
              }],
            },
          });
          invalidateCache();
          return { deletedCount: count, keptMonth: headers[keepUpToIdx], deletedRange: `cols ${deleteFrom}–${totalCols - 1}` };
        }

        try {
          const [cw, rm] = await Promise.all([
            cleanupSheet(CW_ID, 'Website List'),
            cleanupSheet(RM_ID, 'Website List'),
          ]);
          return ok({ success: true, cw, rm });
        } catch (e) { return err(500, e.message); }
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
      // POST /api/master/sites  (admin+)
      if (pathname === '/api/master/sites' && method === 'POST') {
        const b = await body();
        try {
          const site = db.addSite(b);
          // Two-way sync: append to respected Google Sheet (CW or RM)
          import('./sheets.js').then(({ appendNewSiteToSheet }) => {
            appendNewSiteToSheet({
              account: site.account,
              siteUrl: site.url,
              company: site.company,
              cms: site.cms,
              accountManager: site.accountManager,
              status: site.status,
              note: site.note,
            }).catch(err => console.warn('[sheet append new site error]:', err.message));
          }).catch(() => {});

          return ok({ site });
        } catch (e) {
          return err(400, e.message);
        }
      }
      // PUT /api/master/sites/:id/status (admin+)
      if (/^\/api\/master\/sites\/([^/]+)\/status$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/')[4];
        const b = await body();
        try {
          const site = db.toggleSiteStatus(id, b.status);
          // Two-way sync: update Column A in respected Google Sheet
          import('./sheets.js').then(({ updateSiteStatusInSheet }) => {
            updateSiteStatusInSheet({
              account: site.account,
              siteUrl: site.url,
              status: site.status,
            }).catch(err => console.warn('[sheet update site status error]:', err.message));
          }).catch(() => {});

          return ok({ site });
        } catch (e) {
          return err(404, e.message);
        }
      }
      // PUT /api/master/sites/:id  (admin+)
      if (/^\/api\/master\/sites\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try {
          let site = db.updateSite(id, b);
          if (Array.isArray(b.assignedUsers)) {
            site = db.assignUsersToSite(id, b.assignedUsers);
          }
          if (b.status) {
            import('./sheets.js').then(({ updateSiteStatusInSheet }) => {
              updateSiteStatusInSheet({
                account: site.account,
                siteUrl: site.url,
                status: site.status,
              }).catch(err => console.warn('[sheet update site status error]:', err.message));
            }).catch(() => {});
          }
          if (b.latestMonthStatus) {
            import('./sheets.js').then(({ syncSiteStatusToSheet }) => {
              syncSiteStatusToSheet({
                account: site.account || 'CW',
                siteUrl: site.url,
                month: site.latestMonth || db.getActiveMonth(),
                status: b.latestMonthStatus,
              }).catch(err => console.warn('[sheet-sync error]:', err.message));
            }).catch(() => {});
          }
          return ok({ site });
        }
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

      // ── MONTHS & TWO-WAY SHEETS SYNC ───────────────────────────
      // GET /api/master/months
      if (pathname === '/api/master/months' && method === 'GET') {
        return ok({
          activeMonth: db.getActiveMonth(),
          months: db.getAllMonths(),
        });
      }
      // POST /api/master/add-month (Superadmin/Admin)
      if (pathname === '/api/master/add-month' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const monthName = b.monthName.trim();
        const { appendMonthColumn } = await import('./sheets.js');

        const cwId = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const rmId = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';

        let cwResult = null, rmResult = null, cwErr = null, rmErr = null;
        try {
          cwResult = await appendMonthColumn(cwId, 'Website List', monthName);
        } catch (e) {
          cwErr = e.message;
          console.error('[add-month CW error]:', e.message);
        }
        try {
          rmResult = await appendMonthColumn(rmId, 'Website List', monthName);
        } catch (e) {
          rmErr = e.message;
          console.error('[add-month RM error]:', e.message);
        }

        const dbRes = db.addNewMonth(monthName);
        return ok({
          success: true,
          monthName,
          cw: cwResult || { error: cwErr },
          rm: rmResult || { error: rmErr },
          db: dbRes,
        });
      }
      // POST /api/master/sync-status (Explicit manual or programmatic sync to sheet)
      if (pathname === '/api/master/sync-status' && method === 'POST') {
        const b = await body();
        if (!b.siteUrl) return err(400, 'siteUrl required');
        const { syncSiteStatusToSheet } = await import('./sheets.js');
        try {
          const res = await syncSiteStatusToSheet({
            account: b.account || 'CW',
            siteUrl: b.siteUrl,
            month: b.month || db.getActiveMonth(),
            status: b.status,
          });
          return ok(res);
        } catch (e) {
          return err(500, e.message);
        }
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
        const users = db.getUsers().filter(u => u.active !== false);
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
        try {
          const updatedRow = db.updateDailyReviewRow(id, b);
          // If status changed, sync to Google Sheet in background
          if (b.maintenanceStatus || b.maintenanceRaw) {
            import('./sheets.js').then(({ syncSiteStatusToSheet }) => {
              const statusVal = b.maintenanceRaw || b.maintenanceStatus;
              syncSiteStatusToSheet({
                account: updatedRow.company || 'CW',
                siteUrl: updatedRow.siteUrl,
                month: db.getActiveMonth(),
                status: statusVal,
              }).catch(err => console.warn('[sheet-sync background error]:', err.message));
            }).catch(() => {});
          }
          return ok({ row: updatedRow });
        }
        catch (e) { return err(404, e.message); }
      }
      // POST /api/master/daily-review/batch (batch update multiple rows)
      if (pathname === '/api/master/daily-review/batch' && method === 'POST') {
        const b = await body();
        if (!Array.isArray(b.ids) || !b.ids.length) return err(400, 'ids array required');
        const rows = db.updateDailyReviewBatch(b.ids, b.updates || {});
        // If maintenance status was updated in batch, sync each to sheet
        if (b.updates?.maintenanceStatus || b.updates?.maintenanceRaw) {
          import('./sheets.js').then(async ({ syncSiteStatusToSheet }) => {
            const statusVal = b.updates.maintenanceRaw || b.updates.maintenanceStatus;
            const activeM = db.getActiveMonth();
            for (const r of rows) {
              await syncSiteStatusToSheet({
                account: r.company || 'CW',
                siteUrl: r.siteUrl,
                month: activeM,
                status: statusVal,
              }).catch(() => {});
            }
          }).catch(() => {});
        }
        return ok({ rows, count: rows.length });
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

      // ── DEV PROJECTS (Two-way Live Sync with Google Sheets) ─────
      // GET /api/master/dev-projects
      if (pathname === '/api/master/dev-projects' && method === 'GET') {
        let projs = db.getDevProjects();
        if (!projs.length || reqUrl.searchParams.get('fresh') === 'true') {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            projs = await fetchDevTrackerSheetData();
            db.setDevProjects(projs);
          } catch (e) {
            console.warn('[dev-projects] Live fetch fallback:', e.message);
          }
        }
        // Column layout of the tracker sheet, read from the schema registry
        // (cache only — no Google call on this path). Lets the UI render a
        // tab's real columns, including any added by hand, without hardcoding.
        let schema = null;
        try {
          const [{ getSheetSchema }, { DEV_TRACKER_SPREADSHEET_ID }] = await Promise.all([
            import('./sheetSchema.js'),
            import('./sheets.js'),
          ]);
          schema = getSheetSchema(DEV_TRACKER_SPREADSHEET_ID);
        } catch { /* schema is optional context for the UI */ }
        return ok({ projects: projs, schema });
      }

      // POST /api/master/dev-projects/fetch-live (Explicit refresh directly from Google Sheets)
      if (pathname === '/api/master/dev-projects/fetch-live' && method === 'POST') {
        try {
          const { fetchDevTrackerSheetData } = await import('./sheets.js');
          const projs = await fetchDevTrackerSheetData();
          db.setDevProjects(projs);
          return ok({ success: true, count: projs.length, projects: projs });
        } catch (e) {
          return err(500, `Failed to fetch from Google Sheets: ${e.message}`);
        }
      }

      // ── DEV ASSISTANT (Chatbot over Dev Tracker data) ───────────
      // GET /api/master/dev-assistant — overview snapshot + suggested questions
      if (pathname === '/api/master/dev-assistant' && method === 'GET') {
        const config = db.getAssistantConfig();
        let projs = db.getDevProjects();
        if (!projs.length) {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const live = await fetchDevTrackerSheetData();
            if (live?.length) { projs = live; db.setDevProjects(projs); }
          } catch (e) {
            console.warn('[dev-assistant] Live fetch fallback:', e.message);
          }
        }
        const { getAssistantMeta } = await import('./devAssistant.js');
        const meta = getAssistantMeta(projs, process.env, config);
        // Auto-discovered column layout of the configured source sheet → passed
        // to the client so the chat UI can show what columns the assistant can
        // see (including hand-added ones). Discovery is cached, so this is
        // normally free; ?refresh=1 on the GET re-reads from Google.
        const schemaText = await assistantSchemaText(config);
        // Columns the sheets actually carry (auto-discovered, including hand-added
        // ones) — surfaced so the assistant UI can show what it can answer from.
        const { discoverExtraColumns } = await import('./devAssistant.js');
        // Provider names / chain details are superadmin-only. Everyone else gets
        // the overview plus a plain "AI on/off" flag — no keys, no provider list.
        const role = reqUrl.searchParams.get('role') || '';
        // Broad RAG: also fetch all-sheets summary so the frontend boot can
        // show which sheets the assistant is connected to (SECTION 6 sources).
        let allSheetsMeta = null;
        try {
          const { fetchAllSheetsSummary } = await import('./sheets.js');
          allSheetsMeta = await fetchAllSheetsSummary();
        } catch (e) {
          console.warn('[dev-assistant] Boot all-sheets fetch failed:', e.message);
        }
        if (role !== 'superadmin') {
          return ok({
            engine: meta.aiAvailable ? 'llm' : 'builtin',
            aiAvailable: meta.aiAvailable,
            overview: meta.overview,
            suggestions: meta.suggestions,
            schemaText,
            detectedColumns: discoverExtraColumns(projs),
            allSheets: allSheetsMeta,
          });
        }
        return ok({ ...meta, schemaText, detectedColumns: discoverExtraColumns(projs), allSheets: allSheetsMeta });
      }

      // POST /api/master/dev-assistant { question, fresh? } — ask the assistant
        if (pathname === '/api/master/dev-assistant' && method === 'POST') {
        const b = await body();
        const q = String(b.question || '').trim();
        if (!q) return err(400, 'question required');
        const config = db.getAssistantConfig();
        let projs = db.getDevProjects();
        let schemaRefreshed = false;
        if (b.fresh === true || config.source.freshOnAsk === true) {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const live = await fetchDevTrackerSheetData();
            if (live?.length) { projs = live; db.setDevProjects(projs); }
            // When project data is pulled live from the sheet, the column layout
            // may have changed too (a new column was added by hand). Re-discover
            // the schema for ALL connected sheets so SECTION 5 reflects the
            // current layout of every sheet, not a stale cache entry that
            // predates the new column.
            const { getSchemaRegistry } = await import('./sheetSchema.js');
            await getSchemaRegistry({ refresh: true, maxTabs: 14 });
            schemaRefreshed = true;
          } catch (e) {
            console.warn('[dev-assistant] Fresh fetch failed, using cached data:', e.message);
          }
        }
        const { answerDevQuestion } = await import('./devAssistant.js');
        const role = String(b.role || reqUrl.searchParams.get('role') || '');
        // Auto-discovered column layout of the source sheet(s) → SECTION 5, so
        // the assistant knows about columns/tabs added by hand after this code
        // was written. Cheap: cached in memory + data/sheet-schema.json.
        const schemaText = await assistantSchemaText(config);

        // Broad RAG: also fetch a compact summary from ALL connected sheets
        // (CW Maintenance, RM Maintenance, Daily Review, Property Registry, etc.)
        // so the assistant can reason across every sheet the project reads, not
        // just the Dev Tracker.  This is a separate data block passed to the LLM
        // as SECTION 6 — it does NOT replace the existing dev-projects flow.
        let allSheetsSummary = null;
        try {
          const { fetchAllSheetsSummary } = await import('./sheets.js');
          allSheetsSummary = await fetchAllSheetsSummary();
        } catch (e) {
          console.warn('[dev-assistant] All-sheets fetch failed:', e.message);
        }

        return ok(await answerDevQuestion(q, projs, {
          config, schemaText, debug: role === 'superadmin',
          allSheets: allSheetsSummary,
        }));
      }

// ─ SHEET SCHEMA (auto-discovered columns & tabs) ───────────
      // GET /api/master/sheet-schema — every spreadsheet the app reads, with the
      // columns of each tab exactly as discovered from that tab's header row.
      // `?refresh=1` re-reads from Google; `?tabs=A,B` limits the walk.
      if (pathname === '/api/master/sheet-schema' && method === 'GET') {
        const { getSchemaRegistry, summarizeSchema } = await import('./sheetSchema.js');
        const refresh = reqUrl.searchParams.get('refresh') === '1';
        const tabs = (reqUrl.searchParams.get('tabs') || '').split(',').map((t) => t.trim()).filter(Boolean);
        try {
          const registry = await getSchemaRegistry({ refresh, tabs });
          return ok({ ...summarizeSchema(registry.sheets), updatedAt: registry.updatedAt, errors: registry.errors });
        } catch (e) {
          return err(500, `Schema discovery failed: ${e.message}`);
        }
      }

      // POST /api/master/sheet-schema/refresh — force a fresh discovery.
      // Body: { spreadsheetId?, tabs?, maxTabs?, sampleRows? } (no id = all sheets)
      if (pathname === '/api/master/sheet-schema/refresh' && method === 'POST') {
        const b = await body();
        const { refreshSheetSchema, getSchemaRegistry, summarizeSchema } = await import('./sheetSchema.js');
        try {
          if (b.spreadsheetId) {
            const one = await refreshSheetSchema(String(b.spreadsheetId).trim(), {
              tabs: Array.isArray(b.tabs) ? b.tabs : undefined,
              maxTabs: b.maxTabs,
              sampleRows: b.sampleRows,
            });
            return ok({ success: true, ...summarizeSchema([one]) });
          }
          const registry = await getSchemaRegistry({ refresh: true, tabs: Array.isArray(b.tabs) ? b.tabs : undefined, maxTabs: b.maxTabs });
          return ok({ success: true, ...summarizeSchema(registry.sheets), errors: registry.errors });
        } catch (e) {
          return err(500, `Schema refresh failed: ${e.message}`);
        }
      }

// ── DEV ASSISTANT SETTINGS (superadmin only) ────────────────
      // GET /api/master/assistant-config — provider cards (keys MASKED), live
      // chain status, selectable Google Sheet sources, RAG settings.
      if (pathname === '/api/master/assistant-config' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const { resolveProviderSettings, PROVIDER_DEFAULT_ORDER, PROVIDER_DEFAULTS } = await import('./devAssistant.js');
        const config = db.getAssistantConfig();
        const settings = resolveProviderSettings(process.env, config);
        // Keys are masked here — a raw token never leaves the server.
        const providers = settings.map((s) => {
          const envKey = String(process.env[s.keyEnv] || '');
          const dbKey = String(config.providers?.[s.name]?.apiKey || '');
          return {
            name: s.name,
            label: config.providers?.[s.name]?.label || s.name,
            kind: s.kind,
            keyEnv: s.keyEnv,
            enabled: s.enabled,
            configured: s.configured,
            skipReason: s.skipReason || '',
            baseUrl: s.base,
            defaultBaseUrl: PROVIDER_DEFAULTS[s.name]?.base || '',
            defaultModels: PROVIDER_DEFAULTS[s.name]?.models || [],
            models: s.models,
            modelsOverride: config.providers?.[s.name]?.models || '',
            hasKey: Boolean(s.apiKey),
            keySource: dbKey ? 'dashboard' : envKey ? 'env' : 'none',
            keyMasked: s.apiKey ? db.maskSecret(s.apiKey) : '',
            envKeyPresent: Boolean(envKey),
          };
        });
        const sheetOptions = db.getSheetCredentials().map((c) => ({
          id: c.id,
          title: c.title || c.key || c.id,
          spreadsheetId: c.spreadsheetId,
          tabName: c.tabName || '',
          active: c.active !== false,
          isSystem: c.isSystem === true,
          category: c.category || '',
        }));
        const liveNames = settings.filter((s) => s.configured).map((s) => s.name);
        // What the assistant can actually see right now: the hand-added columns
        // of the current snapshot, plus (when already discovered) the stored
        // column layout of the selected source. No Google call is made here —
        // the UI can POST /api/master/sheet-schema/refresh to re-read.
        const { discoverExtraColumns } = await import('./devAssistant.js');
        const snapshotProjects = db.getDevProjects();
        return ok({
          providers,
          order: config.order,
          providerOrderOptions: PROVIDER_DEFAULT_ORDER,
          source: config.source,
          rag: config.rag,
          sheetOptions,
          detectedColumns: discoverExtraColumns(snapshotProjects),
          updatedAt: config.updatedAt,
          aiAvailable: liveNames.length > 0,
          engine: liveNames.length ? `llm:${liveNames.join('→')}` : 'builtin',
        });
      }
// PUT /api/master/assistant-config — save provider keys / source / RAG settings
      if (pathname === '/api/master/assistant-config' && method === 'PUT') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const patch = {};
        const cleanedIgnored = [];
        if (b.providers && typeof b.providers === 'object') {
          patch.providers = {};
          for (const [name, val] of Object.entries(b.providers)) {
            if (!val || typeof val !== 'object') continue;
            const clean = {};
            if ('enabled' in val) clean.enabled = val.enabled !== false;
            if ('baseUrl' in val) clean.baseUrl = String(val.baseUrl || '').trim();
            if ('models' in val) clean.models = String(val.models || '').trim();
            // A key is only written when a REAL value is sent. Two guards:
            //  - a masked preview (contains '•' or '…') means "leave as is"
            //  - provider tokens are long; anything under 16 chars is a mask,
            //    a typo, or a truncated paste, so it is rejected outright.
            // An empty string is honoured as an explicit "clear this key".
            if ('apiKey' in val) {
              const k = String(val.apiKey || '').trim();
              const looksMasked = k.includes('•') || k.includes('…') || k.includes('\uFFFD');
              if (k === '') clean.apiKey = '';
              else if (looksMasked) cleanedIgnored.push(`${name}: masked value sent back — key left unchanged`);
              else if (k.length < 16) cleanedIgnored.push(`${name}: key looks truncated (${k.length} chars) — ignored`);
              else clean.apiKey = k;
            }
            patch.providers[name] = clean;
          }
        }
        if (Array.isArray(b.order)) patch.order = b.order.filter((n) => typeof n === 'string');
        if (b.source && typeof b.source === 'object') {
          patch.source = {
            credentialId: String(b.source.credentialId || '').trim(),
            spreadsheetId: String(b.source.spreadsheetId || '').trim(),
            tabs: Array.isArray(b.source.tabs) ? b.source.tabs.map((t) => String(t).trim()).filter(Boolean) : [],
            freshOnAsk: b.source.freshOnAsk === true,
          };
        }
        if (b.rag && typeof b.rag === 'object') {
          patch.rag = {};
          if ('strictGrounding' in b.rag) patch.rag.strictGrounding = b.rag.strictGrounding !== false;
          if ('verifyNumbers' in b.rag) patch.rag.verifyNumbers = b.rag.verifyNumbers !== false;
          if ('includePageUrls' in b.rag) patch.rag.includePageUrls = b.rag.includePageUrls !== false;
          if ('evidenceLimit' in b.rag) patch.rag.evidenceLimit = Math.max(0, Math.min(60, Number(b.rag.evidenceLimit) || 0));
          if ('contextChars' in b.rag) patch.rag.contextChars = Math.max(2000, Math.min(60000, Number(b.rag.contextChars) || 0));
        }
        try {
          const saved = db.setAssistantConfig(patch);
          return ok({ success: true, updatedAt: saved.updatedAt, source: saved.source, rag: saved.rag, ignored: cleanedIgnored });
        } catch (e) { return err(400, e.message); }
      }
// POST /api/master/assistant-config/test — live-test one provider or all
      if (pathname === '/api/master/assistant-config/test' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const { testProvider, resolveProviderSettings } = await import('./devAssistant.js');
        const config = db.getAssistantConfig();
        // Allow testing a key the superadmin just typed but has not saved yet.
        if (b.draft && typeof b.draft === 'object') {
          for (const [name, val] of Object.entries(b.draft)) {
            if (!val || typeof val !== 'object') continue;
            const merged = { ...(config.providers[name] || {}), ...val };
            const k = String(merged.apiKey || '');
            if (k.includes('•') || k.includes('…')) merged.apiKey = config.providers?.[name]?.apiKey || '';
            config.providers[name] = merged;
          }
        }
        if (b.all === true) {
          const names = resolveProviderSettings(process.env, config).map((s) => s.name);
          const results = [];
          for (const n of names) results.push(await testProvider(n, process.env, config));
          return ok({ success: true, results });
        }
        const name = String(b.provider || '').trim();
        if (!name) return err(400, 'provider required');
        const result = await testProvider(name, process.env, config);
        return ok({ success: result.ok === true, result });
      }

      // POST /api/master/assistant-config/test-source — verify the selected Google
      // Sheet is reachable and report how many rows the assistant would see.
      if (pathname === '/api/master/assistant-config/test-source' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const config = db.getAssistantConfig();
        const spreadsheetId = String(b.spreadsheetId || config.source.spreadsheetId || '').trim();
        const wantedTabs = Array.isArray(b.tabs) && b.tabs.length
          ? b.tabs.map((t) => String(t).trim()).filter(Boolean) : [];
        try {
          const { listTabTitles, getTabValues } = await import('./sheets.js');
          const tabs = await listTabTitles(spreadsheetId);
          const target = wantedTabs.length ? tabs.filter((t) => wantedTabs.includes(t)) : tabs;
          let rows = 0;
          const perTab = [];
          for (const tab of target) {
            try {
              const values = await getTabValues(tab, 'A1:E500', spreadsheetId);
              const n = Math.max(0, (values?.length || 0) - 1);
              rows += n;
              perTab.push({ tab, rows: n });
            } catch (e) {
              perTab.push({ tab, rows: 0, error: e.message });
            }
          }
          return ok({
            success: true,
            spreadsheetId,
            allTabs: tabs,
            tabsUsed: wantedTabs.length ? wantedTabs : ['(all tabs)'],
            perTab,
            totalRows: rows,
          });
        } catch (e) {
          return err(500, `Sheet unreachable: ${e.message}`);
        }
      }


      // PUT /api/master/dev-projects/:id/items/:idx (Update item + live write to Google Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/items\/\d+$/.test(pathname) && method === 'PUT') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const itemIdx = parseInt(parts[6], 10);
        const b = await body();
        try {
          const { project, item } = db.updateDevProjectItem(projId, itemIdx, b);

          // Real-time live write to Google Sheet
          let sheetResult = null;
          try {
            const { updateDevTrackerRowInSheet } = await import('./sheets.js');
            if (project?.project && item?.rowNum) {
              // NOTE: devDate/devNotes (columns C/D — Development-Date /
              // Development-Updates) MUST be passed through. They used to be
              // omitted here, and because buildDevTrackerRow() defaults any
              // missing field to '' the writer silently WIPED the Development
              // columns in the sheet on every status change / edit made from
              // the dashboard. Fall back to the incoming body so a partial
              // update can never blank them.
              sheetResult = await updateDevTrackerRowInSheet({
                tabName: project.project,
                rowNum: item.rowNum,
                url: item.url,
                status: item.status,
                devDate: item.devDate ?? b.devDate ?? '',
                devNotes: item.devNotes ?? b.devNotes ?? '',
                feedbackUrl: item.feedbackUrl,
                date: item.date,
                notes: item.notes,
                // Hand-added sheet columns (auto-discovered keys) — forwarded so
                // a dashboard edit can never blank them in the sheet.
                extra: b.extra ?? item.extra ?? {},
              });
              console.log(`[dev-projects] ✅ Live synced to sheet "${project.project}" row ${item.rowNum}`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not write to sheet: ${sheetErr.message}`);
          }

          return ok({ project, item, sheetResult });
        }
        catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/:id/items (Add new item + append to Google Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/items$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const { project, item } = db.addDevProjectItem(projId, b);

          let sheetResult = null;
          try {
            const { appendDevTrackerRowInSheet } = await import('./sheets.js');
            if (project?.project) {
              // devDate/devNotes → sheet columns C/D (Development-Date /
              // Development-Updates). Same reason as the PUT handler: omitting
              // them writes blank cells instead of the real values.
              sheetResult = await appendDevTrackerRowInSheet({
                tabName: project.project,
                url: item.url,
                status: item.status,
                devDate: item.devDate ?? b.devDate ?? '',
                devNotes: item.devNotes ?? b.devNotes ?? '',
                feedbackUrl: item.feedbackUrl,
                date: item.date,
                notes: item.notes,
                extra: b.extra ?? item.extra ?? {},
              });
              console.log(`[dev-projects] ✅ Appended new row to sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not append to sheet: ${sheetErr.message}`);
          }

          return ok({ project, item, sheetResult });
        } catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/:id/feedback-round (Create new feedback cycle + header in Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/feedback-round$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const { project, headerItem, workItem } = db.addDevProjectFeedbackRound(projId, b);

          let sheetResult = null;
          try {
            const { createNewFeedbackRoundInSheet } = await import('./sheets.js');
            if (project?.project) {
              sheetResult = await createNewFeedbackRoundInSheet({
                tabName: project.project,
                feedbackGroup: b.feedbackGroup || 'Feedback',
                feedbackUrl: b.feedbackUrl,
                date: b.date,
                notes: b.notes,
                status: b.status,
                url: b.url,
                // Development-Date / Development-Updates (columns C/D) — must
                // be forwarded, otherwise the new round's first work row is
                // written with blank Development cells.
                devDate: b.devDate ?? '',
                devNotes: b.devNotes ?? '',
              });
              console.log(`[dev-projects] ✅ Created new feedback round "${b.feedbackGroup}" in sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not create feedback round in sheet: ${sheetErr.message}`);
          }

          return ok({ project, headerItem, workItem, sheetResult });
        } catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/create-project (Create new project tab with sitemap and initial feedback)
      if (pathname === '/api/master/dev-projects/create-project' && method === 'POST') {
        const b = await body();
        try {
          const { project } = db.createDevProject(b);

          let sheetResult = null;
          try {
            const { createNewProjectTabWithSitemapInSheet } = await import('./sheets.js');
            sheetResult = await createNewProjectTabWithSitemapInSheet({
              projectName: project.project,
              urls: b.urls || [],
              feedbackUrl: b.feedbackUrl,
              date: b.date,
              notes: b.notes,
              status: b.status,
            });
            console.log(`[dev-projects] ✅ Created new sheet tab "${project.project}" with sitemap`);
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not create tab in sheet: ${sheetErr.message}`);
          }

          return ok({ project, sheetResult });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/dev-projects/:id/bulk-sitemap (Bulk import pasted URLs into project and Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/bulk-sitemap$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const urls = Array.isArray(b.urls) ? b.urls : [];
          if (!urls.length) return err(400, 'No URLs provided');

          const { project, addedCount } = db.bulkAddDevProjectUrls(projId, urls, b.status || 'todo');

          let sheetResult = null;
          try {
            const { bulkAppendSitemapUrlsInSheet } = await import('./sheets.js');
            if (project?.project) {
              sheetResult = await bulkAppendSitemapUrlsInSheet({
                tabName: project.project,
                urls,
                status: b.status || 'todo',
              });
              console.log(`[dev-projects] ✅ Bulk appended ${addedCount} URLs to sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not bulk append to sheet: ${sheetErr.message}`);
          }

          return ok({ project, addedCount, sheetResult });
        } catch (e) { return err(400, e.message); }
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

        if (b.siteId || b.url || b.rowId) {
          let url = b.url;
          let site = b.siteId ? db.getSiteById(b.siteId) : (url ? db.getSiteByUrl(url) : null);
          if (!site && b.rowId) {
            const rows = db.getDailyReview();
            const r = rows.find(x => x.id === b.rowId);
            if (r) {
              url = r.siteUrl;
              if (r.siteId) site = db.getSiteById(r.siteId);
              if (!site && url) site = db.getSiteByUrl(url);
            }
          }
          if (!url && site) url = site.url;
          if (!url) return err(400, 'Could not resolve URL to check');
          const result = await checkSite(url);
          let updated = null;
          if (site) {
            updated = db.updateSite(site.id, {
              uptimeStatus: result.status,
              uptimeStatusCode: result.statusCode,
              uptimeResponseTime: result.responseTime,
              lastUptimeCheck: result.checkedAt,
            });
          }
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

      // ── NOTICES (Notice Board) ──────────────────────────────────
      // GET /api/master/notices
      if (pathname === '/api/master/notices' && method === 'GET') {
        return ok({ notices: db.getNotices() });
      }
      // POST /api/master/notices  (admin+)
      if (pathname === '/api/master/notices' && method === 'POST') {
        const b = await body();
        if (!b.title) return err(400, 'title required');
        return ok({ notice: db.createNotice(b) });
      }
      // PUT /api/master/notices/:id  (admin+)
      if (/^\/api\/master\/notices\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ notice: db.updateNotice(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/notices/:id  (admin+)
      if (/^\/api\/master\/notices\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteNotice(id);
        return ok({ success: true });
      }

      // ── DOMAIN EXPIRY REQUESTS (Approval Workflow) ─────────────
      // GET /api/master/domain-expiry-requests?status=
      if (pathname === '/api/master/domain-expiry-requests' && method === 'GET') {
        const status = reqUrl.searchParams.get('status');
        return ok({ requests: db.getDomainExpiryRequests(status ? { status } : {}) });
      }
      // POST /api/master/domain-expiry-requests (user submits, or admin directApply)
      if (pathname === '/api/master/domain-expiry-requests' && method === 'POST') {
        const b = await body();
        if (!b.requestedDate) return err(400, 'requestedDate required');
        if (b.directApply) {
          try {
            const site = db.updateSiteDomainExpiryDirect(b.siteId || b.siteUrl, b.requestedDate);
            return ok({ direct: true, site });
          } catch (e) { return err(404, e.message); }
        }
        try {
          const reqItem = db.createDomainExpiryRequest(b);
          return ok({ request: reqItem });
        } catch (e) { return err(400, e.message); }
      }
      // POST /api/master/domain-expiry-requests/:id/resolve (admin+)
      if (/^\/api\/master\/domain-expiry-requests\/([^/]+)\/resolve$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const b = await body();
        if (!b.action) return err(400, 'action required (approved or rejected)');
        try {
          const result = db.resolveDomainExpiryRequest(id, b.action, b.resolvedBy || 'admin');
          return ok({ success: true, ...result });
        } catch (e) { return err(400, e.message); }
      }

      // ── SHEET CREDENTIALS & INTEGRATION (Connected Spreadsheets) ──────────
      const sheetProgressCache = new Map();

      async function getOrComputeSheetProgress(cred) {
        if (!cred || !cred.spreadsheetId) return { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
        const cached = sheetProgressCache.get(cred.id);
        if (cached && (Date.now() - cached.cachedAt < 90000)) return cached.data;

        try {
          const { getTabValues, listTabTitles } = await import('./sheets.js');
          let targetTab = cred.tabName;
          let allRows = [];
          try {
            allRows = await getTabValues(targetTab, 'A1:ZZ500', cred.spreadsheetId) || [];
          } catch {
            const tabs = await listTabTitles(cred.spreadsheetId).catch(() => []);
            if (tabs.length) {
              targetTab = tabs[0];
              allRows = await getTabValues(targetTab, 'A1:ZZ500', cred.spreadsheetId) || [];
            }
          }

          const hRow = cred.headerRow || 1;
          if (allRows.length < hRow) {
            const res = { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
            sheetProgressCache.set(cred.id, { data: res, cachedAt: Date.now() });
            return res;
          }

          const rawHeader = allRows[hRow - 1] || [];
          const headers = rawHeader.map((h, i) => ({ key: `col_${i}`, label: String(h || '').trim(), index: i })).filter(h => h.label);
          const statusCol = headers.find(h => {
            const l = h.label.toLowerCase();
            return l.includes('status') || l.includes('state') || l.includes('progress') || l.includes('stage') || l.includes('phase') || l === 'active' || l.includes('done');
          });

          const isCompletedVal = v => /^(completed|done|finished|resolved|closed|approved|active|live|yes|ok|passed)$/i.test(String(v).trim());
          const isInProgressVal = v => /^(in[ _-]progress|progress|review|client[ _-]review|doing|working|wip|ongoing|testing)$/i.test(String(v).trim());
          const isPendingVal = v => /^(pending|todo|to[ _-]do|backlog|open|planned|hold|draft|new|inactive|deactive)$/i.test(String(v).trim());

          const dataRows = allRows.slice(hRow);
          const statusSummary = {};
          let completed = 0, inProgress = 0, pending = 0;
          let totalWithData = 0;

          dataRows.forEach(r => {
            if (!r || !r.some(v => v !== '' && v !== null && v !== undefined)) return;
            totalWithData++;
            if (statusCol) {
              const val = String(r[statusCol.index] || '').trim();
              if (val) {
                statusSummary[val] = (statusSummary[val] || 0) + 1;
                if (isCompletedVal(val)) completed++;
                else if (isInProgressVal(val)) inProgress++;
                else if (isPendingVal(val)) pending++;
              }
            }
          });

          const totalForPct = statusCol ? Object.values(statusSummary).reduce((a, b) => a + b, 0) : totalWithData;
          const completionPct = totalForPct > 0 ? Math.round((completed / totalForPct) * 100) : 0;
          const res = { total: totalWithData, completed, inProgress, pending, completionPct, statusSummary };
          sheetProgressCache.set(cred.id, { data: res, cachedAt: Date.now() });
          return res;
        } catch {
          return { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
        }
      }

      // GET /api/master/sheet-credentials & GET /api/master/custom-sheets
      if ((pathname === '/api/master/sheet-credentials' || pathname === '/api/master/custom-sheets') && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || 'user';
        const isManage = reqUrl.searchParams.get('manage') === '1';
        let credentials = db.getSheetCredentials();
        let sheets = db.getCustomSheets();
        if (!isManage) {
          const uid = reqUrl.searchParams.get('userId') || '';
          const uname = (reqUrl.searchParams.get('userName') || '').toLowerCase();
          credentials = credentials.filter(c => {
            if (c.active === false) return false;
            if (c.showInNav === false) return false;
            if (c.visibleTo && !c.visibleTo.includes(role)) return false;
            if (role === 'user' && Array.isArray(c.assignedUsers) && c.assignedUsers.length > 0) {
              const matched = c.assignedUsers.some(u =>
                String(u).toLowerCase() === uid.toLowerCase() ||
                String(u).toLowerCase() === uname
              );
              if (!matched) return false;
            }
            return true;
          });
          sheets = sheets.filter(s => s.visibleTo?.includes(role));
        }

        if (reqUrl.searchParams.get('progress') === '1') {
          const progressList = await Promise.all(credentials.map(async c => {
            const metrics = await getOrComputeSheetProgress(c);
            const canEdit = (c.editableBy || []).includes(role);
            return { ...c, metrics, canEdit };
          }));
          credentials = progressList;
        }

        let serviceAccountEmail = null;
        try {
          const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json';
          const saRaw = fs.readFileSync(saPath, 'utf8');
          serviceAccountEmail = JSON.parse(saRaw).client_email || null;
        } catch {}
        return ok({ credentials, sheets, serviceAccountEmail });
      }

      // PUT /api/master/sheet-credentials/:id — update spreadsheet ID, active status, tabName, permissions, etc.
      if (/^\/api\/master\/sheet-credentials\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try {
          sheetProgressCache.delete(id);
          const updated = db.updateSheetCredential(id, b);
          return ok({ success: true, credential: updated });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/sheet-credentials — add a new sheet credential
      if (pathname === '/api/master/sheet-credentials' && method === 'POST') {
        const b = await body();
        try {
          const created = db.createSheetCredential(b);
          return ok({ success: true, credential: created });
        } catch (e) { return err(400, e.message); }
      }

      // DELETE /api/master/sheet-credentials/:id — delete custom sheet credential
      if (/^\/api\/master\/sheet-credentials\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        try {
          db.deleteSheetCredential(id);
          return ok({ success: true });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/sheet-credentials/:id/test — test live connection to spreadsheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/test$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');
        const sheetIdToTest = cred.spreadsheetId;
        try {
          const { listTabTitles, getTabValues } = await import('./sheets.js');
          const tabs = await listTabTitles(sheetIdToTest);
          let rowCount = 0;
          let headerCols = [];
          if (tabs && tabs.length) {
            const targetTab = tabs.includes(cred.tabName) ? cred.tabName : tabs[0];
            const sampleRows = await getTabValues(targetTab, 'A1:ZZ100', sheetIdToTest).catch(() => []);
            rowCount = sampleRows?.length || 0;
            const hRow = cred.headerRow || 1;
            if (sampleRows.length >= hRow) {
              headerCols = (sampleRows[hRow - 1] || []).filter(h => h && String(h).trim());
            }
          }
          const updated = db.updateSheetCredential(id, {
            connectionStatus: 'ok',
            lastChecked: new Date().toISOString(),
            lastError: null,
            detectedTabs: tabs,
          });
          return ok({
            ok: true,
            status: 'ok',
            tabs,
            rowCount,
            headerCols,
            credential: updated,
            message: `Connected successfully! Found ${tabs?.length || 0} tab(s) and ${headerCols.length} columns.`,
          });
        } catch (e) {
          const updated = db.updateSheetCredential(id, {
            connectionStatus: 'error',
            lastChecked: new Date().toISOString(),
            lastError: e.message,
          });
          return ok({
            ok: false,
            status: 'error',
            error: e.message,
            credential: updated,
            message: `Connection failed: ${e.message}`,
          });
        }
      }

      // GET /api/master/sheet-credentials/:id/data — read smart sheet data with status detection & role check
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/data$/.test(pathname) && method === 'GET') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'user';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        // Check view permission
        if (cred.visibleTo && !cred.visibleTo.includes(role)) {
          return err(403, 'Access denied for your role');
        }

        const canEdit = (cred.editableBy || []).includes(role);
        const search = (reqUrl.searchParams.get('search') || '').toLowerCase().trim();
        const page = Math.max(1, Number(reqUrl.searchParams.get('page') || 1));
        const limit = Math.min(500, Math.max(10, Number(reqUrl.searchParams.get('limit') || 200)));

        try {
          const { getTabValues, listTabTitles } = await import('./sheets.js');
          const headerRowNum = cred.headerRow || 1;
          const reqTab = reqUrl.searchParams.get('tab');
          let targetTab = reqTab || cred.tabName;
          let availableTabs = cred.detectedTabs || [];

          let allRows;
          try {
            allRows = await getTabValues(targetTab, 'A1:ZZ2000', cred.spreadsheetId) || [];
          } catch (tabErr) {
            // If requested tab failed, fetch available tabs and auto-heal to first available tab
            availableTabs = await listTabTitles(cred.spreadsheetId).catch(() => []);
            if (availableTabs.length) {
              targetTab = availableTabs[0];
              allRows = await getTabValues(targetTab, 'A1:ZZ2000', cred.spreadsheetId) || [];
              if (!reqTab) {
                db.updateSheetCredential(id, { tabName: targetTab, detectedTabs: availableTabs });
              }
            } else {
              throw tabErr;
            }
          }

          if (!availableTabs.length) {
            availableTabs = await listTabTitles(cred.spreadsheetId).catch(() => [targetTab]);
          }

          if (allRows.length < headerRowNum) {
            return ok({ rows: [], headers: [], total: 0, page: 1, limit, pages: 0, statusSummary: {}, canEdit, title: cred.title || cred.label, tabName: targetTab, tabs: availableTabs, spreadsheetId: cred.spreadsheetId });
          }

          const rawHeader = allRows[headerRowNum - 1] || [];
          const headers = rawHeader.map((h, i) => ({
            key: `col_${i}`,
            label: (h || `Col ${i + 1}`).trim(),
            index: i,
          })).filter(h => h.label);

          const dataRowsRaw = allRows.slice(headerRowNum);
          let rows = dataRowsRaw.map((r, rowIdx) => {
            const rowNumber = rowIdx + headerRowNum + 1; // 1-indexed spreadsheet row
            const obj = { _rowNumber: rowNumber, _rowIndex: rowIdx };
            headers.forEach(h => {
              obj[h.key] = r[h.index] ?? '';
            });
            return obj;
          });

          // Intelligent Column Detection
          const statusColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('status') || l.includes('state') || l.includes('progress') || l.includes('stage') || l.includes('phase') || l === 'active' || l.includes('done');
          }).map(h => h.key);

          const assigneeColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('assign') || l.includes('user') || l.includes('dev') || l.includes('owner') || l.includes('member') || l.includes('person') || l.includes('who') || l.includes('author') || l.includes('lead');
          }).map(h => h.key);

          const urlColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('url') || l.includes('site') || l.includes('website') || l.includes('domain') || l.includes('link') || l.includes('endpoint');
          }).map(h => h.key);

          const titleColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('task') || l.includes('title') || l.includes('name') || l.includes('project') || l.includes('item') || l.includes('feature') || l.includes('summary') || l.includes('issue');
          }).map(h => h.key);

          const priorityColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('priority') || l.includes('urgency') || l.includes('level') || l.includes('severity');
          }).map(h => h.key);

          const primaryStatusKey = statusColKeys[0] || null;
          const primaryAssigneeKey = assigneeColKeys[0] || null;
          const primaryUrlKey = urlColKeys[0] || null;
          const primaryTitleKey = titleColKeys[0] || (headers.find(h => h.key !== primaryStatusKey && !urlColKeys.includes(h.key))?.key || headers[0]?.key);
          const primaryPriorityKey = priorityColKeys[0] || null;

          // Compute status summary & progress across all dataset rows
          const statusSummary = {};
          const assigneeSummary = {};
          let completedCount = 0;
          let inProgressCount = 0;
          let pendingCount = 0;

          const isCompletedVal = v => /^(completed|done|finished|resolved|closed|approved|active|live|yes|ok|passed)$/i.test(String(v).trim());
          const isInProgressVal = v => /^(in[ _-]progress|progress|review|client[ _-]review|doing|working|wip|ongoing|testing)$/i.test(String(v).trim());
          const isPendingVal = v => /^(pending|todo|to[ _-]do|backlog|open|planned|hold|draft|new|inactive|deactive)$/i.test(String(v).trim());

          let totalRowsWithData = 0;
          rows.forEach(r => {
            const hasData = Object.keys(r).some(k => !k.startsWith('_') && r[k] !== '' && r[k] !== null && r[k] !== undefined);
            if (!hasData) return;
            totalRowsWithData++;

            if (primaryStatusKey) {
              const val = String(r[primaryStatusKey] || '').trim();
              if (val) {
                statusSummary[val] = (statusSummary[val] || 0) + 1;
                if (isCompletedVal(val)) completedCount++;
                else if (isInProgressVal(val)) inProgressCount++;
                else if (isPendingVal(val)) pendingCount++;
              }
            }
            if (primaryAssigneeKey) {
              const val = String(r[primaryAssigneeKey] || '').trim();
              if (val) {
                assigneeSummary[val] = (assigneeSummary[val] || 0) + 1;
              }
            }
          });

          const totalForPct = primaryStatusKey ? Object.values(statusSummary).reduce((a, b) => a + b, 0) : totalRowsWithData;
          const completionPct = totalForPct > 0 ? Math.round((completedCount / totalForPct) * 100) : 0;

          // Curated status list
          const rawStatusKeys = Object.keys(statusSummary);
          const defaultStatuses = ['Active', 'In Progress', 'Completed', 'Done', 'Pending', 'To Do', 'Deactive'];
          const allStatuses = Array.from(new Set([...rawStatusKeys, ...defaultStatuses])).filter(Boolean);

          // Search filter
          if (search) {
            rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(search)));
          }

          const total = rows.length;
          const paginated = rows.slice((page - 1) * limit, page * limit);

          return ok({
            rows: paginated,
            headers,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            statusColKeys,
            assigneeColKeys,
            urlColKeys,
            titleColKeys,
            priorityColKeys,
            primaryStatusKey,
            primaryAssigneeKey,
            primaryUrlKey,
            primaryTitleKey,
            primaryPriorityKey,
            statusSummary,
            assigneeSummary,
            allStatuses,
            metrics: {
              total: totalRowsWithData,
              completed: completedCount,
              inProgress: inProgressCount,
              pending: pendingCount,
              completionPct,
            },
            canEdit,
            title: cred.title || cred.label,
            tabName: targetTab,
            tabs: availableTabs,
            spreadsheetId: cred.spreadsheetId,
            headerRowNum,
            category: cred.category,
          });
        } catch (e) {
          return err(502, `Failed to fetch sheet data: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/cell — update single cell
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/cell$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to edit this sheet');
        }

        const b = await body();
        const { rowNumber, colIndex, value } = b;
        if (rowNumber === undefined || colIndex === undefined) {
          return err(400, 'rowNumber and colIndex are required');
        }

        try {
          sheetProgressCache.delete(id);
          const { updateSheetCell, colIndexToA1 } = await import('./sheets.js');
          const colLetter = colIndexToA1(colIndex);
          const a1Notation = `${colLetter}${rowNumber}`;
          const tab = b.tabName || cred.tabName;
          await updateSheetCell(cred.spreadsheetId, tab, a1Notation, value ?? '');
          return ok({ success: true, a1Notation, value });
        } catch (e) {
          return err(502, `Failed to update cell in Google Sheet: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/row — append a row to sheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/row$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to add rows to this sheet');
        }

        const b = await body();
        const rowValues = Array.isArray(b.rowValues) ? b.rowValues : [];
        const tab = b.tabName || cred.tabName;
        try {
          sheetProgressCache.delete(id);
          const { appendSheetRow } = await import('./sheets.js');
          await appendSheetRow(cred.spreadsheetId, tab, rowValues);
          return ok({ success: true, message: 'Row added directly to Google Sheet' });
        } catch (e) {
          return err(502, `Failed to append row: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/column — append a column to sheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/column$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to add columns to this sheet');
        }

        const b = await body();
        const columnName = (b.columnName || '').trim();
        if (!columnName) return err(400, 'columnName is required');
        const tab = b.tabName || cred.tabName;

        try {
          sheetProgressCache.delete(id);
          const { appendSheetColumn } = await import('./sheets.js');
          const res = await appendSheetColumn(cred.spreadsheetId, tab, columnName, cred.headerRow || 1);
          return ok({ success: true, ...res, message: `Column "${columnName}" created in Google Sheet` });
        } catch (e) {
          return err(502, `Failed to append column: ${e.message}`);
        }
      }

      // ── CUSTOM SHEETS (Superadmin-managed external Google Sheets) ─────────
      // POST /api/master/custom-sheets — create
      if (pathname === '/api/master/custom-sheets' && method === 'POST') {
        const b = await body();
        try { return ok({ sheet: db.createCustomSheet(b) }); }
        catch (e) { return err(400, e.message); }
      }

      // PUT /api/master/custom-sheets/:id — update
      if (/^\/api\/master\/custom-sheets\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ sheet: db.updateCustomSheet(id, b) }); }
        catch (e) { return err(404, e.message); }
      }

      // DELETE /api/master/custom-sheets/:id — delete
      if (/^\/api\/master\/custom-sheets\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteCustomSheet(id);
        return ok({ success: true });
      }

      // POST /api/master/custom-sheets/:id/probe — test connection, auto-detect columns
      if (/^\/api\/master\/custom-sheets\/([^/]+)\/probe$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const sheet = db.getCustomSheetById(id);
        if (!sheet) return err(404, 'Custom sheet not found');
        try {
          const { getTabValues } = await import('./sheets.js');
          // Fetch header row
          const headerRowNum = sheet.headerRow || 1;
          const headerRange = `${sheet.tabName}!A${headerRowNum}:ZZ${headerRowNum}`;
          const headerRows = await getTabValues(sheet.tabName, `A${headerRowNum}:ZZ${headerRowNum}`, sheet.spreadsheetId);
          const headers = (headerRows?.[0] || []).map((h, i) => ({
            key: `col_${i}`,
            label: h || `Column ${i + 1}`,
            index: i,
          })).filter(h => h.label && h.label.trim());

          // Sample first 50 data rows to guess numeric columns
          const dataStart = headerRowNum + 1;
          const dataRows = await getTabValues(sheet.tabName, `A${dataStart}:ZZ${dataStart + 49}`, sheet.spreadsheetId) || [];
          const numericCols = headers
            .map(h => ({ ...h, numericRatio: dataRows.filter(r => r[h.index] !== undefined && r[h.index] !== '' && !isNaN(Number(String(r[h.index]).replace(/[$,%]/g, '')))).length / Math.max(1, dataRows.length) }))
            .filter(h => h.numericRatio > 0.5)
            .map(h => h.key);

          const updated = db.updateCustomSheet(id, {
            columns: headers,
            statColumns: numericCols.slice(0, 4), // max 4 auto-stat cards
            connectionStatus: 'ok',
            lastProbed: new Date().toISOString(),
          });
          return ok({ sheet: updated, headers, suggestedStatColumns: numericCols, rowCount: dataRows.length });
        } catch (e) {
          db.updateCustomSheet(id, { connectionStatus: 'error', lastProbeError: e.message, lastProbed: new Date().toISOString() });
          return err(502, `Cannot connect to sheet: ${e.message}`);
        }
      }

      // GET /api/master/custom-sheets/:id/data?page=1&limit=200&search=
      if (/^\/api\/master\/custom-sheets\/([^/]+)\/data$/.test(pathname) && method === 'GET') {
        const id = pathname.split('/')[4];
        const sheet = db.getCustomSheetById(id);
        if (!sheet) return err(404, 'Custom sheet not found');
        const search = (reqUrl.searchParams.get('search') || '').toLowerCase().trim();
        const page = Math.max(1, Number(reqUrl.searchParams.get('page') || 1));
        const limit = Math.min(500, Math.max(10, Number(reqUrl.searchParams.get('limit') || 200)));
        try {
          const { getTabValues } = await import('./sheets.js');
          const headerRowNum = sheet.headerRow || 1;
          const headers = sheet.columns?.length ? sheet.columns : [];
          // Fetch all data rows (after header)
          const dataStart = headerRowNum + 1;
          const rawRows = await getTabValues(sheet.tabName, `A${dataStart}:ZZ`, sheet.spreadsheetId) || [];

          let rows = rawRows.map((r, rowIdx) => {
            const obj = { _rowIndex: rowIdx + dataStart };
            headers.forEach(h => { obj[h.key] = r[h.index] ?? ''; });
            return obj;
          });

          // Search filter
          if (search) {
            rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(search)));
          }

          const total = rows.length;
          const paginated = rows.slice((page - 1) * limit, page * limit);

          // Stat summaries for numeric stat columns
          const stats = {};
          (sheet.statColumns || []).forEach(key => {
            const col = headers.find(h => h.key === key);
            if (!col) return;
            const nums = rows.map(r => Number(String(r[key] || '').replace(/[$,%]/g, ''))).filter(n => !isNaN(n));
            stats[key] = {
              label: col.label,
              sum: nums.reduce((a, b) => a + b, 0),
              count: nums.length,
              avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : 0,
              min: nums.length ? Math.min(...nums) : 0,
              max: nums.length ? Math.max(...nums) : 0,
            };
          });

          return ok({ rows: paginated, total, page, limit, pages: Math.ceil(total / limit), headers, stats });
        } catch (e) {
          return err(502, `Failed to fetch sheet data: ${e.message}`);
        }
      }

      sendJson(res, 404, { error: 'Master API route not found' });
      return;

    }



    // Static Files
    let filePath = path.join(PUBLIC_DIR,
      (pathname === '/' || pathname === '/master' || pathname === '/master.html' || pathname === '/dashboard') ? 'master.html' :
      (pathname === '/mailer' || pathname === '/mailer.html' || pathname === '/index.html' || pathname === '/email' || pathname === '/emails' || pathname === '/emaildashboard' || pathname === '/email-dashboard') ? 'index.html' :
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

