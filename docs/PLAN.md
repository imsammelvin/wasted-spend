# BUILD PLAN — Wasted Spend (Click-a-thon 2026, Observability Track)

> **How to use this document:** This is the execution plan for the project described in
> `IDEA.md`. It is written so that each phase can be handed to an AI coding assistant or
> a teammate as a self-contained work order. Follow phases IN ORDER — each has an
> **Exit Criteria** gate. Do not start a phase until the previous gate passes.
> When something doesn't match reality (a table name, a config key), the instruction is
> always: inspect the live system (`SHOW TABLES`, read the source, check docs) and adapt —
> do not guess.

---

## Architecture (target state)

```
                       ┌────────────────────────────────────────────┐
 users / load-gen ───► │ LibreChat (Node.js)                        │
                       │  • OTel auto-instrumentation (traces/logs) │
                       └───────┬───────────────────────┬────────────┘
                               │ LLM calls              │ OTLP (traces, logs, metrics)
                               ▼                        ▼
                       ┌───────────────┐        ┌──────────────────┐
                       │ LiteLLM proxy │        │ OTel Collector   │
                       │  • Langfuse   │        │ (ClickStack)     │
                       │    callback   │        └───────┬──────────┘
                       └──────┬────────┘                │
                              │ traces/generations      │ spans/logs/metrics
                              ▼                         ▼
                       ┌────────────────────────────────────────────┐
                       │              CLICKHOUSE                    │
                       │  langfuse.traces / observations / scores   │
                       │  otel_traces / otel_logs / otel_metrics    │
                       │  ── unified views + MVs (our SQL layer) ── │
                       │  ── wasted_spend, golden_signals ──        │
                       └───────┬───────────────────────┬────────────┘
                               │                       │
                        HyperDX UI              RCA Agent (lives in
                        + our dashboard         LibreChat, writes SQL)
```

**Why LiteLLM proxy:** LibreChat has no native Langfuse integration. Instead of patching
LibreChat's LLM dispatch code (fragile), route all LLM traffic through a LiteLLM proxy,
which has first-class Langfuse logging built in. LibreChat supports custom OpenAI-compatible
endpoints, so this is pure configuration. The trace stitch then happens at the proxy.

---

## Phase 0 — Environment & Repo Setup (½ day)

**Goal:** One `docker compose up` brings the whole stack alive.

### Tasks
1. Create repo `wasted-spend` (public — it becomes the OSS artifact for judges). Structure:
   ```
   /docker-compose.yml
   /sql/            ← all ClickHouse DDL (views, MVs, queries) — versioned, numbered files
   /loadgen/        ← traffic generator
   /litellm/        ← proxy config + custom callback
   /dashboard/      ← our UI (Phase 4)
   /agent/          ← RCA agent (Phase 5)
   /docs/           ← IDEA.md, this plan, demo script
   ```
2. Docker Compose services:
   - **ClickHouse** (single instance, shared by everything — this is a demo point: "one database")
   - **ClickStack / HyperDX** (use the official `docker.hyperdx.io/hyperdx/hyperdx-all-in-one`
     image or ClickStack compose from docs — but configure it to use the SHARED ClickHouse,
     not its bundled one, if the distribution allows; otherwise run its bundle and treat
     that ClickHouse as the shared one)
   - **Langfuse v3** (needs ClickHouse + Postgres + Redis + S3/minio per its self-host docs —
     point its ClickHouse at the shared instance)
   - **LibreChat** + its MongoDB
   - **LiteLLM proxy**
   - **OTel Collector** (comes with ClickStack)
3. Get API keys into `.env`: one real LLM provider key (use a cheap model, e.g. gpt-4o-mini
   or claude-haiku) for live traffic.
4. Verify in ClickHouse (`clickhouse-client`):
   - `SHOW DATABASES` → langfuse db + otel/hyperdx tables exist.
   - `SHOW TABLES FROM ...` → record ACTUAL table names in `/sql/00_inventory.md`.
     Expected (VERIFY, do not assume): Langfuse → `traces`, `observations`, `scores`;
     ClickStack → `otel_traces`, `otel_logs`, `otel_metrics_*`.

### Exit criteria
- [ ] `docker compose up` → all services healthy.
- [ ] LibreChat UI loads, can hold a chat conversation via LiteLLM.
- [ ] HyperDX UI loads. Langfuse UI loads.
- [ ] `/sql/00_inventory.md` documents real table names + one sample row from each key table.

---

## Phase 1 — Telemetry Flowing (1 day)

**Goal:** Both halves of the data arriving in ClickHouse (not yet joined).

### Task 1.1 — Infra telemetry: LibreChat → ClickStack
- Add OTel Node auto-instrumentation to LibreChat **without forking it**:
  set env on the LibreChat container:
  ```
  NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register
  OTEL_SERVICE_NAME=librechat
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
  OTEL_TRACES_EXPORTER=otlp  OTEL_LOGS_EXPORTER=otlp  OTEL_METRICS_EXPORTER=otlp
  ```
  (May require a small Dockerfile layer to `npm install` the OTel packages on top of the
  official image. That's fine — keep the patch as a Dockerfile, not a fork.)
- Verify: chat once in LibreChat → `SELECT * FROM otel_traces WHERE ServiceName='librechat' LIMIT 5`
  shows HTTP + outbound-fetch spans, including the outbound call to LiteLLM.

### Task 1.2 — LLM telemetry: LiteLLM → Langfuse
- LiteLLM config: `success_callback: ["langfuse"]`, `failure_callback: ["langfuse"]`,
  Langfuse keys in env.
- Point LibreChat at LiteLLM as a custom OpenAI-compatible endpoint (`librechat.yaml`).
- Verify: chat once → Langfuse UI shows the generation with model, tokens, cost;
  `SELECT * FROM langfuse.observations ORDER BY start_time DESC LIMIT 5` shows it in ClickHouse.

### Task 1.3 — Load generator (`/loadgen`)
Small Python script hitting LibreChat's API (or LiteLLM directly for volume) with:
- N concurrent simulated users, randomized prompts (keep them short/cheap),
- a mix of RAG-style queries if RAG is configured (optional),
- rate configurable via env. Run it continuously during development so every phase has live data.

### Exit criteria
- [ ] One chat message produces rows in BOTH `otel_traces` (infra) AND `langfuse.observations` (LLM).
- [ ] Loadgen sustains ~1 req/s for 10 min with no errors.

---

## Phase 2 — THE STITCH: one trace_id in both systems (1–2 days) ⚠️ HIGHEST RISK

**Goal:** For a single chat request, the Langfuse trace and the OTel trace share a joinable ID.
**Build the fallback FIRST, then attempt the true join. Never let later phases depend on the true join.**

### Task 2.1 — Fallback correlation (build first, ~2 hours)
- In LiteLLM, add a custom callback (`/litellm/callback.py`, LiteLLM `CustomLogger`) that copies
  correlation keys into Langfuse trace **metadata**: the incoming request's `x-request-id` /
  session id / user id + timestamp.
- Join strategy in SQL: `(session_id, time-bucket)` proximity via `ASOF JOIN`.
- This alone already enables every dashboard and the Wasted Spend metric (with slightly
  weaker attribution). **Checkpoint: the project is demoable from here on, no matter what.**

### Task 2.2 — True trace_id propagation (the crown jewel)
Mechanism: OTel auto-instrumentation in LibreChat already injects a W3C `traceparent`
header on the outbound HTTP call to LiteLLM (verify this in captured headers). Then:
1. In the LiteLLM custom callback, read the incoming `traceparent` header
   (available via the request's proxy metadata / headers passthrough — enable
   `litellm_settings: forward_client_headers` or read from `proxy_server_request` in kwargs).
2. Parse the 32-hex `trace_id` out of `traceparent`.
3. Set it on the Langfuse trace: pass `trace_id` (Langfuse SDK supports supplying your own
   trace id; if the LiteLLM↔Langfuse integration doesn't expose it, write it into trace
   metadata field `otel_trace_id` — joining on a metadata column is equally valid for SQL).
4. Verify end-to-end: chat once →
   ```sql
   SELECT TraceId FROM otel_traces WHERE ServiceName='librechat' ORDER BY Timestamp DESC LIMIT 1;
   SELECT trace_id, metadata FROM langfuse.traces ORDER BY timestamp DESC LIMIT 1;
   ```
   → the SAME 32-hex id appears in both (directly or in metadata).

### Task 2.3 — Alternative path if 2.2 blocks for >1 day
Langfuse v3 exposes an **OTel ingestion endpoint** (`/api/public/otel`). Configure the OTel
Collector to fan out LLM-related spans to Langfuse as a second exporter, using GenAI
semantic-convention attributes for model/tokens/cost. Same outcome: shared trace_id.
Pick whichever path yields the stitch faster; do not do both.

### Exit criteria
- [ ] `SELECT ... FROM otel_traces INNER JOIN langfuse.traces ON <id>` returns matched rows for live chats.
- [ ] Fallback ASOF-join path also works (kept as insurance, behind a SQL view flag).
- [ ] Write `/docs/stitch.md` explaining exactly how propagation works (this becomes the upstream PR/blog content).

---

## Phase 3 — The Unified SQL Layer (1–2 days) — THE CLICKHOUSE SHOWPIECE

**Goal:** All analytics as versioned SQL in `/sql/`. Everything downstream (dashboard, agent) only reads these views.

### Task 3.1 — `10_unified_spans.sql` — one view over both worlds
```sql
-- Adapt column names to the real schemas recorded in 00_inventory.md
CREATE VIEW unified_spans AS
SELECT TraceId AS trace_id, SpanId AS span_id, ParentSpanId AS parent_span_id,
       'infra' AS layer, SpanName AS name, ServiceName AS service,
       Timestamp AS start_time, Duration/1e6 AS duration_ms,
       StatusCode AS status, 0.0 AS cost_usd, 0 AS total_tokens,
       NULL AS model, NULL AS eval_score
FROM otel_traces
UNION ALL
SELECT <otel_trace_id_or_metadata> AS trace_id, o.id, o.parent_observation_id,
       'llm' AS layer, o.name, 'langfuse',
       o.start_time, dateDiff('millisecond', o.start_time, o.end_time),
       o.level, o.calculated_total_cost, o.usage_details['total'],
       o.provided_model_name, s.value
FROM langfuse.observations o
LEFT JOIN langfuse.scores s ON s.observation_id = o.id;
```

### Task 3.2 — `20_golden_signals.sql` — Materialized Views (real-time rollups)
Four golden signals of AI apps, per minute (AggregatingMergeTree targets):
1. **Latency** — p50/p95/p99 split into infra_ms vs llm_ms per request
2. **Cost** — $/min, $/request, tokens/request, by model
3. **Quality** — avg eval score, % scored below threshold
4. **Loops** — retries per request, tool-call depth, requests with >N generations

### Task 3.3 — `30_wasted_spend.sql` — THE metric
Definition (v1, keep it explainable in one breath):
> A generation's cost is WASTED if, within the same trace, it (a) follows a failed/timeout
> LLM generation (retry), or (b) follows an infra span slower than its p95 baseline
> (infra-induced), or (c) belongs to a request whose final eval score < threshold after
> multiple attempts (quality churn).
```sql
-- Sketch: retries = generations ranked >1 within a trace
WITH gen AS (
  SELECT trace_id, id, cost_usd, status, start_time,
         row_number() OVER (PARTITION BY trace_id ORDER BY start_time) AS attempt
  FROM unified_spans WHERE layer='llm'
),
slow_infra AS (
  SELECT trace_id, max(duration_ms) AS worst_infra_ms, argMax(name, duration_ms) AS culprit
  FROM unified_spans WHERE layer='infra' AND name NOT LIKE 'HTTP%' GROUP BY trace_id
)
SELECT g.trace_id, sum(g.cost_usd) AS wasted_usd, any(s.culprit) AS root_cause
FROM gen g LEFT JOIN slow_infra s USING (trace_id)
WHERE g.attempt > 1        -- retries: only attempt-1 was "necessary"
GROUP BY g.trace_id;
```
Plus: `wasted_spend_by_root_cause` (ranked, with $ totals) and `wasted_spend_per_minute` (for the live climbing counter in the demo).

### Task 3.4 — `40_impossible_query.sql` — the one for the judges
"Every request this week where cost spiked AND quality dropped AND cause was infra, ranked by dollars" — a single readable query; keep it under ~40 lines, commented.

### Exit criteria
- [ ] All SQL files apply cleanly from scratch (`clickhouse-client < sql/*.sql` in order).
- [ ] With loadgen running, `SELECT * FROM golden_signals_1m ORDER BY minute DESC LIMIT 5` updates live.
- [ ] `wasted_spend` returns nonzero rows when you manually cause a retry (kill LiteLLM briefly).

---

## Phase 4 — Dashboard & Waterfall (1–2 days)

**Goal:** The demo surface. Keep the stack dumb-simple: one small web app (Next.js or plain
React+Vite), server-side queries to ClickHouse over HTTP interface, poll every 2s. NO
websockets, NO auth, NO state — this is demo software.

### Views to build
1. **Overview** — four golden-signal tiles + **"Wasted Spend today: $X"** big red counter
   (this number climbing during the live break is the money shot).
2. **Unified waterfall** — for a given trace_id: horizontal bars from `unified_spans`,
   colored by layer (infra = blue, llm = orange), showing name, duration, and for LLM
   spans: cost + tokens + eval score. Parent-child nesting via `parent_span_id`; if
   nesting is flaky across layers, plain time-sorted bars are acceptable — the point is
   BOTH LAYERS IN ONE TIMELINE.
3. **Root-cause table** — `wasted_spend_by_root_cause` ranked with $ figures.
4. Every view shows its SQL in a collapsible `<details>` ("powered by this query") —
   judges are engineers; showing the SQL is a feature.

Also: build 1–2 dashboards inside HyperDX itself from the same tables — proves ClickStack
fluency and gives a fallback UI if our app breaks.

### Exit criteria
- [ ] Click any recent request → waterfall renders both layers with one trace_id in <1s.
- [ ] Wasted Spend counter visibly climbs within 60s of injecting a fault.

---

## Phase 5 — RCA Agent (1–2 days)

**Goal:** Ask "why did cost spike at 3pm?" in LibreChat → answer with proven root cause + $ figure.

### Design (keep it small — this is a tool-using loop, not a framework)
- Implement as a **LibreChat Agent with a custom tool** (or an OpenAPI Action): tool
  `query_clickhouse(sql) -> rows` (read-only ClickHouse user, `readonly=1`, row limits).
- System prompt contains: the unified schema (views + columns), the Wasted Spend
  definition, 5–6 worked example Q→SQL pairs (few-shot), and instructions to always
  answer with: root cause → evidence (trace_ids) → blast radius → dollars.
- **The recursion punchline:** the agent's own LLM calls go through LiteLLM → they are
  traced by the very system it queries. Prepare the query that shows the agent's own
  trace, and show it in the demo ("it monitors itself").

### Guardrails for demo reliability
- Cache the 5 demo questions' answers; live-generate but fall back on cache if the model flails.
- Hard timeout 10s per SQL; SELECT-only enforced at the DB user level, not the prompt level.

### Exit criteria
- [ ] Agent answers the scripted incident question correctly, citing real trace_ids and a $ figure.
- [ ] Agent survives 3 unscripted questions from a teammate without embarrassing itself.

---

## Phase 6 — Scale & Chaos (1 day)

### Task 6.1 — 1B-span synthetic dataset
- `/loadgen/synthesize.py`: generate ~30 days of history directly as ClickHouse INSERTs
  (bypass the apps — write to the same tables/schemas, realistic distributions: diurnal
  traffic, a few incident windows with retry storms, several models with different costs).
- Target ≥1B rows in `otel_traces` + proportional langfuse rows. Insert in large batches
  (`INSERT ... SELECT` from `generateRandom` or numbers() with transforms is fastest).
- Tune: check the impossible query + wasted-spend-by-root-cause run **sub-second**; add
  projections/skip indexes only if needed. Record numbers for the demo:
  "X rows, Y ms, on a laptop."

### Task 6.2 — Fault injection (the live break)
`/loadgen/chaos.sh` with three switchable faults:
1. **Slow vector search / DB** — `docker pause`-style throttle or add artificial latency (toxiproxy container in front of the DB used by RAG, or degrade LiteLLM upstream latency).
2. **LLM timeouts** — set LiteLLM upstream timeout very low → real retries → real wasted spend.
3. **Bad deploy marker** — write a deploy event row, then trigger fault 1 (gives the agent a "deploy at 2:47" to blame).
Rehearse: fault ON → 60s → dashboard shows it → agent explains it → fault OFF → recovery visible.

### Exit criteria
- [ ] Impossible query <1s over 1B+ rows, cold-ish cache. Numbers written down.
- [ ] Each chaos switch produces visible signal within 60s and clean recovery.

---

## Phase 7 — Ecosystem Moves & Demo (last 2 days)

1. **Upstream PR / OSS release** (one evening, do NOT skip — judge psychology):
   - Publish the repo with a real README (problem, architecture diagram, quickstart, the SQL).
   - Open a PR or detailed issue to LibreChat: "OTel instrumentation support" with our
     Dockerfile layer + docs. Even unmerged, a serious PR link on the final slide lands.
   - Optionally: short write-up "Joining Langfuse and ClickStack in one ClickHouse" in /docs — this is the ecosystem artifact ClickHouse judges love.
2. **Demo script** (`/docs/demo.md`) — the 3-minute flow from IDEA.md §6, with exact
   commands, exact questions to ask the agent, and WHO does what. Rehearse ×3, time it.
   Record a full backup screen-capture of a perfect run.
3. **Slides (≤6):** Problem (torn trace) → The thesis (one DB, one JOIN) → Live demo →
   Wasted Spend metric → 1B-row numbers → PR link + "four golden signals of AI apps".
4. **Pre-demo checklist:** compose up from clean state <10 min; seed data loaded; chaos
   rehearsed; agent cache warm; backup video on a second machine.

---

## Timeline & team split (adapt to actual hackathon window)

Assuming ~8–10 working days and 3 people:

| Days | Person A (infra/stitch) | Person B (SQL/ClickHouse) | Person C (UI/agent) |
|---|---|---|---|
| 1 | Phase 0 compose | Phase 0 inventory | Loadgen (1.3) |
| 2 | 1.1 OTel→ClickStack | 1.2 LiteLLM→Langfuse | Loadgen polish |
| 3–4 | **Phase 2 stitch** | Phase 3 views/MVs (on fallback join) | Dashboard skeleton |
| 5 | Stitch hardening | Wasted Spend + impossible query | Waterfall view |
| 6–7 | Chaos scripts (6.2) | Synthetic 1B + tuning (6.1) | **Phase 5 agent** |
| 8 | PR + OSS release | Query numbers, HyperDX dashboards | Agent guardrails |
| 9–10 | Demo rehearsal ×3, slides, backup recording — everyone | | |

**Standing rule:** after Phase 2's fallback checkpoint, the project is ALWAYS demoable.
Every subsequent day must end in a demoable state — no long-lived broken branches.

---

## Instructions when delegating a phase to an AI assistant

Paste the phase section plus this preamble:
> Context: read `/docs/IDEA.md` and `/sql/00_inventory.md` first. Work ONLY on the tasks
> in this phase. Verify every assumption against the live system (SHOW TABLES, curl,
> container logs) before writing code — schema/config names in the plan are educated
> guesses to be confirmed. Prefer configuration over forking upstream projects. Every
> task ends with its verification step actually executed and its output shown. Do not
> mark exit criteria done without running them.
