function id(value) {
  if (!(typeof value === 'string' && value.trim()) && !(Number.isSafeInteger(value) && value >= 0)) throw new Error('Missing record ID');
  return String(value);
}
async function paginate(client, path, query, maxPages = 1000) {
  const records = [], seenPages = new Set();
  let total, pages;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.get(path, { ...query, page, size: 100 });
    if (!data || !Array.isArray(data.content) || !Number.isSafeInteger(data.totalElements) || data.totalElements < 0 || !Number.isSafeInteger(data.totalPages) || data.totalPages < 0 || data.number !== page || data.size !== 100 || data.content.length > 100 || data.totalPages !== Math.ceil(data.totalElements / 100)) throw new Error('Invalid pagination');
    if (page === 0) { total = data.totalElements; pages = data.totalPages; }
    if (total !== data.totalElements || pages !== data.totalPages) throw new Error('Changing pagination');
    if (data.content.length !== Math.min(100, total - page * 100)) throw new Error('Incomplete page');
    const signature = JSON.stringify(data.content.map(record => id(record?.id)));
    if (seenPages.has(signature)) throw new Error('Repeated page');
    seenPages.add(signature);
    records.push(...data.content);
    if (page + 1 >= pages) {
      if (records.length !== total) throw new Error('Incomplete results');
      return records;
    }
  }
  throw new Error('Pagination limit exceeded');
}
async function mapLimit(values, limit, action) {
  let next = 0, failed = false;
  const results = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await action(values[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
function unique(records, project) {
  const found = new Map();
  for (const record of records) {
    const key = id(record?.id), value = project(record);
    if (found.has(key) && JSON.stringify(found.get(key)) !== JSON.stringify(value)) throw new Error('Conflicting duplicate');
    found.set(key, value);
  }
  return [...found.values()];
}
module.exports = { paginate, mapLimit, unique, id };
