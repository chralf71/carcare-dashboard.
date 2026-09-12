(function (root) {
  function renderTechnicians(mode, data, doc = document) {
    const body = doc.getElementById(`technician-${mode}-rows`);
    const status = doc.getElementById(`technician-${mode}-status`);
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
      for (const key of ['hours', 'jobCount']) {
        const td = doc.createElement('td'), value = row.metrics?.[key];
        td.textContent = value?.available && typeof value.value === 'number' && Number.isFinite(value.value)
          ? value.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const stamp = new Date(data.asOf).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
    status.textContent = `${mode === 'current' ? 'Current snapshot as of' : 'Updated'} ${stamp}. `
      + (report.rows.length ? 'Totals reconciled within this report.' : 'No qualifying work found.')
      + (report.status === 'partial' ? ' Assignment/name information is partial; see exception buckets.' : '');
  }
  function createTechnicianController({ createLoader, fetchImpl, pending, render, failure }) {
    const loader = mode => createLoader({ fetchImpl,
      acceptError: data => data?.technicianReport?.status === 'unavailable',
      urlFor: date => `/api/technician-summary?report=${mode}` + (mode === 'completed' ? `&date=${encodeURIComponent(date)}` : ''),
      validate: (data, date) => data.report === mode && (mode === 'current' ? data.historical === false : data.date === date)
        && data.technicianReport && Array.isArray(data.technicianReport.rows) && (data.technicianReport.status === 'unavailable' || Number.isFinite(Date.parse(data.asOf))),
      pending: date => pending(mode, date), render: data => render(mode, data), failure: () => failure(mode),
    });
    const completed = loader('completed'), current = loader('current');
    return {
      dateChanged(date) { return completed.refresh(date, true); },
      refresh(date) { return Promise.all([completed.refresh(date), current.refresh('current')]); },
    };
  }
  function mount() {
    const date = document.getElementById('reporting-date');
    const controller = createTechnicianController({
      createLoader: root.DailyDashboard.createLoader, fetchImpl: (...args) => fetch(...args),
      pending(mode, selected) {
        document.getElementById(`technician-${mode}-rows`).replaceChildren();
        document.getElementById(`technician-${mode}-status`).textContent = 'Loading…';
        if (mode === 'completed') document.getElementById('technician-completed-heading').textContent = `Completed on ${selected}`;
      },
      render: renderTechnicians, failure: mode => renderTechnicians(mode, null),
    });
    date.addEventListener('change', () => controller.dateChanged(date.value));
    document.getElementById('refresh-button').addEventListener('click', () => controller.refresh(date.value));
    controller.refresh(date.value);
    setInterval(() => controller.refresh(date.value), 120000);
  }
  if (typeof module !== 'undefined') module.exports = { createTechnicianController, renderTechnicians };
  else { root.TechnicianDashboard = { createTechnicianController, renderTechnicians }; mount(); }
})(typeof window === 'undefined' ? globalThis : window);
