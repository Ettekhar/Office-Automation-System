import { generateAllPreviews } from '../src/dashboardApi.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const month = req.query.month || (req.body && req.body.month) || null;
    const account = req.query.account || (req.body && req.body.account) || 'all';
    const data = await generateAllPreviews(month, account);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

