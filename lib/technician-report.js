const { id } = require('./pagination');
const { employeeId } = require('./employees');
const { postedDay, validateDate } = require('./shop-date');
const metric = value => ({ available: true, value });
const unavailableMetric = () => ({ available: false, value: null, reason: 'Technician data unavailable' });
function unavailableReport() {
  return { status: 'unavailable', directoryStatus: 'unavailable', selectionMode: 'all', rows: [], totals: { hours: unavailableMetric(), jobCount: unavailableMetric() }, reconciliation: { hours: 'unavailable', jobCount: 'unavailable' }, reason: 'Complete technician data could not be verified within retrieval limits.' };
}
function assignment(value) {
  if (value === null || value === undefined) return 'unassigned';
  try { return `employee:${employeeId(value)}`; } catch { return 'invalid'; }
}
function completedDay(value) {
  if (value === null) return null;
  // Job completion is an instant, not a posted accounting date. Reject offsetless/date-only values.
  if (typeof value !== 'string' || !value.includes('T')) throw new Error('Invalid job completion timestamp');
  return postedDay(value);
}
function mergeAssignment(a, b) { return a === b ? a : 'invalid'; }
function normalize(records, mode) {
  const jobs = new Map();
  for (const raw of records) {
    const key = id(raw?.id);
    for (const field of ['authorized', 'selected', 'archived']) {
      if (![true, false, null].includes(raw[field])) throw new Error('Invalid eligibility');
    }
    const eligible = raw.authorized === true && raw.selected === true && raw.archived === false;
    const base = { id: key, parent: raw.repairOrderId === undefined ? null : id(raw.repairOrderId), eligible,
      flags: [raw.authorized, raw.selected, raw.archived], day: eligible && mode === 'completed' ? completedDay(raw.completedDate) : null, lines: [] };
    const owner = assignment(raw.technicianId);
    const lineOwners = new Map();
    if (eligible) {
      if (!Array.isArray(raw.labor)) throw new Error('Missing labor');
      const lines = new Map();
      for (const line of raw.labor) {
        const lineId = id(line?.id);
        if (typeof line.hours !== 'number' || !Number.isFinite(line.hours) || line.hours < 0) throw new Error('Invalid hours');
        if (mode === 'current' && typeof line.complete !== 'boolean') throw new Error('Invalid labor completion');
        const projection = { id: lineId, hours: line.hours, incomplete: mode === 'current' ? !line.complete : true };
        if (lines.has(lineId) && JSON.stringify(lines.get(lineId)) !== JSON.stringify(projection)) throw new Error('Conflicting labor quantity');
        // Only explicit null triggers the job assignment fallback; absent assignment stays Unassigned.
        const lineOwner = line.technicianId === null ? owner : assignment(line.technicianId);
        lineOwners.set(lineId, lineOwners.has(lineId) ? mergeAssignment(lineOwners.get(lineId), lineOwner) : lineOwner);
        lines.set(lineId, projection);
      }
      base.lines = [...lines.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    if (jobs.has(key)) {
      const previous = jobs.get(key);
      if (JSON.stringify(previous.base) !== JSON.stringify(base)) throw new Error('Conflicting job record');
      previous.owner = mergeAssignment(previous.owner, owner);
      for (const [lineId, lineOwner] of lineOwners) previous.lineOwners.set(lineId, mergeAssignment(previous.lineOwners.get(lineId), lineOwner));
    } else jobs.set(key, { base, owner, lineOwners });
  }
  return [...jobs.values()];
}
function buildTechnicianReport(records, directory, mode, date) {
  if (mode === 'completed') validateDate(date);
  const all = normalize(records, mode);
  const selected = all.filter(job => job.base.eligible && (mode === 'current' || job.base.day === date));
  const groups = new Map(), lines = new Map();
  const group = key => {
    if (!groups.has(key)) groups.set(key, { hours: 0, jobCount: 0 });
    return groups.get(key);
  };
  let count = 0;
  for (const job of selected) {
    const included = job.base.lines.filter(line => line.incomplete);
    if (mode === 'completed' || included.length) { group(job.owner).jobCount++; count++; }
    for (const line of included) {
      const owner = job.lineOwners.get(line.id);
      if (lines.has(line.id)) {
        const previous = lines.get(line.id);
        if (previous.hours !== line.hours) throw new Error('Conflicting shared labor');
        previous.owner = previous.job !== job.base.id ? 'invalid' : mergeAssignment(previous.owner, owner);
      } else lines.set(line.id, { hours: line.hours, owner, job: job.base.id });
    }
  }
  let totalHours = 0;
  for (const line of lines.values()) { group(line.owner).hours += line.hours; totalHours += line.hours; }
  if (!Number.isFinite(totalHours)) throw new Error('Invalid total hours');
  const rows = [...groups.entries()].map(([key, values]) => {
    const employee = key.startsWith('employee:') ? key.slice(9) : null;
    const assignmentStatus = key === 'invalid' ? 'invalid' : key === 'unassigned' ? 'unassigned' : directory === null ? 'name-unavailable' : directory.has(employee) ? 'matched' : 'unknown';
    const name = key === 'invalid' ? 'Invalid/conflicting assignment' : key === 'unassigned' ? 'Unassigned' : directory === null ? 'Technician name unavailable' : directory.get(employee) || 'Unknown technician';
    return { key, employeeId: employee, name, assignmentStatus, metrics: { hours: metric(values.hours), jobCount: metric(values.jobCount) } };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const sumHours = rows.reduce((sum, row) => sum + row.metrics.hours.value, 0);
  const sumJobs = rows.reduce((sum, row) => sum + row.metrics.jobCount.value, 0);
  const matched = Math.abs(sumHours - totalHours) <= 1e-9 * Math.max(1, Math.abs(totalHours), Math.abs(sumHours)) && sumJobs === count;
  if (!matched) throw new Error('Reconciliation failed');
  return { status: directory !== null && rows.every(row => row.assignmentStatus === 'matched') ? 'complete' : 'partial', directoryStatus: directory === null ? 'unavailable' : 'complete', selectionMode: 'all', rows,
    totals: { hours: metric(totalHours), jobCount: metric(count) }, reconciliation: { hours: 'matched', jobCount: 'matched' } };
}
module.exports = { buildTechnicianReport, unavailableReport, normalize, completedDay };
