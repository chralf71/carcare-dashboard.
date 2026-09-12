const { paginate, mapLimit, id } = require('./pagination');
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
async function technicianData(client, mode, limits = LIMITS) {
  const api = limitedClient(client, limits.requests);
  const startedAt = new Date().toISOString();
  async function jobs(status) {
    const scope = status === undefined ? 'Completed history (all shop jobs)' : `Current Tech Board status ${status}`;
    try {
      return await paginate(api, '/jobs', { shop: api.shop, ...(status === undefined ? {} : { repairOrderStatusId: status }) }, limits.pages);
    } catch (error) {
      if (error.message === 'Pagination limit exceeded') {
        throw new RetrievalFailure(`${scope}: retrieval exceeded ${limits.pages} pages of 100 jobs; additional pages remain.`
          + (status === undefined ? ' No verified completedDate filter is available, so complete shop history is required.' : ''));
      }
      if (api.limitReached) throw new RetrievalFailure(`${scope}: the ${limits.requests}-request report budget was exhausted.`);
      throw new RetrievalFailure(`${scope}: the upstream request or complete pagination response could not be validated. This is not a confirmed retrieval-limit failure.`);
    }
  }
  // Separate API invocations, clients and budgets keep the two reports independent.
  // No verified completion filter: history must be scanned completely, never via postedDate.
  const records = mode === 'completed' ? await jobs()
    : (await mapLimit([1, 2, 3], 2, jobs)).flat();
  for (const job of records) if (job.shopId !== undefined && id(job.shopId) !== api.shop) throw new Error('Wrong job shop');
  let directory = null;
  try { directory = await employeeDirectory(api); } catch { /* Directory failure only affects names. */ }
  if (api.limitReached) throw new RetrievalFailure(`Employee directory: the ${limits.requests}-request report budget was exhausted.`);
  return { records, directory, startedAt, asOf: new Date().toISOString() };
}
module.exports = { technicianData, limitedClient, LIMITS, RetrievalFailure };
