# THE STITCH — one trace_id across the LLM and infra worlds

**Status: working, 100% stitch rate on live traffic (verified 2026-07-07, 79/79 traces).**

## The problem

LibreChat's infra telemetry (OTel → ClickStack) and its LLM telemetry
(LiteLLM → Langfuse) land in the same ClickHouse but with unrelated IDs:
OTel generates a W3C trace_id per request; Langfuse generates its own UUID
per trace. Same request, two identities — the trace is torn in half.

## The mechanism (3 hops, ~40 lines, zero forks)

```
LibreChat (OTel auto-instrumentation)
  │  outbound POST /v1/chat/completions
  │  undici instrumentation auto-injects:  traceparent: 00-<trace_id>-<span_id>-01
  ▼
LiteLLM proxy — litellm/custom_callbacks.py (CustomLogger.async_pre_call_hook)
  │  reads data['proxy_server_request']['headers']['traceparent']
  │  sets  data['metadata']['trace_id'] = <the 32-hex otel trace_id>
  ▼
LiteLLM's Langfuse integration
     honors metadata['trace_id'] → creates the Langfuse trace WITH THAT ID
```

Result in the shared ClickHouse (`default` db):

```sql
SELECT ... FROM otel_traces o INNER JOIN traces l ON l.id = o.TraceId
```

No mapping table, no fuzzy matching — **the join key is the primary key.**
Every LLM call spawned by one user request (chat completion + title generation)
shares that one trace: the full fan-out is visible in a single waterfall.

## Facts that make it work (all verified live, not assumed)

1. **OTel Node auto-instrumentation propagates context through undici/fetch** —
   LibreChat's OpenAI-SDK call to LiteLLM carries `traceparent` with no app code.
   (Instrumentation is loaded via `NODE_OPTIONS=--require .../build/src/register.js`;
   the absolute file path matters — the package `exports` map doesn't apply.)
2. **LiteLLM exposes incoming proxy headers** to callbacks via
   `data['proxy_server_request']['headers']` in `async_pre_call_hook`, which may
   mutate `data` before dispatch.
3. **LiteLLM's Langfuse logger honors `metadata['trace_id']`** as the Langfuse
   trace id. Unknown metadata keys are preserved on the *observation* (not the
   trace) — our diagnostics (`stitch`, `otel_trace_id`, `otel_parent_span_id`)
   live there.
4. Langfuse trace ids are free-form strings — a 32-hex OTel id is a valid id.

## Fallback (insurance — the demo must never depend on the hard part)

`sql/03_stitch_fallback.sql` creates `v_stitch_fallback`: Langfuse traces with
UUID-form ids (i.e., unstitched) are ASOF-joined to the nearest preceding
outbound `/chat/completions` client span from LibreChat within the same minute.
Weaker attribution, always available. The unified layer (Phase 3) prefers the
true join and falls back per-trace.

Verification queries for all of the above: `sql/02_stitch_verification.sql`.

## Upstream relevance (Phase 7)

- **LibreChat**: "OTel auto-instrumentation support" — our Dockerfile layer +
  env config is a copy-paste-able recipe; no code changes needed upstream, docs PR.
- **LiteLLM**: the callback is generic "W3C traceparent → Langfuse trace id"
  bridging — candidate for a built-in `litellm_settings` flag.
