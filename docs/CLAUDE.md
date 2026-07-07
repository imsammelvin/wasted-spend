# Project: Wasted Spend — Click-a-thon 2026 (Observability track)

## What this is
Hackathon project (ClickHouse Click-a-thon 2026, shortlisted top-30, ₹10L pool, must-win).
We build **full-stack observability for AI apps**: stitch the LLM layer (Langfuse) and the
infra layer (ClickStack/OTel) into ONE trace inside ClickHouse — both tools already store
in ClickHouse, so correlation is a `JOIN` on trace_id. On top we compute **Wasted Spend**:
dollars burned on LLM tokens *caused by* infra failures (retries after timeouts, doubled
calls after slow vector search) — a metric no existing tool can compute, priced per root
cause. An RCA agent inside LibreChat answers "why did cost spike?" with SQL-proven causality.

## Required reading (in order)
1. `docs/IDEA.md` — problem, novelty strategy, judge psychology, demo script
2. `docs/PLAN.md` — the phase-by-phase build plan. **Work strictly phase by phase; each
   phase has Exit Criteria gates that must be actually executed, not assumed.**

## Architecture in one line
LibreChat (OTel auto-instr → ClickStack) → **LiteLLM proxy** (Langfuse callback, carries
the shared trace_id) → one ClickHouse → our SQL layer (`/sql/`) → dashboard + RCA agent.

## Non-negotiable rules
- **Never fork upstream projects** (LibreChat/Langfuse/ClickStack) — configuration and
  Dockerfile layers only. The one exception: a clean patch we intend to PR upstream.
- **Verify, don't guess:** table/column/config names in the plan are educated guesses.
  Inspect the live system (`SHOW TABLES`, container logs, source) before writing code.
  Real schema names live in `sql/00_inventory.md` — keep it current.
- **All analytics are versioned SQL** in `/sql/` (numbered files). Dashboard and agent
  only read views — no business logic in the UI.
- **Fallback-first:** the time-bucket ASOF-join correlation (Phase 2.1) must always keep
  working even after true trace_id propagation lands. The project must be demoable at the
  end of every day.
- ClickHouse access for the agent: read-only user, SELECT-only, hard timeouts.

## Current status
<!-- UPDATE THIS SECTION AS PHASES COMPLETE -->
- [x] Phase 0 — environment (docker compose, all services healthy, schema inventory)
      One shared ClickHouse 26.5; both worlds in the `default` db. See sql/00_inventory.md.
      Gotchas solved: CH healthcheck must use 127.0.0.1; OTLP ingestion requires
      `authorization: $HYPERDX_INGESTION_API_KEY` and only works after the first
      HyperDX user exists (bootstrap: register user → key in Mongo → .env).
- [x] Phase 1 — telemetry flowing (OTel→ClickStack, LiteLLM→Langfuse, loadgen).
      Exit run: 10 min @ 1.08 req/s, 646 sent / 643 ok, 0 timeouts; one 64-error burst
      (LibreChat message rate-limiter, self-recovered). Data: 168k otel spans,
      809 langfuse traces, 655 scores. Facts learned:
      • failed LLM calls log level='ERROR', 0 tokens, NULL cost in Langfuse → waste
        dollars come from duplicated *successful* calls (loadgen's impatient-client retry)
      • LibreChat re-assigns client messageIds server-side; loadgen detects replies
        by snapshot-diffing finished assistant messages
      • LibreChat API needs a browser-like User-Agent (uaParser middleware)
      • free-tier Groq/Gemini keys produce real $ costs (Langfuse prices from its
        model table × tokens) — no OpenAI needed
- [x] Phase 2 — THE STITCH ✅ 100% stitch rate. Langfuse trace id == OTel trace id via
      LiteLLM async_pre_call_hook (litellm/custom_callbacks.py) reading traceparent.
      INNER JOIN otel_traces ↔ traces works; v_stitch_fallback (ASOF) as insurance.
      See docs/stitch.md + sql/02_stitch_verification.sql.
- [x] Phase 3 — unified SQL layer ✅ sql/10 unified_spans view; sql/20 four golden-signal
      MVs (AggregatingMergeTree + golden_signals_1m reader); sql/30 wasted_spend v2
      (success-rank duplicates by prompt hash, root cause from FIRST attempt's trace,
      ERROR rows = signal not cost) + by_root_cause + per_minute; sql/40 impossible query.
      All exit gates run: applied from scratch, live MV updates, wasted_spend nonzero
      under induced retry storm ($0.018 / 27 dups / 8.6k tokens, ranked root causes).
      Gotchas: CH alias self-shadowing breaks *Merge (sumMerge(x) AS x); langfuse tables
      are ReplacingMergeTree → read with FINAL where correctness matters.
- [x] Phase 4 — dashboard + unified waterfall ✅ burn console (dashboard/, TS zero-dep,
      :8090): burn-bar hero (waste as % of spend), golden tiles + sparklines, root-cause
      share bars, prompt+answer request table, waterfall w/ ruler (renders in 38ms — gate
      was <1s); counter climbs <60s under fault ✓; every panel shows its SQL; reads CH via
      ro_viewer. Demo economics: mock-pro priced as gemini-2.5-pro, RAG-sized prompts.
      Deferred (optional): fallback dashboards inside HyperDX itself — do in Phase 7 prep.
- [x] Phase 5 — RCA agent ✅ "Cost Detective" LibreChat agent + MCP server (agent/server.ts,
      streamable-http, tools: query_clickhouse + get_schema, ro_viewer user). Verified:
      scripted incident Q answered with real trace_ids + $ (matches views to 4 decimals);
      survived unscripted Q; recursion proven (agent's own calls in observations with
      tool_call_names). Gotchas: ENDPOINTS must include `agents` or ALL agent tools are
      silently disabled; mcpSettings.allowedDomains needed for docker-internal MCP hosts;
      Gemini free tier = 20 req/DAY (agent runs on groq llama-3.3-70b).
      Recreate agent: node agent/create-agent.ts (idempotent).
- [x] Phase 6 — synthetic history + chaos ✅ loadgen/synthesize.sh (resumable, chunked,
      diurnal + incident windows, stitched trace ids; sized 3 days × 8M spans = 33M by
      user request — 1B attempt OOM-killed the 7.7GB VM twice; scale knobs documented).
      toxiproxy switchboard (librechat→litellm & →mongo) + loadgen/chaos.sh
      {slow-llm, slow-db, timeout, heal} + deploy_events markers. Exit gates run:
      fault→waste visible <90s w/ named root cause; clean recovery. Scale fixes:
      _24h dashboard views, semi-join culprits, Duration>1s prefilter in sql/40,
      ro_viewer memory cap. Numbers: MV polls 10ms, root-cause 24h 130ms,
      full-history 1.2s, impossible query 1.5s @ 33M spans.
- [x] Phase 7 — demo & ecosystem ✅ docs/demo.md (3-min script + checklists + kill
      switches), docs/slides.md (6 slides), docs/upstream-librechat-otel.md (ready-to-post
      PR/issue). REMAINING FOR HUMANS: post the upstream issue/PR, flip repo public,
      rehearse ×3, record backup run, optional HyperDX fallback dashboard.
