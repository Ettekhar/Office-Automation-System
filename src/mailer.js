import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { config, getAccountConfig } from './config.js';

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
 */
export function buildEmail({
  websiteUrl,
  reportMonth,
  reportHtml,
  hasAdditionalIssues,
  hasPremiumPlugins,
  accountKey = 'CW',
  fromName = null,
}) {
  const acct = getAccountConfig(accountKey);
  const senderName = fromName || acct.fromName || config.fromName;

  const cleanUrl = String(websiteUrl ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const subject = `Website Maintenance Report for ${cleanUrl} (${reportMonth.monthLower}-${reportMonth.year})`;

  const premiumPluginsParagraph = hasPremiumPlugins
    ? '\n      <p>Premium Plugin (Required License): These plugin licenses have expired. We recommend renewing them for security reasons. Otherwise, the website may face security vulnerabilities or potential malware issues.</p>'
    : '';

  const additionalIssuesParagraph = hasAdditionalIssues
    ? '\n      <p>Additional Issues Fixed: Along with the scheduled maintenance, we resolved additional issues identified on the website.</p>'
    : '';

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

      <p>Best Regards,</p>
    </div>
  `;
  return { subject, html };
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendReportEmail({ to, subject, html, dryRun, accountKey = 'CW' }) {
  const acct = getAccountConfig(accountKey);

  if (dryRun) {
    const previewDir = path.resolve('dry-run-previews');
    fs.mkdirSync(previewDir, { recursive: true });
    const safeName = subject.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
    const previewPath = path.join(previewDir, `${safeName}.html`);
    fs.writeFileSync(
      previewPath,
      `<!doctype html><html><head><meta charset="utf-8"><title>${subject}</title></head>` +
      `<body style="max-width:650px;margin:20px auto;font-family:Arial,sans-serif;">` +
      `<div style="background:#f4f4f4;padding:12px;margin-bottom:16px;border-radius:6px;font-size:13px;">` +
      `<strong>Workspace / Account:</strong> ${acct.name} (${acct.key})<br/>` +
      `<strong>From:</strong> &quot;${acct.fromName}&quot; &lt;${acct.fromEmail}&gt;<br/>` +
      `<strong>To:</strong> ${to.join(', ')}<br/><strong>Subject:</strong> ${subject}</div>` +
      `${html}</body></html>`
    );

    console.log(`--- DRY RUN [${acct.key} - ${acct.fromEmail}]: would send email ---`);
    console.log('To:', to.join(', '));
    console.log('Subject:', subject);
    console.log('Preview saved:', previewPath);
    console.log('-------------------------------------------------------------\n');
    return { dryRun: true, previewPath, account: acct.key };
  }

  const t = getTransporter(accountKey);
  const info = await t.sendMail({
    from: `"${acct.fromName}" <${acct.fromEmail}>`,
    to: to.join(', '),
    bcc: acct.bccEmail || undefined,
    subject,
    html,
  });
  return info;
}

