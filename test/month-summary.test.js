const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthToDateSummary, weeklyBreakdown, sales, RetrievalFailure } = require('../lib/month-summary');
const { createMonthSummaryController, renderMonthSummary } = require('../public/month-summary');
const { createLoader, formatCents } = require('../public/dashboard');
const ro = (id, status, postedDate, values = {}) => ({ id, repairOrderStatus: { id: status }, postedDate,
  laborSales: 10000, partsSales: 5000, subletSales: 0, feeTotal: 0, discountTotal: 0, ...values });
const page = (rows, number = 0) => ({ content: rows.slice(number * 100, (number + 1) * 100), number, size: 100, totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) });
function api(orders = []) {
  const calls = [];
  return { shop: '1', calls, async get(path, query) {
    calls.push({ path, ...query });
    assert.equal(query.shop, '1');
    if (path === '/repair-orders') return page(orders.filter(o => o.repairOrderStatus.id === query.repairOrderStatusId), query.page);
    throw new Error('Unexpected path');
  } };
}
test('sales uses the verified pre-tax formula in integer cents', () => {
  const result = sales([{ id: '1', day: '2026-09-09', cents: [10000, 5000, 0, 500, 1000] }]);
  assert.equal(result.salesCents.value, 14500); assert.equal(result.repairOrderCount.value, 1);
});
test('empty period is verified zero, not fabricated', () => {
  const result = sales([]);
  assert.equal(result.salesCents.value, 0); assert.equal(result.repairOrderCount.value, 0);
});
test('weekly breakdown partitions orders exactly and labels a partial boundary week', () => {
  const orders = [
    { id: '1', day: '2026-09-01', cents: [10000, 0, 0, 0, 0] },
    { id: '2', day: '2026-09-06', cents: [5000, 0, 0, 0, 0] },
    { id: '3', day: '2026-09-07', cents: [2000, 0, 0, 0, 0] },
  ];
  const weeks = weeklyBreakdown(orders);
  assert.equal(weeks.length, 2);
  assert.deepEqual([weeks[0].weekStart, weeks[0].weekEnd], ['2026-08-31', '2026-09-06']);
  assert.equal(weeks[0].salesCents.value, 15000);
  assert.deepEqual([weeks[1].weekStart, weeks[1].weekEnd], ['2026-09-07', '2026-09-13']);
  assert.equal(weeks[1].salesCents.value, 2000);
});
test('month to date fetches statuses 5 and 6 with a posted-date range from the 1st through the reporting date', async () => {
  const orders = [ro(1, 5, '2026-09-01T15:00:00Z'), ro(2, 6, '2026-09-09T15:00:00Z'), ro(3, 5, '2026-09-10T15:00:00Z')];
  const source = api(orders);
  const { start, end, totals, weeks } = await monthToDateSummary(source, '2026-09-09');
  assert.equal(start, '2026-09-01'); assert.equal(end, '2026-09-09');
  assert.equal(totals.salesCents.value, 30000); assert.equal(totals.repairOrderCount.value, 2);
  assert.deepEqual(source.calls.map(c => c.repairOrderStatusId).sort(), [5, 6]);
  assert.ok(source.calls.every(c => 'postedDateStart' in c && 'postedDateEnd' in c));
  const weekSum = weeks.reduce((sum, week) => sum + week.salesCents.value, 0);
  assert.equal(weekSum, totals.salesCents.value);
});
test('orders posted after the reporting date or before the month start are excluded', async () => {
  const orders = [ro(1, 5, '2026-08-31T15:00:00Z'), ro(2, 5, '2026-09-10T15:00:00Z')];
  const { totals } = await monthToDateSummary(api(orders), '2026-09-09');
  assert.equal(totals.salesCents.value, 0); assert.equal(totals.repairOrderCount.value, 0);
});
test('malformed pagination is a sanitized retrieval failure, not a false zero', async () => {
  await assert.rejects(monthToDateSummary({ shop: '1', get: async () => ({ private: 'SYNTHETIC_PRIVATE' }) }, '2026-09-09'), error => {
    assert.ok(error instanceof RetrievalFailure);
    assert.match(error.reason, /Month to date sales/);
    assert.ok(!error.reason.includes('SYNTHETIC_PRIVATE'));
    return true;
  });
});
test('endpoint computes month-to-date range and sanitizes failure', async () => {
  const handler = require('../api/month-summary');
  const env = { TEKMETRIC_BASE_URL: 'https://sandbox.tekmetric.com', TEKMETRIC_CLIENT_ID: 'synthetic', TEKMETRIC_CLIENT_SECRET: 'synthetic', TEKMETRIC_SHOP_ID: '1' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const oldFetch = global.fetch;
  try {
    global.fetch = async url => ({ ok: true, json: async () => url.endsWith('/token') ? { access_token: 'SYNTHETIC_PRIVATE' } : page([]) });
    let code, body; const res = { setHeader() {}, status(value) { code = value; return this; }, json(value) { body = value; } };
    await handler({ method: 'GET', query: { date: '2026-09-09' } }, res);
    assert.equal(code, 200); assert.equal(body.monthToDate.start, '2026-09-01'); assert.equal(body.monthToDate.end, '2026-09-09');
    assert.equal(body.monthToDate.totals.salesCents.value, 0);
    global.fetch = async () => { throw new Error('SYNTHETIC_PRIVATE'); };
    await handler({ method: 'GET', query: { date: '2026-09-09' } }, res);
    assert.equal(code, 503); assert.equal(body.monthToDate.totals.salesCents.available, false);
    assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PRIVATE'));
    await handler({ method: 'GET', query: { date: 'bad' } }, res);
    assert.equal(code, 400);
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('renderer shows month total, repair order count, and weekly rows', () => {
  const element = () => ({ textContent: '', children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const elements = { 'month-sales': element(), 'month-ro-count': element(), 'month-status': element(), 'month-week-rows': element() };
  const doc = { getElementById: key => elements[key], createElement: element };
  renderMonthSummary({ date: '2026-09-09', monthToDate: { start: '2026-09-01', end: '2026-09-09',
    totals: { salesCents: { available: true, value: 30000 }, repairOrderCount: { available: true, value: 2 } },
    weeks: [{ weekStart: '2026-08-31', weekEnd: '2026-09-06', salesCents: { available: true, value: 10000 }, repairOrderCount: { available: true, value: 1 } }] } }, doc);
  assert.equal(elements['month-sales'].textContent, formatCents(30000));
  assert.equal(elements['month-ro-count'].textContent, '2');
  assert.equal(elements['month-week-rows'].children.length, 1);
  renderMonthSummary(null, doc);
  assert.equal(elements['month-sales'].textContent, 'Unavailable');
  assert.equal(elements['month-week-rows'].children.length, 0);
});
test('frontend controller renders sanitized unavailable response', async () => {
  const rendered = [];
  const controller = createMonthSummaryController({
    createLoader, fetchImpl: async url => {
      const date = new URL(url, 'https://example.test').searchParams.get('date');
      return { ok: date !== 'bad-month', json: async () => ({ date, updatedAt: new Date().toISOString(),
        monthToDate: date === 'bad-month'
          ? { start: null, end: null, totals: { salesCents: { available: false, value: null, reason: 'Sanitized retrieval explanation' }, repairOrderCount: { available: false, value: null } }, weeks: [] }
          : { start: '2026-09-01', end: date, totals: { salesCents: { available: true, value: 100 }, repairOrderCount: { available: true, value: 1 } }, weeks: [] } }) };
    },
    pending() {}, render: data => rendered.push(data.monthToDate.totals.salesCents.available), failure: () => assert.fail('sanitized failure should render'),
  });
  await controller.refresh('2026-09-09');
  await controller.refresh('bad-month');
  assert.deepEqual(rendered, [true, false]);
});
