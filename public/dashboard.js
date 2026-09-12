(function (root) {
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function formatCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
    return money.format(value / 100);
  }
  function today() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  // Serializes transport requests, coalesces date changes, and rejects stale results.
  function createLoader({ fetchImpl, render, pending, failure }) {
    let running = false, desired = null, generation = 0, controller;
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (desired !== null) {
          const date = desired, version = generation;
          desired = null;
          controller = new AbortController();
          pending(date);
          const timer = setTimeout(() => controller.abort(), 55000);
          try {
            const response = await fetchImpl(`/api/dashboard-summary?date=${encodeURIComponent(date)}`, { cache: 'no-store', signal: controller.signal });
            const data = await response.json();
            if (!response.ok || data.date !== date || !data.metrics || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('Unavailable');
            if (version === generation) render(data);
          } catch {
            if (version === generation) failure(date);
          } finally { clearTimeout(timer); }
        }
      } finally { running = false; }
    }
    return {
      refresh(date, changed = false) {
        if (running && !changed) return;
        generation++;
        desired = date;
        if (running) { controller.abort(); pending(date); }
        return pump();
      },
    };
  }
  function renderAdvisors(report, doc = document) {
    const body = doc.getElementById('advisor-rows');
    body.replaceChildren();
    const status = doc.getElementById('advisor-status');
    const reconciliation = doc.getElementById('advisor-reconciliation');
    reconciliation.textContent = '';
    if (!report || report.status === 'unavailable' || !Array.isArray(report.rows)) {
      status.textContent = 'Advisor report unavailable'; return;
    }
    status.textContent = report.rows.length === 0 ? 'No qualifying repair orders for this date.'
      : report.status === 'complete' ? 'All observed advisors' : 'Advisor report partially available · review unnamed assignments or unavailable metrics.';
    if (report.directoryStatus === 'unavailable') status.textContent += ' Employee names unavailable.';
    for (const row of report.rows) {
      const tr = doc.createElement('tr');
      const name = doc.createElement('td');
      name.textContent = row.name + (row.assignmentStatus === 'unknown' || row.assignmentStatus === 'name-unavailable' ? ` (${row.employeeId})` : '');
      tr.appendChild(name);
      for (const key of ['salesCents', 'repairOrderCount', 'averageRoCents', 'hoursSold', 'grossProfit']) {
        const td = doc.createElement('td'), metric = row.metrics?.[key];
        td.textContent = key !== 'grossProfit' && metric?.available === true && typeof metric.value === 'number' && Number.isFinite(metric.value)
          ? key.endsWith('Cents') ? formatCents(metric.value) : metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const labels = { salesCents: 'Sales', repairOrderCount: 'RO count', hoursSold: 'Hours' };
    reconciliation.textContent = 'Reconciliation with shop totals: ' + Object.entries(labels).map(([key, label]) => {
      const value = report.reconciliation?.[key];
      return `${label}: ${['matched', 'mismatch', 'unavailable'].includes(value) ? value : 'unavailable'}`;
    }).join(' · ');
  }
  function mount() {
    const byId = id => document.getElementById(id);
    const date = byId('reporting-date'), button = byId('refresh-button');
    const metrics = { salesCents: 'daily-sales', repairOrderCount: 'ro-count', averageRoCents: 'average-ro', hoursSold: 'hours-sold' };
    function clear() { renderAdvisors(null); Object.values(metrics).forEach(id => { byId(id).textContent = 'Unavailable'; }); }
    const loader = createLoader({
      fetchImpl: (...args) => fetch(...args),
      pending(day) {
        clear(); button.disabled = true;
        byId('connection-text').textContent = 'Loading daily report…';
        byId('last-updated').textContent = `${day} · America/Chicago`;
      },
      render(data) {
        let partial = false;
        for (const [key, element] of Object.entries(metrics)) {
          const metric = data.metrics[key];
          const valid = metric?.available === true && typeof metric.value === 'number' && Number.isFinite(metric.value);
          byId(element).textContent = valid ? (key.endsWith('Cents') ? formatCents(metric.value) : metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 })) : 'Unavailable';
          if (!valid) partial = true;
        }
        renderAdvisors(data.advisorReport);
        if (data.advisorReport?.status !== 'complete') partial = true;
        button.disabled = false;
        byId('connection-text').textContent = partial ? 'Report loaded · some metrics unavailable' : 'Daily report loaded';
        byId('last-updated').textContent = `${data.date} · Updated ${new Date(data.updatedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' })}`;
      },
      failure() {
        clear(); button.disabled = false;
        byId('connection-text').textContent = 'Daily data unavailable. Try again later.';
      },
    });
    date.value = today();
    date.addEventListener('change', () => loader.refresh(date.value, true));
    button.addEventListener('click', () => loader.refresh(date.value));
    loader.refresh(date.value);
    setInterval(() => loader.refresh(date.value), 120000);
  }
  if (typeof module !== 'undefined') module.exports = { formatCents, createLoader, renderAdvisors };
  else { root.DailyDashboard = { formatCents, createLoader, renderAdvisors }; mount(); }
})(typeof window === 'undefined' ? globalThis : window);
