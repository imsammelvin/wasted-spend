-- ═══════════════════════════════════════════════════════════════════════════
-- THE STITCH — verification queries (Phase 2 exit gates + debugging)
-- Run any block:  docker compose exec clickhouse clickhouse-client \
--                   --password $CLICKHOUSE_PASSWORD -q "<query>"
-- Or all at once: docker compose exec -T clickhouse clickhouse-client \
--                   --password $CLICKHOUSE_PASSWORD -n < sql/02_stitch_verification.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. STITCH RATE — % of Langfuse traces whose id IS an OTel trace id (32-hex),
--    and how many actually join to infra spans. Both should be ~100% for
--    traffic that flows LibreChat → LiteLLM. (Verified 2026-07-07: 79/79 = 100%.)
SELECT
    count() AS traces_15min,
    countIf(match(id, '^[0-9a-f]{32}$')) AS stitched,
    round(stitched / traces_15min * 100, 1) AS stitch_pct,
    countIf(id IN (SELECT DISTINCT TraceId FROM otel_traces)) AS join_hits
FROM traces
WHERE timestamp > now() - INTERVAL 15 MINUTE
FORMAT PrettyCompact;

-- 2. EXIT GATE — the INNER JOIN that is impossible in either tool alone:
--    infra spans and the LLM generation of the SAME trace, one query.
SELECT o.TraceId, o.SpanName, o.ServiceName, round(o.Duration/1e6) AS ms,
       l.name AS langfuse_name
FROM otel_traces o
INNER JOIN traces l ON l.id = o.TraceId
WHERE l.timestamp > now() - INTERVAL 15 MINUTE
ORDER BY o.Timestamp DESC
LIMIT 10
FORMAT PrettyCompact;

-- 3. UNIFIED WATERFALL for one trace — both layers, time-ordered
--    (preview of the Phase 4 waterfall; swap in any TraceId).
WITH (SELECT id FROM traces WHERE match(id, '^[0-9a-f]{32}$')
      ORDER BY timestamp DESC LIMIT 1) AS tid
SELECT * FROM (
    SELECT Timestamp        AS t, 'infra' AS layer, SpanName AS name,
           round(Duration/1e6, 1) AS ms, ''  AS model, 0.0 AS cost_usd
    FROM otel_traces WHERE TraceId = tid
    UNION ALL
    SELECT start_time, 'llm', name,
           dateDiff('millisecond', start_time, end_time),
           provided_model_name, toFloat64(total_cost)
    FROM observations WHERE trace_id = tid
) ORDER BY t
FORMAT PrettyCompact;

-- 4. STITCH DIAGNOSTICS — the callback writes these at the OBSERVATION level
--    (LiteLLM consumes trace-level directives like metadata.trace_id).
SELECT trace_id,
       metadata['stitch']              AS stitch_mode,   -- 'traceparent' | 'fallback'
       metadata['otel_trace_id']       AS otel_trace_id,
       metadata['otel_parent_span_id'] AS parent_span
FROM observations
WHERE start_time > now() - INTERVAL 15 MINUTE AND metadata['stitch'] != ''
ORDER BY start_time DESC
LIMIT 5
FORMAT PrettyCompact;

-- 5. FAILED-CALL ECONOMICS — proves failures carry no cost in Langfuse
--    (level='ERROR', 0 tokens, NULL cost) → Wasted Spend must price the
--    duplicated SUCCESSFUL calls, using ERROR rows only as the retry signal.
SELECT level, count() AS n, sum(usage_details['total']) AS tokens,
       sum(total_cost) AS cost_usd
FROM observations
GROUP BY level
FORMAT PrettyCompact;
