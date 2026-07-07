# Wasted Spend — every AI incident gets a price tag

**Full-stack observability for AI apps.** The LLM layer (Langfuse) and the infra layer
(ClickStack) both store their telemetry in ClickHouse — so we run them against **one
shared ClickHouse** and stitch both halves of every request together with a single
`trace_id`. Correlation isn't an integration; it's an `INNER JOIN`.

On top of the joined plane we compute a metric no single tool can:

> **Wasted Spend** — dollars burned on LLM tokens *caused by* infrastructure failures:
> every duplicated call after a timeout, priced, and attributed to the span that caused it.

Plus an RCA agent living inside LibreChat that answers *"why did cost spike?"* with
SQL-proven causality — and whose own LLM calls are traced by the system it queries.

```
 users / loadgen ──▶ LibreChat (OTel auto-instrumented) ──OTLP──▶ ClickStack collector ─┐
                        │ LLM calls                                                     │
                        ▼                                                               ▼
                    LiteLLM proxy ── THE STITCH: traceparent → Langfuse trace_id ─▶ ┌────────────┐
                        │ langfuse callback                                         │ CLICKHOUSE │
                        ▼                                                           │  (shared)  │
                    Langfuse v3 ──(worker)──────────────────────────────────────▶   └─────┬──────┘
                                                                                          │
                       unified views · golden-signal MVs · wasted_spend  ◀────────────────┘
                                    │                    │
                            dashboard :8090      Cost Detective agent (in LibreChat)
```

## Getting started

Prerequisites: **Docker Desktop** (≥8 GB RAM allocated), **Node ≥ 23**, and two free
API keys — [Groq](https://console.groq.com) and [Google AI Studio](https://aistudio.google.com)
(no cards needed; the `mock-pro` model even works with zero keys).

```bash
git clone https://github.com/imsammelvin/wasted-spend && cd wasted-spend

./bootstrap.sh                # everything: .env generation, the 15-service stack,
                              # the OTLP ingestion key, the SQL layer, accounts,
                              # and the Cost Detective agent. Idempotent — re-run anytime.

# add your free GROQ_API_KEY / GEMINI_API_KEY to .env for real models
# (optional — the mock-pro model works with zero keys), then:
docker compose up -d litellm

# lights on
node dashboard/server.ts &    # burn console → http://localhost:8090
node loadgen/loadgen.ts       # simulated users (Ctrl-C to stop)
```

<details><summary>what bootstrap.sh does, step by step (for the curious or the stuck)</summary>

1. checks docker + node ≥ 23
2. generates `.env` with fresh secrets (kept untouched if it exists)
3. `docker compose up -d` and waits for ClickHouse, Langfuse, HyperDX, LibreChat health
4. registers the HyperDX admin — this mints the OTLP ingestion key — and writes it to `.env`
5. applies the SQL layer in order (readonly user, unified views, golden-signal MVs, wasted_spend)
6. registers the LibreChat demo account and verifies login
7. creates/updates the Cost Detective agent via the LibreChat API
</details>

All URLs, logins, and API details: **[docs/ACCESS.md](docs/ACCESS.md)**.

## See it do the thing

1. Watch the dashboard at **:8090** — golden signals ticking, waste at ~$0.
2. Make clients impatient (this is what converts slowness into dollars):
   ```bash
   LOADGEN_PATIENCE_S=3 LOADGEN_MODEL=llama-3.3-70b node loadgen/loadgen.ts
   ```
3. Within a minute: the **Wasted Spend counter climbs**, and the root-cause table
   names the culprit span with a price on it.
4. Open LibreChat (**:3080**) → Agents → **Cost Detective** → ask
   *"how much money was wasted today and what caused it?"* — it writes SQL against
   the joined plane and answers with root cause → evidence trace_ids → blast radius → dollars.
5. Click any request in the dashboard → the **unified waterfall**: infra spans and
   LLM calls of the same request on one timeline. No product on the market renders this.

## How the stitch works (the hard part, ~40 lines)

LibreChat runs with OTel auto-instrumentation (a Dockerfile layer — no fork), so its
outbound call to LiteLLM carries a W3C `traceparent` header. A LiteLLM pre-call hook
([litellm/custom_callbacks.py](litellm/custom_callbacks.py)) reads it and sets the
**Langfuse trace id = the OTel trace id**. Same primary key in both worlds:

```sql
SELECT ... FROM otel_traces o INNER JOIN traces l ON l.id = o.TraceId
```

Verified at 100% stitch rate on live traffic. Full write-up: [docs/stitch.md](docs/stitch.md).

## Repo layout

```
docker-compose.yml    the whole stack — one shared ClickHouse for both tools
sql/                  ALL analytics, versioned: inventory, stitch checks, unified
                      views, golden-signal MVs, wasted_spend, the impossible query
litellm/              proxy config + custom_callbacks.py (THE STITCH)
librechat/            OTel Dockerfile layer + librechat.yaml (LiteLLM endpoint, MCP)
loadgen/              TS load generator: impatient-client retries + quality scorer
dashboard/            TS zero-dep server + the burn console UI
agent/                MCP server (query_clickhouse) + Cost Detective creator
docs/                 IDEA.md · PLAN.md · stitch.md · ACCESS.md · notes
```

## The four golden signals of AI apps

Classic SRE watches latency / traffic / errors / saturation. Agentic apps have a new
failure surface — we track, per minute, as ClickHouse materialized views:
**latency** (infra vs LLM, split), **cost** ($/min, tokens), **quality** (eval scores),
**loops** (generations per request — retry and agent-spiral pressure).

Built for ClickHouse Click-a-thon 2026 (observability track).
