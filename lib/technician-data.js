const { paginate, id } = require('./pagination');
const { employeeDirectory } = require('./employees');
const LIMITS = Object.freeze({ pages: 10, requests: 64 });
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
async function technicianData(client, mode, limits = LIMITS) {
  if (mode === 'completed') throw new RetrievalFailure(HISTORY_REASON);
  const api = limitedClient(client, limits.requests);
  const startedAt = new Date().toISOString();
  let records;
  const scope = 'Current Tech Board statuses 1,2,3';
  try {
    // Use the existing client's URLSearchParams encoding, including arrays.
    records = await paginate(api, '/jobs', { shop: api.shop, repairOrderStatusId: [1, 2, 3] }, limits.pages);
  } catch (error) {
    if (error.message === 'Pagination limit exceeded') throw new RetrievalFailure(`${scope}: retrieval exceeded ${limits.pages} pages of 100 jobs; additional pages remain.`);
    if (api.limitReached) throw new RetrievalFailure(`${scope}: the ${limits.requests}-request report budget was exhausted.`);
    throw new RetrievalFailure(`${scope}: the upstream request or complete pagination response could not be validated. No partial totals are shown.`);
  }
  for (const job of records) if (job.shopId !== undefined && id(job.shopId) !== api.shop) throw new Error('Wrong job shop');
  let directory = null;
  try { directory = await employeeDirectory(api); } catch { /* Directory failure only affects names. */ }
  if (api.limitReached) throw new RetrievalFailure(`Employee directory: the ${limits.requests}-request report budget was exhausted.`);
  return { records, directory, startedAt, asOf: new Date().toISOString() };
}
module.exports = { technicianData, limitedClient, LIMITS, RetrievalFailure, HISTORY_REASON };
