import { getSitePreview } from '../src/dashboardApi.js';

export default async function handler(req, res) {
  try {
    const websiteUrl = req.query.websiteUrl;
    const month = req.query.month || null;
    const account = req.query.account || null;
    if (!websiteUrl) {
      return res.status(400).json({ error: 'websiteUrl query parameter is required' });
    }
    const data = await getSitePreview(websiteUrl, month, account);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

