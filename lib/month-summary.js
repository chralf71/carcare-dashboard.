const { paginate, mapLimit, unique, id } = require('./pagination');
const { monthToDateRange, weekRange, postedDay } = require('./shop-date');
const STATUSES = Object.freeze([5, 6]);
const SCOPE = 'Month to date sales';
class RetrievalFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const available = value => ({ available: true, value });
const unavailable = reason => ({ available: false, value: null, reason });
function emptyTotals(reason = 'Month to date data unavailable') {
  return { salesCents: unavailable(reason), repairOrderCount: unavailable(reason) };
}
function unavailableSummary(reason = 'Month to date data could not be validated. No partial totals are shown.') {
  return { start: null, end: null, totals: emptyTotals(reason), weeks: [], reason };
}
function safeInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid cents');
  return value;
}
// Mirrors the verified pre-tax sales formula already reconciled for shop/advisor
// reporting (lib/daily-financials.js), applied here to an arbitrary posted-date range.
function qualifyingOrders(records, start, end) {
  return unique(records, ro => {
    if (![5, 6].includes(ro.repairOrderStatus?.id)) throw new Error('Invalid RO status');
    return { id: id(ro.id), day: postedDay(ro.postedDate), cents: ['laborSales', 'partsSales', 'subletSales', 'feeTotal', 'discountTotal'].map(field => safeInteger(ro[field])) };
  }).filter(ro => ro.day >= start && ro.day <= end);
}
function sales(orders) {
  let cents = 0n;
  for (const ro of orders) {
    const [labor, parts, sublet, fee, discount] = ro.cents.map(BigInt);
    cents += labor + parts + sublet + fee - discount;
  }
  const total = safeInteger(Number(cents));
  return { salesCents: available(total), repairOrderCount: available(orders.length) };
}
async function periodOrders(client, start, end) {
  const midnightStart = Date.parse(`${start}T00:00:00Z`);
  const midnightEnd = Date.parse(`${end}T00:00:00Z`);
  // Broad UTC envelope contains the entire Chicago range across DST changes.
  const postedDateStart = new Date(midnightStart - 86400000).toISOString();
  const postedDateEnd = new Date(midnightEnd + 2 * 86400000).toISOString();
  let pages;
  try {
    pages = await mapLimit(STATUSES, STATUSES.length, status => paginate(client, '/repair-orders', { shop: client.shop, postedDateStart, postedDateEnd, repairOrderStatusId: status }));
  } catch { throw new RetrievalFailure(`${SCOPE}: repair order retrieval could not be validated. No partial totals are shown.`); }
  for (const ro of pages.flat()) if (ro.shopId !== undefined && id(ro.shopId) !== client.shop) throw new RetrievalFailure(`${SCOPE}: repair order records could not be validated. No partial totals are shown.`);
  try { return qualifyingOrders(pages.flat(), start, end); }
  catch { throw new RetrievalFailure(`${SCOPE}: repair order records could not be validated. No partial totals are shown.`); }
}
// Weekly rows partition the same qualifying-order set as the month-to-date total, so the
// two always reconcile exactly; a week overlapping the month boundary is labeled by its
// true Monday-Sunday range but only sums the days that actually fall within the month.
function weeklyBreakdown(orders) {
  const buckets = new Map();
  for (const ro of orders) {
    const { start: weekStart, end: weekEnd } = weekRange(ro.day);
    if (!buckets.has(weekStart)) buckets.set(weekStart, { weekStart, weekEnd, orders: [] });
    buckets.get(weekStart).orders.push(ro);
  }
  return [...buckets.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(bucket => ({ weekStart: bucket.weekStart, weekEnd: bucket.weekEnd, ...sales(bucket.orders) }));
}
async function monthToDateSummary(client, date) {
  const { start, end } = monthToDateRange(date);
  const orders = await periodOrders(client, start, end);
  const totals = sales(orders);
  const weeks = weeklyBreakdown(orders);
  const weekCents = weeks.reduce((sum, week) => sum + week.salesCents.value, 0);
  const weekOrders = weeks.reduce((sum, week) => sum + week.repairOrderCount.value, 0);
  if (weekCents !== totals.salesCents.value || weekOrders !== totals.repairOrderCount.value) throw new Error('Weekly breakdown does not reconcile with month to date total');
  return { start, end, totals, weeks };
}
module.exports = { monthToDateSummary, weeklyBreakdown, sales, qualifyingOrders, unavailableSummary, emptyTotals, RetrievalFailure };
