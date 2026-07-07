# Slides (6) — content per slide

> Build these in any tool; one idea per slide, the demo carries the weight.

## 1 — The torn trace
**Every AI request is one story told in two halves.**
Left: ClickStack sees `HTTP → mongo → 9s ???` (no tokens, no dollars).
Right: Langfuse sees `3 generations, $0.31, quality 3/10` (no infra).
Bottom line: *Neither can see that the slow query CAUSED the cost spike.*

## 2 — The thesis
**Both tools already store in ClickHouse. So: one database, one trace id.**
Diagram: LibreChat → (OTel) → ClickStack ⌄ / → LiteLLM → Langfuse ⌄ → ONE ClickHouse.
The stitch: LiteLLM pre-call hook copies W3C `traceparent` → Langfuse trace id.
~40 lines. No forks. 100% stitch rate. `INNER JOIN otel_traces ON traces.id = TraceId`.

## 3 — LIVE DEMO
(just the URL bar and nerves)

## 4 — Wasted Spend: every incident gets a price tag
**The metric neither tool can compute:**
`duplicate of an earlier successful identical prompt within 30 min = wasted`
— failures are $0 signals; the dollars sit on duplicated *successes*;
root cause = slowest span of the FIRST attempt's trace.
Show the root-cause table screenshot: `slow: vector.search — $47.20 — 8.4s`.

## 5 — The four golden signals of AI apps
latency (infra vs LLM, split) · cost ($/min) · quality (eval scores) · **loops**
(generations per request — the retry/agent-spiral signal).
All AggregatingMergeTree MVs — dashboard reads pre-aggregated minutes in ms.
*Classic SRE had four signals. Agentic apps needed new ones. We defined them.*

## 6 — This is ecosystem work, not just a demo
- Repo: github.com/imsammelvin/wasted-spend (one-command bootstrap)
- LibreChat OTel instrumentation recipe — upstream PR/issue submitted
- The Langfuse↔ClickStack join schema — documented, reusable for ANY app
  (two-line contract: route LLM calls through LiteLLM, start with OTel env vars)
- *"Every AI incident gets a price tag."*
