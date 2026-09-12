const { createClient } = require('../lib/tekmetric');
const { chicagoDate, validateDate, TIMEZONE } = require('../lib/shop-date');
const { technicianWeekReport, RetrievalFailure, unavailableReport } = require('../lib/technician-week');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  let date;
  try { date = validateDate(req.query?.date === undefined ? chicagoDate() : req.query.date); }
  catch { return res.status(400).json({ error: 'Use a valid YYYY-MM-DD reporting date', technicianReport: unavailableReport() }); }
  try {
    const { weekStart, weekEnd, technicianReport } = await technicianWeekReport(createClient(), date);
    return res.status(200).json({ report: 'week', timezone: TIMEZONE, date, weekStart, weekEnd, asOf: new Date().toISOString(), technicianReport });
  } catch (error) {
    const reason = error instanceof RetrievalFailure ? error.reason : undefined;
    return res.status(503).json({ report: 'week', timezone: TIMEZONE, date, technicianReport: unavailableReport(reason), error: 'Technician report unavailable. Try again later.' });
  }
};
