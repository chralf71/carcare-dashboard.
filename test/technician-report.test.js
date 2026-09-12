const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTechnicianReport: build, completedDay } = require('../lib/technician-report');
const { technicianData, LIMITS } = require('../lib/technician-data');
const { createLoader } = require('../public/dashboard');
const { createTechnicianController, renderTechnicians } = require('../public/technicians');
const day = '2026-09-12';
const directory = new Map([['11', 'Synthetic One'], ['12', 'Synthetic Two'], ['13', 'Synthetic Three']]);
const line = (id, technicianId = 11, hours = 1.5, complete = false) => ({ id, technicianId, hours, complete });
const job = (id = 1, extra = {}) => ({ id, repairOrderId: 1, technicianId: 11, authorized: true, selected: true, archived: false, completedDate: '2026-09-12T12:00:00Z', labor: [line(id)], ...extra });
const page = (rows, number = 0) => ({ content: rows.slice(number * 100, (number + 1) * 100), number, size: 100, totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) });
const metric = (result, name) => result.totals[name].value;
function api(orders = [], jobs = [], employees = [], failEmployees = false) {
  const calls = [];
  return { shop: '1', calls, async get(path, query) {
    calls.push({ path, ...query });
    assert.equal(query.shop, '1');
    if (path === '/employees' && failEmployees) throw new Error('SYNTHETIC_PRIVATE_ERROR');
    const rows = path === '/employees' ? employees : path === '/repair-orders' ? orders.filter(ro => ro.repairOrderStatus.id === query.repairOrderStatusId) : query.repairOrderStatusId !== undefined ? jobs.filter(j => orders.some(ro => ro.id === j.repairOrderId && ro.repairOrderStatus.id === query.repairOrderStatusId)) : query.repairOrderId === undefined ? jobs : jobs.filter(j => String(j.repairOrderId) === query.repairOrderId);
    return page(rows, query.page);
  } };
}
test('completed uses job date not RO posted date or labor complete', () => {
  const result = build([job(1, { postedDate: '2020-01-01', labor: [line(1, 11, 2, false), line(2, 11, 3, true)] }), job(2, { completedDate: '2026-09-13T06:00:00Z', postedDate: day })], directory, 'completed', day);
  assert.equal(metric(result, 'hours'), 5); assert.equal(metric(result, 'jobCount'), 1);
  assert.equal(build([job(1, { completedDate: null })], directory, 'completed', day).rows.length, 0);
  for (const completedDate of [undefined, '2026-09-12', '2026-09-12T12:00:00', 'bad']) assert.throws(() => build([job(1, { completedDate })], directory, 'completed', day));
});
test('completed Chicago/DST boundaries are half-open calendar days', () => {
  for (const [date, start, end] of [['2026-03-08','2026-03-08T06:00:00Z','2026-03-09T05:00:00Z'], ['2026-11-01','2026-11-01T05:00:00Z','2026-11-02T06:00:00Z']]) {
    assert.equal(completedDay(start), date); assert.equal(completedDay(new Date(Date.parse(end)-1).toISOString()), date);
    const records = [start, new Date(Date.parse(start)-1).toISOString(), new Date(Date.parse(end)-1).toISOString(), end].map((completedDate, i) => job(i, { completedDate }));
    assert.equal(metric(build(records, directory, 'completed', date), 'jobCount'), 2);
  }
});
test('eligibility flags are strict for both modes; no clocked hours or job.complete needed', () => {
  for (const mode of ['completed','current']) {
    for (const extra of [{ authorized: false }, { selected: false }, { archived: true }, { authorized: null }, { selected: null }]) {
      assert.equal(metric(build([job(1, extra)], directory, mode, day), 'jobCount'), 0);
    }
    assert.throws(() => build([job(1, { selected: undefined })], directory, mode, day));
    assert.throws(() => build([job(1, { archived: 'false' })], directory, mode, day));
  }
});
test('current board includes statuses 1–3 only, no historical filters', async () => {
  const orders = [1,2,3,4,5,6,7].map(id => ({ id, repairOrderStatus: { id } }));
  const source = api(orders, orders.map(ro => job(ro.id, { repairOrderId: ro.id, completedDate: 'ignored' })));
  const data = await technicianData(source, 'current');
  assert.equal(metric(build(data.records, directory, 'current'), 'jobCount'), 3);
  assert.deepEqual(source.calls.filter(c => c.path === '/jobs').map(c => c.repairOrderStatusId), [1,2,3]);
  assert.ok(source.calls.every(c => !('postedDateStart' in c) && !('authorizedDateStart' in c)));
  assert.equal(data.records.length, 3);
  assert.ok(source.calls.every(c => c.path !== '/repair-orders' && !('repairOrderId' in c) && !('authorized' in c) && !('selected' in c) && !('archived' in c)));
});
test('current incomplete hours and active jobs exclude complete lines, count once', () => {
  const result = build([job(1, { labor: [line(1, 11, 2), line(2, 11, 3, true), line(3, 11, 0)] }), job(2, { labor: [line(4, 11, 4, true)] }), job(3, { labor: [] })], directory, 'current');
  assert.equal(metric(result,'hours'), 2); assert.equal(metric(result,'jobCount'), 1);
  assert.throws(() => build([job(1, { labor: [{ id: 1, technicianId: 11, hours: 1 }] })], directory, 'current'));
});
test('labor ownership prefers line; explicit null falls back; job counts use job owner', () => {
  const result = build([job(1, { technicianId: 12, labor: [line(1, 11, 2), line(2, null, 3), line(3, 13, 4)] })], directory, 'completed', day);
  assert.equal(result.rows.find(r => r.employeeId === '11').metrics.hours.value, 2);
  assert.equal(result.rows.find(r => r.employeeId === '12').metrics.hours.value, 3);
  assert.equal(result.rows.find(r => r.employeeId === '12').metrics.jobCount.value, 1);
  assert.equal(metric(result, 'jobCount'), 1); assert.equal(metric(result, 'hours'), 9);
  assert.ok(result.rows.filter(r => r.employeeId !== '12').every(r => r.metrics.jobCount.value === 0));
});
test('missing, unknown and malformed assignments are explicit; no name matching', () => {
  const result = build([job(1, { technicianId: null, labor: [line(1, null)] }), job(2, { technicianId: 99, labor: [line(2, 99)] }), job(3, { technicianId: {}, labor: [line(3, 'bad')] }), job(4, { labor: [{ id: 4, hours: 1, complete: false }] })], directory, 'current');
  assert.deepEqual(result.rows.map(r => r.assignmentStatus).sort(), ['invalid','matched','unassigned','unknown']);
  assert.equal(result.status, 'partial');
  assert.equal(result.rows.find(r => r.key === 'unassigned').metrics.hours.value, 2.5);
});
test('identical duplicate jobs and lines counted once', () => {
  const j = job(1, { labor: [line(1), line(1)] });
  const result = build([j,j], directory, 'completed', day);
  assert.equal(metric(result,'hours'), 1.5); assert.equal(metric(result,'jobCount'), 1);
});
test('assignment conflicts use bucket; conflicting quantities/parents/eligibility unavailable', () => {
  const result = build([job(1), job(1, { technicianId: 12, labor: [line(1, 12)] })], directory, 'completed', day);
  assert.equal(result.rows[0].assignmentStatus, 'invalid'); assert.equal(metric(result,'hours'), 1.5);
  for (const extra of [{ labor: [line(1,11,9)] }, { repairOrderId: 2 }, { selected: false }, { completedDate: '2026-09-13T12:00:00Z' }]) assert.throws(() => build([job(1),job(1,extra)], directory,'completed',day));
});
test('shared labor IDs deduplicate into conflict bucket; jobs retain distinct ownership', () => {
  const result = build([job(1),job(2,{technicianId:12,labor:[line(1,12)]})],directory,'completed',day);
  assert.equal(metric(result,'hours'),1.5);assert.equal(metric(result,'jobCount'),2);
  assert.equal(result.rows.find(r=>r.key==='invalid').metrics.hours.value,1.5);
  assert.deepEqual(result.reconciliation,{hours:'matched',jobCount:'matched'});
});
test('empty datasets are verified zero and completed zero-labor jobs still count', () => {
  for(const mode of ['completed','current']) {
    const result=build([],directory,mode,day);assert.deepEqual(result.rows,[]);assert.equal(metric(result,'hours'),0);assert.equal(result.status,'complete');
  }
  assert.equal(metric(build([job(1,{labor:[]})],directory,'completed',day),'jobCount'),1);
});
test('employee failure preserves valid aggregate report with unavailable names', async () => {
  const source=api([], [job()], [], true);const data=await technicianData(source,'completed');
  const result=build(data.records,data.directory,'completed',day);
  assert.equal(result.directoryStatus,'unavailable');assert.equal(result.rows[0].name,'Technician name unavailable');assert.equal(metric(result,'hours'),1.5);
});
test('complete job pagination and limit failures never produce partial metrics', async () => {
  const jobs=Array.from({length:101},(_,i)=>job(i));const source=api([],jobs);
  assert.equal((await technicianData(source,'completed')).records.length,101);
  await assert.rejects(technicianData(api([],jobs),'completed',{...LIMITS,pages:1}));
  await assert.rejects(technicianData(api([],jobs),'completed',{...LIMITS,requests:1}));
  await assert.rejects(technicianData(api([{id:1,repairOrderStatus:{id:1}}],jobs),'current',{...LIMITS,pages:1}), /Current Tech Board status 1: retrieval exceeded 1 pages/);
});
test('historical job request scans shop jobs independent of RO statuses or dates',async()=>{
  const source=api([], [job()]);await technicianData(source,'completed');
  assert.deepEqual(source.calls[0],{path:'/jobs',shop:'1',page:0,size:100});
});
test('invalid labor fields and job responses never fabricate zero',()=>{
  for(const labor of [null,[{id:1,hours:'1',complete:false}],[{hours:1,complete:false}],[line(1,11,-1)]]) assert.throws(()=>build([job(1,{labor})],directory,'current'));
});
test('reconciliation tolerates float representation; output is aggregate allowlist',()=>{
  const result=build([job(1,{customer:'SYNTHETIC_PRIVATE',labor:[line(1,11,0.1),line(2,12,0.2)],notes:'SYNTHETIC_PRIVATE'})],directory,'completed',day);
  assert.deepEqual(result.reconciliation,{hours:'matched',jobCount:'matched'});
  for(const row of result.rows) assert.deepEqual(Object.keys(row).sort(),['key','employeeId','name','assignmentStatus','metrics'].sort());
  for(const forbidden of ['SYNTHETIC_PRIVATE','repairOrderId','technicianId','completedDate','labor','token','grossProfit']) assert.ok(!JSON.stringify(result).includes(forbidden));
});
test('date change refetches completed only; existing stale guard applies',async()=>{
  const calls=[],pending=[],rendered=[];
  const controller=createTechnicianController({createLoader,fetchImpl:url=>new Promise(resolve=>{calls.push(url);pending.push(()=>resolve({ok:true,json:async()=>({report:url.includes('report=current')?'current':'completed',historical:false,date:new URL(url,'https://example.test').searchParams.get('date'),asOf:new Date().toISOString(),technicianReport:{rows:[]}})}));}),pending(){},render:(mode,data)=>rendered.push([mode,data.date]),failure(){assert.fail('unexpected');}});
  const initial=controller.refresh(day);assert.equal(calls.length,2);
  controller.dateChanged('2026-09-13');assert.equal(calls.length,2);
  pending[0]();pending[1]();await new Promise(r=>setImmediate(r));assert.equal(calls.length,3);
  pending[2]();await initial;
  assert.equal(calls.filter(c=>c.includes('report=current')).length,1);
  assert.ok(!calls.find(c=>c.includes('report=current')).includes('date='));
  assert.deepEqual(rendered.filter(r=>r[0]==='completed'),[['completed','2026-09-13']]);
});
test('technician renderer uses text only and clears stale data',()=>{
  const element=()=>({textContent:'',children:[],appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}});
  const elements={'technician-current-rows':element(),'technician-current-status':element()};
  const doc={getElementById:key=>elements[key],createElement:element};
  const result=build([job()],new Map([['11','<img> Synthetic']]),'current');
  renderTechnicians('current',{asOf:new Date().toISOString(),technicianReport:result},doc);
  assert.equal(elements['technician-current-rows'].children[0].children[0].textContent,'<img> Synthetic');
  assert.ok(elements['technician-current-status'].textContent.includes('Current snapshot as of'));
  renderTechnicians('current',null,doc);assert.equal(elements['technician-current-rows'].children.length,0);
});
test('endpoint current ignores historical date and sanitizes failure',async()=>{
  const handler=require('../api/technician-summary'); const oldFetch=global.fetch;
  const env={TEKMETRIC_BASE_URL:'https://sandbox.tekmetric.com',TEKMETRIC_CLIENT_ID:'synthetic',TEKMETRIC_CLIENT_SECRET:'synthetic',TEKMETRIC_SHOP_ID:'1'};
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  try {
    global.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'SYNTHETIC_PRIVATE'}:page([])});
    let code,body;const res={setHeader(){},status(value){code=value;return this;},json(value){body=value;}};
    await handler({method:'GET',query:{report:'current',date:'not-a-date'}},res);assert.equal(code,200);assert.equal(body.historical,false);assert.ok(!('date'in body));
    global.fetch=async()=>{throw new Error('SYNTHETIC_PRIVATE');};
    await handler({method:'GET',query:{report:'completed',date:day}},res);assert.equal(code,503);assert.equal(body.technicianReport.status,'unavailable');assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PRIVATE'));
  } finally {global.fetch=oldFetch;for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('history truncation and board truncation are independent, with precise reasons', async () => {
  const many = Array.from({length:101}, (_, i) => job(i));
  for (const failing of ['completed', 'current']) {
    const client = {shop:'1', async get(path, query) {
      if (path === '/employees') return page([]);
      const mode = query.repairOrderStatusId === undefined ? 'completed' : 'current';
      return page(mode === failing ? many : [job(1, {technicianId:null, labor:[line(1,null)]})], query.page);
    }};
    const [history, board] = await Promise.allSettled(['completed','current'].map(mode => technicianData(client,mode,{...LIMITS,pages:1})));
    const failed = failing === 'completed' ? history : board, passed = failing === 'completed' ? board : history;
    assert.equal(failed.status,'rejected'); assert.equal(passed.status,'fulfilled');
    assert.match(failed.reason.reason, /retrieval exceeded 1 pages of 100 jobs; additional pages remain/);
    if(failing === 'completed') assert.match(failed.reason.reason,/No verified completedDate filter/);
    const report=build(passed.value.records,passed.value.directory,failing === 'completed'?'current':'completed',day);
    assert.equal(report.rows[0].key,'unassigned');assert.equal(metric(report,'jobCount'),1);assert.equal(metric(report,'hours'),1.5);
  }
});
test('malformed pagination is not reported as a confirmed limit failure',async()=>{
  await assert.rejects(technicianData({shop:'1',get:async()=>({private:'SYNTHETIC_PRIVATE'})},'current'),error=>{
    assert.match(error.reason,/Current Tech Board status [123]/);assert.match(error.reason,/not a confirmed retrieval-limit failure/);
    assert.ok(!error.reason.includes('SYNTHETIC_PRIVATE'));return true;
  });
});
test('frontend renders sanitized unavailable response independently of successful table',async()=>{
  for(const failedMode of ['completed','current']) {
    const rendered=[];
    const controller=createTechnicianController({createLoader,fetchImpl:async url=>{
      const mode=new URL(url,'https://example.test').searchParams.get('report');
      return {ok:mode!==failedMode,json:async()=>({report:mode,date:day,historical:false,asOf:mode===failedMode?undefined:new Date().toISOString(),technicianReport:{status:mode===failedMode?'unavailable':'complete',rows:[],reason:'Sanitized retrieval explanation'}})};
    },pending(){},render:(mode,data)=>rendered.push([mode,data.technicianReport.status]),failure(){assert.fail('sanitized failure should render');}});
    await controller.refresh(day);
    assert.deepEqual(rendered.sort(),[['completed',failedMode==='completed'?'unavailable':'complete'],['current',failedMode==='current'?'unavailable':'complete']]);
  }
});
test('September 9 completed job with null assignments is Unassigned, not unavailable',()=>{
  const report=build([job(1,{completedDate:'2026-09-09T15:00:00Z',technicianId:null,labor:[line(1,null)]})],directory,'completed','2026-09-09');
  assert.equal(report.rows[0].key,'unassigned');assert.equal(metric(report,'hours'),1.5);assert.equal(metric(report,'jobCount'),1);
});
