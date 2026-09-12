const { paginate, mapLimit, unique, id } = require('./pagination');
const { employeeDirectory } = require('./employees');
// Current Tech Board scans a live open-RO queue, not a single day, so it needs a larger
// request budget than a single-day report; the client's own request timeout/deadline
// (lib/tekmetric.js) still bounds worst-case wall-clock time.
const LIMITS = Object.freeze({ pages: 10, requests: 300, orderConcurrency: 8 });
const STATUSES = Object.freeze([1, 2, 3]);
const SCOPE = 'Current Tech Board statuses 1,2,3';
class RetrievalFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function limitedClient(client, maxRequests = LIMITS.requests) {
  let requests = 0, limitReached = false;
  return { shop: client.shop, get limitReached() { return limitReached; }, get(path, query) {
    if (++requests > maxRequests) { limitReached = true; throw new Error('Retrieval limit'); }
    return client.get(path, query);
  } };
}
const HISTORY_REASON = 'Tekmetric does not provide a verified job completed-date filter; scanning complete shop history is not safe for live reporting.';
function upstreamFailure(api, limits, error, pageUnit) {
  if (error.message === 'Pagination limit exceeded') return new RetrievalFailure(`${SCOPE}: retrieval exceeded ${limits.pages} pages of 100 ${pageUnit}; additional pages remain.`);
  if (api.limitReached) return new RetrievalFailure(`${SCOPE}: the ${limits.requests}-request report budget was exhausted.`);
  return new RetrievalFailure(`${SCOPE}: the upstream request or complete pagination response could not be validated. No partial totals are shown.`);
}
// Uses the same proven /repair-orders retrieval already reconciled for shop and advisor
// reporting (lib/daily-financials.js), instead of the /jobs repairOrderStatusId array
// query that could not be validated live.
async function currentRepairOrders(api, limits) {
  let pages;
  try {
    pages = await mapLimit(STATUSES, STATUSES.length, status => paginate(api, '/repair-orders', { shop: api.shop, repairOrderStatusId: status }, limits.pages));
  } catch (error) { throw upstreamFailure(api, limits, error, 'repair orders'); }
  try {
    return unique(pages.flat(), ro => {
      if (ro.shopId !== undefined && id(ro.shopId) !== api.shop) throw new Error('Wrong shop');
      if (!STATUSES.includes(ro.repairOrderStatus?.id)) throw new Error('Wrong status');
      return { id: id(ro.id), status: ro.repairOrderStatus.id };
    });
  } catch { throw new RetrievalFailure(`${SCOPE}: repair order records could not be validated. No partial totals are shown.`); }
}
async function currentJobs(api, orders, limits) {
  let jobsByOrder;
  try {
    jobsByOrder = await mapLimit(orders, limits.orderConcurrency, async order => {
      const rows = await paginate(api, '/jobs', { shop: api.shop, repairOrderId: order.id, authorized: true }, limits.pages);
      for (const job of rows) if (job.repairOrderId !== undefined && id(job.repairOrderId) !== order.id) throw new Error('Wrong repair order');
      return rows;
    });
  } catch (error) { throw upstreamFailure(api, limits, error, 'jobs'); }
  try { return unique(jobsByOrder.flat(), job => job); }
  catch { throw new RetrievalFailure(`${SCOPE}: duplicate job records disagree. No partial totals are shown.`); }
}
async function technicianData(client, mode, limits = LIMITS) {
  if (mode === 'completed') throw new RetrievalFailure(HISTORY_REASON);
  const api = limitedClient(client, limits.requests);
  const startedAt = new Date().toISOString();
  const orders = await currentRepairOrders(api, limits);
  const records = await currentJobs(api, orders, limits);
  let directory = null;
  try { directory = await employeeDirectory(api); } catch { /* Directory failure only affects names. */ }
  if (api.limitReached) throw new RetrievalFailure(`Employee directory: the ${limits.requests}-request report budget was exhausted.`);
  return { records, directory, startedAt, asOf: new Date().toISOString() };
}
module.exports = { technicianData, limitedClient, LIMITS, RetrievalFailure, HISTORY_REASON };
