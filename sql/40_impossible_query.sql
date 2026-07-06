-- ═══════════════════════════════════════════════════════════════════════════
-- 40 — THE IMPOSSIBLE QUERY
-- "Show me every request this week where LLM cost spiked AND quality dropped
--  AND the cause was infrastructure — ranked by dollars."
-- Impossible in Langfuse alone (no infra spans) and in ClickStack alone
-- (no cost, no quality). One query here, because both live in one ClickHouse
-- and share trace_id (THE STITCH).
-- ═══════════════════════════════════════════════════════════════════════════
WITH
-- typical request cost over the week = the spike baseline
baseline AS (
    SELECT avg(cost) AS avg_cost FROM (
        SELECT sum(toFloat64(coalesce(total_cost, 0))) AS cost
        FROM observations FINAL
        WHERE start_time > now() - INTERVAL 7 DAY AND type = 'GENERATION'
        GROUP BY trace_id
    )
),
-- LLM side: per-request cost + tokens
llm AS (
    SELECT trace_id,
           sum(toFloat64(coalesce(total_cost, 0))) AS cost_usd,
           sum(usage_details['total'])             AS tokens,
           count()                                 AS generations
    FROM observations FINAL
    WHERE start_time > now() - INTERVAL 7 DAY AND type = 'GENERATION'
    GROUP BY trace_id
),
-- quality side: worst score per request
quality AS (
    SELECT trace_id, min(value) AS worst_score
    FROM scores FINAL
    WHERE timestamp > now() - INTERVAL 7 DAY AND name = 'quality'
    GROUP BY trace_id
),
-- infra side: slowest meaningful span per request
infra AS (
    SELECT TraceId AS trace_id,
           argMax(SpanName, Duration)    AS slowest_span,
           round(max(Duration) / 1e6)    AS slowest_ms
    FROM otel_traces
    WHERE Timestamp > now() - INTERVAL 7 DAY
      AND SpanName NOT LIKE 'middleware%'
    GROUP BY TraceId
)
SELECT l.trace_id,
       round(l.cost_usd, 6)             AS cost_usd,
       l.tokens, l.generations,
       q.worst_score,
       i.slowest_span, i.slowest_ms
FROM llm l
INNER JOIN quality q USING (trace_id)
INNER JOIN infra   i USING (trace_id)          -- ← the join no other tool can do
WHERE l.cost_usd  > 2 * (SELECT avg_cost FROM baseline)   -- cost spiked
  AND q.worst_score < 5                                   -- quality dropped
  AND i.slowest_ms  > 1000                                -- infra was the drag
ORDER BY l.cost_usd DESC
LIMIT 20
FORMAT PrettyCompact;
