const { sales, hours, emptyMetrics } = require('./daily-financials');
const { employeeDirectory } = require('./employees');
const { id } = require('./pagination');
const HOURS_TOLERANCE = 1e-9;
function unavailableReport() {
  return { status: 'unavailable', directoryStatus: 'unavailable', selectionMode: 'all', rows: [], reconciliation: { salesCents: 'unavailable', repairOrderCount: 'unavailable', hoursSold: 'unavailable' } };
}
function reconcile(rows, shop) {
  const result = {};
  for (const key of ['salesCents', 'repairOrderCount', 'hoursSold']) {
    if (!shop[key].available || rows.some(row => !row.metrics[key].available)) { result[key] = 'unavailable'; continue; }
    if (key === 'hoursSold') {
      const total = rows.reduce((sum, row) => sum + row.metrics[key].value, 0);
      result[key] = Math.abs(total - shop[key].value) <= HOURS_TOLERANCE * Math.max(1, Math.abs(total), Math.abs(shop[key].value)) ? 'matched' : 'mismatch';
    } else {
      const total = rows.reduce((sum, row) => sum + BigInt(row.metrics[key].value), 0n);
      result[key] = total === BigInt(shop[key].value) ? 'matched' : 'mismatch';
    }
  }
  return result;
}
function buildAdvisorReport(dataset, directory) {
  const groups = new Map();
  for (const order of dataset.orders) {
    const assignment = order.assignment;
    let key, name, assignmentStatus, employeeId = assignment.serviceWriterId;
    if (assignment.status === 'unassigned') { key = 'unassigned'; name = 'Unassigned'; assignmentStatus = 'unassigned'; }
    else if (['invalid', 'conflict'].includes(assignment.status)) { key = 'invalid'; name = 'Invalid assignment'; assignmentStatus = 'invalid'; }
    else {
      key = `employee:${employeeId}`;
      name = directory === null ? 'Advisor name unavailable' : directory.get(employeeId) || 'Unknown advisor';
      assignmentStatus = directory === null ? 'name-unavailable' : directory.has(employeeId) ? 'matched' : 'unknown';
    }
    if (!groups.has(key)) groups.set(key, { key, employeeId, name, assignmentStatus, orders: [] });
    groups.get(key).orders.push(order);
  }
  // Detect ambiguous ownership globally before allocating deduplicated hours.
  let hoursValid = dataset.jobsByOrder !== null;
  const jobOwners = new Map(), lineOwners = new Map();
  try {
    for (const parent of dataset.jobsByOrder || []) for (const job of parent.jobs) {
      const jobId = id(job.id);
      if (jobOwners.has(jobId) && jobOwners.get(jobId) !== parent.repairOrderId) throw new Error('Ambiguous job owner');
      jobOwners.set(jobId, parent.repairOrderId);
      if (job.archived) continue;
      for (const line of job.labor) {
        const lineId = id(line.id);
        if (lineOwners.has(lineId) && lineOwners.get(lineId) !== parent.repairOrderId) throw new Error('Ambiguous labor owner');
        lineOwners.set(lineId, parent.repairOrderId);
      }
    }
  } catch { hoursValid = false; }
  const jobs = new Map((dataset.jobsByOrder || []).map(parent => [parent.repairOrderId, parent.jobs]));
  const rows = [...groups.values()].map(group => {
    const metrics = { ...emptyMetrics('Advisor labor data unavailable'), ...sales(group.orders) };
    if (hoursValid) metrics.hoursSold = { available: true, value: hours(group.orders.flatMap(order => jobs.get(order.id))) };
    return { key: group.key, employeeId: group.employeeId, name: group.name, assignmentStatus: group.assignmentStatus, metrics };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const reconciliation = reconcile(rows, dataset.metrics);
  return {
    status: directory !== null && rows.every(row => row.assignmentStatus === 'matched') && Object.values(reconciliation).every(value => value === 'matched') ? 'complete' : 'partial',
    directoryStatus: directory === null ? 'unavailable' : 'complete', selectionMode: 'all', rows, reconciliation,
  };
}
async function advisorReport(client, dataset) {
  let directory = null;
  try { directory = await employeeDirectory(client); } catch { /* Keep the validated shop report. */ }
  try { return buildAdvisorReport(dataset, directory); } catch { return unavailableReport(); }
}
module.exports = { advisorReport, buildAdvisorReport, reconcile, unavailableReport, HOURS_TOLERANCE };
