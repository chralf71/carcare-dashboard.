(function (root) {
  const shared = typeof module !== 'undefined' ? require('./dashboard') : null;
  function money(cents) { return (shared || root.DailyDashboard).formatCents(cents); }
  function renderTechnicianWeek(data, doc = document) {
    const body = doc.getElementById('technician-week-rows');
    const status = doc.getElementById('technician-week-status');
    body.replaceChildren();
    const report = data?.technicianReport;
    if (!report || report.status === 'unavailable') {
      status.textContent = 'Unavailable — ' + (typeof report?.reason === 'string' ? report.reason : 'Technician request failed. Try refreshing.');
      return;
    }
    for (const row of report.rows) {
      const tr = doc.createElement('tr'), name = doc.createElement('td');
      name.textContent = row.name + (['unknown', 'name-unavailable'].includes(row.assignmentStatus) ? ` (${row.employeeId})` : '');
      tr.appendChild(name);
      const hours = doc.createElement('td'), hoursMetric = row.metrics?.hoursSold;
      hours.textContent = hoursMetric?.available && typeof hoursMetric.value === 'number' && Number.isFinite(hoursMetric.value)
        ? hoursMetric.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable';
      tr.appendChild(hours);
      const sales = doc.createElement('td'), salesMetric = row.metrics?.laborSalesCents;
      sales.textContent = salesMetric?.available && typeof salesMetric.value === 'number' && Number.isFinite(salesMetric.value)
        ? money(salesMetric.value) : 'Unavailable';
      tr.appendChild(sales);
      body.appendChild(tr);
    }
    const range = data.weekStart === data.weekEnd ? data.weekStart : `${data.weekStart} – ${data.weekEnd}`;
    status.textContent = `Week of ${range}. `
      + (report.rows.length ? 'Totals reconciled within this report.' : 'No qualifying posted repair orders this week.')
      + (report.status === 'partial' ? ' Assignment/name information is partial; see exception buckets.' : '');
  }
  function createTechnicianWeekController({ createLoader, fetchImpl, pending, render, failure }) {
    return createLoader({ fetchImpl,
      acceptError: data => data?.technicianReport?.status === 'unavailable',
      urlFor: date => `/api/technician-summary?date=${encodeURIComponent(date)}`,
      validate: (data, date) => data.report === 'week' && data.date === date
        && data.technicianReport && Array.isArray(data.technicianReport.rows) && (data.technicianReport.status === 'unavailable' || Number.isFinite(Date.parse(data.asOf))),
      pending, render, failure,
    });
  }
  function mount() {
    const date = document.getElementById('reporting-date');
    const loader = createTechnicianWeekController({
      createLoader: root.DailyDashboard.createLoader, fetchImpl: (...args) => fetch(...args),
      pending() {
        document.getElementById('technician-week-rows').replaceChildren();
        document.getElementById('technician-week-status').textContent = 'Loading…';
      },
      render: data => renderTechnicianWeek(data), failure: () => renderTechnicianWeek(null),
    });
    date.addEventListener('change', () => loader.refresh(date.value, true));
    document.getElementById('refresh-button').addEventListener('click', () => loader.refresh(date.value));
    loader.refresh(date.value);
    setInterval(() => loader.refresh(date.value), 120000);
  }
  if (typeof module !== 'undefined') module.exports = { createTechnicianWeekController, renderTechnicianWeek };
  else { root.TechnicianDashboard = { createTechnicianWeekController, renderTechnicianWeek }; mount(); }
})(typeof window === 'undefined' ? globalThis : window);
