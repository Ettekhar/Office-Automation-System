import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, getAccountConfig } from './config.js';
import { safeExternalUrl } from './reportUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.resolve(__dirname, '../public/assets');

const transporterMap = new Map();

export function getTransporter(accountKey = 'CW') {
  const acct = getAccountConfig(accountKey);
  const cacheKey = `${acct.smtp.host}:${acct.smtp.port}:${acct.smtp.user}`;

  if (transporterMap.has(cacheKey)) {
    return transporterMap.get(cacheKey);
  }

  const transporter = nodemailer.createTransport({
    host: acct.smtp.host,
    port: acct.smtp.port,
    secure: acct.smtp.secure,
    auth: { user: acct.smtp.user, pass: acct.smtp.pass },
  });

  transporterMap.set(cacheKey, transporter);
  return transporter;
}

/**
 * websiteUrl + reportMonth (from getReportMonthInfo) drive the subject line:
 *   "Website Maintenance Report for themenhaden.com (july-2026)"
 * reportHtml is the copied grid from that site's report tab (columns A-D),
 * dropped verbatim into the fixed template below — not summarized or reworded.
 *
 * conditionalNotes is the list from resolveConditionalNotes(): one entry per
 * condition the site's report tab actually mentions. Each becomes a paragraph
 * just above the sign-off, with its link taken from the tab.
 */
export function buildEmail({
  websiteUrl,
  reportMonth,
  reportHtml,
  hasAdditionalIssues,
  hasPremiumPlugins,
  conditionalNotes = [],
  accountKey = 'CW',
  fromName = null,
}) {
  const acct = getAccountConfig(accountKey);
  const senderName = senderNameOf(acct, fromName);

  const cleanUrl = String(websiteUrl ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const subject = `Website Maintenance Report for ${cleanUrl} (${reportMonth.monthName} ${reportMonth.year})`;

  const premiumPluginsParagraph = hasPremiumPlugins
    ? '\n      <p>Premium Plugin (Required License): These plugin licenses have expired. We recommend renewing them for security reasons. Otherwise, the website may face security vulnerabilities or potential malware issues.</p>'
    : '';

  const additionalIssuesParagraph = hasAdditionalIssues
    ? '\n      <p>Additional Issues Fixed: Along with the scheduled maintenance, we resolved additional issues identified on the website.</p>'
    : '';

  const conditionalNoteParagraphs = renderConditionalNotes(conditionalNotes);
  const signatureHtml = renderAccountSignature(accountKey);

  const html = `
    <div style="font-family:Arial,sans-serif;color:#222;font-size:14px;line-height:1.5;">
      <p>Hi,</p>

      <p><strong>Maintenance Actions:</strong><br/>
      Plugin Updates: We updated all plugins to their latest versions to improve security, fix bugs and ensure optimal performance.</p>

      ${reportHtml}
${premiumPluginsParagraph}
${additionalIssuesParagraph}
      <p>Functionality Checks: We performed a quality assurance check to verify that all key website functions are working correctly.</p>

      <p>Responsiveness: Tested the website's layout on various devices (Desktop, Tablet, Mobile &ndash; Android &amp; iOS).</p>

      <p>Forms: Confirmed that all contact forms and other forms are fully operational.</p>

      <p>Everything is running smoothly. We'll continue to monitor your site for optimal performance.</p>
${conditionalNoteParagraphs}
      <p>Best Regards,</p>${signatureHtml}
    </div>
  `;
  return { subject, html };
}

function senderNameOf(acct, fromName) {
  return fromName || acct.fromName || config.fromName;
}

/**
 * Where the link goes inside the message. The operator writes the sentence they
 * want and marks the spot with {{link:…}}, optionally naming the words that
 * should BE the link:
 *
 *     …remediation details are available {{link:here}}.
 *     Read more at {{link:the security advisory}} for context.
 *     Click {{link}} to open it.                       → link reads "here"
 *
 * The label is optional so a message can read naturally whether or not the
 * author wants the word "here". Every marker in the message is honoured, so one
 * sentence can link the same document twice. Nothing is positional or
 * hardcoded: the marker is the whole mechanism.
 *
 * A message with no marker still works, which is why the already-registered
 * operator message was left untouched: the link goes onto the LAST standalone
 * "here", or — if the message has no "here" — the link is appended as its own
 * sentence rather than being silently dropped. If there is no link at all the
 * message renders as plain text, so the condition's content is never withheld
 * just because a URL is missing, and a marker degrades to its own label.
 *
 * A malformed marker ("{{link:oops" with no closing braces) is left as typed:
 * a visible typo the operator can spot beats a message silently rewritten.
 */
const LINK_MARKER = /\{\{\s*link\s*(?::\s*([^}]*?)\s*)?\}\}/gi;

/**
 * Turn resolved conditions into the paragraphs that sit above the sign-off.
 *
 * The message is operator-authored plain text held in the DB, so it is escaped
 * before anything else touches it. Only the anchors this function writes ever
 * become markup — escaping afterwards could not tell the href it had just
 * written from operator text, so the order is not negotiable.
 *
 * Message formatting is the operator's call, not a fixed single paragraph: a
 * blank line starts a new <p> and a single newline becomes <br/>, so a message
 * can be a paragraph, a list of lines, or several paragraphs. The split happens
 * after the links are placed, which is safe only because a marker label is
 * collapsed to a single line and a URL cannot contain a raw newline — so an
 * anchor can never be torn in half by a paragraph break.
 */
function renderConditionalNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return '';

  const paragraphs = [];
  for (const note of list) {
    const message = String(note?.message ?? '').trim();
    if (!message) continue;
    // Re-validated here, not just upstream: this is the exact point the href is
    // built, so the guarantee lives where the href is written.
    const url = safeExternalUrl(note?.url ?? '');
    const escaped = escapeHtml(message);
    // Link placement runs on the WHOLE message before it is split into
    // paragraphs. Deciding per paragraph would let the no-marker fallback fire on
    // the paragraphs that happened to omit a marker, appending a second, unasked
    // link to a message that had already placed its own.
    const linked = placeLinks(escaped, url);

    for (const block of linked.split(/\n{2,}/)) {
      const para = block.trim();
      if (!para) continue;
      paragraphs.push(`\n      <p>${para.replace(/\n/g, '<br/>')}</p>`);
    }
  }

  return paragraphs.length ? `\n${paragraphs.join('\n')}` : '';
}

/**
 * Place the link inside one already-escaped paragraph.
 *
 * Markers are honoured first. Only if the message used none — the legacy
 * "…available here." wording — does the link fall back to the last "here", so a
 * message that DID choose its own link position never also gets one imposed.
 */
function placeLinks(escapedParagraph, url) {
  LINK_MARKER.lastIndex = 0; // module-level regex is stateful with /g
  let sawMarker = false;
  const out = escapedParagraph.replace(LINK_MARKER, (whole, label) => {
    sawMarker = true;
    // Whitespace inside a label collapses to spaces so a marker typed across two
    // lines cannot push the </a> into the next paragraph.
    const text = String(label ?? '').replace(/\s+/g, ' ').trim() || 'here';
    return url ? anchor(text, escapeHtml(url)) : text;
  });
  if (sawMarker || !url) return out;
  return linkWithoutMarker(out, url);
}

/** Attach the link to the last standalone "here", or append it as its own sentence. */
function linkWithoutMarker(escaped, url) {
  const hereRe = /\bhere\b/gi;
  const last = [...escaped.matchAll(hereRe)].pop();
  if (last) {
    return escaped.slice(0, last.index) + anchor('here', escapeHtml(url))
      + escaped.slice(last.index + last[0].length);
  }
  return `${escaped} ${anchor(escapeHtml(url), escapeHtml(url))}`;
}

const ANCHOR_STYLE = 'color:#1155cc;text-decoration:underline';
function anchor(escapedLabel, escapedUrl) {
  return `<a href="${escapedUrl}" style="${ANCHOR_STYLE}">${escapedLabel}</a>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderAccountSignature(accountKey = 'CW') {
  const key = String(accountKey || '').trim().toUpperCase();
  if (key === 'RM') {
    return renderRmSignature();
  }
  if (key === 'CW') {
    return renderCwSignature();
  }
  return '';
}

function renderRmSignature() {
  return `
      <p style="color:#777;margin:12px 0 8px 0;font-size:13px;line-height:1;">--</p>
      <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;margin-top:6px;">
        <tr>
          <td valign="middle" style="padding-right:18px;vertical-align:middle;">
            <a href="https://www.razibmarketing.com" target="_blank" style="text-decoration:none;display:block;">
              <img src="/assets/rm-logo.png" alt="Razib Marketing" width="105" height="105" style="display:block;border:0;width:105px;height:105px;border-radius:4px;" />
            </a>
          </td>
          <td valign="middle" style="border-left:1px solid #dcdcdc;padding-left:18px;vertical-align:middle;line-height:1.45;">
            <div style="font-size:16px;font-weight:bold;color:#8cb811;margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.2px;">
              Razib Marketing Support
            </div>
            <div style="font-size:13px;color:#222222;margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;">
              <strong style="color:#222222;">Email:</strong> <a href="mailto:support@razibmarketing.com" style="color:#1155cc;text-decoration:underline;">support@razibmarketing.com</a>
            </div>
            <div style="font-size:13px;color:#222222;margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;">
              <strong style="color:#222222;">Website:</strong> <a href="https://www.razibmarketing.com" target="_blank" style="color:#1155cc;text-decoration:underline;">www.razibmarketing.com</a>
            </div>
            <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding-right:8px;vertical-align:middle;">
                  <a href="https://www.facebook.com/RazibMarketing" target="_blank" style="text-decoration:none;display:inline-block;">
                    <img src="/assets/icon-facebook.png" alt="Facebook" width="24" height="24" style="display:block;border:0;width:24px;height:24px;" />
                  </a>
                </td>
                <td style="vertical-align:middle;">
                  <a href="https://www.linkedin.com/company/razib-marketing/" target="_blank" style="text-decoration:none;display:inline-block;">
                    <img src="/assets/icon-linkedin.png" alt="LinkedIn" width="24" height="24" style="display:block;border:0;width:24px;height:24px;" />
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
}

function renderCwSignature() {
  return `
      <p style="color:#777;margin:12px 0 8px 0;font-size:13px;line-height:1;">--</p>
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#222;">
        <div style="font-size:16px;font-weight:bold;color:#888888;margin:0 0 4px 0;">Cogwheel Support</div>
        <div style="font-size:13px;margin:0 0 3px 0;">
          <a href="mailto:support@cogwheelmarketing.com" style="color:#1155cc;text-decoration:underline;font-weight:bold;">support@cogwheelmarketing.com</a>
        </div>
        <div style="font-size:13px;margin:0 0 12px 0;">
          <a href="https://cogwheelmarketing.com/" target="_blank" style="color:#1155cc;text-decoration:underline;">cogwheelmarketing.com</a>
        </div>
        <div style="margin:0 0 10px 0;">
          <a href="https://cogwheelmarketing.com/" target="_blank" style="text-decoration:none;display:inline-block;">
            <img src="/assets/cw-logo.jpg" alt="Cogwheel Marketing" width="220" height="73" style="display:block;border:0;width:220px;height:73px;" />
          </a>
        </div>
        <div style="font-size:13px;color:#888888;margin:0;">
          *Sign Up for Newsletters <a href="http://eepurl.com/dxGxJ5" target="_blank" style="color:#1155cc;text-decoration:underline;">HERE</a>
        </div>
      </div>`;
}

const EMAIL_ASSET_SPECS = [
  {
    cid: 'rm-logo',
    filename: 'rm-logo.png',
    filePath: path.join(ASSETS_DIR, 'rm-logo.png'),
    patterns: [/src=["']?(?:cid:rm-logo|\/assets\/rm-logo\.png)["']?/gi],
    mimeType: 'image/png',
  },
  {
    cid: 'rm-facebook',
    filename: 'icon-facebook.png',
    filePath: path.join(ASSETS_DIR, 'icon-facebook.png'),
    patterns: [/src=["']?(?:cid:rm-facebook|\/assets\/icon-facebook\.png)["']?/gi],
    mimeType: 'image/png',
  },
  {
    cid: 'rm-linkedin',
    filename: 'icon-linkedin.png',
    filePath: path.join(ASSETS_DIR, 'icon-linkedin.png'),
    patterns: [/src=["']?(?:cid:rm-linkedin|\/assets\/icon-linkedin\.png)["']?/gi],
    mimeType: 'image/png',
  },
  {
    cid: 'cw-logo',
    filename: 'cw-logo.jpg',
    filePath: path.join(ASSETS_DIR, 'cw-logo.jpg'),
    patterns: [/src=["']?(?:cid:cw-logo|\/assets\/cw-logo\.jpg)["']?/gi],
    mimeType: 'image/jpeg',
  },
];

export function prepareEmailAttachments(html) {
  let finalHtml = html;
  const attachments = [];

  for (const asset of EMAIL_ASSET_SPECS) {
    let matched = false;
    for (const pattern of asset.patterns) {
      if (pattern.test(finalHtml)) {
        matched = true;
        finalHtml = finalHtml.replace(pattern, `src="cid:${asset.cid}"`);
      }
    }
    if (matched && fs.existsSync(asset.filePath)) {
      attachments.push({
        filename: asset.filename,
        path: asset.filePath,
        cid: asset.cid,
      });
    }
  }

  return { finalHtml, attachments };
}

export function inlineImagesForOfflinePreview(html) {
  let out = html;
  for (const asset of EMAIL_ASSET_SPECS) {
    if (fs.existsSync(asset.filePath)) {
      const b64 = fs.readFileSync(asset.filePath).toString('base64');
      const mimeType = asset.mimeType || (asset.filename.endsWith('.jpg') || asset.filename.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
      const dataUri = `data:${mimeType};base64,${b64}`;
      for (const pattern of asset.patterns) {
        out = out.replace(pattern, `src="${dataUri}"`);
      }
    }
  }
  return out;
}

export async function sendReportEmail({ to, subject, html, dryRun, accountKey = 'CW', attachments = [] }) {
  const acct = getAccountConfig(accountKey);

  if (dryRun) {
    const previewDir = path.resolve('dry-run-previews');
    fs.mkdirSync(previewDir, { recursive: true });
    const safeName = subject.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
    const previewPath = path.join(previewDir, `${safeName}.html`);
    const previewHtml = inlineImagesForOfflinePreview(html);
    fs.writeFileSync(
      previewPath,
      `<!doctype html><html><head><meta charset="utf-8"><title>${subject}</title></head>` +
      `<body style="max-width:650px;margin:20px auto;font-family:Arial,sans-serif;">` +
      `<div style="background:#f4f4f4;padding:12px;margin-bottom:16px;border-radius:6px;font-size:13px;">` +
      `<strong>Workspace / Account:</strong> ${acct.name} (${acct.key})<br/>` +
      `<strong>From:</strong> &quot;${acct.fromName}&quot; &lt;${acct.fromEmail}&gt;<br/>` +
      `<strong>To:</strong> ${to.join(', ')}<br/><strong>Subject:</strong> ${subject}</div>` +
      `${previewHtml}</body></html>`
    );

    console.log(`--- DRY RUN [${acct.key} - ${acct.fromEmail}]: would send email ---`);
    console.log('To:', to.join(', '));
    console.log('Subject:', subject);
    console.log('Preview saved:', previewPath);
    console.log('-------------------------------------------------------------\n');
    return { dryRun: true, previewPath, account: acct.key };
  }

  const { finalHtml, attachments: autoAttachments } = prepareEmailAttachments(html);
  const allAttachments = [...(attachments || []), ...autoAttachments];

  const t = getTransporter(accountKey);
  const mailOptions = {
    from: `"${acct.fromName}" <${acct.fromEmail}>`,
    to: to.join(', '),
    bcc: acct.bccEmail || undefined,
    subject,
    html: finalHtml,
  };
  if (allAttachments.length > 0) {
    mailOptions.attachments = allAttachments;
  }
  const info = await t.sendMail(mailOptions);
  return info;
}


