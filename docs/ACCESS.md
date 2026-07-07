# URLs & credentials (local demo stack)

> Everything binds to localhost — these are demo-grade credentials for the local
> compose stack, useless outside your machine. Real secrets live in `.env` (gitignored).

## UIs

| Service | URL | Login |
|---|---|---|
| **LibreChat** (the AI app + Cost Detective agent) | http://localhost:3080 | `wastedspend.demo@gmail.com` / `WastedSpend!2026` |
| **Wasted Spend console** (our dashboard) | http://localhost:8090 | none |
| **Langfuse** (LLM traces) | http://localhost:3000 | `wastedspend.demo@gmail.com` / `WastedSpend!2026` |
| **HyperDX / ClickStack** (infra traces) | http://localhost:8080 | `wastedspend.demo@gmail.com` / `WastedSpend!2026` |
| **ClickHouse Play** (raw SQL) | http://localhost:8123/play | `default` / `wastedspend_ch` |

## Cost Detective agent

LibreChat → endpoint picker → **Agents** → **Cost Detective**.
Ask: *"How much money was wasted today and what caused it?"*
Recreate/update it: `node agent/create-agent.ts`

## APIs & internals

| What | Where | Auth |
|---|---|---|
| LiteLLM proxy (OpenAI-compatible) | http://localhost:4000/v1 | Bearer `LITELLM_MASTER_KEY` from `.env` |
| ClickHouse HTTP | http://localhost:8123 | `default` / `wastedspend_ch` (full) or `ro_viewer` / `wastedspend_ro` (read-only) |
| ClickHouse native | localhost:9000 | same |
| OTLP ingestion (traces/logs/metrics) | localhost:4317 (gRPC) / 4318 (HTTP) | header `authorization: $HYPERDX_INGESTION_API_KEY` (`.env`) |
| RCA MCP server | http://localhost:8100/mcp | none (localhost only) |
| Langfuse API | http://localhost:3000/api/public | basic `pk-lf-wastedspend-demo-2026` / `sk-lf-wastedspend-demo-2026` |
| MinIO console | http://localhost:9091 | `minio` / `wastedspend_minio` |

## Run things

```bash
docker compose up -d                        # the whole stack (14 services)
node dashboard/server.ts                    # dashboard on :8090 (host)
node loadgen/loadgen.ts                     # traffic; env knobs in file header
LOADGEN_PATIENCE_S=3 node loadgen/loadgen.ts  # impatient clients → wasted spend
```

Models in LibreChat: `llama-3.3-70b` (Groq, real), `gemini-flash` (Gemini, real —
free tier is 20 req/day!), `mock-pro` (instant, free, priced as gemini-2.5-pro).
