const { createClient } = require('../lib/tekmetric');
const { chicagoDate, validateDate, TIMEZONE } = require('../lib/shop-date');
const { monthToDateSummary, RetrievalFailure, unavailableSummary } = require('../lib/month-summary');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  let date;
  try { date = validateDate(req.query?.date === undefined ? chicagoDate() : req.query.date); }
  catch { return res.status(400).json({ error: 'Use a valid YYYY-MM-DD reporting date', monthToDate: unavailableSummary() }); }
  try {
    const { start, end, totals, weeks } = await monthToDateSummary(createClient(), date);
    return res.status(200).json({ timezone: TIMEZONE, date, monthToDate: { start, end, totals, weeks }, updatedAt: new Date().toISOString() });
  } catch (error) {
    const reason = error instanceof RetrievalFailure ? error.reason : undefined;
    return res.status(503).json({ timezone: TIMEZONE, date, monthToDate: unavailableSummary(reason), error: 'Month to date data unavailable. Try again later.' });
  }
};
