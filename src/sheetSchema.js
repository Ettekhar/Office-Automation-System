/**
 * sheetSchema.js — "understand every sheet we are connected to".
 *
 * WHAT IT DOES
 * ────────────
 * Walks the tabs of a spreadsheet, resolves each tab's column layout from its
 * OWN header row (see tabSchema.js), and stores the result in a schema registry
 * at `data/sheet-schema.json`. The registry is the single answer to:
 *
 *   • "what sheets/tabs do we have?"     → getConnectedSheets()
 *   • "what columns does this tab have?" → getSheetSchema(id).tabs[n].columns
 *   • "what did someone add by hand?"    → tab.extras (QA Check, SEO Notes…)
 *   • "what can the chatbot talk about?" → describeSchemaForAssistant()
 *
 * WHY IT EXISTS
 * ─────────────
 * Columns and whole tabs are added to these spreadsheets by hand, between
 * releases. Nothing here is hardcoded: a new column becomes an "extra column",
 * a new tab is discovered by listTabTitles(), and a brand-new spreadsheet is
 * discovered through the same code path. The dashboard, the DB import and the
 * chatbot all read this registry, so they pick new data up with no code change.
 *
 * COST CONTROL
 * ────────────
 * Discovery is one Sheets read per tab (A1:Z{header + sample rows}); results are
 * cached in memory for SCHEMA_TTL_MS (default 30 min) AND persisted, and
 * `maxTabs` caps how many tabs one discovery walks — the maintenance
 * spreadsheets carry ~70 per-site report tabs nothing here needs.
 */

import { listTabTitles, getTabValues } from './sheets.js';
import { dbRead, dbWrite, getSheetCredentials } from './db.js';
import {
  resolveColumns,
  detectHeaderRow,
  describeColumns,
  describeColumnsText,
  schemaSignature,
  monthColumns,
} from './tabSchema.js';
import { accounts } from './config.js';

const SCHEMA_FILE = 'sheet-schema';
const SCHEMA_VERSION = 1;
const SCHEMA_TTL_MS = Number(process.env.SHEET_SCHEMA_TTL_MS || 30 * 60 * 1000);
const DEFAULT_MAX_TABS = Number(process.env.SHEET_SCHEMA_MAX_TABS || 12);

/** In-memory layer in front of the persisted registry (keyed by spreadsheetId). */
const memory = new Map();

// ── Persistence ─────────────────────────────────────────────────────────────

/** Read the persisted registry (never throws; returns a valid empty shell). */
export function readRegistry() {
  const raw = dbRead(SCHEMA_FILE);
  if (!raw || typeof raw !== 'object' || typeof raw.spreadsheets !== 'object' || !raw.spreadsheets) {
    return { version: SCHEMA_VERSION, updatedAt: null, spreadsheets: {} };
  }
  return { version: raw.version || SCHEMA_VERSION, updatedAt: raw.updatedAt || null, spreadsheets: raw.spreadsheets };
}

function writeRegistry(registry) {
  registry.version = SCHEMA_VERSION;
  registry.updatedAt = new Date().toISOString();
  dbWrite(SCHEMA_FILE, registry);
  return registry;
}

/** Friendly name for a spreadsheet: configured account name, else its title. */
export function labelForSpreadsheet(spreadsheetId) {
  for (const acct of Object.values(accounts)) {
    if (acct.spreadsheetId === spreadsheetId) return acct.name;
  }
  try {
    const cred = getSheetCredentials().find((c) => c.spreadsheetId === spreadsheetId);
    if (cred) return cred.title || cred.key || cred.id;
  } catch { /* label is cosmetic — ignore */ }
  return `Sheet ${String(spreadsheetId).slice(0, 8)}…`;
}

// ── Tab discovery ───────────────────────────────────────────────────────────

/**
 * Discover ONE tab: header row (found dynamically, so a note/banner above the
 * header is fine), resolved field indexes, extra columns, month columns and a
 * few sample rows.
 */
export async function discoverTabSchema(spreadsheetId, tabName, opts = {}) {
  const sample = Math.max(0, Math.min(10, Number(opts.sampleRows ?? 3)));
  const wanted = String(opts.profile || 'auto');
  const rows = await getTabValues(tabName, `A1:Z${Math.max(20, sample + 10)}`, spreadsheetId);
  const list = Array.isArray(rows) ? rows : [];
  const detected = detectHeaderRow(list, { profile: wanted });
  const cols = resolveColumns(detected.headerRow, { profile: detected.profile, tabName });

  const dataRows = list
    .slice(detected.headerRowIndex + 1)
    .filter((r) => (r || []).some((c) => String(c ?? '').trim() !== ''));

  return {
    title: String(tabName),
    headerRowIndex: detected.headerRowIndex,
    headerRowNumber: detected.headerRowIndex + 1, // 1-based, for humans
    headers: cols.headers,
    signature: schemaSignature(cols.headers),
    profile: cols.profile,
    columns: describeColumns(cols),
    extras: cols.extras,
    months: cols.months || monthColumns(cols.headers),
    fields: Object.fromEntries(Object.entries(cols).filter(([, v]) => typeof v === 'number')),
    dataRowCount: dataRows.length,
    sampleRows: dataRows.slice(0, sample),
    columnsText: describeColumnsText(cols),
  };
}

/**
 * Discover a spreadsheet: which tabs exist, and the layout of each.
 *
 * @param {string} spreadsheetId
 * @param {{ tabs?: string[], profile?: string, sampleRows?: number, maxTabs?: number, label?: string }} opts
 */
export async function discoverSpreadsheetSchema(spreadsheetId, opts = {}) {
  const id = String(spreadsheetId || '').trim();
  if (!id) throw new Error('spreadsheetId is required');

  const allTabs = await listTabTitles(id);
  const requested = (Array.isArray(opts.tabs) ? opts.tabs : []).map((t) => String(t).trim()).filter(Boolean);
  const maxTabs = Math.max(1, Number(opts.maxTabs ?? DEFAULT_MAX_TABS));

  // An explicit tab list wins; otherwise every tab of the sheet, capped.
  let targets = requested.length ? allTabs.filter((t) => requested.includes(t)) : allTabs;
  const skippedTabs = [];
  if (targets.length > maxTabs) {
    skippedTabs.push(...targets.slice(maxTabs));
    targets = targets.slice(0, maxTabs);
  }

  const tabs = [];
  const errors = [];
  for (const tab of targets) {
    try {
      tabs.push(await discoverTabSchema(id, tab, { profile: opts.profile, sampleRows: opts.sampleRows }));
    } catch (e) {
      errors.push({ tab, error: e.message });
    }
  }

  return {
    spreadsheetId: id,
    label: opts.label || labelForSpreadsheet(id),
    discoveredAt: new Date().toISOString(),
    tabCount: allTabs.length,
    tabs,
    skippedTabs,
    errors,
  };
}

// ── Accessors (cache-first) ─────────────────────────────────────────────────

/** Cached schema for one spreadsheet, from memory then disk. `null` if none. */
export function getSheetSchema(spreadsheetId) {
  const id = String(spreadsheetId || '').trim();
  if (!id) return null;
  const hit = memory.get(id);
  if (hit && Date.now() - hit.cachedAt < SCHEMA_TTL_MS) return hit.value;
  const stored = readRegistry().spreadsheets[id];
  if (stored) memory.set(id, { cachedAt: Date.now(), value: stored });
  return stored || null;
}

/**
 * Schema for a spreadsheet, discovering it on first use (or when `refresh`).
 * A discovery failure never breaks the caller — the stored schema wins.
 */
export async function getOrDiscoverSheetSchema(spreadsheetId, opts = {}) {
  const id = String(spreadsheetId || '').trim();
  if (!id) return null;
  const cached = getSheetSchema(id);
  if (cached && opts.refresh !== true) return cached;
  try {
    const discovered = await discoverSpreadsheetSchema(id, opts);
    memory.set(id, { cachedAt: Date.now(), value: discovered });
    const registry = readRegistry();
    registry.spreadsheets[id] = discovered;
    writeRegistry(registry);
    return discovered;
  } catch (e) {
    if (cached) {
      console.warn(`[sheetSchema] Discovery failed for ${id} (${e.message}) — using the stored schema.`);
      return cached;
    }
    throw e;
  }
}

/** Every spreadsheet the app is configured to read (accounts + credentials). */
export function getConnectedSheets() {
  const out = [];
  const seen = new Set();
  const push = (spreadsheetId, label, tabName, source) => {
    if (!spreadsheetId || seen.has(spreadsheetId)) return;
    seen.add(spreadsheetId);
    out.push({ spreadsheetId, label, tabName: tabName || '', source });
  };
  for (const acct of Object.values(accounts)) {
    push(acct.spreadsheetId, acct.name, acct.masterTabName, `account:${acct.key}`);
  }
  try {
    for (const cred of getSheetCredentials()) {
      push(cred.spreadsheetId, cred.title || cred.key || cred.id, cred.tabName, `credential:${cred.id}`);
    }
  } catch { /* credentials are optional for the discovery layer */ }
  return out;
}

/**
 * The whole registry: connected spreadsheets joined with their discovered
 * schema (discovering anything missing). Never throws — a bad sheet is reported
 * in `errors` and every other sheet still comes back.
 */
export async function getSchemaRegistry({ refresh = false, maxTabs, tabs } = {}) {
  const discovered = [];
  const errors = [];
  for (const sheet of getConnectedSheets()) {
    try {
      const schema = await getOrDiscoverSheetSchema(sheet.spreadsheetId, {
        refresh,
        maxTabs,
        tabs: tabs && tabs.length ? tabs : (sheet.tabName ? [sheet.tabName] : undefined),
        label: sheet.label,
      });
      discovered.push({ ...schema, label: sheet.label || schema.label, source: sheet.source });
    } catch (e) {
      errors.push({ spreadsheetId: sheet.spreadsheetId, label: sheet.label, error: e.message });
    }
  }
  return { updatedAt: new Date().toISOString(), sheets: discovered, errors };
}

/** Force a fresh discovery of one spreadsheet and persist it. */
export async function refreshSheetSchema(spreadsheetId, opts = {}) {
  memory.delete(String(spreadsheetId || '').trim());
  return getOrDiscoverSheetSchema(spreadsheetId, { ...opts, refresh: true });
}
// ─ Chatbot / UI description ────────────────────────────────────────────────

/**
 /** Compact, token-cheap description of the discovered schema for the chatbot.
  * It answers "what columns exist everywhere, including the ones someone added
  * by hand?" so the model can quote a new column instead of claiming it is
  * missing. Hand-added columns are marked with "+".
  *
  * When `sheets` is empty the function falls back to describing EVERY connected
  * spreadsheet (accounts + credentials) so the chatbot can see columns across
  * ALL sheets the project reads — not just the single source configured in the
  * assistant config. Pass an explicit list when you only want one sheet.
  */
export function describeSchemaForAssistant(sheets, { maxTabs = 14, maxSheets = 6 } = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  if (!list.length) return '';
  const lines = [];
  const label = (c) => (c.extra ? `+ ${c.label}` : c.label);
  for (const sheet of list.slice(0, maxSheets)) {
    for (const tab of (sheet.tabs || []).slice(0, maxTabs)) {
      const cols = (tab.columns || []).map(label);
      lines.push(
        `• ${sheet.label || sheet.spreadsheetId} / ${tab.title} — profile: ${tab.profile}, ` +
        `header row ${tab.headerRowNumber || 1}, ${cols.length} column(s)` +
        `${tab.extras?.length ? `, ${tab.extras.length} hand-added` : ''}`,
      );
      lines.push(`  columns: ${cols.length ? cols.join(', ') : '(none)'}`);
      if (tab.months?.length) {
        const shown = tab.months.slice(-6).map((m) => m.label).join(', ');
        lines.push(`  month columns: ${shown}${tab.months.length > 6 ? ' …' : ''}`);
      }
    }
    const skipped = (sheet.skippedTabs || []).length;
    if (skipped) {
      lines.push(`  (${skipped} further tab(s) in ${sheet.label} were not scanned — raise SHEET_SCHEMA_MAX_TABS to include them)`);
    }
  }
  const extras = extrasAcrossSheets(list);
  if (extras.length) {
    lines.push(`Extra columns seen anywhere: ${extras.join(', ')} — treat these as first-class tracker data.`);
  }
  return lines.join('\n');
}

/** Distinct hand-added column labels across every discovered tab. */
export function extrasAcrossSheets(sheets) {
  const seen = new Set();
  for (const sheet of Array.isArray(sheets) ? sheets : []) {
    for (const tab of sheet.tabs || []) {
      for (const e of tab.extras || []) {
        const label = e.label || e.key;
        if (label) seen.add(label);
      }
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** JSON-friendly summary for the dashboard UI (sample rows stripped out). */
export function summarizeSchema(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  return {
    connected: list.length,
    extras: extrasAcrossSheets(list),
    sheets: list.map((sheet) => ({
      spreadsheetId: sheet.spreadsheetId,
      label: sheet.label,
      discoveredAt: sheet.discoveredAt,
      tabCount: sheet.tabCount,
      skippedTabs: sheet.skippedTabs || [],
      errors: sheet.errors || [],
      tabs: (sheet.tabs || []).map((tab) => ({
        title: tab.title,
        profile: tab.profile,
        headerRowNumber: tab.headerRowNumber,
        dataRowCount: tab.dataRowCount,
        signature: tab.signature,
        columns: tab.columns || [],
        extras: tab.extras || [],
        months: tab.months || [],
        columnsText: tab.columnsText || '',
      })),
    })),
  };
}

/** One tab's discovered schema (cached; only hits the API when unknown). */
export async function getTabSchema(spreadsheetId, tabName) {
  const schema = await getOrDiscoverSheetSchema(spreadsheetId, { tabs: [tabName] });
  return (schema?.tabs || []).find((t) => t.title === tabName) || null;
}