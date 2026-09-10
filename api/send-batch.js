import { sendSingleEmail } from '../src/dashboardApi.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { emails, dryRun = false } = req.body || {};
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array is required' });
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
      await new Promise((r) => setTimeout(r, 200));
    }

    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

