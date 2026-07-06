-- ═══════════════════════════════════════════════════════════════════════════
-- 30 — WASTED SPEND: dollars burned on LLM tokens attributable to failures.
--
-- Definition v2 (one breath): a generation's cost is WASTED if it is a
-- DUPLICATE of an earlier successful generation of the same prompt — i.e. the
-- caller re-sent the identical request because the first answer didn't arrive
-- in time (client timeout → re-send) or failed. Only duplicates beyond the
-- first SUCCESS are priced; failed calls carry $0 in Langfuse (verified) and
-- serve as retry *signals*, not cost carriers. Agentic multi-step traces are
-- NOT waste: different steps have different inputs → different hashes.
--
-- Root cause: attributed from the FIRST attempt's trace (that's where the
-- slowness/failure lives), via its slowest non-middleware infra span.
-- All reads use FINAL (Langfuse tables are ReplacingMergeTree).
-- ═══════════════════════════════════════════════════════════════════════════

-- Per-generation waste classification (base view; others build on it)
CREATE OR REPLACE VIEW wasted_generations AS
WITH gens AS (
    SELECT id, trace_id, start_time,
           toFloat64(coalesce(total_cost, 0))   AS cost_usd,
           usage_details['total']               AS tokens,
           coalesce(provided_model_name, '')    AS model,
           level,
           cityHash64(coalesce(input, ''))      AS prompt_hash
    FROM observations FINAL
    WHERE type = 'GENERATION' AND coalesce(input, '') != ''
)
SELECT *,
    -- rank among SUCCESSFUL attempts of the same prompt; rank 1 = the answer
    -- the user needed, rank > 1 = pure duplicate = waste
    row_number() OVER (PARTITION BY prompt_hash, (level = 'ERROR')
                       ORDER BY start_time) AS success_rank,
    (level != 'ERROR' AND row_number() OVER (
        PARTITION BY prompt_hash, (level = 'ERROR')
        ORDER BY start_time) > 1)            AS is_waste
FROM gens;

-- Waste grouped per incident (one prompt_hash = one user request storyline)
CREATE OR REPLACE VIEW wasted_spend AS
SELECT prompt_hash,
       min(start_time)                          AS first_seen,
       count()                                  AS attempts,
       countIf(level = 'ERROR')                 AS failed_attempts,
       countIf(is_waste)                        AS duplicate_calls,
       round(sumIf(cost_usd, is_waste), 6)      AS wasted_usd,
       sumIf(tokens, is_waste)                  AS wasted_tokens,
       any(model)                               AS model,
       argMin(trace_id, start_time)             AS first_trace_id,
       groupArrayIf(3)(trace_id, is_waste)      AS duplicate_trace_ids
FROM wasted_generations
GROUP BY prompt_hash
HAVING duplicate_calls > 0
   -- retries cluster tightly; guards against accidental hash collisions
   AND dateDiff('minute', min(start_time), max(start_time)) < 30;

-- Ranked root causes with $ totals — THE demo table.
-- Culprit = slowest non-middleware span in the FIRST attempt's trace.
CREATE OR REPLACE VIEW wasted_spend_by_root_cause AS
WITH culprit AS (
    SELECT TraceId                        AS first_trace_id,
           argMax(SpanName, Duration)     AS slowest_span,
           round(max(Duration) / 1e6)     AS slowest_ms
    FROM otel_traces
    WHERE SpanName NOT LIKE 'middleware%' AND SpanName NOT LIKE 'request handler%'
    GROUP BY TraceId
)
SELECT
    multiIf(w.failed_attempts > 0, 'llm failure → retry',
            c.slowest_span != '',  concat('slow: ', c.slowest_span),
            'client re-send (unattributed)')  AS root_cause,
    count()                                   AS incidents,
    sum(w.duplicate_calls)                    AS duplicate_calls,
    round(sum(w.wasted_usd), 6)               AS wasted_usd,
    sum(w.wasted_tokens)                      AS wasted_tokens,
    max(c.slowest_ms)                         AS worst_span_ms
FROM wasted_spend w
LEFT JOIN culprit c USING (first_trace_id)
GROUP BY root_cause
ORDER BY wasted_usd DESC;

-- Per-minute series — the live climbing counter in the demo.
CREATE OR REPLACE VIEW wasted_spend_per_minute AS
SELECT toStartOfMinute(start_time)       AS minute,
       round(sumIf(cost_usd, is_waste), 6) AS wasted_usd,
       sumIf(tokens, is_waste)           AS wasted_tokens,
       countIf(is_waste)                 AS duplicate_calls
FROM wasted_generations
GROUP BY minute
HAVING wasted_usd > 0 OR duplicate_calls > 0
ORDER BY minute;
