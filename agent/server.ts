#!/usr/bin/env node
/**
 * RCA tools — an MCP (streamable-http) server exposing the unified ClickHouse
 * to LibreChat agents. One tool that matters: query_clickhouse.
 *
 * Safety is enforced at the DATABASE, not here and not in prompts:
 * the ro_viewer user is readonly=2 with a 10s execution cap and a 10k-row
 * limit (sql/05_readonly_user.sql). This server adds only ergonomics.
 *
 * The recursion punchline: the agent calling this tool runs its own LLM
 * through LiteLLM — so its calls are traced by the very system it queries.
 */
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.RCA_PORT ?? 8100);
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123';
const CH_USER = process.env.CLICKHOUSE_RO_USER ?? 'ro_viewer';
const CH_PASS = process.env.CLICKHOUSE_RO_PASSWORD ?? 'wastedspend_ro';

const SCHEMA_DOC = `
UNIFIED OBSERVABILITY SCHEMA (one ClickHouse, database "default")

Views to prefer (they join both telemetry worlds on trace_id — THE STITCH):
- unified_spans(trace_id, span_id, parent_span_id, layer['infra'|'llm'], name,
    service, kind, start_time, duration_ms, status, cost_usd, total_tokens, model)
- golden_signals_1m(minute, infra_p95_ms, llm_p95_ms, cost_usd, tokens,
    llm_calls, llm_errors, avg_quality, low_scores, gens, requests, gens_per_request)
- wasted_spend(prompt_hash, first_seen, attempts, failed_attempts, duplicate_calls,
    wasted_usd, wasted_tokens, model, first_trace_id, duplicate_trace_ids)
- wasted_spend_by_root_cause(root_cause, incidents, duplicate_calls, wasted_usd,
    wasted_tokens, worst_span_ms)
- wasted_spend_per_minute(minute, wasted_usd, wasted_tokens, duplicate_calls)

Raw tables when views don't cover it:
- otel_traces: infra spans (TraceId, SpanName, ServiceName, Timestamp,
    Duration [nanoseconds! /1e6 for ms], StatusCode, SpanAttributes Map)
- observations FINAL: LLM calls (trace_id, name, start_time, level ['ERROR' = failed],
    total_cost, usage_details['total'] tokens, provided_model_name, input, output)
- traces FINAL: one row per request (id, timestamp, session_id, metadata Map)
- scores FINAL: quality scores (trace_id, name='quality', value 1-10)

WASTED SPEND definition: a generation's cost is wasted if it is a DUPLICATE of an
earlier successful generation of the same prompt within 30 min (client re-sent
after timeout/failure). Failed calls log $0 — they are retry SIGNALS; the dollars
sit on the duplicated successes. Root cause = slowest non-middleware span of the
FIRST attempt's trace.
`;

async function clickhouse(sql: string): Promise<string> {
  const res = await fetch(`${CH_URL}/?user=${CH_USER}&password=${CH_PASS}&default_format=JSONCompact`, {
    method: 'POST',
    body: sql,
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse error: ${text.slice(0, 500)}`);
  // JSONCompact keeps token usage low: {"meta":[...],"data":[[...]],...}
  const parsed = JSON.parse(text);
  const out = {
    columns: parsed.meta.map((m: { name: string }) => m.name),
    rows: parsed.data.slice(0, 200),
    row_count: parsed.rows,
    truncated: parsed.rows > 200,
  };
  return JSON.stringify(out);
}

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: 'wasted-spend-rca', version: '1.0.0' });

  mcp.registerTool(
    'query_clickhouse',
    {
      description:
        'Run a read-only SQL query against the unified observability ClickHouse ' +
        '(infra spans + LLM calls + costs + quality scores, joined by trace_id). ' +
        'SELECT only — the database user cannot write. Call get_schema first if unsure.',
      inputSchema: {
        sql: z.string().describe('One ClickHouse SELECT statement. No trailing semicolon needed.'),
      },
    },
    async ({ sql }) => {
      const clean = sql.trim().replace(/;+\s*$/, '');
      if (/;/.test(clean)) throw new Error('One statement per call.');
      try {
        return { content: [{ type: 'text' as const, text: await clickhouse(clean) }] };
      } catch (e) {
        // return errors as content so the model can self-correct its SQL
        return { content: [{ type: 'text' as const, text: String(e) }], isError: true };
      }
    },
  );

  mcp.registerTool(
    'get_schema',
    {
      description:
        'The unified observability schema: views, tables, columns, and the Wasted Spend definition.',
    },
    async () => ({ content: [{ type: 'text' as const, text: SCHEMA_DOC }] }),
  );

  return mcp;
}

// stateless streamable-http: fresh transport per request, no sessions to expire
createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : 'not found');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await buildMcp().connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('mcp error:', e);
    if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, () => console.log(`rca-tools MCP on :${PORT}/mcp`));
