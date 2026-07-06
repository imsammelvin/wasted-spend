/* WASTEDSPEND console — vanilla JS, hand-rolled SVG.
   All series are gap-filled onto a continuous 30-minute time axis. */
const $ = (s) => document.querySelector(s);
const tooltip = $('#tooltip');
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const fmt$ = (v, d = 4) => '$' + Number(v || 0).toFixed(d);
const fmtMs = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');
const fmtK = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
const ago = (iso) => {
  const s = (Date.now() - +new Date(iso + 'Z')) / 1000;
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
};
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  tooltip.style.left = Math.min(ev.clientX + 14, innerWidth - tooltip.offsetWidth - 10) + 'px';
  tooltip.style.top = Math.min(ev.clientY + 14, innerHeight - tooltip.offsetHeight - 10) + 'px';
}
const hideTip = () => (tooltip.hidden = true);

/* gap-fill rows (keyed "YYYY-MM-DD HH:MM") onto the last N minute buckets */
function buckets30(rows, fields) {
  const out = [];
  const nowMin = Math.floor(Date.now() / 60000);
  for (let i = 29; i >= 0; i--) {
    const t = new Date((nowMin - i) * 60000);
    const key = t.toISOString().slice(0, 16).replace('T', ' ');
    const row = rows.find((r) => r.minute.slice(0, 16) === key) || {};
    const b = { t };
    for (const f of fields) b[f] = +row[f] || 0;
    out.push(b);
  }
  return out;
}

/* ── hero ── */
let lastWasted = null;
function renderHero(t, series) {
  const wasted = +t.wasted_usd || 0, spend = +t.spend_usd || 0;
  const fig = $('#wasted-usd');
  fig.textContent = fmt$(wasted);
  if (lastWasted !== null && wasted > lastWasted) {
    fig.classList.add('tick');
    setTimeout(() => fig.classList.remove('tick'), 200);
  }
  lastWasted = wasted;
  $('#h-dups').textContent = fmtK(t.duplicate_calls);
  $('#h-tokens').textContent = fmtK(t.wasted_tokens);
  const b = buckets30(series, ['wasted_usd', 'duplicate_calls']);
  const rate = b[b.length - 1].wasted_usd + b[b.length - 2].wasted_usd;
  $('#h-rate').textContent = fmt$(rate / 2) + '/min';
  const pct = spend > 0 ? (wasted / spend) * 100 : 0;
  $('#burn-pct').textContent = pct.toFixed(1) + '%';
  $('#burnbar-waste').style.width = Math.min(pct, 100) + '%';
  $('#h-spend').textContent = fmt$(spend);
  $('#h-waste2').textContent = fmt$(wasted);

  // burn/min bars with a time axis
  const svg = $('#wasted-chart'), W = 640, H = 96, base = H - 14;
  const max = Math.max(1e-4, ...b.map((x) => x.wasted_usd));
  const bw = W / 30;
  svg.innerHTML =
    b.map((x, i) => {
      const h = Math.round((x.wasted_usd / max) * (base - 8));
      return `<rect data-i="${i}" x="${i * bw + 1.5}" y="${base - h}" width="${bw - 3}"
        height="${Math.max(h, x.wasted_usd > 0 ? 3 : 0)}" rx="2" fill="${css('--critical')}"/>`;
    }).join('') +
    `<line x1="0" y1="${base + .5}" x2="${W}" y2="${base + .5}" stroke="${css('--axis')}"/>` +
    [0, 10, 20, 29].map((i) =>
      `<text x="${i * bw + bw / 2}" y="${H - 2}" font-size="9" font-family="${css('--mono')}"
         fill="${css('--muted')}" text-anchor="middle">${hhmm(b[i].t)}</text>`).join('');
  svg.querySelectorAll('rect').forEach((r) => {
    const x = b[+r.dataset.i];
    r.addEventListener('mousemove', (ev) =>
      showTip(ev, `<b>${fmt$(x.wasted_usd)}</b> wasted · ${x.duplicate_calls} duplicates<br>${hhmm(x.t)}`));
    r.addEventListener('mouseleave', hideTip);
  });
}

/* ── tiles: 30-min aggregates + sparklines ── */
function spark(id, vals, color, color2vals, color2) {
  const svg = $(id), W = 150, H = 30;
  const all = color2vals ? vals.concat(color2vals) : vals;
  const max = Math.max(...all, 1e-9);
  const line = (vs, c) =>
    `<polyline fill="none" stroke="${c}" stroke-width="1.5" points="${vs.map((v, i) =>
      `${(i / (vs.length - 1)) * W},${H - 3 - (v / max) * (H - 8)}`).join(' ')}"/>`;
  svg.innerHTML = line(vals, color) + (color2vals ? line(color2vals, color2) : '');
}

function renderTiles(golden) {
  const b = buckets30(golden, ['infra_p95_ms', 'llm_p95_ms', 'cost_usd', 'avg_quality', 'gens_per_request', 'llm_calls', 'llm_errors']);
  const w = b.filter((x) => x.llm_calls > 0);
  const lastLat = [...b].reverse().find((x) => x.infra_p95_ms > 0 || x.llm_p95_ms > 0) || b[29];
  $('#t-lat-infra').textContent = fmtMs(lastLat.infra_p95_ms);
  $('#t-lat-llm').textContent = fmtMs(lastLat.llm_p95_ms);
  $('#t-cost').textContent = fmt$(b.reduce((s, x) => s + x.cost_usd, 0));
  const qRows = w.filter((x) => x.avg_quality > 0);
  $('#t-quality').textContent = qRows.length
    ? (qRows.reduce((s, x) => s + x.avg_quality, 0) / qRows.length).toFixed(1) : '–';
  const calls = w.reduce((s, x) => s + x.llm_calls, 0);
  const errs = w.reduce((s, x) => s + x.llm_errors, 0);
  $('#t-errors').textContent = errs ? `${errs} errors / ${calls} calls` : `${calls} calls, no errors`;
  $('#t-loops').textContent = w.length
    ? (w.reduce((s, x) => s + x.gens_per_request * x.llm_calls, 0) / Math.max(calls, 1)).toFixed(2) : '–';
  spark('#sp-lat', b.map((x) => x.infra_p95_ms), css('--infra'), b.map((x) => x.llm_p95_ms), css('--llm'));
  spark('#sp-cost', b.map((x) => x.cost_usd), css('--ink-2'));
  spark('#sp-q', b.map((x) => x.avg_quality), css('--good'));
  spark('#sp-loops', b.map((x) => x.gens_per_request), css('--ink-2'));
}

/* ── latency chart: continuous time axis, two labeled series ── */
function renderLatency(golden) {
  const b = buckets30(golden, ['infra_p95_ms', 'llm_p95_ms', 'llm_calls', 'cost_usd']);
  const svg = $('#latency-chart'), W = 1200, H = 170, padB = 18, padT = 14;
  const max = Math.max(...b.flatMap((x) => [x.infra_p95_ms, x.llm_p95_ms]), 10);
  const x = (i) => (i / 29) * (W - 70) + 4;
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const line = (f, c) =>
    `<polyline fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"
       points="${b.map((r, i) => `${x(i)},${y(r[f])}`).join(' ')}"/>`;
  const grid = [0.5, 1].map((f) =>
    `<line x1="4" y1="${y(max * f)}" x2="${W - 66}" y2="${y(max * f)}" stroke="${css('--grid')}"/>
     <text x="${W - 62}" y="${y(max * f) + 3}" font-size="10" font-family="${css('--mono')}"
       fill="${css('--muted')}">${fmtMs(max * f)}</text>`).join('');
  const ticks = [0, 10, 20, 29].map((i) =>
    `<text x="${x(i)}" y="${H - 4}" font-size="10" font-family="${css('--mono')}"
       fill="${css('--muted')}" text-anchor="middle">${hhmm(b[i].t)}</text>`).join('');
  const last = b[29];
  svg.innerHTML = grid + ticks +
    line('infra_p95_ms', css('--infra')) + line('llm_p95_ms', css('--llm')) +
    `<text x="${W - 62}" y="${y(last.infra_p95_ms) + 3}" font-size="11" font-family="${css('--mono')}" fill="${css('--infra')}">infra</text>
     <text x="${W - 62}" y="${y(last.llm_p95_ms) + 3}" font-size="11" font-family="${css('--mono')}" fill="${css('--llm')}">llm</text>`;
  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(29, Math.round(((ev.clientX - rect.left) / rect.width) * 29)));
    const r = b[i];
    showTip(ev, `<b>${hhmm(r.t)}</b><br>infra p95 <b>${fmtMs(r.infra_p95_ms)}</b> · llm p95 <b>${fmtMs(r.llm_p95_ms)}</b><br>${r.llm_calls} llm calls · ${fmt$(r.cost_usd)}`);
  };
  svg.onmouseleave = hideTip;
}

/* ── root causes with share bars ── */
function renderRootCauses(rows) {
  const total = rows.reduce((s, r) => s + +r.wasted_usd, 0);
  $('#root-causes tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr><td>${r.root_cause}</td>
      <td class="num"><b>${fmt$(r.wasted_usd)}</b></td>
      <td class="num">${r.duplicate_calls}</td>
      <td class="num">${+r.worst_span_ms ? fmtMs(+r.worst_span_ms) : '–'}</td>
      <td><div class="share-track"><div class="share-fill" style="width:${total ? (+r.wasted_usd / total) * 100 : 0}%"></div></div></td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No waste detected yet. Break something — throttle the vector DB or run the impatient-client loadgen — and this table names the culprit with a price.</td></tr>';
}

/* ── recent requests ── */
let selectedTrace = null;
function renderRecent(rows) {
  $('#recent tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr data-id="${r.trace_id}" class="${r.trace_id === selectedTrace ? 'selected' : ''}">
      <td>${ago(r.t)}</td>
      <td>${(r.model || '–').replace(/^.*\//, '')}</td>
      <td class="num">${r.llm_calls}${+r.errors ? ` <span class="badge-err">⚠${r.errors}</span>` : ''}</td>
      <td class="num">${fmt$(r.cost_usd)}</td>
      <td class="num">${fmtMs(+r.max_ms)}</td>
      <td class="mono">${r.trace_id.slice(0, 8)}…</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No traffic in the last 2 hours. Start the loadgen: <span class="mono">node loadgen/loadgen.ts</span></td></tr>';
  document.querySelectorAll('#recent tbody tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => loadWaterfall(tr.dataset.id)));
}

/* ── the unified waterfall ── */
async function loadWaterfall(traceId) {
  selectedTrace = traceId;
  const rows = await api('waterfall', `?trace_id=${traceId}`);
  $('#waterfall-panel').hidden = false;
  $('#wf-trace').textContent = traceId;
  if (!rows.length) { $('#waterfall').innerHTML = '<div class="empty">no spans</div>'; return; }
  const t0 = Math.min(...rows.map((r) => +new Date(r.start_time + 'Z')));
  const t1 = Math.max(...rows.map((r) => +new Date(r.start_time + 'Z') + +r.duration_ms));
  const span = Math.max(t1 - t0, 1);
  const llm = rows.filter((r) => r.layer === 'llm');
  $('#wf-summary').innerHTML =
    `<span>wall time <b>${fmtMs(span)}</b></span>
     <span>llm calls <b>${llm.length}</b></span>
     <span>llm cost <b>${fmt$(llm.reduce((s, r) => s + +r.cost_usd, 0))}</b></span>
     <span>tokens <b>${fmtK(llm.reduce((s, r) => s + +r.total_tokens, 0))}</b></span>`;
  $('#wf-ruler').innerHTML = [0, .25, .5, .75, 1].map((f) =>
    `<span style="left:${f * 100}%">${fmtMs(span * f)}</span>`).join('');
  $('#waterfall').innerHTML = rows.map((r) => {
    const left = ((+new Date(r.start_time + 'Z') - t0) / span) * 100;
    const width = Math.max((+r.duration_ms / span) * 100, 0.5);
    const isErr = r.status === 'ERROR' || r.status === 'Error';
    const val = r.layer === 'llm' ? `${fmtMs(+r.duration_ms)} · ${fmt$(r.cost_usd)}` : fmtMs(+r.duration_ms);
    const tip = `<b>${r.name}</b> — ${r.layer}<br>${fmtMs(+r.duration_ms)}` +
      (r.layer === 'llm' ? `<br>${fmt$(r.cost_usd)} · ${r.total_tokens} tokens · ${r.model}` : '') +
      (isErr ? '<br><span style="color:var(--critical)">⚠ ERROR</span>' : '');
    return `<div class="wf-row">
      <div class="wf-name" title="${r.name}"><span class="lyr" style="background:var(--${r.layer})"></span>${r.name}</div>
      <div class="wf-track"><div class="wf-bar ${r.layer}${isErr ? ' error' : ''}"
        style="left:${left}%;width:${width}%" data-tip="${tip.replace(/"/g, '&quot;')}"></div></div>
      <div class="wf-val">${val}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('.wf-bar').forEach((bar) => {
    bar.addEventListener('mousemove', (ev) => showTip(ev, bar.dataset.tip));
    bar.addEventListener('mouseleave', hideTip);
  });
  document.querySelectorAll('#recent tbody tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.id === traceId));
}

/* ── poll ── */
let first = true;
async function tick() {
  try {
    const [total, series, golden, causes, recent] = await Promise.all([
      api('wasted_total'), api('wasted_series'), api('golden'), api('root_causes'), api('recent'),
    ]);
    renderHero(total[0] || {}, series);
    renderTiles(golden);
    renderLatency(golden);
    renderRootCauses(causes);
    renderRecent(recent);
    if (first && recent.length) { first = false; loadWaterfall(recent[0].trace_id); }
    $('#live').classList.remove('stale');
  } catch (e) {
    $('#live').classList.add('stale');
    console.error(e);
  }
}
tick();
setInterval(tick, 2000);
