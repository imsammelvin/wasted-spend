#!/usr/bin/env bash
# Synthetic 30-day observability history, generated INSIDE ClickHouse
# (INSERT … SELECT FROM numbers() — no data leaves the server).
#
# Shape:
#   • SPANS_PER_DAY otel spans/day, 8 spans per trace, diurnal traffic curve
#   • 12.5% of traces carry an LLM generation (observations+traces+scores),
#     with trace_id == otel TraceId — the stitch holds across synthetic history
#   • 3 incident windows: vector-search spans go 25× slower AND impatient
#     clients duplicate their calls → real wasted-spend history with root cause
#   • all timestamps strictly BEFORE today — live "today" tiles stay clean
#
# Idempotent/resumable: progress tracked per day in synth_progress.
# Usage:  DAYS=30 SPANS_PER_DAY=33400000 ./loadgen/synthesize.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DAYS=${DAYS:-30}
SPANS_PER_DAY=${SPANS_PER_DAY:-33400000}
SPANS_PER_TRACE=8
CH_PASSWORD=$(grep '^CLICKHOUSE_PASSWORD=' .env | cut -d= -f2)

ch() { docker compose exec -T clickhouse clickhouse-client --password "$CH_PASSWORD" \
        --max_memory_usage 1800000000 --max_insert_threads 2 --max_threads 4 -n "$@"; }

CHUNKS=4  # each day's span insert split into quarters — keeps peak RAM low on small VMs

TRACES_PER_DAY=$(( SPANS_PER_DAY / SPANS_PER_TRACE ))
LLM_TRACES_PER_DAY=$(( TRACES_PER_DAY / 8 ))          # 12.5% of traces hit the LLM

# incidents: day index (1=yesterday … DAYS=oldest), hour of day
INCIDENT_DAYS=(3 11 22)
INCIDENT_HOUR=14

ch <<'SQL'
CREATE TABLE IF NOT EXISTS synth_progress (day UInt16, done_at DateTime DEFAULT now())
  ENGINE = MergeTree ORDER BY day;
CREATE TABLE IF NOT EXISTS deploy_events (
  ts DateTime, service LowCardinality(String), version String, note String
) ENGINE = MergeTree ORDER BY ts;
SQL

echo "synthesizing: $DAYS days × $SPANS_PER_DAY spans (traces/day: $TRACES_PER_DAY, llm/day: $LLM_TRACES_PER_DAY)"
t_start=$(date +%s)

for (( d=DAYS; d>=1; d-- )); do
  if [ "$(ch <<<"SELECT count() FROM synth_progress WHERE day=$d" | tr -d '[:space:]')" != "0" ]; then
    echo "day $d: already done, skipping"; continue
  fi
  IS_INCIDENT=0
  for x in "${INCIDENT_DAYS[@]}"; do [ "$x" = "$d" ] && IS_INCIDENT=1; done
  t0=$(date +%s)

  CHUNK_N=$(( SPANS_PER_DAY / CHUNKS ))
  for (( c=0; c<CHUNKS; c++ )); do
    ch <<SQL
SET max_block_size = 500000;

-- ── infra spans (chunk $((c+1))/$CHUNKS) ─────────────────────────────────────
INSERT INTO otel_traces (Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind,
                         ServiceName, SpanAttributes, Duration, StatusCode)
WITH
  toStartOfDay(now() - INTERVAL $d DAY)                                   AS day_start,
  intDiv(number, $SPANS_PER_TRACE)                                        AS tseq,
  toUInt8(number % $SPANS_PER_TRACE)                                      AS sidx,
  lower(hex(sipHash128(toString($d * 1000000000 + tseq))))                AS tid,
  -- diurnal curve: weighted hours (quiet nights, double-peak workday)
  [0,0,0,1,1,2,4,7,10,12,12,11,10,12,13,12,11,9,7,5,4,3,2,1]              AS w,
  arrayCumSum(w)                                                          AS cw,
  sipHash64(tseq, 101) % arraySum(w)                                      AS hpick,
  toUInt8(arrayFirstIndex(x -> x > hpick, cw) - 1)                        AS hh,
  toUInt32(sipHash64(tseq, 102) % 3600)                                   AS sec_in_hour,
  day_start + hh * 3600 + sec_in_hour                                     AS trace_ts,
  ['POST /api/agents/chat/custom','middleware - auth','mongoose.User.findOne',
   'mongodb.find messages','vector.search pgvector','embeddings litellm',
   'POST http://litellm:4000/v1/chat/completions','mongodb.insert message']  AS names,
  ['Server','Internal','Client','Client','Client','Client','Client','Client'] AS kinds,
  [420.0, 2.0, 6.0, 9.0, 45.0, 60.0, 900.0, 4.0]                          AS base_ms,
  (toFloat64(sipHash64(number, 103) % 1000000) + 1) / 1000000.0           AS r01,
  -- exponential jitter around the base
  base_ms[sidx + 1] * (0.4 - ln(r01))                                     AS dur_ms_raw,
  ($IS_INCIDENT = 1 AND hh = $INCIDENT_HOUR)                              AS in_incident,
  -- incident: vector search 25×, root span inherits the pain
  multiIf(in_incident AND sidx = 4, dur_ms_raw * 25,
          in_incident AND sidx = 0, dur_ms_raw + 1100.0 * 25,
          dur_ms_raw)                                                     AS dur_ms,
  lower(substring(hex(sipHash128(toString($d * 1000000000 + tseq) || '-' || toString(sidx))), 1, 16)) AS sid,
  lower(substring(hex(sipHash128(toString($d * 1000000000 + tseq) || '-0')), 1, 16))                  AS root_sid
SELECT
  trace_ts + toIntervalMillisecond(toUInt64(sidx) * 12),
  tid,
  sid,
  if(sidx = 0, '', root_sid),
  names[sidx + 1],
  kinds[sidx + 1],
  'librechat',
  if(sidx = 6, map('url.full', 'http://litellm:4000/v1/chat/completions'), map()),
  toUInt64(dur_ms * 1e6),
  if(in_incident AND sidx = 6 AND sipHash64(number, 104) % 5 = 0, 'Error', 'Unset')
FROM numbers($(( c * CHUNK_N )), $CHUNK_N);
SQL
  done

  ch <<SQL
-- ── LLM generations (every 8th trace; trace_id == otel TraceId → stitched) ──
INSERT INTO observations (id, trace_id, project_id, environment, type, start_time, end_time,
                          name, level, input, provided_model_name, usage_details, total_cost,
                          created_at, updated_at, event_ts, is_deleted)
WITH
  toStartOfDay(now() - INTERVAL $d DAY)                                   AS day_start,
  number * 8                                                              AS tseq,
  lower(hex(sipHash128(toString($d * 1000000000 + tseq))))                AS tid,
  [0,0,0,1,1,2,4,7,10,12,12,11,10,12,13,12,11,9,7,5,4,3,2,1]              AS w,
  arrayCumSum(w)                                                          AS cw,
  sipHash64(tseq, 101) % arraySum(w)                                      AS hpick,
  toUInt8(arrayFirstIndex(x -> x > hpick, cw) - 1)                        AS hh,
  toUInt32(sipHash64(tseq, 102) % 3600)                                   AS sec_in_hour,
  day_start + hh * 3600 + sec_in_hour                                     AS trace_ts,
  sipHash64(tseq, 105) % 10                                               AS mpick,
  multiIf(mpick < 2, 'gemini/gemini-2.5-pro',
          mpick < 7, 'groq/llama-3.3-70b-versatile',
                     'gemini/gemini-2.5-flash')                            AS model,
  toUInt64(400 + sipHash64(tseq, 106) % 2600)                             AS tokens,
  multiIf(mpick < 2, 8.0, mpick < 7, 0.75, 0.45)                          AS usd_per_mtok,
  ($IS_INCIDENT = 1 AND hh = $INCIDENT_HOUR)                              AS in_incident
SELECT
  concat('syn-', tid),
  tid,
  'wasted-spend',
  'default',
  'GENERATION',
  trace_ts + toIntervalMillisecond(150),
  trace_ts + toIntervalMillisecond(150 + tokens * 12),
  'litellm-acompletion',
  if(in_incident AND sipHash64(tseq, 107) % 5 = 0, 'ERROR', 'DEFAULT'),
  concat('Q#', toString(sipHash64(tid)), ': user question about product analytics and retrieval'),
  model,
  map('total', tokens),
  toDecimal64(tokens / 1e6 * usd_per_mtok, 12),
  trace_ts, trace_ts, trace_ts,
  0
FROM numbers($LLM_TRACES_PER_DAY);

-- ── langfuse traces (one per LLM trace; keeps stitch-rate queries honest) ───
INSERT INTO traces (id, timestamp, name, project_id, environment, created_at, updated_at, event_ts, is_deleted)
WITH
  toStartOfDay(now() - INTERVAL $d DAY)                                   AS day_start,
  number * 8                                                              AS tseq,
  lower(hex(sipHash128(toString($d * 1000000000 + tseq))))                AS tid,
  [0,0,0,1,1,2,4,7,10,12,12,11,10,12,13,12,11,9,7,5,4,3,2,1]              AS w,
  arrayCumSum(w)                                                          AS cw,
  toUInt8(arrayFirstIndex(x -> x > sipHash64(tseq, 101) % arraySum(w), cw) - 1) AS hh,
  day_start + hh * 3600 + toUInt32(sipHash64(tseq, 102) % 3600)           AS trace_ts
SELECT concat('', tid), trace_ts, 'chat', 'wasted-spend', 'default',
       trace_ts, trace_ts, trace_ts, 0
FROM numbers($LLM_TRACES_PER_DAY);

-- ── quality scores (~a third of LLM traces; dip during incidents) ───────────
INSERT INTO scores (id, timestamp, project_id, environment, trace_id, name, value,
                    source, data_type, created_at, updated_at, event_ts, is_deleted)
WITH
  toStartOfDay(now() - INTERVAL $d DAY)                                   AS day_start,
  number * 24                                                             AS tseq,
  lower(hex(sipHash128(toString($d * 1000000000 + tseq))))                AS tid,
  [0,0,0,1,1,2,4,7,10,12,12,11,10,12,13,12,11,9,7,5,4,3,2,1]              AS w,
  arrayCumSum(w)                                                          AS cw,
  toUInt8(arrayFirstIndex(x -> x > sipHash64(tseq, 101) % arraySum(w), cw) - 1) AS hh,
  day_start + hh * 3600 + toUInt32(sipHash64(tseq, 102) % 3600)           AS trace_ts,
  ($IS_INCIDENT = 1 AND hh = $INCIDENT_HOUR)                              AS in_incident
SELECT concat('syn-score-', tid), trace_ts + 60, 'wasted-spend', 'default', tid, 'quality',
       greatest(1.0, least(10.0,
         6.5 + (toFloat64(sipHash64(tseq, 108) % 500) - 250) / 100.0 - if(in_incident, 3.2, 0.0))),
       'API', 'NUMERIC', trace_ts, trace_ts, trace_ts, 0
FROM numbers(intDiv($LLM_TRACES_PER_DAY, 3));
SQL

  # ── incident duplicates: impatient clients re-send during the slow hour ─────
  if [ "$IS_INCIDENT" = "1" ]; then
    ch <<SQL
INSERT INTO observations (id, trace_id, project_id, environment, type, start_time, end_time,
                          name, level, input, provided_model_name, usage_details, total_cost,
                          created_at, updated_at, event_ts, is_deleted)
WITH
  toStartOfDay(now() - INTERVAL $d DAY)                                   AS day_start,
  number * 8                                                              AS tseq,
  lower(hex(sipHash128(toString($d * 1000000000 + tseq))))                AS tid,
  [0,0,0,1,1,2,4,7,10,12,12,11,10,12,13,12,11,9,7,5,4,3,2,1]              AS w,
  arrayCumSum(w)                                                          AS cw,
  toUInt8(arrayFirstIndex(x -> x > sipHash64(tseq, 101) % arraySum(w), cw) - 1) AS hh,
  day_start + hh * 3600 + toUInt32(sipHash64(tseq, 102) % 3600)           AS trace_ts,
  sipHash64(tseq, 105) % 10                                               AS mpick,
  multiIf(mpick < 2, 'gemini/gemini-2.5-pro',
          mpick < 7, 'groq/llama-3.3-70b-versatile',
                     'gemini/gemini-2.5-flash')                            AS model,
  toUInt64(400 + sipHash64(tseq, 106) % 2600)                             AS tokens,
  multiIf(mpick < 2, 8.0, mpick < 7, 0.75, 0.45)                          AS usd_per_mtok,
  1 + sipHash64(tseq, 109) % 2                                            AS dup_n
SELECT
  concat('syn-dup', toString(dup), '-', tid),
  lower(hex(sipHash128(concat(tid, '-dup', toString(dup))))),   -- the re-sent request = its own trace
  'wasted-spend', 'default', 'GENERATION',
  trace_ts + toIntervalSecond(20 * dup + 15),
  trace_ts + toIntervalSecond(20 * dup + 15) + toIntervalMillisecond(tokens * 12),
  'litellm-acompletion', 'DEFAULT',
  concat('Q#', toString(sipHash64(tid)), ': user question about product analytics and retrieval'),
  model, map('total', tokens),
  toDecimal64(tokens / 1e6 * usd_per_mtok, 12),
  trace_ts, trace_ts, trace_ts, 0
FROM numbers($LLM_TRACES_PER_DAY)
ARRAY JOIN range(1, toUInt64(dup_n) + 1) AS dup
WHERE hh = $INCIDENT_HOUR AND sipHash64(tseq, 110) % 3 = 0;

INSERT INTO deploy_events VALUES
  (toStartOfDay(now() - INTERVAL $d DAY) + $INCIDENT_HOUR * 3600 - 780,
   'retrieval-service', concat('v2.', toString($d), '.0'),
   'connection-pool refactor (regressed under load)');
SQL
  fi

  ch <<<"INSERT INTO synth_progress (day) VALUES ($d)"
  echo "day $d done in $(( $(date +%s) - t0 ))s $( [ "$IS_INCIDENT" = "1" ] && echo '← INCIDENT' )"
done

echo "total: $(( $(date +%s) - t_start ))s"
ch <<'SQL'
SELECT 'otel_traces' AS t, formatReadableQuantity(count()) AS rows FROM otel_traces
UNION ALL SELECT 'observations', formatReadableQuantity(count()) FROM observations
UNION ALL SELECT 'traces', formatReadableQuantity(count()) FROM traces
UNION ALL SELECT 'scores', formatReadableQuantity(count()) FROM scores
FORMAT PrettyCompact;
SQL
