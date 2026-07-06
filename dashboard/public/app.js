/* Wasted Spend dashboard — vanilla JS, hand-rolled SVG marks.
   Polls named server endpoints every 2s; every panel shows its SQL. */
const $ = (s) => document.querySelector(s);
const tooltip = $('#tooltip');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmt$ = (v) => '$' + Number(v || 0).toFixed(4);
const fmtMs = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms');
const fmtT = (iso) => new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function api(name, params = '') {
  const r = await fetch(`/api/${name}${params}`);
  if (!r.ok) throw new Error((await r.json()).error || r.status);
  const j = await r.json();
  const pre = $(`#sql-${name}`);
  if (pre && !pre.textContent) pre.textContent = j.sql;
  return j.rows;
}

function showTip(ev, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const x = Math.min(ev.clientX + 12, innerWidth - tooltip.offsetWidth - 8);
  tooltip.style.left = x + 'px';
  tooltip.style.top = ev.clientY + 12 + 'px';
}
const hideTip = () => (tooltip.hidden = true);

/* ── bar series: wasted $/min (status-critical — waste is a state, not a series) */
function renderWasted(rows) {
  const svg = $('#wasted-chart');
  const W = 560, H = 120, pad = 4;
  const now = Date.now(), buckets = [];
  for (let i = 29; i >= 0; i--) {
    const t = new Date(Math.floor(now / 60000 - i) * 60000);
    const key = t.toISOString().slice(0, 16);
    const row = rows.find((r) => r.minute.slice(0, 16) === key);
    buckets.push({ t, usd: row ? +row.wasted_usd : 0, dups: row ? +row.duplicate_calls : 0 });
  }
  const max = Math.max(0.0001, ...buckets.map((b) => b.usd));
  const bw = (W - pad * 2) / 30;
  svg.innerHTML = buckets.map((b, i) => {
    const h = Math.round((b.usd / max) * (H - 18));
    const x = pad + i * bw, y = H - h;
    return `<rect data-i="${i}" x="${x + 1}" y="${y}" width="${bw - 2}" height="${Math.max(h, b.usd > 0 ? 3 : 0)}"
      rx="2" fill="${css('--critical')}"></rect>`;
  }).join('') + `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="${css('--axis')}" stroke-width="1"/>`;
  svg.querySelectorAll('rect').forEach((r) => {
    const b = buckets[+r.dataset.i];
    r.addEventListener('mousemove', (ev) =>
      showTip(ev, `<b>${fmt$(b.usd)}</b> wasted · ${b.dups} duplicate calls<br>${b.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
    r.addEventListener('mouseleave', hideTip);
  });
}

/* ── two-series line: latency p95 infra vs llm ── */
function renderLatency(rows) {
  const svg = $('#latency-chart');
  const W = 1160, H = 140, padL = 6, padB = 14, padT = 12;
  if (!rows.length) { svg.innerHTML = ''; return; }
  const max = Math.max(...rows.flatMap((r) => [+r.infra_p95_ms || 0, +r.llm_p95_ms || 0]), 1);
  const x = (i) => padL + (i / Math.max(rows.length - 1, 1)) * (W - padL * 2);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const path = (key, color) => {
    const pts = rows.map((r, i) => `${x(i)},${y(+r[key] || 0)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  };
  const grid = [0.25, 0.5, 0.75].map((f) =>
    `<line x1="${padL}" y1="${y(max * f)}" x2="${W - padL}" y2="${y(max * f)}" stroke="${css('--grid')}" stroke-width="1"/>`).join('');
  const last = rows[rows.length - 1];
  svg.innerHTML = grid + path('infra_p95_ms', css('--infra')) + path('llm_p95_ms', css('--llm')) +
    `<text x="${W - padL - 4}" y="${y(+last.infra_p95_ms || 0) - 5}" fill="${css('--infra')}" font-size="11" text-anchor="end">infra ${fmtMs(+last.infra_p95_ms || 0)}</text>` +
    `<text x="${W - padL - 4}" y="${y(+last.llm_p95_ms || 0) - 5}" fill="${css('--llm')}" font-size="11" text-anchor="end">llm ${fmtMs(+last.llm_p95_ms || 0)}</text>`;
  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.round(((ev.clientX - rect.left) / rect.width) * (rows.length - 1));
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    showTip(ev, `<b>${r.minute.slice(11, 16)}</b><br>infra p95 ${fmtMs(+r.infra_p95_ms || 0)} · llm p95 ${fmtMs(+r.llm_p95_ms || 0)}<br>${r.llm_calls} calls · ${fmt$(r.cost_usd)}`);
  };
  svg.onmouseleave = hideTip;
}

function renderTiles(rows) {
  const last = [...rows].reverse().find((r) => +r.llm_calls > 0) || rows[rows.length - 1];
  if (!last) return;
  $('#t-lat-infra').textContent = fmtMs(+last.infra_p95_ms || 0);
  $('#t-lat-llm').textContent = fmtMs(+last.llm_p95_ms || 0);
  $('#t-cost').textContent = fmt$(last.cost_usd) + '/min';
  $('#t-quality').textContent = (+last.avg_quality || 0).toFixed(1);
  $('#t-loops').textContent = (+last.gens_per_request || 0).toFixed(2);
}

function renderRootCauses(rows) {
  $('#root-causes tbody').innerHTML = rows.map((r) => `
    <tr><td>${r.root_cause}</td><td class="num">${r.incidents}</td>
    <td class="num">${r.duplicate_calls}</td>
    <td class="num"><b>${fmt$(r.wasted_usd)}</b></td>
    <td class="num">${r.worst_span_ms ? fmtMs(+r.worst_span_ms) : '–'}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">no waste detected — inject a fault to see this fill up</td></tr>';
}

function renderRecent(rows) {
  $('#recent tbody').innerHTML = rows.map((r) => `
    <tr data-id="${r.trace_id}">
      <td>${fmtT(r.t)}</td><td>${r.model || '–'}</td>
      <td class="num">${r.llm_calls}${+r.errors ? ' ⚠' : ''}</td>
      <td class="num">${fmt$(r.cost_usd)}</td>
      <td class="num">${fmtMs(+r.max_ms)}</td>
      <td class="mono muted">${r.trace_id.slice(0, 8)}…</td></tr>`).join('');
  document.querySelectorAll('#recent tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => loadWaterfall(tr.dataset.id)));
}

/* ── the unified waterfall: both worlds, one timeline ── */
async function loadWaterfall(traceId) {
  const rows = await api('waterfall', `?trace_id=${traceId}`);
  $('#waterfall-panel').hidden = false;
  $('#wf-trace').textContent = traceId;
  if (!rows.length) { $('#waterfall').innerHTML = '<div class="muted">no spans</div>'; return; }
  const t0 = Math.min(...rows.map((r) => +new Date(r.start_time + 'Z')));
  const t1 = Math.max(...rows.map((r) => +new Date(r.start_time + 'Z') + (+r.duration_ms)));
  const span = Math.max(t1 - t0, 1);
  $('#waterfall').innerHTML = rows.map((r) => {
    const left = ((+new Date(r.start_time + 'Z') - t0) / span) * 100;
    const width = Math.max((+r.duration_ms / span) * 100, 0.4);
    const showMs = width < 78; /* keep the ms label inside the track */
    const isErr = r.status === 'ERROR' || r.status === 'Error';
    const llmInfo = r.layer === 'llm' ? ` · ${fmt$(r.cost_usd)} · ${r.total_tokens} tok · ${r.model}` : '';
    return `<div class="wf-row">
      <div class="wf-name" title="${r.name}">${r.layer === 'llm' ? '🧠 ' : ''}${r.name}</div>
      <div class="wf-track">
        <div class="wf-bar ${r.layer}${isErr ? ' error' : ''}" style="left:${left}%;width:${width}%"
             data-tip="<b>${r.name}</b> (${r.layer})<br>${fmtMs(+r.duration_ms)}${llmInfo}${isErr ? '<br>⚠ ERROR' : ''}">
          ${showMs ? `<span class="wf-ms">${fmtMs(+r.duration_ms)}${r.layer === 'llm' ? ` · ${fmt$(r.cost_usd)}` : ''}</span>` : ''}
        </div>
      </div></div>`;
  }).join('');
  document.querySelectorAll('.wf-bar').forEach((b) => {
    b.addEventListener('mousemove', (ev) => showTip(ev, b.dataset.tip));
    b.addEventListener('mouseleave', hideTip);
  });
  $('#waterfall-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── poll loop ── */
let firstWaterfall = true;
async function tick() {
  try {
    const [total, series, golden, causes, recent] = await Promise.all([
      api('wasted_total'), api('wasted_series'), api('golden'), api('root_causes'), api('recent'),
    ]);
    const t = total[0] || {};
    $('#wasted-usd').textContent = fmt$(t.wasted_usd);
    $('#wasted-sub').textContent = `${t.duplicate_calls || 0} duplicate calls · ${Number(t.wasted_tokens || 0).toLocaleString()} tokens burned`;
    renderWasted(series);
    renderTiles(golden);
    renderLatency(golden);
    renderRootCauses(causes);
    renderRecent(recent);
    if (firstWaterfall && recent.length) { firstWaterfall = false; loadWaterfall(recent[0].trace_id); }
    $('#live').classList.remove('stale');
  } catch (e) {
    $('#live').classList.add('stale');
    console.error(e);
  }
}
tick();
setInterval(tick, 2000);
