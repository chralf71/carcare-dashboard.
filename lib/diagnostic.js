const { createClient } = require('./tekmetric');
// Legacy diagnostic URLs return connectivity only, never record data.
module.exports = async function diagnostic(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.ENABLE_DIAGNOSTICS !== 'true') return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await createClient().authenticate();
    return res.status(200).json({ connected: true });
  } catch { return res.status(503).json({ connected: false, error: 'Connection unavailable' }); }
};
