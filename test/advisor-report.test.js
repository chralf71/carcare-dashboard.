const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dailyDataset } = require('../lib/daily-financials');
const { advisorReport, buildAdvisorReport, reconcile } = require('../lib/advisor-report');
const { employeeDirectory } = require('../lib/employees');
const { renderAdvisors } = require('../public/dashboard');
const day = '2026-09-12';
const ro = (id, serviceWriterId, extra = {}) => ({ id, serviceWriterId, repairOrderStatus: { id: 5 }, postedDate: day, laborSales: 10000, partsSales: 2000, subletSales: 100, feeTotal: 200, discountTotal: 300, ...extra });
const job = (id, hours = 1.5, extra = {}) => ({ id, authorized: true, archived: false, labor: [{ id, hours, complete: false }], ...extra });
const employee = (id, firstName = 'Synthetic', lastName = `Advisor ${id}`) => ({ id, firstName, lastName });
const page = (rows, number) => ({ content: rows.slice(number * 100, (number + 1) * 100), number, size: 100, totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) });
function client(orders, jobs = {}, employees = [], fail = false) {
  return { shop: '1', async get(path, query) {
    assert.equal(query.shop, '1'); assert.equal(query.size, 100);
    if (path === '/employees' && fail) throw new Error('SYNTHETIC_PRIVATE_UPSTREAM');
    const rows = path === '/employees' ? employees : path === '/jobs' ? jobs[query.repairOrderId] || [] : orders.filter(order => order.repairOrderStatus.id === query.repairOrderStatusId);
    return page(rows, query.page);
  } };
}
async function report(orders, jobs, employees, fail) {
  const api = client(orders, jobs, employees, fail);
  const dataset = await dailyDataset(api, day);
  return { dataset, report: await advisorReport(api, dataset) };
}
test('allocates statuses 5/6 and discounts exactly, joins IDs not names, reconciles', async () => {
  const { dataset, report: result } = await report([ro(1, 11), ro(2, '12', { repairOrderStatus: { id: 6 }, discountTotal: 301 })], { 1: [job(101)], 2: [job(102, 2)] }, [employee(11), employee(12)]);
  assert.equal(result.status, 'complete'); assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].metrics.salesCents.value, 12000);
  assert.equal(result.rows[1].metrics.salesCents.value, 11999);
  assert.equal(dataset.metrics.salesCents.value, 23999);
  assert.deepEqual(result.reconciliation, { salesCents: 'matched', repairOrderCount: 'matched', hoursSold: 'matched' });
  assert.ok(result.rows.every(row => !row.metrics.grossProfit.available));
  assert.equal(result.selectionMode, 'all');
});
test('duplicates across pages and job/labor duplicates contribute once', async () => {
  const orders = Array.from({ length: 101 }, () => ro(1, 11));
  const repeated = job(1); repeated.labor.push({ ...repeated.labor[0] });
  const { report: result } = await report(orders, { 1: [repeated, repeated] }, [employee(11), employee(11)]);
  assert.equal(result.rows[0].metrics.repairOrderCount.value, 1);
  assert.equal(result.rows[0].metrics.hoursSold.value, 1.5);
  assert.equal(result.reconciliation.hoursSold, 'matched');
});
test('missing, unknown and malformed assignments get explicit applicable buckets', async () => {
  const { report: result } = await report([ro(1, null), ro(2, undefined), ro(3, 99), ro(4, { bad: true }), ro(5, 0)], {}, []);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.rows.map(row => row.name).sort(), ['Invalid assignment', 'Unassigned', 'Unknown advisor']);
  assert.equal(result.rows.find(row => row.name === 'Unassigned').metrics.repairOrderCount.value, 2);
  assert.equal(result.reconciliation.salesCents, 'matched');
});
test('conflicting advisor on duplicate RO preserves shop and uses invalid bucket', async () => {
  const { dataset, report: result } = await report([ro(1, 11), ro(1, 12)], { 1: [job(1)] }, [employee(11), employee(12)]);
  assert.equal(dataset.metrics.repairOrderCount.value, 1);
  assert.equal(result.rows[0].name, 'Invalid assignment');
  assert.equal(result.status, 'partial');
  assert.equal(result.reconciliation.repairOrderCount, 'matched');
});
test('employee failure preserves shop, IDs and aggregates but never invents names', async () => {
  const { dataset, report: result } = await report([ro(1, 11)], { 1: [job(1)] }, [], true);
  assert.equal(dataset.metrics.salesCents.available, true);
  assert.equal(result.directoryStatus, 'unavailable');
  assert.equal(result.rows[0].name, 'Advisor name unavailable');
  assert.equal(result.rows[0].employeeId, '11');
  assert.equal(result.reconciliation.salesCents, 'matched');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_UPSTREAM'));
});
test('complete employee directory paginates and rejects malformed/conflicting entries', async () => {
  const employees = Array.from({ length: 101 }, (_, index) => employee(index + 1));
  const directory = await employeeDirectory(client([], {}, employees));
  assert.equal(directory.size, 101);
  await assert.rejects(employeeDirectory(client([], {}, [employee(1), employee(1, 'Different')])));
  await assert.rejects(employeeDirectory(client([], {}, [{ id: 1 }])));
});
test('disabled employees and duplicate names do not change ID allocation', async () => {
  const { report: result } = await report([ro(1, 11), ro(2, 12)], {}, [{ ...employee(11, 'Same', 'Name'), disabled: true }, employee(12, 'Same', 'Name')]);
  assert.equal(result.rows.length, 2); assert.notEqual(result.rows[0].employeeId, result.rows[1].employeeId);
});
test('empty day has no observed rows; zero-value RO still counts and never has GP', async () => {
  const empty = await report([], {}, [employee(11)]);
  assert.deepEqual(empty.report.rows, []); assert.equal(empty.report.status, 'complete');
  const zero = await report([ro(1, 11, { laborSales: 0, partsSales: 0, subletSales: 0, feeTotal: 0, discountTotal: 0 })], {}, [employee(11)]);
  assert.equal(zero.report.rows[0].metrics.repairOrderCount.value, 1);
  assert.equal(zero.report.rows[0].metrics.averageRoCents.value, 0);
});
test('ambiguous job or labor parent cannot double count advisor hours', async () => {
  for (const jobs of [{ 1: [job(1)], 2: [job(1)] }, { 1: [job(1)], 2: [job(2, 1.5, { labor: [{ id: 1, hours: 1.5 }] })] }]) {
    const { dataset, report: result } = await report([ro(1, 11), ro(2, 12)], jobs, [employee(11), employee(12)]);
    assert.equal(dataset.metrics.hoursSold.value, 1.5); // Preserve existing global shop deduplication.
    assert.ok(result.rows.every(row => !row.metrics.hoursSold.available));
    assert.equal(result.reconciliation.hoursSold, 'unavailable');
  }
});
test('job failure and archived jobs retain existing shop-hour rules', async () => {
  const bad = await report([ro(1, 11)], { 1: [job(1, 1, { labor: null })] }, [employee(11)]);
  assert.equal(bad.dataset.metrics.hoursSold.available, false); assert.equal(bad.report.rows[0].metrics.hoursSold.available, false);
  const archived = await report([ro(1, 11)], { 1: [job(1, 8, { archived: true })] }, [employee(11)]);
  assert.equal(archived.report.rows[0].metrics.hoursSold.value, 0);
});
test('reconciliation distinguishes exact monetary mismatch and floating point tolerance', async () => {
  const { dataset, report: result } = await report([ro(1, 11)], { 1: [job(1, 0.3)] }, [employee(11)]);
  result.rows[0].metrics.hoursSold.value = 0.1 + 0.2;
  assert.equal(reconcile(result.rows, dataset.metrics).hoursSold, 'matched');
  result.rows[0].metrics.salesCents.value++;
  assert.equal(reconcile(result.rows, dataset.metrics).salesCents, 'mismatch');
});
test('serialization exposes identity/aggregates only; renderer uses text and clears stale rows', async () => {
  const { report: result } = await report([ro(1, 11, { customer: 'SYNTHETIC_PRIVATE_CUSTOMER' })], { 1: [job(1)] }, [{ ...employee(11, '<b>Text</b>'), email: 'SYNTHETIC_PRIVATE_CONTACT' }]);
  const json = JSON.stringify(result);
  for (const forbidden of ['SYNTHETIC_PRIVATE', 'laborSales', 'repairOrderId', 'serviceWriterId', 'access_token']) assert.ok(!json.includes(forbidden));
  const element = () => ({ textContent: '', children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const elements = Object.fromEntries(['advisor-rows', 'advisor-status', 'advisor-reconciliation'].map(key => [key, element()]));
  const doc = { getElementById: key => elements[key], createElement: element };
  renderAdvisors(result, doc);
  assert.equal(elements['advisor-rows'].children.length, 1);
  assert.ok(elements['advisor-rows'].children[0].children[0].textContent.includes('<b>Text</b>'));
  renderAdvisors(null, doc); assert.equal(elements['advisor-rows'].children.length, 0);
});
test('failed parallel work drains before subsequent requests begin', async () => {
  const { mapLimit } = require('../lib/pagination');
  let active = 0;
  await assert.rejects(mapLimit([1, 2, 3], 2, async value => {
    active++;
    try { if (value === 1) throw new Error('Synthetic failure'); await new Promise(resolve => setTimeout(resolve, 5)); }
    finally { active--; }
  }));
  assert.equal(active, 0);
});
test('later employee page failure discards partial directory', async () => {
  const api = client([ro(1, 11)], {}, Array.from({ length: 101 }, (_, i) => employee(i + 1)));
  const original = api.get;
  api.get = (path, query) => path === '/employees' && query.page === 1 ? Promise.resolve({ content: [] }) : original(path, query);
  const dataset = await dailyDataset(api, day);
  const result = await advisorReport(api, dataset);
  assert.equal(result.directoryStatus, 'unavailable');
  assert.equal(result.rows[0].assignmentStatus, 'name-unavailable');
});
