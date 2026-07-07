# The 3-minute demo — script, commands, fallbacks

**Thesis line (memorize):** *"Langfuse watches the LLM, ClickStack watches the infra —
neither can see that a slow database caused a cost spike. Both store in ClickHouse,
so we made them share one database and one trace id. Correlation is an INNER JOIN,
and on top of the join we compute a metric neither tool can: Wasted Spend."*

## Pre-demo checklist (T-30 min)

```bash
./bootstrap.sh                                  # idempotent; verifies everything
node dashboard/server.ts &                      # console on :8090
LOADGEN_PATIENCE_S=30 node loadgen/loadgen.ts & # calm baseline traffic (no waste)
./loadgen/chaos.sh heal                         # make sure no leftover faults
```
- [ ] Dashboard :8090 — tiles moving, waste ≈ $0 today, burn bar mostly gray
- [ ] LibreChat :3080 logged in (`wastedspend.demo@gmail.com`), **Cost Detective** selected in a fresh chat tab
- [ ] Groq quota sane: ask the agent one warm-up question (also warms its cache)
- [ ] Second machine/tab: backup screen-recording of a full successful run
- [ ] Browser zoom ~125% for the projector; dark OS theme (console is dark-first)

## The 3 minutes

**[0:00 — the healthy world]** Dashboard fullscreen.
> "This is a live AI app — real users, real LLM calls. Four golden signals of AI apps:
> latency split infra vs LLM, cost, quality, loops. Wasted Spend today: ~zero."

**[0:30 — break it, on stage]** In a visible terminal:
```bash
./loadgen/chaos.sh slow-llm        # +2.5s on every LLM call + a deploy marker
```
> "A deploy just regressed our LLM gateway. Watch what users do when answers
> get slow — they hit retry."

**[1:00 — money bleeds]** Point at the hero as it climbs.
> "Every re-send is a fully billed duplicate call. Latency you can see anywhere.
> *This* — dollars per minute, attributed — nobody else can show you."
Point at root-cause table: **slow: chat … — $X — worst span N s**.

**[1:30 — the waterfall]** Click the top row in *recent requests*.
> "One request, both worlds, one trace id: HTTP handling, Mongo, and the LLM call
> with its price — infra spans from ClickStack, LLM spans from Langfuse, joined in
> one ClickHouse. No product on the market renders this view."

**[2:00 — ask the detective]** Switch to LibreChat (already open).
Type: **"How much money did we waste in the last 15 minutes and what caused it?"**
> While it thinks: "The agent writes SQL against the joined plane. And it runs
> through the same proxy — the system traces its own detective."
Read its answer aloud: root cause → evidence trace ids → blast radius → dollars.

**[2:40 — heal + close]**
```bash
./loadgen/chaos.sh heal
```
> "Recovery, visible in a minute. Everything you saw is versioned SQL on one
> ClickHouse — the repo is public, the LibreChat instrumentation recipe is
> upstream-ready, and Wasted Spend is computable *only* because both observability
> layers standardized on ClickHouse."

## The scale question (when a judge asks)

Honest numbers (measured 2026-07-08, 3-day history on a 7.7 GB Docker VM shared
with 16 containers — regenerate bigger with `DAYS=n SPANS_PER_DAY=m ./loadgen/synthesize.sh`):
- 33M spans + 383k LLM calls + 128k scores of history, with a priced incident:
  *"slow: vector.search pgvector — 1,718 incidents — $9.12 — worst span 8.1 s"*
- dashboard polls (golden signals via AggregatingMergeTree MVs): **10 ms**;
  root-cause table (24h window): **~130 ms**
- full-history root-cause attribution: **1.2 s**; the impossible query (7-day,
  3-table join): **1.5 s** — on a laptop VM, cold-ish
- "The dashboard's every panel shows its SQL — click any 'SQL' toggle."
- If pressed on a billion: "same schema, same SQL, standard ClickHouse scaling —
  the metric is a JOIN + window function, nothing exotic. The MV-fed panels are
  O(minutes), not O(rows), so the dashboard doesn't care about raw volume."

## Unscripted-question insurance (agent)

Safe follow-ups it handles well: "which model costs most per request?", "what was
our p95 infra latency during the incident?", "show the most expensive trace today".
If the agent flails or Groq 429s: fall back to the dashboard root-cause table and
the waterfall — the SQL proves the same story without the agent.

## Kill switches

| Symptom | Fix |
|---|---|
| Dashboard frozen | `pkill -f 'node server.ts' && node dashboard/server.ts &` |
| No waste climbing | check loadgen alive; `./loadgen/chaos.sh status`; patience ≤ 3s during fault |
| Agent 429 (Groq) | switch agent model to `llama-3.1-8b` in agent builder, or use dashboard-only path |
| Anything else | play the backup recording, keep talking over it |
