const { createClient } = require('../lib/tekmetric');
const { chicagoDate, validateDate, TIMEZONE } = require('../lib/shop-date');
const { technicianData } = require('../lib/technician-data');
const { buildTechnicianReport, unavailableReport } = require('../lib/technician-report');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mode = req.query?.report;
  if (!['completed', 'current'].includes(mode)) return res.status(400).json({ error: 'Choose completed or current report' });
  let date;
  try { if (mode === 'completed') date = validateDate(req.query?.date === undefined ? chicagoDate() : req.query.date); }
  catch { return res.status(400).json({ error: 'Use a valid YYYY-MM-DD reporting date', technicianReport: unavailableReport() }); }
  const identity = mode === 'completed' ? { date } : { historical: false };
  try {
    const data = await technicianData(createClient(), mode);
    const technicianReport = buildTechnicianReport(data.records, data.directory, mode, date);
    return res.status(200).json({ report: mode, timezone: TIMEZONE, ...identity, startedAt: data.startedAt, asOf: data.asOf, technicianReport });
  } catch {
    return res.status(503).json({ report: mode, timezone: TIMEZONE, ...identity, technicianReport: unavailableReport(), error: 'Technician report unavailable. Try again later.' });
  }
};
