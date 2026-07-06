-- ═══════════════════════════════════════════════════════════════════════════
-- 20 — The four golden signals of AI apps: LATENCY, COST, QUALITY, LOOPS.
-- Real-time per-minute rollups as AggregatingMergeTree targets fed by
-- materialized views, plus one reader view (golden_signals_1m) the dashboard
-- polls. MVs fire on INSERT: otel_traces is append-only (safe); Langfuse
-- tables are ReplacingMergeTree but our pipeline writes each row once
-- (verified: rows == uniqExact(id)) — correctness-critical metrics
-- (wasted_spend) read raw tables with FINAL instead.
-- Re-applying this file rebuilds targets from scratch (idempotent).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1+2. LATENCY (infra vs llm) ─────────────────────────────────────────────
DROP TABLE IF EXISTS mv_latency_infra;
DROP TABLE IF EXISTS mv_latency_llm;
DROP TABLE IF EXISTS golden_latency_1m;
CREATE TABLE golden_latency_1m (
    minute DateTime,
    layer  LowCardinality(String),
    q_ms   AggregateFunction(quantiles(0.5, 0.95, 0.99), Float64),
    n      AggregateFunction(count)
) ENGINE = AggregatingMergeTree ORDER BY (minute, layer);

CREATE MATERIALIZED VIEW mv_latency_infra TO golden_latency_1m AS
SELECT toStartOfMinute(Timestamp) AS minute, 'infra' AS layer,
       quantilesState(0.5, 0.95, 0.99)(toFloat64(Duration) / 1e6) AS q_ms,
       countState() AS n
FROM otel_traces
WHERE ServiceName = 'librechat' AND SpanKind = 'Server'
GROUP BY minute;

CREATE MATERIALIZED VIEW mv_latency_llm TO golden_latency_1m AS
SELECT toStartOfMinute(start_time) AS minute, 'llm' AS layer,
       quantilesState(0.5, 0.95, 0.99)(
           toFloat64(dateDiff('millisecond', start_time, coalesce(end_time, start_time)))) AS q_ms,
       countState() AS n
FROM observations
WHERE type = 'GENERATION'
GROUP BY minute;

INSERT INTO golden_latency_1m
SELECT toStartOfMinute(Timestamp), 'infra',
       quantilesState(0.5, 0.95, 0.99)(toFloat64(Duration) / 1e6), countState()
FROM otel_traces WHERE ServiceName = 'librechat' AND SpanKind = 'Server' GROUP BY 1;

INSERT INTO golden_latency_1m
SELECT toStartOfMinute(start_time), 'llm',
       quantilesState(0.5, 0.95, 0.99)(
           toFloat64(dateDiff('millisecond', start_time, coalesce(end_time, start_time)))), countState()
FROM observations WHERE type = 'GENERATION' GROUP BY 1;

-- ── 2. COST ─────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS mv_cost;
DROP TABLE IF EXISTS golden_cost_1m;
CREATE TABLE golden_cost_1m (
    minute  DateTime,
    model   LowCardinality(String),
    cost    AggregateFunction(sum, Float64),
    tokens  AggregateFunction(sum, UInt64),
    calls   AggregateFunction(count),
    errors  AggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree ORDER BY (minute, model);

CREATE MATERIALIZED VIEW mv_cost TO golden_cost_1m AS
SELECT toStartOfMinute(start_time) AS minute,
       coalesce(provided_model_name, '') AS model,
       sumState(toFloat64(coalesce(total_cost, 0))) AS cost,
       sumState(usage_details['total']) AS tokens,
       countState() AS calls,
       sumState(toUInt64(level = 'ERROR')) AS errors
FROM observations
WHERE type = 'GENERATION'
GROUP BY minute, model;

INSERT INTO golden_cost_1m
SELECT toStartOfMinute(start_time), coalesce(provided_model_name, ''),
       sumState(toFloat64(coalesce(total_cost, 0))), sumState(usage_details['total']),
       countState(), sumState(toUInt64(level = 'ERROR'))
FROM observations WHERE type = 'GENERATION' GROUP BY 1, 2;

-- ── 3. QUALITY ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS mv_quality;
DROP TABLE IF EXISTS golden_quality_1m;
CREATE TABLE golden_quality_1m (
    minute DateTime,
    avg_q  AggregateFunction(avg, Float64),
    n      AggregateFunction(count),
    low    AggregateFunction(sum, UInt64)   -- scores below threshold (5)
) ENGINE = AggregatingMergeTree ORDER BY minute;

CREATE MATERIALIZED VIEW mv_quality TO golden_quality_1m AS
SELECT toStartOfMinute(timestamp) AS minute,
       avgState(value) AS avg_q, countState() AS n,
       sumState(toUInt64(value < 5)) AS low
FROM scores
WHERE name = 'quality'
GROUP BY minute;

INSERT INTO golden_quality_1m
SELECT toStartOfMinute(timestamp), avgState(value), countState(), sumState(toUInt64(value < 5))
FROM scores WHERE name = 'quality' GROUP BY 1;

-- ── 4. LOOPS (generations per request, retry pressure) ─────────────────────
DROP TABLE IF EXISTS mv_loops;
DROP TABLE IF EXISTS golden_loops_1m;
CREATE TABLE golden_loops_1m (
    minute DateTime,
    gens   AggregateFunction(count),
    reqs   AggregateFunction(uniq, String),
    errs   AggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree ORDER BY minute;

CREATE MATERIALIZED VIEW mv_loops TO golden_loops_1m AS
SELECT toStartOfMinute(start_time) AS minute,
       countState() AS gens, uniqState(trace_id) AS reqs,
       sumState(toUInt64(level = 'ERROR')) AS errs
FROM observations
WHERE type = 'GENERATION'
GROUP BY minute;

INSERT INTO golden_loops_1m
SELECT toStartOfMinute(start_time), countState(), uniqState(trace_id), sumState(toUInt64(level = 'ERROR'))
FROM observations WHERE type = 'GENERATION' GROUP BY 1;

-- ── Reader: one row per minute, all four signals ────────────────────────────
CREATE OR REPLACE VIEW golden_signals_1m AS
WITH
lat AS (
    SELECT minute,
           maxIf(q[2], layer = 'infra') AS infra_p95_ms,
           maxIf(q[2], layer = 'llm')   AS llm_p95_ms
    FROM (SELECT minute, layer, quantilesMerge(0.5, 0.95, 0.99)(q_ms) AS q
          FROM golden_latency_1m GROUP BY minute, layer)
    GROUP BY minute
),
cost AS (
    -- NB: aliases must not equal source column names (sumMerge(tokens) AS tokens
    -- self-shadows under the analyzer and breaks the Merge combinator)
    SELECT minute, round(sumMerge(cost), 6) AS cost_usd, sumMerge(tokens) AS token_total,
           countMerge(calls) AS llm_calls, sumMerge(errors) AS llm_errors
    FROM golden_cost_1m GROUP BY minute
),
qual AS (
    SELECT minute, round(avgMerge(avg_q), 2) AS avg_quality, sumMerge(low) AS low_scores
    FROM golden_quality_1m GROUP BY minute
),
loops AS (
    SELECT minute, countMerge(gens) AS gen_calls, uniqMerge(reqs) AS requests,
           round(countMerge(gens) / uniqMerge(reqs), 2) AS gens_per_request
    FROM golden_loops_1m GROUP BY minute
)
SELECT minute,
       infra_p95_ms, llm_p95_ms,
       cost_usd, token_total AS tokens, llm_calls, llm_errors,
       avg_quality, low_scores,
       gen_calls AS gens, requests, gens_per_request
FROM cost
FULL JOIN lat   USING (minute)
FULL JOIN qual  USING (minute)
FULL JOIN loops USING (minute);
