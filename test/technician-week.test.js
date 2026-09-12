const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTechnicianWeekReport: build, technicianWeekReport, RetrievalFailure } = require('../lib/technician-week');
const { createTechnicianWeekController, renderTechnicianWeek } = require('../public/technicians');
const { createLoader } = require('../public/dashboard');
const directory = new Map([['11', 'Synthetic One'], ['12', 'Synthetic Two'], ['13', 'Synthetic Three']]);
const line = (id, technicianId = 11, hours = 1.5) => ({ id, technicianId, hours });
const job = (id = 1, extra = {}) => ({ id, repairOrderId: 1, technicianId: 11, authorized: true, archived: false, laborTotal: 15000, labor: [line(id)], ...extra });
const parent = (repairOrderId, jobs) => ({ repairOrderId, jobs });
const page = (rows, number = 0) => ({ content: rows.slice(number * 100, (number + 1) * 100), number, size: 100, totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) });
const metric = (result, name) => result.totals[name].value;
function api(orders = [], jobsByRO = {}, employees = [], failEmployees = false) {
  const calls = [];
  return { shop: '1', calls, async get(path, query) {
    calls.push({ path, ...query });
    assert.equal(query.shop, '1');
    if (path === '/employees') { if (failEmployees) throw new Error('SYNTHETIC_PRIVATE_ERROR'); return page(employees, query.page); }
    if (path === '/repair-orders') return page(orders.filter(ro => ro.repairOrderStatus.id === query.repairOrderStatusId), query.page);
    if (path === '/jobs') { assert.equal(query.authorized, true); return page(jobsByRO[query.repairOrderId] || [], query.page); }
    throw new Error('Unexpected path');
  } };
}
test('week hours and labor sales are attributed by job/line ownership and reconcile', () => {
  const result = build([parent(1, [job(1, { technicianId: 12, labor: [line(1, 11, 2), line(2, null, 3)] })])], directory);
  assert.equal(result.rows.find(r => r.employeeId === '11').metrics.hoursSold.value, 2);
  assert.equal(result.rows.find(r => r.employeeId === '12').metrics.hoursSold.value, 3);
  assert.equal(result.rows.find(r => r.employeeId === '12').metrics.laborSalesCents.value, 15000);
  assert.equal(result.rows.find(r => r.employeeId === '11').metrics.laborSalesCents.value, 0);
  assert.deepEqual(result.reconciliation, { hoursSold: 'matched', laborSalesCents: 'matched' });
  assert.equal(metric(result, 'hoursSold'), 5); assert.equal(metric(result, 'laborSalesCents'), 15000);
});
test('archived jobs are excluded from both hours and labor sales', () => {
  const result = build([parent(1, [job(1, { archived: true, laborTotal: null, labor: undefined })])], directory);
  assert.equal(metric(result, 'hoursSold'), 0); assert.equal(metric(result, 'laborSalesCents'), 0);
  assert.deepEqual(result.rows, []);
});
test('missing, unknown and malformed assignments get explicit applicable buckets', () => {
  const result = build([parent(1, [
    job(1, { technicianId: null, labor: [line(1, null)] }),
    job(2, { technicianId: 99, labor: [line(2, 99)] }),
    job(3, { technicianId: {}, labor: [line(3, 'bad')] }),
    job(4),
  ])], directory);
  assert.deepEqual(result.rows.map(r => r.assignmentStatus).sort(), ['invalid', 'matched', 'unassigned', 'unknown']);
  assert.equal(result.status, 'partial');
});
test('conflicting job records across duplicate reports are unavailable, not double-counted', () => {
  assert.throws(() => build([parent(1, [job(1)]), parent(1, [job(1, { laborTotal: 1 })])]), /Conflicting job record/);
});
test('identical duplicate job reports count once', () => {
  const j = job(1);
  const result = build([parent(1, [j]), parent(1, [j])], directory);
  assert.equal(metric(result, 'hoursSold'), 1.5); assert.equal(metric(result, 'laborSalesCents'), 15000);
});
test('invalid job flags, missing labor and negative hours never fabricate zero', () => {
  for (const extra of [{ authorized: false }, { authorized: null }, { archived: 'false' }, { labor: null }, { labor: [{ id: 1, technicianId: 11, hours: -1 }] }]) {
    assert.throws(() => build([parent(1, [job(1, extra)])], directory));
  }
});
test('employee failure preserves valid aggregate report with unavailable names', () => {
  const result = build([parent(1, [job()])], null);
  assert.equal(result.directoryStatus, 'unavailable'); assert.equal(result.rows[0].name, 'Technician name unavailable');
});
test('week retrieval uses repair-orders for statuses 5 and 6 with a posted-date range, then jobs per repair order', async () => {
  const orders = [{ id: 1, repairOrderStatus: { id: 5 }, postedDate: '2026-09-09T15:00:00Z' }, { id: 2, repairOrderStatus: { id: 6 }, postedDate: '2026-09-10T15:00:00Z' }];
  const jobsByRO = { 1: [job(1, { repairOrderId: 1 })], 2: [job(2, { repairOrderId: 2 })] };
  const source = api(orders, jobsByRO);
  const { weekStart, weekEnd, technicianReport } = await technicianWeekReport(source, '2026-09-09');
  assert.equal(weekStart, '2026-09-07'); assert.equal(weekEnd, '2026-09-13');
  assert.equal(metric(technicianReport, 'hoursSold'), 3);
  assert.deepEqual(source.calls.filter(c => c.path === '/repair-orders').map(c => c.repairOrderStatusId).sort(), [5, 6]);
  assert.ok(source.calls.every(c => c.path !== '/repair-orders' || 'postedDateStart' in c));
  assert.equal(source.calls.filter(c => c.path === '/jobs').length, 2);
});
test('calendar week is Monday through Sunday regardless of which weekday is selected', async () => {
  for (const date of ['2026-09-07', '2026-09-13']) {
    const { weekStart, weekEnd } = await technicianWeekReport(api(), date);
    assert.equal(weekStart, '2026-09-07'); assert.equal(weekEnd, '2026-09-13');
  }
});
test('repair orders posted outside the week are excluded even when returned by a broad query', async () => {
  const orders = [{ id: 1, repairOrderStatus: { id: 5 }, postedDate: '2026-09-06T15:00:00Z' }, { id: 2, repairOrderStatus: { id: 5 }, postedDate: '2026-09-14T15:00:00Z' }];
  const { technicianReport } = await technicianWeekReport(api(orders, { 1: [job(1, { repairOrderId: 1 })], 2: [job(2, { repairOrderId: 2 })] }), '2026-09-09');
  assert.deepEqual(technicianReport.rows, []);
});
test('malformed pagination is a retrieval failure, not a false zero', async () => {
  await assert.rejects(technicianWeekReport({ shop: '1', get: async () => ({ private: 'SYNTHETIC_PRIVATE' }) }, '2026-09-09'), error => {
    assert.ok(error instanceof RetrievalFailure);
    assert.match(error.reason, /Technician hours this week/);
    assert.ok(!error.reason.includes('SYNTHETIC_PRIVATE'));
    return true;
  });
});
test('endpoint computes the week from the reporting date and sanitizes failure', async () => {
  const handler = require('../api/technician-summary');
  const env = { TEKMETRIC_BASE_URL: 'https://sandbox.tekmetric.com', TEKMETRIC_CLIENT_ID: 'synthetic', TEKMETRIC_CLIENT_SECRET: 'synthetic', TEKMETRIC_SHOP_ID: '1' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const oldFetch = global.fetch;
  try {
    global.fetch = async url => ({ ok: true, json: async () => url.endsWith('/token') ? { access_token: 'SYNTHETIC_PRIVATE' } : page([]) });
    let code, body; const res = { setHeader() {}, status(value) { code = value; return this; }, json(value) { body = value; } };
    await handler({ method: 'GET', query: { date: '2026-09-09' } }, res);
    assert.equal(code, 200); assert.equal(body.report, 'week'); assert.equal(body.weekStart, '2026-09-07'); assert.equal(body.weekEnd, '2026-09-13');
    global.fetch = async () => { throw new Error('SYNTHETIC_PRIVATE'); };
    await handler({ method: 'GET', query: { date: '2026-09-09' } }, res);
    assert.equal(code, 503); assert.equal(body.technicianReport.status, 'unavailable');
    assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PRIVATE'));
    await handler({ method: 'GET', query: { date: 'not-a-date' } }, res);
    assert.equal(code, 400);
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('output is aggregate allowlist with no raw identifiers', () => {
  const result = build([parent(1, [job(1, { customer: 'SYNTHETIC_PRIVATE', notes: 'SYNTHETIC_PRIVATE' })])], directory);
  for (const row of result.rows) assert.deepEqual(Object.keys(row).sort(), ['key', 'employeeId', 'name', 'assignmentStatus', 'metrics'].sort());
  for (const forbidden of ['SYNTHETIC_PRIVATE', 'repairOrderId', 'technicianId', 'token']) assert.ok(!JSON.stringify(result).includes(forbidden));
});
test('renderer shows hours and labor sales, and clears stale rows on failure', () => {
  const element = () => ({ textContent: '', children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const elements = { 'technician-week-rows': element(), 'technician-week-status': element() };
  const doc = { getElementById: key => elements[key], createElement: element };
  const result = build([parent(1, [job()])], new Map([['11', '<img> Synthetic']]));
  renderTechnicianWeek({ weekStart: '2026-09-07', weekEnd: '2026-09-13', technicianReport: result }, doc);
  assert.equal(elements['technician-week-rows'].children[0].children[0].textContent, '<img> Synthetic');
  assert.ok(elements['technician-week-status'].textContent.includes('Week of 2026-09-07'));
  renderTechnicianWeek(null, doc); assert.equal(elements['technician-week-rows'].children.length, 0);
});
test('frontend controller refreshes on date change and renders sanitized unavailable response', async () => {
  const rendered = [];
  const controller = createTechnicianWeekController({
    createLoader, fetchImpl: async url => {
      const date = new URL(url, 'https://example.test').searchParams.get('date');
      return { ok: date !== 'bad-week', json: async () => ({ report: 'week', date, weekStart: '2026-09-07', weekEnd: '2026-09-13', asOf: new Date().toISOString(), technicianReport: { status: date === 'bad-week' ? 'unavailable' : 'complete', rows: [], reason: 'Sanitized retrieval explanation' } }) };
    },
    pending() {}, render: data => rendered.push(data.technicianReport.status), failure: () => assert.fail('sanitized failure should render'),
  });
  await controller.refresh('2026-09-09');
  await controller.refresh('bad-week');
  assert.deepEqual(rendered, ['complete', 'unavailable']);
});
