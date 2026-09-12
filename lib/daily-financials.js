const { postedDay, broadRange } = require('./shop-date');
const { paginate, mapLimit, unique, id } = require('./pagination');
const COST_REASON = 'Cost data not available through the verified API';
const unavailable = reason => ({ available: false, value: null, reason });
const available = value => ({ available: true, value });
function emptyMetrics(reason = 'Daily data unavailable') {
  return { salesCents: unavailable(reason), repairOrderCount: unavailable(reason), averageRoCents: unavailable(reason), hoursSold: unavailable(reason), grossProfit: unavailable(COST_REASON) };
}
function safeInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid cents');
  return value;
}
function qualifyingOrders(records, date) {
  return unique(records, ro => {
    if (![5, 6].includes(ro.repairOrderStatus?.id)) throw new Error('Invalid RO status');
    // Both eligible statuses form one population, even if an RO moves to A/R.
    return { id: id(ro.id), day: postedDay(ro.postedDate), cents: ['laborSales', 'partsSales', 'subletSales', 'feeTotal', 'discountTotal'].map(field => safeInteger(ro[field])) };
  }).filter(ro => ro.day === date);
}
function sales(orders) {
  let cents = 0n;
  for (const ro of orders) {
    const [labor, parts, sublet, fee, discount] = ro.cents.map(BigInt);
    cents += labor + parts + sublet + fee - discount;
  }
  const total = safeInteger(Number(cents));
  return { salesCents: available(total), repairOrderCount: available(orders.length), averageRoCents: orders.length ? available(total / orders.length) : unavailable('No qualifying repair orders') };
}
function hours(records) {
  const jobs = unique(records, job => {
    if (job.authorized !== true || typeof job.archived !== 'boolean') throw new Error('Invalid job flags');
    if (job.archived) return { id: id(job.id), archived: true };
    if (!Array.isArray(job.labor)) throw new Error('Missing labor');
    return { id: id(job.id), archived: false, labor: unique(job.labor, line => {
      if (typeof line.hours !== 'number' || !Number.isFinite(line.hours) || line.hours < 0) throw new Error('Invalid hours');
      return { id: id(line.id), hours: line.hours };
    }).sort((a, b) => a.id.localeCompare(b.id)) };
  });
  const lines = unique(jobs.filter(job => !job.archived).flatMap(job => job.labor), line => line);
  const result = lines.reduce((sum, line) => sum + line.hours, 0);
  if (!Number.isFinite(result)) throw new Error('Invalid hours total');
  return result;
}
async function dailyDataset(client, date) {
  const pages = await mapLimit([5, 6], 2, status => paginate(client, '/repair-orders', { shop: client.shop, ...broadRange(date), repairOrderStatusId: status }));
  for (const ro of pages.flat()) {
    if (ro.shopId !== undefined && id(ro.shopId) !== client.shop) throw new Error('Wrong shop');
  }
  const orders = qualifyingOrders(pages.flat(), date);
  const metrics = { ...emptyMetrics(), ...sales(orders) };
  let jobsByOrder = null;
  try {
    const jobs = await mapLimit(orders, 4, async ro => {
      const rows = await paginate(client, '/jobs', { shop: client.shop, repairOrderId: ro.id, authorized: true });
      for (const row of rows) if (row.repairOrderId !== undefined && id(row.repairOrderId) !== ro.id) throw new Error('Wrong repair order');
      return rows;
    });
    metrics.hoursSold = available(hours(jobs.flat()));
    jobsByOrder = orders.map((ro, index) => ({ repairOrderId: ro.id, jobs: jobs[index] }));
  } catch { metrics.hoursSold = unavailable('Approved labor data unavailable'); }
  // Assignment conflicts do not invalidate independently verified shop totals.
  const { employeeId } = require('./employees');
  const assignmentsByOrder = new Map();
  for (const ro of pages.flat()) {
    const key = id(ro.id);
    if (!assignmentsByOrder.has(key)) assignmentsByOrder.set(key, []);
    assignmentsByOrder.get(key).push(ro);
  }
  for (const order of orders) {
    const assignments = assignmentsByOrder.get(order.id).map(ro => {
      if (ro.serviceWriterId === null || ro.serviceWriterId === undefined) return { status: 'unassigned', serviceWriterId: null };
      try { return { status: 'assigned', serviceWriterId: employeeId(ro.serviceWriterId) }; }
      catch { return { status: 'invalid', serviceWriterId: null }; }
    });
    order.assignment = assignments.every(value => JSON.stringify(value) === JSON.stringify(assignments[0]))
      ? assignments[0] : { status: 'conflict', serviceWriterId: null };
  }
  return { metrics, orders, jobsByOrder };
}
async function dailySummary(client, date) {
  return (await dailyDataset(client, date)).metrics;
}
module.exports = { dailyDataset, dailySummary, qualifyingOrders, sales, hours, emptyMetrics, COST_REASON };
