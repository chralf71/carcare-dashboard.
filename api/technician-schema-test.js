// TEMPORARY sandbox-only schema probe. Remove after Phase 3 schema validation.
// Documentation verifies job technicianId/completedDate and labor technicianId/hours/complete.
// A labor completedDate is NOT documented; presence alone cannot establish semantics.
const { createClient } = require('../lib/tekmetric');
const { readPage, mapLimit, unique, id } = require('../lib/pagination');
const own = (object, field) => Object.prototype.hasOwnProperty.call(object, field);
function assignmentKind(value) {
  if (value === null) return 'null';
  return Number.isSafeInteger(value) && value > 0 ? 'numeric' : 'malformed';
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let hostname;
  try { hostname = new URL(process.env.TEKMETRIC_BASE_URL).hostname; } catch { /* Fail closed. */ }
  if (hostname !== 'sandbox.tekmetric.com') return res.status(403).json({ error: 'Sandbox only' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // At most five upstream calls: one token, one RO page, three job pages.
    const client = createClient(process.env, fetch, { timeoutMs: 4000, budgetMs: 12000 });
    const parentPage = await readPage(client, '/repair-orders', { shop: client.shop }, 0, 3);
    const parents = unique(parentPage.content, ro => {
      if (ro.shopId !== undefined && id(ro.shopId) !== client.shop) throw new Error('Wrong shop');
      const status = ro.repairOrderStatus?.id;
      if (!Number.isInteger(status) || status < 1 || status > 7) throw new Error('Invalid status');
      return { id: id(ro.id), status };
    });
    const samples = await mapLimit(parents, 2, async parent => {
      const page = await readPage(client, '/jobs', { shop: client.shop, repairOrderId: parent.id }, 0, 3);
      const jobs = page.content.map(job => {
        if (job.repairOrderId !== undefined && id(job.repairOrderId) !== parent.id) throw new Error('Wrong parent');
        if (!Array.isArray(job.labor)) throw new Error('Missing labor array');
        return {
          id: id(job.id), parentId: parent.id,
          technicianPresent: own(job, 'technicianId'), technicianKind: assignmentKind(job.technicianId),
          completedDatePresent: own(job, 'completedDate'), completePresent: own(job, 'complete'),
          laborTruncated: job.labor.length > 30,
          labor: job.labor.slice(0, 30).map(line => {
            if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error('Invalid labor');
            return { id: id(line.id), technicianPresent: own(line, 'technicianId'), technicianKind: assignmentKind(line.technicianId),
              completedDatePresent: own(line, 'completedDate'), completePresent: own(line, 'complete') };
          }),
        };
      });
      return { jobs, truncated: page.totalElements > page.content.length };
    });
    const jobs = unique(samples.flatMap(sample => sample.jobs), job => job);
    const lines = unique(jobs.flatMap(job => job.labor.map(line => ({ ...line, parentJob: job.id }))), line => line);
    const flags = records => ({
      numeric: records.some(record => record.technicianPresent && record.technicianKind === 'numeric'),
      null: records.some(record => record.technicianPresent && record.technicianKind === 'null'),
      malformed: records.some(record => record.technicianPresent && record.technicianKind === 'malformed'),
    });
    // Explicit allowlist only. Never spread source records into this response.
    return res.status(200).json({
      temporary: true, sampleOnly: true,
      sampleTruncated: parentPage.totalElements > parentPage.content.length || samples.some(sample => sample.truncated) || jobs.some(job => job.laborTruncated),
      jobsInspected: jobs.length,
      laborLinesInspected: lines.length,
      jobTechnicianIdPresentCount: jobs.filter(job => job.technicianPresent).length,
      laborTechnicianIdPresentCount: lines.filter(line => line.technicianPresent).length,
      jobCompletedDatePresentCount: jobs.filter(job => job.completedDatePresent).length,
      laborCompletedDatePresentCount: lines.filter(line => line.completedDatePresent).length,
      jobCompleteFieldPresentCount: jobs.filter(job => job.completePresent).length,
      laborCompleteFieldPresentCount: lines.filter(line => line.completePresent).length,
      observedParentRoStatusIds: [...new Set(parents.map(parent => parent.status))].sort((a, b) => a - b),
      jobAssignmentTypesObserved: flags(jobs),
      laborAssignmentTypesObserved: flags(lines),
    });
  } catch { return res.status(503).json({ error: 'Schema sample unavailable' }); }
};
