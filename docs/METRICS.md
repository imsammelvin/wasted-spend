# Metric definitions & calculations

Every number the dashboard or the Cost Detective shows is computed by versioned SQL
in `/sql/` — nothing is calculated in application code. This file is the formal
definition of each metric: formula, source tables, and honest limitations.

Data sources (one ClickHouse, database `default`):

| Source | Rows | Written by |
|---|---|---|
| `otel_traces` | infra spans (HTTP, DB, middleware) | ClickStack collector |
| `observations` | one row per LLM call: tokens, `total_cost`, `level`, `input`/`output` | Langfuse worker |
| `traces` | one row per request (id == OTel trace id, thanks to the stitch) | Langfuse worker |
| `scores` | quality scores per trace | loadgen scorer (heuristic v1) |
| `unified_spans` (view, `sql/10`) | both worlds in one shape | — |

Cost provenance: Langfuse computes `total_cost = tokens × its per-model price list`.
Real token counts, official list prices — independent of what the provider bills us.

---

## 1. Wasted Spend — `sql/30_wasted_spend.sql`

**Definition (one breath):** a generation's cost is *wasted* if it is a **duplicate of
an earlier successful generation of the same prompt within 30 minutes** — i.e. the
caller re-sent an identical request because the first answer was too slow or failed,
and both were billed.

**Calculation, per generation** (view `wasted_generations`):

```
prompt_hash  = cityHash64(input)                      -- byte-identical payloads collide
success_rank = row_number() OVER (PARTITION BY prompt_hash, (level='ERROR')
                                  ORDER BY start_time)
is_waste     = level != 'ERROR'                        -- only successes carry cost
               AND success_rank > 1                    -- the 2nd, 3rd… identical answer
               AND start_time - prev_same_prompt < 30 min   -- retries cluster tightly
```

**Aggregations built on it:**

| View | Formula |
|---|---|
| `wasted_spend` (per incident) | group by `prompt_hash`: `wasted_usd = sumIf(cost_usd, is_waste)`, `duplicate_calls = countIf(is_waste)`, `first_trace_id = argMin(trace_id, start_time)` |
| `wasted_spend_by_root_cause` | join each incident's **first** attempt's trace to `otel_traces`; `root_cause =` "llm failure → retry" if the group had ERROR attempts, else "slow: <slowest non-middleware span of the FIRST trace>", else "client re-send (unattributed)"; ranked by `sum(wasted_usd)` |
| `wasted_spend_per_minute` | `sumIf(cost_usd, is_waste)` bucketed by `toStartOfMinute(start_time)` — the climbing demo counter |

**Why the first attempt's trace for root cause:** the duplicate's trace is usually
healthy — the *first* attempt is the one that was slow/broken, so causality lives there.

**Why failed calls aren't the dollars:** verified empirically — Langfuse logs
`level='ERROR'` calls with 0 tokens and NULL cost. Failures are the *retry signal*;
the duplicated *successes* carry the price.

**Limitations (state these when asked):**
- Lower bound: misses provider-side charges for aborted/partial generations.
- Assumes retries re-send byte-identical payloads (true for standard clients; the
  loadgen adds a nonce per *distinct* request so unrelated requests never collide).
- The first success is credited as "necessary" even if the user had already left.
- Agentic multi-step chains are never flagged: each step has different input → different hash.

---

## 2. The four golden signals of AI apps — `sql/20_golden_signals.sql`

Classic SRE golden signals are latency/traffic/errors/saturation. Agentic apps have
a different failure surface: **latency, cost, quality, loops.** Each is a per-minute
rollup stored as an `AggregatingMergeTree` fed by materialized views (they update on
INSERT — no polling recomputation), merged by the reader view `golden_signals_1m`.

### Latency (infra vs LLM — the split is the point)
```
infra_p95_ms = quantile(0.95)(Duration/1e6)  FROM otel_traces
               WHERE ServiceName='librechat' AND SpanKind='Server'     -- request handling
llm_p95_ms   = quantile(0.95)(end_time - start_time)  FROM observations (GENERATION)
```
Stored as `quantilesState(0.5,0.95,0.99)` so p50/p95/p99 are all available.
The demo story is the *divergence*: infra p95 spikes while llm p95 stays flat →
the problem is yours, not the model's.

### Cost
```
cost_usd  = sum(total_cost)              per minute, per model
tokens    = sum(usage_details['total'])
llm_calls = count()
llm_errors= countIf(level='ERROR')
```

### Quality
```
avg_quality = avg(value)        FROM scores WHERE name='quality'   (1–10 scale)
low_scores  = countIf(value<5)
```
v1 scores come from the loadgen's heuristic scorer (answer length + jitter). A real
deployment replaces the *writer* (LLM-as-judge); the metric SQL doesn't change.

### Loops (retry / agent-spiral pressure)
```
gens_per_request = count(generations) / uniq(trace_id)   per minute
```
1.0 = healthy single-shot. Sustained >1.5 means retries or agent loops are
multiplying every user request into several paid LLM calls.

---

## 3. Dashboard-derived numbers (`dashboard/`, computed from the views above)

| Number | Formula |
|---|---|
| **Wasted today** (hero) | `sum(wasted_usd)` from `wasted_spend_per_minute` since `toStartOfDay(now())` |
| **Spend today** | `sum(total_cost)` from `observations` since midnight |
| **Burn share** (the burn bar) | `wasted_today / spend_today` — waste as % of spend; the single most tellable number |
| **Burn rate $/min** | mean of the last 2 minutes of `wasted_spend_per_minute` |
| **Root-cause share bars** | incident's `wasted_usd / sum(wasted_usd)` across the table |

## 4. Diagnostic metrics (`sql/02_stitch_verification.sql`)

| Metric | Formula | Healthy |
|---|---|---|
| **Stitch rate** | `countIf(match(traces.id,'^[0-9a-f]{32}$')) / count()` over recent traces | 100% |
| **Join coverage** | traces whose id exists in `otel_traces.TraceId` | ≈ stitch rate |
| **Fallback matches** | rows in `v_stitch_fallback` (ASOF time-proximity join for unstitched traces) | only pre-stitch history |

## 5. The impossible query — `sql/40_impossible_query.sql`

Not a metric but the thesis as one statement: requests this week where
`cost > 2× the weekly per-request average` **AND** `min(quality) < 5` **AND**
`slowest non-middleware infra span > 1s`, ranked by cost. Requires cost (Langfuse),
quality (scores), and infra spans (ClickStack) in one join — impossible in either
tool alone; a plain INNER JOIN here because both share trace_id in one ClickHouse.

---

## Freshness & gotchas

- **Langfuse-side metrics lag ~5–15s** (async ingestion: redis → worker → S3 → ClickHouse).
  Infra spans arrive in ~1–5s. Don't panic during a demo pause.
- Langfuse tables are `ReplacingMergeTree` → correctness-critical reads use `FINAL`
  (wasted_spend does); the golden-signal MVs trade that for real-time speed.
- `otel_traces.Duration` is **nanoseconds**; Langfuse times are millisecond DateTime64.
- Waste counters reset at midnight (all "today" windows use `toStartOfDay(now())`).
