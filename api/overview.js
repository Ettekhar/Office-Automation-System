import { getOverviewData } from '../src/dashboardApi.js';

export default async function handler(req, res) {
  try {
    const month = req.query.month || null;
    const account = req.query.account || 'all';
    const data = await getOverviewData(month, account);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

