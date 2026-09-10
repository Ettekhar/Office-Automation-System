/** Strip protocol, "www.", trailing slash, and any path/query so we get just the domain. */
export function normalizeUrl(url) {
  if (!url) return '';
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Extract just the base domain from a URL (strips paths, query strings). */
function baseDomain(url) {
  if (!url) return '';
  const norm = normalizeUrl(url);
  // Take everything before the first / (path separator)
  return norm.split('/')[0].split('?')[0];
}

/**
 * Find the tab whose title best matches a given website URL.
 * Matching priority:
 *  1. Exact normalized match (full URL)
 *  2. Base-domain exact match (both sides stripped to domain only)
 *  3. One side is a clean prefix/suffix of the other (min 6 chars) — strict partial
 * Rejects loose substring matches that can cause preview cross-contamination.
 */
export function findMatchingTab(tabTitles, websiteUrl, masterTabName) {
  if (!isValidWebsiteUrl(websiteUrl)) return null;
  const target = normalizeUrl(websiteUrl);
  const targetDomain = baseDomain(websiteUrl);
  if (!target) return null;

  // Tier 1: full normalized equality
  for (const title of tabTitles) {
    if (title === masterTabName) continue;
    if (normalizeUrl(title) === target) return title;
  }

  // Tier 2: base domain equality (e.g. "morrisonhouse.com" vs "morrisonhouse.com/page")
  if (targetDomain.length >= 4) {
    for (const title of tabTitles) {
      if (title === masterTabName) continue;
      if (baseDomain(title) === targetDomain) return title;
    }
  }

  // Tier 3: strict partial — only if the SHORTER value is at least 6 chars
  // and is a genuine substring of the other (not a coincidental substring)
  for (const title of tabTitles) {
    if (title === masterTabName) continue;
    const normTitle = normalizeUrl(title);
    const normDomain = baseDomain(title);
    if (!normTitle || normTitle.length < 6) continue;
    // Ensure target domain includes tab's domain or vice-versa (domain-anchored)
    if (
      (targetDomain.length >= 6 && normDomain.length >= 6) &&
      (targetDomain.includes(normDomain) || normDomain.includes(targetDomain))
    ) {
      return title;
    }
  }

  return null;
}


/**
 * Find the actual table header row in the master sheet (skipping any top banner/note rows).
 */
export function findHeaderRow(rows) {
  if (!rows || rows.length === 0) return { headerRow: [], headerRowIndex: 0 };
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i] || [];
    const hasWebsite = row.some((c) =>
      String(c ?? "")
        .trim()
        .toLowerCase()
        .includes("website url"),
    );
    const hasCMS = row.some((c) =>
      String(c ?? "")
        .trim()
        .toLowerCase()
        .includes("cms"),
    );
    if (hasWebsite || hasCMS) {
      return { headerRow: row, headerRowIndex: i };
    }
  }
  return { headerRow: rows[0] || [], headerRowIndex: 0 };
}


/**
 * Detect column indices dynamically based on header row text.
 * Adapts seamlessly between CW, RM, and any sheet with different column layouts.
 *
 * Optional columns (NOTE, CLICKUP_URL, REPORT_URL, BACKUP_URL) are initialized
 * to -1 (not found) so they never pollute the FIRST_MONTH_COL calculation.
 * FIRST_MONTH_COL is found by scanning for the first actual month name in the header.
 */
export function detectColumns(headerRow) {
  const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december',
                       'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec'];

  const cols = {
    STATUS: 0,        // nearly always col 0 (Active/Inactive)
    CMS: 1,           // default, updated by scan
    COMPANY: 2,       // default, updated by scan
    CONTACT: 3,       // default, updated by scan
    AM: 4,            // default, updated by scan
    NOTE: -1,         // optional – not in RM sheet
    WEBSITE_URL: -1,  // MUST be detected; fallback 6
    CLICKUP_URL: -1,  // optional
    REPORT_URL: -1,   // optional – not in RM sheet
    BACKUP_URL: -1,   // optional – not in RM sheet
    FIRST_MONTH_COL: 10, // will be overridden by month-name scan
  };

  if (!headerRow || headerRow.length === 0) return cols;

  headerRow.forEach((val, idx) => {
    const v = String(val ?? '').trim().toLowerCase();
    if (v.includes('website url') || (v === 'website')) {
      cols.WEBSITE_URL = idx;
    } else if (v === 'cms') {
      cols.CMS = idx;
    } else if (v === 'company') {
      cols.COMPANY = idx;
    } else if (v.includes('contact')) {
      cols.CONTACT = idx;
    } else if (v.includes('manager') || v === 'am' || v.includes('a/c')) {
      cols.AM = idx;
    } else if (v.includes('clickup')) {
      cols.CLICKUP_URL = idx;
    } else if (v.includes('report url') || v.includes('report link')) {
      cols.REPORT_URL = idx;
    } else if (v.includes('backup url') || v.includes('backup link')) {
      cols.BACKUP_URL = idx;
    } else if (v === 'note' || v === 'notes') {
      cols.NOTE = idx;
    }
  });

  // Fallback for WEBSITE_URL if not explicitly found
  if (cols.WEBSITE_URL === -1) cols.WEBSITE_URL = 6;

  // PRIMARY: find FIRST_MONTH_COL by scanning header for first month-name cell
  // This is accurate regardless of how many meta columns exist.
  let firstMonthFromScan = -1;
  for (let i = 1; i < headerRow.length; i++) {
    const v = String(headerRow[i] ?? '').trim().toLowerCase();
    if (v && MONTH_NAMES.some((m) => v.startsWith(m))) {
      firstMonthFromScan = i;
      break;
    }
  }

  if (firstMonthFromScan > 0) {
    cols.FIRST_MONTH_COL = firstMonthFromScan;
  } else {
    // FALLBACK: max of only the explicitly detected cols + 1
    const detectedOnly = [
      cols.STATUS,
      cols.CMS,
      cols.COMPANY,
      cols.CONTACT,
      cols.AM,
      cols.WEBSITE_URL,
      cols.CLICKUP_URL >= 0 ? cols.CLICKUP_URL : null,
      cols.NOTE >= 0 ? cols.NOTE : null,
      cols.REPORT_URL >= 0 ? cols.REPORT_URL : null,
      cols.BACKUP_URL >= 0 ? cols.BACKUP_URL : null,
    ].filter((idx) => idx !== null && idx !== undefined && idx >= 0);
    const maxDetected = detectedOnly.length > 0 ? Math.max(...detectedOnly) : 9;
    cols.FIRST_MONTH_COL = maxDetected + 1;
  }

  return cols;
}

/**
 * Check whether a raw cell value looks like a real website URL / domain.
 * Filters out garbage like "Note:https://...", empty strings, ClickUp-only rows, etc.
 */
export function isValidWebsiteUrl(raw) {
  if (!raw) return false;
  const url = String(raw).trim();
  if (!url) return false;
  // Reject note-prefixed values (common bad data pattern in CW sheet)
  if (/^note[:\s]/i.test(url)) return false;
  // Reject values that are just numbers or very short
  if (url.length < 4) return false;
  // Must contain a dot (domain) or start with http
  return url.includes('.') || url.startsWith('http');
}


/**
 * Find the latest (rightmost) month column from the master sheet header row,
 * or find a specific requested month if provided.
 */
export function resolveMonthColumn(
  headerRow,
  firstMonthCol = 10,
  targetMonthName = null,
) {
  if (!headerRow || headerRow.length === 0) return null;

  if (targetMonthName) {
    // Search from right-to-left to pick the latest instance of this month name
    for (let i = headerRow.length - 1; i >= firstMonthCol; i--) {
      const colName = (headerRow[i] || "").trim();
      if (colName.toLowerCase() === targetMonthName.trim().toLowerCase()) {
        return {
          columnIndex: i,
          monthName: colName,
          monthLower: colName.toLowerCase(),
          year: new Date().getFullYear(),
        };
      }
    }
    return null;
  }

  // Find the rightmost non-empty column in the header row starting from firstMonthCol
  for (let i = headerRow.length - 1; i >= firstMonthCol; i--) {
    const colName = (headerRow[i] || "").trim();
    if (colName) {
      return {
        columnIndex: i,
        monthName: colName,
        monthLower: colName.toLowerCase(),
        year: new Date().getFullYear(),
      };
    }
  }

  return null;
}

export function isActive(statusCell) {
  return String(statusCell ?? "")
    .trim()
    .toLowerCase()
    .startsWith("active");
}

export function isMarkedDone(cell, doneMarker = "updated & backup") {
  const text = String(cell ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes("updated & backup") ||
    text.includes("update & backup") ||
    text.includes("updated and backup") ||
    text.includes("update and backup") ||
    (doneMarker && text.includes(doneMarker.toLowerCase()))
  );
}

export function parseContacts(contactCell) {
  if (!contactCell) return [];
  return contactCell
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter((e) => /\S+@\S+\.\S+/.test(e));
}

const FONT = "font-family:Arial, Helvetica, sans-serif;";
const WRAP = "overflow-wrap:break-word;word-break:break-word;";
const TABLE_MAX_WIDTH = "650px";

const bandStyle = `padding:8px 12px;border:1px solid #e0a800;background:#f7b900;color:#1a1a1a;font-weight:bold;font-size:14px;${WRAP}${FONT}`;
const subHeaderStyle = `padding:8px 12px;border:1px solid #ddd;background:#fbe8ab;color:#1a1a1a;font-weight:bold;font-size:14px;vertical-align:middle;${WRAP}${FONT}`;
const cellStyle = `padding:8px 12px;border:1px solid #ddd;font-size:14px;vertical-align:middle;color:#222;background:#ffffff;${WRAP}${FONT}`;
const firstColStyle = cellStyle + "font-weight:600;";

export function getSectionHeaderType(row) {
  if (!row || row.length === 0) return null;
  const filled = row.filter((c) => String(c ?? "").trim() !== "");
  if (filled.length !== 1) return null;
  const firstText = String(row[0] ?? "")
    .trim()
    .toLowerCase();
  if (!firstText) return null;

  if (
    firstText.startsWith("plugin update") ||
    firstText.startsWith("plugins update")
  ) {
    return "plugin_updated";
  }
  if (firstText === "other") {
    return "other";
  }
  if (firstText.startsWith("deactivat")) {
    return "deactivated";
  }
  if (firstText.startsWith("premium plugin")) {
    return "premium_plugin";
  }
  if (firstText.startsWith("additional issue")) {
    return "additional_issue";
  }
  return null;
}

export function isIssueSubHeader(row) {
  if (!row || row.length === 0) return false;
  const lowerCells = row.map((c) =>
    String(c ?? "")
      .trim()
      .toLowerCase(),
  );
  return lowerCells.includes("title") || lowerCells.includes("note");
}

export function parseReportSections(rawRows) {
  const sections = [];
  let currentSec = null;
  let consecutiveEmpty = 0;

  for (const row of rawRows) {
    const isEmpty = !row || !row.some((c) => String(c ?? "").trim() !== "");
    if (isEmpty) {
      consecutiveEmpty++;
      continue;
    }

    const secType = getSectionHeaderType(row);
    if (secType) {
      currentSec = { type: secType, headerText: row[0], rows: [] };
      sections.push(currentSec);
      consecutiveEmpty = 0;
      continue;
    }

    if (currentSec) {
      if (currentSec.type === "additional_issue") {
        if (isIssueSubHeader(row)) {
          consecutiveEmpty = 0;
          continue;
        }
        // Only accept data rows directly under subheader; stop on consecutive blank rows
        if (consecutiveEmpty < 2) {
          currentSec.rows.push(row);
        }
      } else {
        if (consecutiveEmpty < 2) {
          currentSec.rows.push(row);
        }
      }
      consecutiveEmpty = 0;
    }
  }

  return sections;
}

/**
 * Turn a per-site report tab's raw grid into an HTML table.
 * - Only sections with rows are rendered (empty bands like empty "Deactivated" or "Premium Plugin" are omitted).
 * - Additional Issue Fixed is rendered only if it contains active issue rows.
 * - Returns { reportHtml, hasAdditionalIssues }.
 */
export function rowsToHtmlTable(rawRows) {
  const sections = parseReportSections(rawRows);

  const mainSections = sections.filter(
    (s) => s.type !== "additional_issue" && s.rows.length > 0,
  );
  const issueSection = sections.find((s) => s.type === "additional_issue");
  const premiumSection = sections.find((s) => s.type === "premium_plugin");

  const hasAdditionalIssues = Boolean(
    issueSection && issueSection.rows.length > 0,
  );
  const hasPremiumPlugins = Boolean(
    premiumSection && premiumSection.rows.length > 0,
  );

  let maxCols = 4;
  for (const sec of mainSections) {
    for (const r of sec.rows) {
      if (r.length > maxCols) maxCols = r.length;
    }
  }
  const pad = (row) => Array.from({ length: maxCols }, (_, i) => row[i] ?? "");

  const mainTable = renderMainSectionsTable(mainSections, maxCols, pad);
  const issueTable = hasAdditionalIssues
    ? renderIssueSectionTable(issueSection, pad)
    : "";

  const reportHtml =
    mainSections.length === 0 && !hasAdditionalIssues
      ? "<p><em>(No report content found on this tab.)</em></p>"
      : `${mainTable}${issueTable}`;

  return { reportHtml, hasAdditionalIssues, hasPremiumPlugins };
}

function renderMainSectionsTable(sections, numCols, pad) {
  if (sections.length === 0) return "";

  const colgroup =
    numCols === 4
      ? '<colgroup><col style="width:16%"><col style="width:48%"><col style="width:20%"><col style="width:16%"></colgroup>'
      : "";

  const renderedRows = [];

  for (const sec of sections) {
    // Render section band header
    renderedRows.push(
      `<tr><td colspan="${numCols}" style="${bandStyle}">${escapeHtml(sec.headerText)}</td></tr>`,
    );

    // Render data rows in this section
    for (const rawRow of sec.rows) {
      const row = pad(rawRow);
      let lastFilled = -1;
      for (let i = row.length - 1; i >= 0; i--) {
        if (String(row[i] ?? "").trim() !== "") {
          lastFilled = i;
          break;
        }
      }
      const trailingEmpty = numCols - 1 - lastFilled;

      const cells = row
        .slice(0, lastFilled + 1)
        .map((cell, i) => {
          const style = i === 0 ? firstColStyle : cellStyle;
          const isLast = i === lastFilled && trailingEmpty > 0;
          const colspanAttr = isLast ? ` colspan="${trailingEmpty + 1}"` : "";
          return `<td style="${style}"${colspanAttr}>${escapeHtml(cell)}</td>`;
        })
        .join("");

      renderedRows.push(`<tr>${cells}</tr>`);
    }
  }

  return `<table style="border-collapse:collapse;width:100%;max-width:${TABLE_MAX_WIDTH};margin:12px 0;table-layout:fixed;">${colgroup}${renderedRows.join("\n")}</table>`;
}

function renderIssueSectionTable(issueSection, pad) {
  const colgroup =
    '<colgroup><col style="width:28%"><col style="width:72%"></colgroup>';

  const issueLabelStyle =
    cellStyle.replace("vertical-align:middle;", "vertical-align:top;") +
    "font-weight:600;";
  const issueNoteStyle = cellStyle.replace(
    "vertical-align:middle;",
    "vertical-align:top;",
  );

  const headerBand = `<tr><td colspan="2" style="${bandStyle}">${escapeHtml(issueSection.headerText)}</td></tr>`;
  const subHeader = `<tr><td style="${subHeaderStyle}vertical-align:top;">Title</td><td style="${subHeaderStyle}vertical-align:top;">Note</td></tr>`;

  const rows = issueSection.rows
    .map((rawRow) => {
      const row = pad(rawRow);
      const filled = row
        .map((c, i) => ({ i, v: String(c ?? "").trim() }))
        .filter((c) => c.v !== "");
      const label = filled[0] ? filled[0].v : "";
      const note = filled[1] ? filled[1].v : "";

      return `<tr><td style="${issueLabelStyle}">${escapeHtml(label)}</td><td style="${issueNoteStyle}">${escapeHtml(note)}</td></tr>`;
    })
    .join("\n");

  return `<table style="border-collapse:collapse;width:100%;max-width:${TABLE_MAX_WIDTH};margin:0;table-layout:fixed;">${colgroup}${headerBand}\n${subHeader}\n${rows}</table>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
