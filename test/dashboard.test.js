const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paginate, mapLimit } = require('../lib/pagination');
const { dailySummary, qualifyingOrders, sales, hours } = require('../lib/daily-financials');
const { postedDay, broadRange, validateDate, chicagoDate } = require('../lib/shop-date');
const { createClient, configuration } = require('../lib/tekmetric');
const { createLoader, formatCents } = require('../public/dashboard');
const date = '2026-09-12';
const ro = (id, status = 5, extra = {}) => ({ id, repairOrderStatus: { id: status }, postedDate: '2026-09-12T12:00:00Z', laborSales: 10000, partsSales: 2500, subletSales: 500, feeTotal: 100, discountTotal: 600, ...extra });
const job = (id, labor = [{ id: 100, hours: 1.5, complete: false }], extra = {}) => ({ id, authorized: true, archived: false, labor, ...extra });
const envelope = (rows, page = 0) => ({ content: rows.slice(page * 100, (page + 1) * 100), number: page, size: 100, totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) });
const env = { TEKMETRIC_BASE_URL: 'https://sandbox.tekmetric.com', TEKMETRIC_CLIENT_ID: 'synthetic-client', TEKMETRIC_CLIENT_SECRET: 'synthetic-secret', TEKMETRIC_SHOP_ID: '1' };
test('pagination fetches every page at size 100', async () => {
  const rows = Array.from({ length: 205 }, (_, id) => ({ id })), calls = [];
  const result = await paginate({ get: async (_, q) => { calls.push(q); return envelope(rows, q.page); } }, '/jobs', {});
  assert.equal(result.length, 205); assert.deepEqual(calls.map(q => q.page), [0, 1, 2]); assert.ok(calls.every(q => q.size === 100));
});
test('malformed, incomplete, changing and repeated pages fail', async () => {
  for (const data of [{}, [], { content: [] }, { ...envelope([]), totalElements: -1 }, { ...envelope([{ id: 1 }]), content: [] }]) {
    await assert.rejects(paginate({ get: async () => data }, '/jobs', {}));
  }
  const rows = Array.from({ length: 200 }, (_, id) => ({ id }));
  await assert.rejects(paginate({ get: async (_, q) => ({ ...envelope(rows, 0), number: q.page }) }, '/jobs', {}), /Repeated/);
  await assert.rejects(paginate({ get: async (_, q) => ({ ...envelope(rows, q.page), totalElements: q.page ? 199 : 200 }) }, '/jobs', {}));
  await assert.rejects(paginate({ get: async (_, q) => envelope(rows, q.page) }, '/jobs', {}, 1), /limit/);
});
test('both statuses are fetched separately; duplicate ROs count once, discounts once', async () => {
  const queries = [];
  const client = { shop: '1', get: async (path, q) => {
    queries.push({ path, ...q });
    const rows = path === '/jobs' ? [] : q.repairOrderStatusId === 5 ? [ro(1), ro(1)] : [ro(1, 6), ro(2, 6)];
    return envelope(rows, q.page);
  } };
  const result = await dailySummary(client, date);
  assert.equal(result.salesCents.value, 25000); assert.equal(result.averageRoCents.value, 12500); assert.equal(result.repairOrderCount.value, 2);
  assert.equal(result.hoursSold.value, 0); assert.equal(result.grossProfit.available, false);
  assert.deepEqual(queries.filter(q => q.path === '/repair-orders').map(q => q.repairOrderStatusId), [5, 6]);
  assert.ok(queries.every(q => q.shop === '1' && q.size === 100));
  assert.ok(queries.filter(q => q.path === '/jobs').every(q => q.authorized === true && !('authorizedDateStart' in q)));
});
test('money conversion and aggregate ARO rounding happen at display', () => {
  assert.equal(formatCents(12500), '$125.00'); assert.equal(formatCents(1), '$0.01'); assert.equal(formatCents(null), 'Unavailable');
  const result = sales(qualifyingOrders([ro(1, 5, { discountTotal: 601 }), ro(2)], date));
  assert.equal(result.averageRoCents.value, 12499.5); assert.equal(formatCents(result.averageRoCents.value), '$125.00');
});
test('empty day is verified zero without fetching jobs; ARO and GP unavailable', async () => {
  const result = await dailySummary({ shop: '1', get: async path => { assert.equal(path, '/repair-orders'); return envelope([]); } }, date);
  for (const key of ['salesCents', 'repairOrderCount', 'hoursSold']) assert.deepEqual(result[key], { available: true, value: 0 });
  assert.equal(result.averageRoCents.available, false); assert.equal(result.grossProfit.available, false);
});
test('missing cents, ambiguous dates, invalid status and conflicting duplicates fail', () => {
  for (const extra of [{ laborSales: null }, { partsSales: '100' }, { feeTotal: 0.1 }, { postedDate: '2026-09-12T12:00:00' }, { repairOrderStatus: { id: 3 } }]) assert.throws(() => qualifyingOrders([ro(1, 5, extra)], date));
  assert.throws(() => qualifyingOrders([ro(1), ro(1, 5, { feeTotal: 9 })], date));
});
test('hours deduplicate jobs and labor globally; exclude archived, ignore complete', () => {
  assert.equal(hours([job(1), job(1), job(2, [{ id: 100, hours: 1.5 }, { id: 101, hours: 2 }, { id: 101, hours: 2 }]), job(3, null, { archived: true })]), 3.5);
  for (const item of [job(1, null), job(1, [{ hours: 1 }]), job(1, [{ id: 1, hours: '2' }]), job(1, [], { archived: undefined }), job(1, [], { authorized: false })]) assert.throws(() => hours([item]));
  assert.throws(() => hours([job(1), job(1, [{ id: 100, hours: 9 }])]));
});
test('bad job pagination or fields makes hours unavailable but keeps sales', async () => {
  for (const payload of [{ content: [] }, envelope([job(1, null)])]) {
    const result = await dailySummary({ shop: '1', get: async (path, q) => path === '/jobs' ? payload : envelope(q.repairOrderStatusId === 5 ? [ro(1)] : []) }, date);
    assert.equal(result.salesCents.available, true); assert.deepEqual(result.hoursSold, { available: false, value: null, reason: 'Approved labor data unavailable' });
  }
});
test('Chicago boundaries include spring 23-hour and fall 25-hour dates', () => {
  for (const [day, start, end] of [['2026-03-08', '2026-03-08T06:00:00Z', '2026-03-09T05:00:00Z'], ['2026-11-01', '2026-11-01T05:00:00Z', '2026-11-02T06:00:00Z'], [date, '2026-09-12T05:00:00Z', '2026-09-13T05:00:00Z']]) {
    assert.equal(postedDay(start), day); assert.equal(postedDay(new Date(Date.parse(end) - 1).toISOString()), day);
    assert.notEqual(postedDay(new Date(Date.parse(start) - 1).toISOString()), day); assert.notEqual(postedDay(end), day);
    const range = broadRange(day); assert.ok(Date.parse(range.postedDateStart) < Date.parse(start)); assert.ok(Date.parse(range.postedDateEnd) > Date.parse(end));
  }
  assert.equal(postedDay(date), date); assert.equal(chicagoDate(new Date('2026-09-13T02:00:00Z')), date);
  for (const value of ['2026-02-30', '2026-13-01', '', ['2026-09-12']]) assert.throws(() => validateDate(value));
});
test('local filtering excludes neighboring days', () => {
  assert.equal(qualifyingOrders([ro(1), ro(2, 6, { postedDate: '2026-09-13T05:00:00Z' }), ro(3, 5, { postedDate: '2026-09-12T04:59:59Z' })], date).length, 1);
});
test('approved hosts only; token shared per client; no redirects; timeout sanitized', async () => {
  for (const base of ['http://sandbox.tekmetric.com', 'https://evil.test', 'https://shop.tekmetric.com.evil.test', 'https://user@shop.tekmetric.com', 'https://shop.tekmetric.com/api', 'https://shop.tekmetric.com?x=1']) assert.throws(() => configuration({ ...env, TEKMETRIC_BASE_URL: base }));
  let tokens = 0;
  const client = createClient(env, async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/token')) tokens++;
    return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'synthetic-token' } : envelope([]) };
  });
  await Promise.all([client.get('/jobs', {}), client.get('/repair-orders', {})]); assert.equal(tokens, 1);
  const timeout = createClient(env, (_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('PRIVATE UPSTREAM')))), { timeoutMs: 5 });
  await assert.rejects(timeout.authenticate(), { message: 'API request unavailable' });
});
test('concurrency is bounded', async () => {
  let active = 0, maximum = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 1)); active--; });
  assert.equal(maximum, 2);
});
test('frontend serializes refreshes and discards stale date responses', async () => {
  const pendingRequests = [], rendered = [];
  let active = 0, maximum = 0;
  const loader = createLoader({ fetchImpl: url => new Promise(resolve => { maximum = Math.max(maximum, ++active); pendingRequests.push(data => { active--; resolve({ ok: true, json: async () => data }); }); }), pending() {}, failure() { assert.fail('unexpected failure'); }, render: data => rendered.push(data.date) });
  const running = loader.refresh(date);
  loader.refresh(date); // Timer tick does not duplicate transport.
  loader.refresh('2026-09-13', true);
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0]({ date, metrics: {}, updatedAt: new Date().toISOString() });
  await new Promise(r => setImmediate(r));
  assert.equal(pendingRequests.length, 2);
  pendingRequests[1]({ date: '2026-09-13', metrics: {}, updatedAt: new Date().toISOString() });
  await running;
  assert.equal(maximum, 1); assert.deepEqual(rendered, ['2026-09-13']);
});
test('all diagnostic routes default off', async () => {
  const previous = process.env.ENABLE_DIAGNOSTICS;
  delete process.env.ENABLE_DIAGNOSTICS;
  try {
    for (const name of ['test-token', 'shops', 'employees-test', 'repair-orders-test', 'repair-orders-sample']) {
      let status, body;
      await require(`../api/${name}`)({ method: 'GET' }, { setHeader() {}, status(code) { status = code; return this; }, json(data) { body = data; } });
      assert.equal(status, 404); assert.deepEqual(body, { error: 'Not found' });
    }
  } finally { if (previous === undefined) delete process.env.ENABLE_DIAGNOSTICS; else process.env.ENABLE_DIAGNOSTICS = previous; }
});
test('handler rejects invalid dates and sanitizes configuration failures', async () => {
  const handler = require('../api/dashboard-summary');
  for (const [query, expected] of [[{ date: 'bad' }, 400], [{ date }, 503]]) {
    const saved = process.env.TEKMETRIC_BASE_URL; process.env.TEKMETRIC_BASE_URL = 'https://private.invalid';
    let code, body;
    try { await handler({ method: 'GET', query }, { setHeader() {}, status(value) { code = value; return this; }, json(value) { body = value; } }); }
    finally { if (saved === undefined) delete process.env.TEKMETRIC_BASE_URL; else process.env.TEKMETRIC_BASE_URL = saved; }
    assert.equal(code, expected); assert.equal(body.metrics.salesCents.value, null); assert.ok(!JSON.stringify(body).includes('private.invalid'));
  }
});
test('enabled diagnostics return connectivity only and summary contains aggregates only', async () => {
  const keys = [...Object.keys(env), 'ENABLE_DIAGNOSTICS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  Object.assign(process.env, env, { ENABLE_DIAGNOSTICS: 'true' });
  global.fetch = async url => ({ ok: true, json: async () => {
    if (url.endsWith('/token')) return { access_token: 'SYNTHETIC_PRIVATE_TOKEN', expires_in: 1000 };
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/jobs') ? envelope([]) : envelope(parsed.searchParams.get('repairOrderStatusId') === '5' ? [ro(1, 5, { customer: { name: 'SYNTHETIC_PRIVATE_CUSTOMER' } })] : []);
  } });
  try {
    for (const name of ['test-token', 'shops', 'employees-test', 'repair-orders-test', 'repair-orders-sample', 'dashboard-summary']) {
      let status, body;
      await require(`../api/${name}`)({ method: 'GET', query: { date } }, { setHeader() {}, status(code) { status = code; return this; }, json(data) { body = data; } });
      assert.equal(status, 200);
      if (name !== 'dashboard-summary') assert.deepEqual(body, { connected: true });
      else assert.equal(body.metrics.salesCents.value, 12500);
      assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PRIVATE')); assert.ok(!JSON.stringify(body).includes('laborSales'));
    }
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
test('jobs span multiple pages, deduplicate across pages, and invalid late page invalidates hours', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => job(i, [{ id: i, hours: 0.5 }]));
  rows[100] = rows[0];
  for (const broken of [false, true]) {
    const result = await dailySummary({ shop: '1', get: async (path, q) => {
      if (path === '/repair-orders') return envelope(q.repairOrderStatusId === 5 ? [ro(1)] : []);
      return broken && q.page === 1 ? {} : envelope(rows, q.page);
    } }, date);
    assert.equal(result.hoursSold.available, !broken); assert.equal(result.hoursSold.value, broken ? null : 50);
  }
});
