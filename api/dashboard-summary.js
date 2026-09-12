const { createClient } = require('../lib/tekmetric');
const { chicagoDate, validateDate, TIMEZONE } = require('../lib/shop-date');
const { dailyDataset, emptyMetrics } = require('../lib/daily-financials');
const { advisorReport, unavailableReport } = require('../lib/advisor-report');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  let date;
  try { date = validateDate(req.query?.date === undefined ? chicagoDate() : req.query.date); }
  catch { return res.status(400).json({ error: 'Use a valid YYYY-MM-DD reporting date', metrics: emptyMetrics(), advisorReport: unavailableReport() }); }
  try {
    const client = createClient();
    const dataset = await dailyDataset(client, date);
    const advisors = await advisorReport(client, dataset);
    const metrics = dataset.metrics;
    return res.status(200).json({ date, timezone: TIMEZONE, metrics, advisorReport: advisors, updatedAt: new Date().toISOString() });
  } catch {
    return res.status(503).json({ date, timezone: TIMEZONE, metrics: emptyMetrics(), advisorReport: unavailableReport(), error: 'Daily data unavailable. Try again later.' });
  }
};
