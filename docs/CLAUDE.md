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
- [ ] Phase 2 — THE STITCH (fallback ASOF join first, then shared trace_id) ⚠ highest risk
- [ ] Phase 3 — unified SQL layer (views, golden-signal MVs, wasted_spend, impossible query)
- [ ] Phase 4 — dashboard + unified waterfall
- [ ] Phase 5 — RCA agent in LibreChat
- [ ] Phase 6 — 1B-row synthetic dataset + chaos scripts
- [ ] Phase 7 — upstream PR, demo rehearsal, slides
