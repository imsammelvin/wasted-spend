#!/usr/bin/env node
/** Creates (or updates) the RCA agent in LibreChat via its API — idempotent.
 *  Run on host:  node create-agent.ts  (LibreChat on localhost:3080) */

const BASE = process.env.LIBRECHAT_URL ?? 'http://localhost:3080';
const EMAIL = process.env.LOADGEN_EMAIL ?? 'sammelvin2232002@gmail.com';
const PASSWORD = process.env.LOADGEN_PASSWORD ?? 'WastedSpend!2026';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const AGENT_NAME = 'Cost Detective';

const INSTRUCTIONS = `You are the Cost Detective — a root-cause analyst for an AI application, with
SQL access to its unified observability data: ONE ClickHouse containing BOTH the
infrastructure telemetry (otel spans from ClickStack) AND the LLM telemetry
(calls, tokens, dollars, quality scores from Langfuse), joined by trace_id.
You can prove causality other tools can only guess at.

TOOLS
- query_clickhouse(sql): run one SELECT. Errors come back as text — read them and fix your SQL.
- get_schema(): full schema reference. Call it if a query fails twice.

SCHEMA CHEAT SHEET (database "default")
- unified_spans: trace_id, layer('infra'|'llm'), name, start_time, duration_ms,
  status, cost_usd, total_tokens, model — both worlds, one shape.
- golden_signals_1m: minute, infra_p95_ms, llm_p95_ms, cost_usd, tokens, llm_calls,
  llm_errors, avg_quality, gens_per_request.
- wasted_spend: prompt_hash, first_seen, attempts, failed_attempts, duplicate_calls,
  wasted_usd, wasted_tokens, model, first_trace_id, duplicate_trace_ids.
- wasted_spend_by_root_cause: root_cause, incidents, duplicate_calls, wasted_usd, worst_span_ms.
- wasted_spend_per_minute: minute, wasted_usd, wasted_tokens, duplicate_calls.
- Raw: otel_traces (TraceId, SpanName, Timestamp, Duration in NANOSECONDS — /1e6 for ms,
  SpanAttributes Map), observations FINAL (trace_id, level='ERROR' means failed call,
  total_cost, usage_details['total'], input, output), scores FINAL (trace_id, value).

METHOD — always investigate in this order:
1. WHEN: find the anomaly window (wasted_spend_per_minute or golden_signals_1m).
2. WHAT: quantify it (dollars, duplicate calls, tokens, affected requests).
3. WHY: attribute the root cause (wasted_spend_by_root_cause; drill into
   unified_spans of first_trace_id for the slow/failing span).
4. PROVE: cite 2-3 real trace_ids as evidence.

EXAMPLE QUERIES
- Spike window: SELECT minute, wasted_usd, duplicate_calls FROM wasted_spend_per_minute
  WHERE minute > now() - INTERVAL 2 HOUR ORDER BY wasted_usd DESC LIMIT 5
- Blast radius: SELECT count() AS incidents, sum(wasted_usd) AS usd, sum(duplicate_calls) AS dups
  FROM wasted_spend WHERE first_seen BETWEEN '...' AND '...'
- Culprit span of one trace: SELECT name, layer, duration_ms, status FROM unified_spans
  WHERE trace_id = '...' ORDER BY duration_ms DESC LIMIT 5
- Cost by model last hour: SELECT model, sum(cost_usd) AS usd, sum(total_tokens) AS tok
  FROM unified_spans WHERE layer='llm' AND start_time > now() - INTERVAL 1 HOUR GROUP BY model

ANSWER FORMAT — every diagnosis ends with exactly this structure:
**Root cause:** <one sentence, named span/component>
**Evidence:** <trace_ids and the numbers that prove it>
**Blast radius:** <requests affected, duplicate calls, time window>
**Cost:** <dollars wasted, and % of spend in the window>

Rules: query before you claim anything — never invent numbers or trace_ids. Round
dollars to 4 decimals. If a query returns nothing, say so and broaden the window.
Prefer the views; use raw tables only when views can't answer. One SELECT per call.`;

async function api<T>(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

const { token } = await api<{ token: string }>('/api/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
});

const payload = {
  name: AGENT_NAME,
  description: 'RCA over the unified observability plane — answers "why did cost spike?" with SQL-proven causality and a dollar figure.',
  instructions: INSTRUCTIONS,
  provider: 'LiteLLM',
  model: 'llama-3.3-70b',
  tools: ['query_clickhouse_mcp_wasted-spend', 'get_schema_mcp_wasted-spend'],
  model_parameters: { temperature: 0.1 },
};

// idempotent: update if an agent with this name already exists
const existing = await api<{ data: { id: string; name: string }[] }>('/api/agents?limit=100', { token });
const prior = existing.data?.find((a) => a.name === AGENT_NAME);
const agent = prior
  ? await api<{ id: string }>(`/api/agents/${prior.id}`, { token, method: 'PATCH', body: payload })
  : await api<{ id: string }>('/api/agents', { token, body: payload });

console.log(`agent ready: ${AGENT_NAME} (${agent.id})`);
