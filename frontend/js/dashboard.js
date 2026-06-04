/* ============================================================
   AUTOMOTIVE MONITORING SYSTEM — Dashboard JS
   ============================================================ */

'use strict';

// ─── Config ──────────────────────────────────────────────
// Auto-detect API base: if opened as file://, point to Flask explicitly
const API = (location.protocol === 'file:')
  ? 'http://localhost:5000'
  : '';
const REFRESH   = 5000;        // ms
const CHART_PTS = 30;

const TH = {
  temperature:  35.0,
  humidity:     80.0,
  sound_level:  3000,
  pressure_min: 900.0,
  pressure_max: 1080.0,
};

// ─── State ───────────────────────────────────────────────
let recordPage   = 1;
let recordTotal  = 0;
const PER_PAGE   = 8;
let activeChart  = 'temp';
let calYear, calMonth;
let scheduledJobs = [];

// ─── Chart instances ──────────────────────────────────────
let mainChart = null;

// ─── Helpers ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html) e.innerHTML = html; return e; };

// PostgreSQL returns timestamps without 'Z', so browser treats them as local time.
// We append 'Z' to tell the browser they are UTC, then display in the user's local timezone.
function utc(ts) {
  // PostgreSQL returns "2026-06-03 21:47:20.134741" — replace space with T only,
  // NO Z appended so the browser treats it as UTC and displays it as-is (no local conversion).
  const s = String(ts).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d) ? new Date(ts) : d;
}
// Format helpers: always display in UTC so times match the database
const UTC_OPTS = { timeZone: 'UTC' };
function fmtTime(ts) {
  return utc(ts).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'UTC' });
}
function fmtDateTime(ts) {
  return utc(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC' });
}
function fmtFull(ts) {
  return utc(ts).toLocaleString('en-US', { timeZone:'UTC' });
}

function statusFor(key, val) {
  if (key === 'pressure') {
    if (val < TH.pressure_min || val > TH.pressure_max) return 'danger';
    if (val < TH.pressure_min * 1.05 || val > TH.pressure_max * 0.97) return 'warn';
    return 'ok';
  }
  const limit = TH[key];
  if (val > limit)          return 'danger';
  if (val > limit * 0.88)   return 'warn';
  return 'ok';
}

// ─── Clock ───────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    $('hdr-time').textContent = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    $('hdr-date').textContent = now.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  }
  tick(); setInterval(tick, 1000);
}

// ─── Metric Cards ────────────────────────────────────────
function updateCard(key, val, unit) {
  const state = statusFor(key === 'pressure' ? 'pressure' : key, val);
  const labels = { temperature: 'Temperature', humidity: 'Humidity', pressure: 'Pressure', sound_level: 'Sound Level' };

  const card    = $('card-' + key);
  const valEl   = $('val-' + key);
  const stateEl = $('state-' + key);

  card.className = 'metric-card state-' + state;
  valEl.textContent = typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(1)) : '—';

  const icons  = { ok: 'fa-circle-check', warn: 'fa-circle-exclamation', danger: 'fa-triangle-exclamation' };
  const words  = { ok: 'Normal', warn: 'Caution', danger: 'Alert' };
  stateEl.className = 'metric-status status-' + state;
  stateEl.innerHTML = `<i class="fa-solid ${icons[state]}"></i> ${words[state]}`;
}

// ─── Sparklines ───────────────────────────────────────────
const sparklines = {};

function initSparkline(key, color) {
  const canvas = $(key + '-spark');
  if (!canvas) return;
  sparklines[key] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: .4, fill: true, backgroundColor: color + '18' }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

function pushSparkline(key, val) {
  const ch = sparklines[key]; if (!ch) return;
  ch.data.labels.push('');
  ch.data.datasets[0].data.push(val);
  if (ch.data.labels.length > 20) { ch.data.labels.shift(); ch.data.datasets[0].data.shift(); }
  ch.update('none');
}

// ─── Main Chart ───────────────────────────────────────────
function initMainChart() {
  const ctx = $('main-chart').getContext('2d');
  mainChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Temperature (°C)', data: [], borderColor: '#0369a1', backgroundColor: '#0369a118', borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: 'y' },
      { label: 'Humidity (%)',     data: [], borderColor: '#0f766e', backgroundColor: '#0f766e18', borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: 'y2', hidden: true },
      { label: 'Pressure (hPa)',   data: [], borderColor: '#d97706', backgroundColor: '#d9770618', borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: 'y',  hidden: true },
      { label: 'Sound Level (AO)', data: [], borderColor: '#7c3aed', backgroundColor: '#7c3aed18', borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: 'y2', hidden: true },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 10, font: { size: 11 }, color: '#64748b' } }
      },
      scales: {
        x:  { ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#f1f5f9' } },
        y:  { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#f1f5f9' } },
        y2: { position: 'right', ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

function setActiveDataset(name) {
  const map = { temp: 0, hum: 1, pres: 2, sound: 3 };
  mainChart.data.datasets.forEach((ds, i) => ds.hidden = (i !== map[name]));
  mainChart.update();
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.chart === name));
}

function updateMainChart(rows) {
  const labels = rows.map(r => fmtTime(r.created_at));
  mainChart.data.labels = labels;
  mainChart.data.datasets[0].data = rows.map(r => r.temperature);
  mainChart.data.datasets[1].data = rows.map(r => r.humidity);
  mainChart.data.datasets[2].data = rows.map(r => r.pressure);
  mainChart.data.datasets[3].data = rows.map(r => r.sound_level);
  mainChart.update('none');
}

// ─── Records Table ────────────────────────────────────────
function renderRecords(records, total) {
  recordTotal = total;
  const tbody = $('records-tbody');
  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1.5rem">No records yet</td></tr>`;
    return;
  }
  tbody.innerHTML = records.map(r => `
    <tr>
      <td style="color:var(--muted)">${fmtDateTime(r.created_at)}</td>
      <td class="col-temp">${r.temperature.toFixed(1)}</td>
      <td class="col-hum">${r.humidity.toFixed(1)}</td>
      <td class="col-pres">${r.pressure.toFixed(1)}</td>
      <td class="col-sound">${r.sound_level}</td>
    </tr>`).join('');
  renderPagination(total);
}

function renderPagination(total) {
  const pages = Math.ceil(total / PER_PAGE) || 1;
  const pg    = $('pagination');
  pg.innerHTML = '';

  const btn = (label, page, disabled = false, active = false) => {
    const b = el('button', 'page-btn' + (active ? ' active' : ''));
    b.innerHTML = label;
    b.disabled  = disabled;
    if (!disabled && !active) b.onclick = () => { recordPage = page; fetchRecords(); };
    return b;
  };

  pg.appendChild(btn('<i class="fa-solid fa-angles-left"></i>',  1,         recordPage === 1));
  pg.appendChild(btn('<i class="fa-solid fa-angle-left"></i>',   recordPage - 1, recordPage === 1));

  // page numbers
  let start = Math.max(1, recordPage - 2);
  let end   = Math.min(pages, start + 4);
  start = Math.max(1, end - 4);

  if (start > 1) { pg.appendChild(btn(1, 1)); if (start > 2) pg.appendChild(Object.assign(el('span','page-ellipsis'), {textContent:'…'})); }
  for (let i = start; i <= end; i++) pg.appendChild(btn(i, i, false, i === recordPage));
  if (end < pages) { if (end < pages - 1) pg.appendChild(Object.assign(el('span','page-ellipsis'), {textContent:'…'})); pg.appendChild(btn(pages, pages)); }

  pg.appendChild(btn('<i class="fa-solid fa-angle-right"></i>',  recordPage + 1, recordPage >= pages));
  pg.appendChild(btn('<i class="fa-solid fa-angles-right"></i>', pages,          recordPage >= pages));
}

// ─── Alert List ───────────────────────────────────────────
function renderAlerts(alerts) {
  const el = $('alert-list');
  if (!alerts.length) {
    el.innerHTML = `<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:.82rem"><i class="fa-solid fa-check-circle" style="color:var(--ok)"></i> No recent alerts</div>`;
    return;
  }
  const typeLabel = { temperature: 'High Temperature', humidity: 'High Humidity', sound_level: 'High Sound Level', pressure: 'Pressure Warning' };
  el.innerHTML = alerts.map(a => `
    <div class="alert-item">
      <div class="alert-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
      <div style="flex:1;min-width:0">
        <div class="alert-type">${typeLabel[a.alert_type] || a.alert_type}</div>
        <div class="alert-msg">${a.message}</div>
        <div class="alert-time">${fmtFull(a.created_at)}</div>
      </div>
      <span class="alert-badge">High</span>
    </div>`).join('');
}

// ─── Averages Table ───────────────────────────────────────
function renderAverages(rows) {
  const tbody = $('avg-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1rem">No averages yet — runs every hour</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td style="color:var(--muted);font-size:.72rem">${fmtDateTime(r.period_start)}</td>
      <td class="col-temp">${(+r.avg_temperature).toFixed(1)}</td>
      <td class="col-hum">${(+r.avg_humidity).toFixed(1)}</td>
      <td class="col-pres">${(+r.avg_pressure).toFixed(1)}</td>
      <td class="col-sound">${(+r.avg_sound).toFixed(0)}</td>
    </tr>`).join('');
}

// ─── Calendar ────────────────────────────────────────────
function initCalendar() {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

function renderCalendar() {
  const today    = new Date();
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay  = new Date(calYear, calMonth + 1, 0);
  const months   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  $('cal-title').textContent = `${months[calMonth]} ${calYear}`;

  // collect days with scheduled jobs
  const jobDays = new Set(scheduledJobs.map(j => {
    const d = new Date(j.next_run); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }));

  const grid = $('cal-grid');
  grid.innerHTML = '';
  // DOW headers
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d => {
    const div = el('div','cal-dow'); div.textContent = d; grid.appendChild(div);
  });

  // blank days before month start
  for (let i = 0; i < firstDay.getDay(); i++) {
    const div = el('div','cal-day other-month'); div.textContent = ''; grid.appendChild(div);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const isToday = (d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear());
    const key     = `${calYear}-${calMonth}-${d}`;
    const cls     = ['cal-day', isToday ? 'today' : '', jobDays.has(key) ? 'has-job' : ''].join(' ').trim();
    const div     = el('div', cls); div.textContent = d;
    div.onclick   = () => selectCalDay(d);
    grid.appendChild(div);
  }
}

function selectCalDay(day) {
  const pad = n => String(n).padStart(2,'0');
  const dateStr = `${calYear}-${pad(calMonth+1)}-${pad(day)}`;
  $('schedule-date').value = dateStr;
}

// cal nav — assigned in boot() after DOM is ready
// btn-schedule — assigned in boot() after DOM is ready

async function fetchSchedules() {
  try {
    const r = await fetch(`${API}/api/schedule`);
    scheduledJobs = await r.json();
    renderScheduledJobs();
  } catch(e) {}
}

function renderScheduledJobs() {
  const wrap = $('scheduled-jobs');
  if (!scheduledJobs.length) {
    wrap.innerHTML = `<p style="font-size:.75rem;color:var(--muted)">No scheduled summaries.</p>`;
    return;
  }
  wrap.innerHTML = scheduledJobs.map(j => `
    <div class="scheduled-item">
      <div>
        <i class="fa-regular fa-clock" style="color:var(--primary);margin-right:.35rem"></i>
        <span class="scheduled-item-time">${j.next_run}</span>
      </div>
      <button class="btn-danger-sm" onclick="cancelJob('${j.id}')">
        <i class="fa-solid fa-xmark"></i> Cancel
      </button>
    </div>`).join('');
}

async function cancelJob(id) {
  await fetch(`${API}/api/schedule/${id}`, { method: 'DELETE' });
  await fetchSchedules();
  renderCalendar();
}

// ─── Fetch functions ──────────────────────────────────────
async function fetchCurrent() {
  try {
    const r = await fetch(`${API}/api/sensor-data/current`);
    const d = await r.json();
    if (!d.temperature) return;
    updateCard('temperature', d.temperature, '°C');
    updateCard('humidity',    d.humidity,    '%');
    updateCard('pressure',    d.pressure,    'hPa');
    updateCard('sound_level', d.sound_level, 'AO');
    pushSparkline('temperature', d.temperature);
    pushSparkline('humidity',    d.humidity);
    pushSparkline('pressure',    d.pressure);
    pushSparkline('sound_level', d.sound_level);
    $('last-update').textContent = 'Last update: ' + fmtTime(d.created_at);
  } catch(e) { console.error('fetchCurrent', e); }
}

async function fetchHistory() {
  try {
    const r    = await fetch(`${API}/api/sensor-data/latest?n=${CHART_PTS}`);
    const rows = (await r.json()).reverse();
    updateMainChart(rows);
  } catch(e) {}
}

async function fetchRecords() {
  try {
    const r = await fetch(`${API}/api/sensor-data/records?page=${recordPage}&per_page=${PER_PAGE}`);
    const d = await r.json();
    renderRecords(d.records, d.total);
  } catch(e) {}
}

async function fetchAlerts() {
  try {
    const r = await fetch(`${API}/api/alerts?n=15`);
    renderAlerts(await r.json());
  } catch(e) {}
}

async function fetchAverages() {
  try {
    const r = await fetch(`${API}/api/averages?n=12`);
    renderAverages(await r.json());
  } catch(e) {}
}

// Force compute
$('btn-compute-now').onclick = async () => {
  await fetch(`${API}/api/averages/compute`, { method: 'POST' });
  fetchAverages();
};

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(b => {
  b.onclick = () => { activeChart = b.dataset.chart; setActiveDataset(activeChart); };
});

// ─── Full refresh loop ────────────────────────────────────
async function refresh() {
  await Promise.all([ fetchCurrent(), fetchHistory(), fetchAlerts() ]);
}

// ─── Boot ────────────────────────────────────────────────
(async function boot() {
  startClock();
  initSparkline('temperature', '#0369a1');
  initSparkline('humidity',    '#0f766e');
  initSparkline('pressure',    '#d97706');
  initSparkline('sound_level', '#7c3aed');
  initMainChart();
  setActiveDataset('temp');
  initCalendar();

  // Calendar nav
  $('cal-prev').onclick = () => { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendar(); };
  $('cal-next').onclick = () => { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendar(); };

  // Schedule button — convert local datetime to UTC before sending to Flask
  $('btn-schedule').onclick = async () => {
    const date = $('schedule-date').value;   // "2026-06-04"
    const time = $('schedule-time').value;   // "22:10"
    if (!date || !time) { alert('Please select a date and time.'); return; }

    // Send exactly what the user typed — Flask will treat it as local server time
    const runAt = `${date}T${time}:00`;  // e.g. "2026-06-03T22:10:00"

    const r = await fetch(`${API}/api/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_at: runAt })
    });
    const result = await r.json();
    if (r.ok) {
      await fetchSchedules();
      renderCalendar();
      alert(`Summary scheduled for ${result.scheduled_at.replace('T',' ')}`);
    } else {
      alert(`Error: ${result.error || 'Could not schedule. Check the date/time.'}`);
    }
  };

  await Promise.all([ refresh(), fetchRecords(), fetchAverages(), fetchSchedules() ]);

  setInterval(refresh, REFRESH);
  setInterval(fetchRecords, 10000);
  setInterval(fetchAlerts,  8000);
  setInterval(fetchAverages, 60000);
})();
