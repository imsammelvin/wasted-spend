-- ═══════════════════════════════════════════════════════════════════════════
-- 10 — unified_spans: ONE view over both telemetry worlds.
-- Infra spans (ClickStack/otel_traces) ∪ LLM observations (Langfuse), sharing
-- trace_id thanks to THE STITCH (docs/stitch.md). Everything downstream
-- (golden signals, wasted spend, waterfall, RCA agent) reads this shape.
-- Column names/types verified against sql/00_inventory.md.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW unified_spans AS
SELECT
    TraceId                          AS trace_id,
    SpanId                           AS span_id,
    ParentSpanId                     AS parent_span_id,
    'infra'                          AS layer,
    SpanName                         AS name,
    ServiceName                      AS service,
    SpanKind                         AS kind,
    toDateTime64(Timestamp, 3)       AS start_time,
    toFloat64(Duration) / 1e6        AS duration_ms,
    StatusCode                       AS status,      -- Unset | Ok | Error
    toFloat64(0)                     AS cost_usd,
    toUInt64(0)                      AS total_tokens,
    ''                               AS model
FROM otel_traces
UNION ALL
SELECT
    trace_id,
    id                               AS span_id,
    coalesce(parent_observation_id, '') AS parent_span_id,
    'llm'                            AS layer,
    name,
    'litellm'                        AS service,
    type                             AS kind,        -- GENERATION | SPAN | EVENT
    start_time,
    toFloat64(dateDiff('millisecond', start_time, coalesce(end_time, start_time))) AS duration_ms,
    level                            AS status,      -- DEFAULT | ERROR
    toFloat64(coalesce(total_cost, 0)) AS cost_usd,
    usage_details['total']           AS total_tokens,
    coalesce(provided_model_name, '') AS model
FROM observations FINAL;                             -- ReplacingMergeTree → dedup on read
