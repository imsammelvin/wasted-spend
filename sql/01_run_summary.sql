-- Per-minute rollup of the last hour, joining both telemetry worlds.
-- Hand-rolled preview of Phase 3's golden_signals_1m materialized view.
-- Run:  docker compose exec -T clickhouse clickhouse-client --password $CLICKHOUSE_PASSWORD < sql/01_run_summary.sql
WITH
llm AS (
    SELECT toStartOfMinute(start_time) AS minute,
           count()                     AS llm_calls,
           sum(usage_details['total']) AS tokens,
           round(sum(total_cost), 6)   AS cost_usd,
           countIf(level = 'ERROR')    AS llm_errors
    FROM observations
    WHERE start_time > now() - INTERVAL 1 HOUR
    GROUP BY minute
),
infra AS (
    SELECT toStartOfMinute(Timestamp) AS minute,
           count()                    AS infra_spans,
           round(quantile(0.95)(Duration/1e6)) AS p95_ms
    FROM otel_traces
    WHERE ServiceName = 'librechat' AND SpanKind = 'Server'
      AND Timestamp > now() - INTERVAL 1 HOUR
    GROUP BY minute
),
quality AS (
    SELECT toStartOfMinute(timestamp) AS minute,
           round(avg(value), 1)       AS avg_quality
    FROM scores
    WHERE name = 'quality' AND timestamp > now() - INTERVAL 1 HOUR
    GROUP BY minute
)
SELECT minute, llm_calls, tokens, cost_usd, llm_errors, infra_spans, p95_ms, avg_quality
FROM llm
LEFT JOIN infra   USING (minute)
LEFT JOIN quality USING (minute)
ORDER BY minute
FORMAT PrettyCompact;

-- docker compose exec -T clickhouse clickhouse-client --password wastedspend_ch < sql/01_run_summary.sql