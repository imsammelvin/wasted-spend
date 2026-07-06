# ClickHouse Schema Inventory — VERIFIED against live system

> Source of truth for all SQL in this repo. Regenerate with `DESCRIBE <table>` after
> any image upgrade. Verified 2026-07-07 on ClickHouse **26.5.5.8**,
> Langfuse **v3** (image `langfuse/langfuse:3`), ClickStack collector **:2**
> (legacy schema mode, `HYPERDX_OTEL_EXPORTER_CREATE_LEGACY_SCHEMA=true`).

## The headline fact

Both worlds live in **one database: `default`** of the single shared ClickHouse.
No cross-database anything — correlation is a plain JOIN.

```
default
├─ otel_traces / otel_logs / otel_metrics_{gauge,sum,histogram,…}   ← ClickStack
├─ otel_traces_trace_id_ts (+ _mv)                                  ← ClickStack helper
├─ hyperdx_sessions                                                 ← ClickStack
├─ traces / observations / scores                                   ← Langfuse v3
└─ analytics_* , event_log, project_environments, dataset_run_*     ← Langfuse internals
```

Access: user `default`, password in `.env` (`CLICKHOUSE_PASSWORD`), ports
localhost `8123` (HTTP) / `9000` (native).

## Key tables & columns (only what our SQL layer needs)

### `otel_traces` (infra spans)
| column | type | notes |
|---|---|---|
| Timestamp | DateTime64(9) | span start |
| TraceId / SpanId / ParentSpanId | String | 32-hex / 16-hex lowercase |
| SpanName | LowCardinality(String) | |
| SpanKind | LowCardinality(String) | |
| ServiceName | LowCardinality(String) | e.g. `librechat` (after Phase 1.1) |
| SpanAttributes / ResourceAttributes | Map(LowCardinality(String), String) | |
| Duration | UInt64 | **nanoseconds** — `/1e6` for ms |
| StatusCode / StatusMessage | LowCardinality(String) / String | `Unset`/`Ok`/`Error` |
| Events.* / Links.* | Arrays | span events incl. exceptions |

### `observations` (Langfuse — one row per LLM call/span/event)
| column | type | notes |
|---|---|---|
| id | String | |
| trace_id | String | Langfuse trace id (NOT otel trace id — stitch pending Phase 2) |
| parent_observation_id | Nullable(String) | |
| type | LowCardinality(String) | `GENERATION` / `SPAN` / `EVENT` |
| start_time / end_time | DateTime64(3) / Nullable | |
| name | String | LiteLLM emits `litellm-acompletion` |
| metadata | **Map(LowCardinality(String), String)** | ← stitch target: `metadata['otel_trace_id']` |
| level | LowCardinality(String) | `DEFAULT` / `ERROR` … — retry/failure signal |
| status_message | Nullable(String) | |
| input / output | Nullable(String) | prompt/completion JSON — prompt-hash source |
| provided_model_name | Nullable(String) | e.g. `openai/gpt-4o-mini` |
| usage_details | Map(String, UInt64) | `usage_details['total']` = total tokens |
| **total_cost** | Nullable(Decimal(18,12)) | ⚠ plan guessed `calculated_total_cost` — wrong |
| cost_details | Map(String, Decimal(18,12)) | input/output split |
| tool_calls / tool_call_names | Array(String) | agentic-step detection (wasted-spend v2) |

### `traces` (Langfuse — one row per trace)
| column | type | notes |
|---|---|---|
| id | String | joins `observations.trace_id` |
| timestamp | DateTime64(3) | |
| name / user_id / session_id | String / Nullable / Nullable | session_id = fallback-join key |
| metadata | Map(LowCardinality(String), String) | stitch target |
| tags | Array(String) | |
| input / output | Nullable(String) | |

### `scores` (Langfuse — quality)
| column | type | notes |
|---|---|---|
| trace_id / observation_id | Nullable(String) | |
| name | String | e.g. `quality` |
| value | Float64 | |
| source | String | `API` when posted by our scorer |
| data_type | String | `NUMERIC` / `CATEGORICAL` / `BOOLEAN` |

## Verified sample rows (2026-07-07 smoke test)

```
otel_traces:   TraceId=61772e6366eeb23a90f059cb4f046b55  ServiceName=phase0-test  SpanName=phase0-smoke
observations:  trace_id=090fdde1-…  name=litellm-acompletion  model=openai/gpt-4o-mini  total_cost=0.0000135  tokens=30
traces:        id=090fdde1-…  name=litellm-acompletion  session_id=NULL
```

Notable: Langfuse **computed cost for a mocked LiteLLM call** (pricing table × usage),
so any model with a known price list yields $ figures regardless of what we actually pay.

## Operational facts

- OTLP ingestion (4317 gRPC / 4318 HTTP) **requires** header
  `authorization: <HYPERDX_INGESTION_API_KEY>` (in `.env`; auto-created with the first
  HyperDX user). Receivers only come alive after a HyperDX team exists → bootstrap order:
  register HyperDX user → collector gets config via OpAMP (~20 s) → send OTLP.
- Langfuse ingestion is async (redis → worker → S3 → ClickHouse); rows appear within
  ~5–15 s of the API call. Don't panic during verification.
- `Duration` in otel_traces is nanoseconds; Langfuse times are DateTime64(3) (ms).
- Langfuse UI login: `tech@anarix.ai` / password in `.env`. HyperDX login: same email,
  same password (registered via API).
