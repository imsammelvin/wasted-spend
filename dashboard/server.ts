#!/usr/bin/env node
/**
 * Wasted Spend dashboard server — zero dependencies, Node ≥ 23 (`node server.ts`).
 *
 * Serves ./public and a handful of NAMED query endpoints (no arbitrary SQL from
 * the browser). Queries hit ClickHouse over HTTP as the read-only user
 * (ro_viewer, readonly=2, 10s cap — see sql/05_readonly_user.sql).
 * Every response includes the SQL it ran: the UI shows it in a <details> panel,
 * because judges are engineers.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';

const PORT = Number(process.env.DASH_PORT ?? 8090);
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_USER = process.env.CLICKHOUSE_RO_USER ?? 'ro_viewer';
const CH_PASS = process.env.CLICKHOUSE_RO_PASSWORD ?? 'wastedspend_ro';
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;

const HEX32 = /^[0-9a-f]{32}$/;

// ── the only SQL the browser can trigger ────────────────────────────────────
const QUERIES: Record<string, (p: URLSearchParams) => string> = {
  // hero: wasted spend today vs total spend today (the burn share)
  wasted_total: () => `
    SELECT
      (SELECT round(coalesce(sum(wasted_usd), 0), 6) FROM wasted_spend_per_minute
        WHERE minute >= toStartOfDay(now()))                             AS wasted_usd,
      (SELECT coalesce(sum(wasted_tokens), 0) FROM wasted_spend_per_minute
        WHERE minute >= toStartOfDay(now()))                             AS wasted_tokens,
      (SELECT coalesce(sum(duplicate_calls), 0) FROM wasted_spend_per_minute
        WHERE minute >= toStartOfDay(now()))                             AS duplicate_calls,
      (SELECT round(coalesce(sum(toFloat64(coalesce(total_cost, 0))), 0), 6)
        FROM observations FINAL
        WHERE start_time >= toStartOfDay(now()) AND type = 'GENERATION') AS spend_usd`,

  // wasted $ per minute, last 30 minutes
  wasted_series: () => `
    SELECT minute, wasted_usd, duplicate_calls
    FROM wasted_spend_per_minute
    WHERE minute > now() - INTERVAL 30 MINUTE
    ORDER BY minute`,

  // four golden signals, last 30 minutes (fed by AggregatingMergeTree MVs)
  golden: () => `
    SELECT minute, infra_p95_ms, llm_p95_ms, cost_usd, tokens,
           llm_calls, llm_errors, avg_quality, gens_per_request
    FROM golden_signals_1m
    WHERE minute > now() - INTERVAL 30 MINUTE
    ORDER BY minute`,

  // ranked root causes with dollars — THE table
  root_causes: () => `
    SELECT root_cause, incidents, duplicate_calls, wasted_usd, wasted_tokens, worst_span_ms
    FROM wasted_spend_by_root_cause
    LIMIT 8`,

  // recent stitched requests (click one → waterfall), with the prompt itself
  recent: () => `
    WITH spans AS (
        SELECT trace_id, min(start_time) AS t, round(max(duration_ms)) AS max_ms
        FROM unified_spans
        WHERE match(trace_id, '^[0-9a-f]{32}$') AND start_time > now() - INTERVAL 2 HOUR
        GROUP BY trace_id
    ),
    llm AS (
        SELECT trace_id,
               round(sum(toFloat64(coalesce(total_cost, 0))), 6) AS cost_usd,
               sum(usage_details['total'])                       AS tokens,
               count()                                           AS llm_calls,
               anyIf(provided_model_name, provided_model_name IS NOT NULL) AS model,
               countIf(level = 'ERROR')                          AS errors,
               substring(argMin(coalesce(input, ''), start_time), 1, 3000) AS raw_input,
               substring(argMax(coalesce(output, ''), start_time), 1, 2000) AS raw_output
        FROM observations FINAL
        WHERE start_time > now() - INTERVAL 2 HOUR AND type = 'GENERATION'
        GROUP BY trace_id
    )
    SELECT trace_id, t, cost_usd, tokens, llm_calls, max_ms, model, errors, raw_input, raw_output
    FROM llm
    INNER JOIN spans USING (trace_id)
    ORDER BY t DESC
    LIMIT 15`,

  // the unified waterfall — both layers of ONE trace, time-ordered
  waterfall: (p) => {
    const id = p.get('trace_id') ?? '';
    if (!HEX32.test(id)) throw new Error('bad trace_id');
    return `
    SELECT layer, name, kind, start_time, duration_ms, status,
           cost_usd, total_tokens, model, span_id, parent_span_id
    FROM unified_spans
    WHERE trace_id = '${id}'
      AND (layer = 'llm' OR (name NOT LIKE 'middleware%' AND duration_ms >= 1))
    ORDER BY start_time
    LIMIT 60`;
  },
};

async function clickhouse(sql: string): Promise<unknown[]> {
  const res = await fetch(`${CH_URL}/?user=${CH_USER}&password=${CH_PASS}`, {
    method: 'POST',
    body: `${sql} FORMAT JSON`,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { data: unknown[] }).data;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const build = QUERIES[name];
      if (!build) throw new Error(`unknown query '${name}'`);
      const sql = build(url.searchParams);
      const rows = await clickhouse(sql);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sql: sql.trim(), rows }));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1).replace(/[^\w./-]/g, '');
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(msg.includes('ENOENT') ? 404 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}).listen(PORT, () => console.log(`dashboard: http://localhost:${PORT}`));
