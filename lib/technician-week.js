const { paginate, mapLimit, unique, id } = require('./pagination');
const { employeeDirectory, employeeId } = require('./employees');
const { weekRange, postedDay } = require('./shop-date');
const STATUSES = Object.freeze([5, 6]);
const SCOPE = 'Technician hours this week';
const ORDER_CONCURRENCY = 6;
class RetrievalFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const metric = value => ({ available: true, value });
const unavailableMetric = () => ({ available: false, value: null, reason: 'Technician week data unavailable' });
function unavailableReport(reason = 'Required technician data could not be validated. No partial totals are shown.') {
  return { status: 'unavailable', directoryStatus: 'unavailable', rows: [],
    totals: { hoursSold: unavailableMetric(), laborSalesCents: unavailableMetric() },
    reconciliation: { hoursSold: 'unavailable', laborSalesCents: 'unavailable' }, reason };
}
function safeInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid cents');
  return value;
}
function assignment(value) {
  if (value === null || value === undefined) return 'unassigned';
  try { return `employee:${employeeId(value)}`; } catch { return 'invalid'; }
}
function mergeAssignment(a, b) { return a === b ? a : 'invalid'; }
function qualifyingOrders(records, start, end) {
  return unique(records, ro => {
    if (![5, 6].includes(ro.repairOrderStatus?.id)) throw new Error('Invalid RO status');
    // Both eligible statuses form one population, even if an RO moves to A/R.
    return { id: id(ro.id), day: postedDay(ro.postedDate) };
  }).filter(ro => ro.day >= start && ro.day <= end);
}
async function weekData(client, date) {
  const { start, end, postedDateStart, postedDateEnd } = weekRange(date);
  let pages;
  try {
    pages = await mapLimit(STATUSES, STATUSES.length, status => paginate(client, '/repair-orders', { shop: client.shop, postedDateStart, postedDateEnd, repairOrderStatusId: status }));
  } catch { throw new RetrievalFailure(`${SCOPE}: repair order retrieval could not be validated. No partial totals are shown.`); }
  for (const ro of pages.flat()) if (ro.shopId !== undefined && id(ro.shopId) !== client.shop) throw new RetrievalFailure(`${SCOPE}: repair order records could not be validated. No partial totals are shown.`);
  let orders;
  try { orders = qualifyingOrders(pages.flat(), start, end); }
  catch { throw new RetrievalFailure(`${SCOPE}: repair order records could not be validated. No partial totals are shown.`); }
  let jobsByOrder;
  try {
    const jobs = await mapLimit(orders, ORDER_CONCURRENCY, async ro => {
      const rows = await paginate(client, '/jobs', { shop: client.shop, repairOrderId: ro.id, authorized: true });
      for (const row of rows) if (row.repairOrderId !== undefined && id(row.repairOrderId) !== ro.id) throw new Error('Wrong repair order');
      return rows;
    });
    jobsByOrder = orders.map((ro, index) => ({ repairOrderId: ro.id, jobs: jobs[index] }));
  } catch { throw new RetrievalFailure(`${SCOPE}: job retrieval could not be validated. No partial totals are shown.`); }
  return { start, end, jobsByOrder };
}
// Mirrors the eligibility already reconciled for shop/advisor hours (lib/daily-financials.js
// hours()): authorized jobs, archived jobs excluded entirely from both hours and labor sales.
function normalize(jobsByOrder) {
  const jobs = new Map();
  for (const parent of jobsByOrder) {
    for (const raw of parent.jobs) {
      if (raw.authorized !== true || typeof raw.archived !== 'boolean') throw new Error('Invalid job flags');
      if (raw.repairOrderId !== undefined && id(raw.repairOrderId) !== id(parent.repairOrderId)) throw new Error('Wrong repair order');
      const key = id(raw.id);
      const owner = assignment(raw.technicianId);
      let laborTotal = null, lines = [];
      if (!raw.archived) {
        laborTotal = safeInteger(raw.laborTotal);
        if (!Array.isArray(raw.labor)) throw new Error('Missing labor');
        const lineMap = new Map();
        for (const line of raw.labor) {
          const lineId = id(line?.id);
          if (typeof line.hours !== 'number' || !Number.isFinite(line.hours) || line.hours < 0) throw new Error('Invalid hours');
          const lineOwner = line.technicianId === null ? owner : assignment(line.technicianId);
          if (lineMap.has(lineId)) {
            const existing = lineMap.get(lineId);
            if (existing.hours !== line.hours) throw new Error('Conflicting labor quantity');
            existing.owner = mergeAssignment(existing.owner, lineOwner);
          } else lineMap.set(lineId, { id: lineId, hours: line.hours, owner: lineOwner });
        }
        lines = [...lineMap.values()].sort((a, b) => a.id.localeCompare(b.id));
      }
      const base = { id: key, parent: parent.repairOrderId, archived: raw.archived, laborTotal, lines: lines.map(({ owner, ...rest }) => rest) };
      if (jobs.has(key)) {
        const previous = jobs.get(key);
        if (JSON.stringify(previous.base) !== JSON.stringify(base)) throw new Error('Conflicting job record');
        previous.owner = mergeAssignment(previous.owner, owner);
        for (const line of lines) {
          const existing = previous.lines.find(candidate => candidate.id === line.id);
          existing.owner = mergeAssignment(existing.owner, line.owner);
        }
      } else jobs.set(key, { base, owner, lines });
    }
  }
  return [...jobs.values()];
}
function buildTechnicianWeekReport(jobsByOrder, directory) {
  const jobs = normalize(jobsByOrder);
  const groups = new Map();
  const group = key => {
    if (!groups.has(key)) groups.set(key, { hoursSold: 0, laborSalesCents: 0 });
    return groups.get(key);
  };
  let totalHours = 0, totalCents = 0;
  for (const job of jobs) {
    if (job.base.archived) continue;
    group(job.owner).laborSalesCents += job.base.laborTotal;
    totalCents += job.base.laborTotal;
    for (const line of job.lines) {
      group(line.owner).hoursSold += line.hours;
      totalHours += line.hours;
    }
  }
  if (!Number.isFinite(totalHours)) throw new Error('Invalid total hours');
  if (!Number.isSafeInteger(totalCents)) throw new Error('Invalid total labor sales');
  const rows = [...groups.entries()].map(([key, values]) => {
    const employee = key.startsWith('employee:') ? key.slice(9) : null;
    const assignmentStatus = key === 'invalid' ? 'invalid' : key === 'unassigned' ? 'unassigned' : directory === null ? 'name-unavailable' : directory.has(employee) ? 'matched' : 'unknown';
    const name = key === 'invalid' ? 'Invalid/conflicting assignment' : key === 'unassigned' ? 'Unassigned' : directory === null ? 'Technician name unavailable' : directory.get(employee) || 'Unknown technician';
    return { key, employeeId: employee, name, assignmentStatus, metrics: { hoursSold: metric(values.hoursSold), laborSalesCents: metric(values.laborSalesCents) } };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const sumHours = rows.reduce((sum, row) => sum + row.metrics.hoursSold.value, 0);
  const sumCents = rows.reduce((sum, row) => sum + row.metrics.laborSalesCents.value, 0);
  const matched = Math.abs(sumHours - totalHours) <= 1e-9 * Math.max(1, Math.abs(totalHours), Math.abs(sumHours)) && sumCents === totalCents;
  if (!matched) throw new Error('Reconciliation failed');
  return { status: directory !== null && rows.every(row => row.assignmentStatus === 'matched') ? 'complete' : 'partial', directoryStatus: directory === null ? 'unavailable' : 'complete', rows,
    totals: { hoursSold: metric(totalHours), laborSalesCents: metric(totalCents) }, reconciliation: { hoursSold: 'matched', laborSalesCents: 'matched' } };
}
async function technicianWeekReport(client, date) {
  const data = await weekData(client, date);
  let directory = null;
  try { directory = await employeeDirectory(client); } catch { /* Directory failure only affects names. */ }
  const technicianReport = buildTechnicianWeekReport(data.jobsByOrder, directory);
  return { weekStart: data.start, weekEnd: data.end, technicianReport };
}
module.exports = { technicianWeekReport, buildTechnicianWeekReport, weekData, unavailableReport, RetrievalFailure };
