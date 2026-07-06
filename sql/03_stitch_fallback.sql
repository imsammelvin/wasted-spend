-- Fallback correlation view — INSURANCE ONLY (Non-negotiable rule: the demo
-- must survive even if traceparent propagation breaks).
-- For Langfuse traces whose id is NOT an OTel trace id (UUID form), correlate
-- to the nearest-preceding outbound LLM call span from LibreChat within the
-- same minute (equality on minute + ASOF on time). Weaker attribution than the
-- true stitch, by design; the unified layer prefers the true join when present.
CREATE OR REPLACE VIEW v_stitch_fallback AS
WITH llm_calls AS (
    SELECT TraceId AS otel_trace_id,
           Timestamp AS call_time,
           toStartOfMinute(Timestamp) AS minute
    FROM otel_traces
    WHERE ServiceName = 'librechat'
      AND SpanKind = 'Client'
      AND (SpanAttributes['url.full'] LIKE '%/chat/completions%'
           OR SpanAttributes['http.url'] LIKE '%/chat/completions%')
),
unstitched AS (
    SELECT id AS langfuse_trace_id,
           timestamp AS trace_time,
           toStartOfMinute(timestamp) AS minute
    FROM traces
    WHERE NOT match(id, '^[0-9a-f]{32}$')
)
SELECT u.langfuse_trace_id,
       c.otel_trace_id,
       u.trace_time,
       c.call_time,
       'asof-fallback' AS stitch_mode
FROM unstitched u
ASOF JOIN llm_calls c
    ON u.minute = c.minute AND u.trace_time >= c.call_time;
