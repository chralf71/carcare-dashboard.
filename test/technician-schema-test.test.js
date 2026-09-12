const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/technician-schema-test');
const secret = 'SYNTHETIC_PROHIBITED_CONTENT';
const page = (rows, total = rows.length) => ({ content: rows, number: 0, size: 3, totalElements: total, totalPages: Math.ceil(total / 3) });
async function run(base, transport, method = 'GET') {
  const env = { TEKMETRIC_BASE_URL: base, TEKMETRIC_CLIENT_ID: 'synthetic', TEKMETRIC_CLIENT_SECRET: 'synthetic', TEKMETRIC_SHOP_ID: '1' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])), oldFetch = global.fetch;
  Object.assign(process.env, env); global.fetch = transport;
  let code, body; const headers = {};
  try { await handler({ method }, { setHeader(key, value) { headers[key] = value; }, status(value) { code = value; return this; }, json(value) { body = value; } }); }
  finally { global.fetch = oldFetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(headers['Cache-Control'], 'no-store');
  return { code, body };
}
test('probe rejects all non-sandbox hosts before authentication', async () => {
  for (const base of ['https://shop.tekmetric.com', 'https://sandbox.tekmetric.com.evil.test', 'https://evil.test', 'not a url']) {
    const result = await run(base, () => assert.fail('No upstream request permitted'));
    assert.equal(result.code, 403); assert.deepEqual(result.body, { error: 'Sandbox only' });
  }
});
test('probe preserves HTTPS/origin validation and rejects non-GET', async () => {
  for (const base of ['http://sandbox.tekmetric.com', 'https://user:pass@sandbox.tekmetric.com', 'https://sandbox.tekmetric.com/path']) {
    assert.equal((await run(base, () => assert.fail('No request'))).code, 503);
  }
  assert.equal((await run('https://sandbox.tekmetric.com', () => assert.fail('No request'), 'POST')).code, 405);
});
test('probe returns only the aggregate allowlist; sampling and requests are bounded', async () => {
  let calls = 0, active = 0, maximum = 0;
  const result = await run('https://sandbox.tekmetric.com', async (url, options) => {
    calls++; assert.equal(options.redirect, 'error');
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: secret }) };
    const parsed = new URL(url); assert.equal(parsed.searchParams.get('size'), '3'); assert.equal(parsed.searchParams.get('page'), '0');
    assert.equal(parsed.searchParams.get('shop'), '1');
    if (parsed.pathname.endsWith('/repair-orders')) return { ok: true, json: async () => page([1, 2, 3].map(id => ({ id, repairOrderStatus: { id: id + 1 }, name: secret, customerId: secret })), 10) };
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const parent = Number(parsed.searchParams.get('repairOrderId'));
    return { ok: true, json: async () => page([1, 2, 3].map(index => ({
      id: parent * 100 + index, repairOrderId: parent, technicianId: index === 1 ? 123456 : index === 2 ? null : secret,
      completedDate: secret, complete: true, notes: secret, vehicleId: secret, totalSales: 987654,
      labor: Array.from({ length: 40 }, (_, line) => ({ id: parent * 10000 + index * 100 + line, technicianId: line === 0 ? null : 123456,
        complete: false, completedDate: secret, hours: 987654, rate: 987654, name: secret })),
    })), 9) };
  });
  assert.equal(result.code, 200); assert.equal(calls, 5); assert.equal(maximum, 2);
  assert.equal(result.body.jobsInspected, 9); assert.equal(result.body.laborLinesInspected, 270); assert.equal(result.body.sampleTruncated, true);
  const keys = ['temporary','sampleOnly','sampleTruncated','jobsInspected','laborLinesInspected','jobTechnicianIdPresentCount','laborTechnicianIdPresentCount','jobCompletedDatePresentCount','laborCompletedDatePresentCount','jobCompleteFieldPresentCount','laborCompleteFieldPresentCount','observedParentRoStatusIds','jobAssignmentTypesObserved','laborAssignmentTypesObserved'];
  assert.deepEqual(Object.keys(result.body).sort(), keys.sort());
  assert.deepEqual(result.body.jobAssignmentTypesObserved, { numeric: true, null: true, malformed: true });
  assert.deepEqual(result.body.observedParentRoStatusIds, [2, 3, 4]);
  const serialized = JSON.stringify(result.body);
  for (const prohibited of [secret, '123456', '987654', 'customerId', 'vehicleId', 'access_token', 'repairOrderId', 'parentJob', 'notes']) assert.ok(!serialized.includes(prohibited));
});
test('probe sanitizes upstream errors and invalid pagination; empty sample makes no job calls', async () => {
  for (const payload of [null, { content: [] }]) {
    const result = await run('https://sandbox.tekmetric.com', async url => {
      if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: secret }) };
      if (payload === null) throw new Error(secret);
      return { ok: true, json: async () => payload };
    });
    assert.equal(result.code, 503); assert.deepEqual(result.body, { error: 'Schema sample unavailable' });
  }
  let calls = 0;
  const result = await run('https://sandbox.tekmetric.com', async url => { calls++; return { ok: true, json: async () => url.endsWith('/token') ? { access_token: secret } : page([]) }; });
  assert.equal(calls, 2); assert.equal(result.body.jobsInspected, 0); assert.equal(result.body.sampleTruncated, false);
});
