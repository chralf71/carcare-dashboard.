(function (root) {
  const shared = typeof module !== 'undefined' ? require('./dashboard') : null;
  function money(cents) { return (shared || root.DailyDashboard).formatCents(cents); }
  function weekLabel(week) { return week.weekStart === week.weekEnd ? week.weekStart : `${week.weekStart} – ${week.weekEnd}`; }
  function renderMonthSummary(data, doc = document) {
    const salesEl = doc.getElementById('month-sales');
    const roEl = doc.getElementById('month-ro-count');
    const status = doc.getElementById('month-status');
    const body = doc.getElementById('month-week-rows');
    body.replaceChildren();
    const summary = data?.monthToDate;
    if (!summary || summary.totals?.salesCents?.available !== true) {
      salesEl.textContent = 'Unavailable'; roEl.textContent = 'Unavailable';
      status.textContent = 'Unavailable — ' + (typeof summary?.reason === 'string' ? summary.reason : 'Month to date request failed. Try refreshing.');
      return;
    }
    salesEl.textContent = money(summary.totals.salesCents.value);
    roEl.textContent = summary.totals.repairOrderCount.available ? summary.totals.repairOrderCount.value.toLocaleString('en-US') : 'Unavailable';
    status.textContent = `${summary.start} through ${summary.end}. `
      + (summary.weeks.length ? 'Weekly totals reconcile to the month-to-date figures above.' : 'No qualifying repair orders this month.');
    for (const week of summary.weeks) {
      const tr = doc.createElement('tr');
      const range = doc.createElement('td'); range.textContent = weekLabel(week); tr.appendChild(range);
      const salesTd = doc.createElement('td'); salesTd.textContent = week.salesCents.available ? money(week.salesCents.value) : 'Unavailable'; tr.appendChild(salesTd);
      const roTd = doc.createElement('td'); roTd.textContent = week.repairOrderCount.available ? week.repairOrderCount.value.toLocaleString('en-US') : 'Unavailable'; tr.appendChild(roTd);
      body.appendChild(tr);
    }
  }
  function createMonthSummaryController({ createLoader, fetchImpl, pending, render, failure }) {
    return createLoader({ fetchImpl,
      acceptError: data => data?.monthToDate?.totals?.salesCents?.available === false,
      urlFor: date => `/api/month-summary?date=${encodeURIComponent(date)}`,
      validate: (data, date) => data.date === date && data.monthToDate && Array.isArray(data.monthToDate.weeks)
        && (data.monthToDate.totals?.salesCents?.available === false || Number.isFinite(Date.parse(data.updatedAt))),
      pending, render, failure,
    });
  }
  function mount() {
    const date = document.getElementById('reporting-date');
    const loader = createMonthSummaryController({
      createLoader: root.DailyDashboard.createLoader, fetchImpl: (...args) => fetch(...args),
      pending() {
        document.getElementById('month-week-rows').replaceChildren();
        document.getElementById('month-sales').textContent = 'Unavailable';
        document.getElementById('month-ro-count').textContent = 'Unavailable';
        document.getElementById('month-status').textContent = 'Loading…';
      },
      render: data => renderMonthSummary(data), failure: () => renderMonthSummary(null),
    });
    date.addEventListener('change', () => loader.refresh(date.value, true));
    document.getElementById('refresh-button').addEventListener('click', () => loader.refresh(date.value));
    loader.refresh(date.value);
    setInterval(() => loader.refresh(date.value), 120000);
  }
  if (typeof module !== 'undefined') module.exports = { createMonthSummaryController, renderMonthSummary };
  else { root.MonthDashboard = { createMonthSummaryController, renderMonthSummary }; mount(); }
})(typeof window === 'undefined' ? globalThis : window);
