const { paginate, mapLimit, unique, id } = require('./pagination');
const { employeeDirectory } = require('./employees');
const LIMITS = Object.freeze({ pages: 10, parents: 200, requests: 64 });
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
  let records;
  if (mode === 'completed') {
    // No verified completion-date query filter: traverse the entire shop job population.
    // No postedDate filter or dependence on financial reporting populations.
    records = await paginate(api, '/jobs', { shop: api.shop }, limits.pages);
  } else {
    const pages = await mapLimit([1, 2, 3], 2, async status => {
      const rows = await paginate(api, '/repair-orders', { shop: api.shop, repairOrderStatusId: status }, limits.pages);
      for (const ro of rows) {
        if (ro.repairOrderStatus?.id !== status || (ro.shopId !== undefined && id(ro.shopId) !== api.shop)) throw new Error('Invalid parent population');
      }
      return rows;
    });
    const parents = unique(pages.flat(), ro => ({ id: id(ro.id), status: ro.repairOrderStatus.id }));
    if (parents.length > limits.parents) throw new Error('Parent limit');
    const jobs = await mapLimit(parents, 4, async parent => {
      const rows = await paginate(api, '/jobs', { shop: api.shop, repairOrderId: parent.id }, limits.pages);
      return rows.map(job => {
        if (job.repairOrderId !== undefined && id(job.repairOrderId) !== parent.id) throw new Error('Conflicting parent');
        return { ...job, repairOrderId: parent.id };
      });
    });
    records = jobs.flat();
  }
  for (const job of records) if (job.shopId !== undefined && id(job.shopId) !== api.shop) throw new Error('Wrong job shop');
  let directory = null;
  // The same request/deadline budget applies. Directory failure only affects names.
  try { directory = await employeeDirectory(api); } catch { /* No raw upstream error escapes. */ }
  if (api.limitReached) throw new Error('Retrieval limit');
  return { records, directory, startedAt, asOf: new Date().toISOString() };
}
module.exports = { technicianData, limitedClient, LIMITS };
