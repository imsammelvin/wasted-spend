# Click-a-thon 2026 — Observability Track
## Project: Wasted Spend — Every AI Incident Gets a Price Tag

> **One-liner:** Full-stack observability for AI apps that stitches the LLM layer (Langfuse)
> and the infrastructure layer (ClickStack) into ONE trace inside ClickHouse — enabling a
> new metric no tool on the market can compute: **Wasted Spend**, the dollars burned on
> LLM tokens *caused by* infrastructure failures.

- **Track:** Observability
- **Status:** Shortlisted (top 30). Prize pool ₹10L.
- **Bonus requirement:** Use ClickStack + Langfuse + LibreChat → all three are load-bearing in this design.

---

## 1. The three tools (plain language)

| Tool | What it is | Role in our build |
|---|---|---|
| **ClickStack** | Open-source observability stack (like self-hosted Datadog). Apps send logs/metrics/traces via OpenTelemetry → stored in **ClickHouse** → viewed in HyperDX UI. | Watches the **infrastructure layer** (HTTP, DB queries, pods, latency). |
| **Langfuse** | Open-source LLM observability. Records every LLM call: prompt, response, model, token counts, **cost in $**, latency, eval/quality scores. Also stores in **ClickHouse**. | Watches the **LLM layer** (tokens, cost, quality, retries). |
| **LibreChat** | Open-source ChatGPT clone — chat app supporting any model API, agents, tools, RAG. Not an observability tool. | The **AI application under observation** — generates realistic traffic. Also hosts our RCA agent UI. |

**The key fact:** Langfuse and ClickStack both store their data in ClickHouse.
Correlating the LLM world and the infra world is therefore not a fragile cross-system
integration — it is a `JOIN` on `trace_id` inside one database. **That thesis is only
true because of ClickHouse** — which is exactly what this jury wants to reward.

---

## 2. The problem (make judges feel it)

One request to an AI app fans out: `HTTP → app → vector search → LLM call → tool calls → retries`.
Today that trace is **torn in half**:

- **ClickStack** sees: some DB query was slow. Blind to tokens, cost, quality.
- **Langfuse** sees: the model retried, cost tripled, eval score tanked. Blind to pods, deploys, DB latency.

**Neither can see that the slow DB query CAUSED the retries and the cost spike.**

Nobody today can answer:
> *"Show me every request where LLM cost spiked AND quality dropped AND the cause was
> infrastructure — and rank the root causes by dollars wasted."*

Every company shipping AI features has this problem. No product solves it.

---

## 3. What we build

### Component 1 — Instrumented LibreChat (the patient)
Deploy LibreChat. Wire it to emit:
- Infra telemetry (OTel) → ClickStack
- LLM telemetry → Langfuse

…with the **same W3C `traceparent` / `trace_id`** stamped on both halves of every request.
This is the hard engineering (OTel context propagation through LibreChat's async Node.js
internals) and it is feasible because **Langfuse v3 ingests OpenTelemetry traces natively**.

### Component 2 — The unified layer (the ClickHouse showpiece)
SQL views + **materialized views** joining ClickStack's OTel tables and Langfuse's tables
on `trace_id` into one model. Live rollups:
- Cost per request / tokens per user
- Latency split: **infra time vs LLM time**
- Quality scores per deploy
- `ASOF JOIN` to align LLM spans with nearest infra metric samples (CPU, queue depth, cache hit-rate)
- Window functions for regression detection at deploy/model-change boundaries

~200 lines of SQL. Only possible because both tools chose ClickHouse.

### Component 3 — One waterfall (the demo moment)
A single per-request timeline:
`HTTP → vector search → LLM call ($0.31, 4,200 tokens, eval 3/10) → retry → retry`
Top half from ClickStack tables, bottom half from Langfuse tables, joined seamlessly.
**No product on the market renders this view.**

### Component 4 — The RCA agent (the closer)
Chat interface built **inside LibreChat itself**. Ask: *"Why did costs spike at 3pm?"*
Agent writes ClickHouse SQL against the unified layer and answers:
> *"Deploy at 2:47 slowed vector search 8×, causing LLM timeouts, causing agent retries —
> 340 requests double-billed, $47 wasted. Here are the traces."*

Punchline: the agent's own LLM calls are traced by our system. It monitors itself.

---

## 4. The signature innovation — the **Wasted Spend** metric

We do not ship a dashboard. We **invent a metric**:

> **Wasted Spend** = dollars burned on LLM tokens *attributable to infrastructure failures*
> — every retry after a timeout, every doubled call after slow vector search, every
> degraded-context re-prompt, joined to its infra root cause and priced.

Why this is the moat:
- It is **only computable on the joined plane** — impossible in Langfuse alone or
  ClickStack alone. The metric itself proves the thesis.
- It converts observability (crowded; every demo looks the same) into **money**
  (nobody forgets a dollar figure).
- "We invented the metric" is a category-defining claim. "We built a dashboard" is not.
- Reframes the RCA agent from "chatbot over logs" to *"where did my money go?"*
  answered with SQL-proven causality.

Also name the framework: **"The four golden signals of AI apps — latency, cost, quality,
loops."** Classic SRE has latency/traffic/errors/saturation; agentic apps have a new
failure surface. Defining a discipline is how hackathon projects get remembered.

---

## 5. How we stand out (everyone will ask GPT/Claude for ideas)

**Accept it:** several teams will land on "correlate Langfuse + ClickStack + RCA agent."
Hackathons are not won on ideas — they're won on **the gap between what teams describe
and what teams prove.** Most will demo two dashboards side by side + an agent that greps
logs and guesses.

Our three proof layers:

1. **The actual stitch.** One `trace_id` flowing through LibreChat's guts into both
   systems. Unglamorous, ~60% of the engineering, invisible on a slide — brutally visible
   in a demo. Their "correlation" = same timestamps. Ours = click a span, see both worlds
   in one waterfall. The judge question *"is this actually joined or just side by side?"*
   kills other teams and crowns us.

2. **The invented metric (Wasted Spend).** LLM-generated project plans produce dashboards;
   they don't invent metrics. Dollars, not graphs.

3. **Serious-team signals (cheap effort, huge judge psychology):**
   - **Open a real upstream PR** — the LibreChat trace-propagation patch submitted to
     LibreChat, and/or the Langfuse↔ClickStack join schema published as an OSS repo,
     *before* demo day. PR link on the final slide. ClickHouse judges partly to grow
     the ecosystem; an ecosystem contribution ≫ a hackathon project. Costs one evening.
   - **Billion-row live query.** Synthetic history alongside live traffic:
     *"Wasted Spend by root cause, 30 days, 1B spans — 600ms."* Engineered for a
     ClickHouse jury; their database is the hero.
   - **Break production live** (see demo script). Live failure + live diagnosis is
     theater the "two dashboards" teams cannot attempt.

**Positioning line:**
> They say: "AI observability with ClickStack and Langfuse."
> We say: "Every AI incident gets a price tag. We invented Wasted Spend —
> infra-attributed LLM cost — computable only as a ClickHouse join, proven live at a
> billion spans, and we've already PR'd the plumbing upstream."

---

## 6. Demo script (3 minutes)

1. Live LibreChat traffic; unified dashboard updating in real time.
2. **Break something on purpose** — throttle the vector DB, on stage.
3. Dashboard shows latency ↑, cost ↑, quality ↓ — *in the same view* (already impossible today). Wasted Spend starts climbing in **dollars per minute**.
4. Click one slow request → full-stack waterfall → slow DB span sitting directly above the expensive retried LLM calls. **Visible causality.**
5. Ask the agent *"what happened?"* → names root cause, blast radius, and the dollar figure — one JOIN across 1B rows, sub-second.
6. Final slide: the upstream PR link.

---

## 7. Why this wins (judge psychology)

- **Real, universal pain** — every judge who shipped an AI feature has hit this personally.
- **All three bonus tools load-bearing** — none decorative. Bonus locked.
- **ClickHouse is the hero** — the whole thesis ("just JOIN the two worlds") exists only
  because both tools standardized on ClickHouse. Demos that "could've been Postgres" lose.
- **Fills ClickHouse's own ecosystem gap** — ClickStack ↔ Langfuse have no bridge today.
- **Right-sized risk** — one hard part (trace propagation), rest is SQL + dashboard.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `trace_id` propagation through LibreChat's async internals is harder than expected | Langfuse v3 speaks OTel natively — emit LLM spans as OTel spans with Langfuse semantics from one pipeline. Fallback (build first, upgrade later): correlate on `(session_id, time-bucket)` via `ASOF JOIN`. Never let the demo depend on the hard part. |
| "Integration project" smell — judges don't award glue | Lead with the impossible query + Wasted Spend metric, never with architecture. |
| Crowded "AI agent does RCA on logs" space | Position explicitly: *"an RCA agent is only as good as what it can join."* Ours proves causality with SQL; theirs guesses from logs. |
| Live demo failure | Rehearse the break/recover loop; keep a recorded backup; synthetic data pre-loaded so queries always have something to show. |

---

## 9. Rejected alternatives (and why)

- **AI-SRE / auto-RCA over ClickStack alone** — no Langfuse → no bonus; less novel. Folded in as a feature.
- **Text-to-ClickHouse-SQL over OTel data** — crowded; "could be any DB." Folded in as the agent's mechanism.
- **Continuous-eval loop (Langfuse-only)** — weak ClickStack usage; feels like a tutorial.
- **eBPF/agentless ingestion** — infra-heavy; ignores two of three tools.

The unified-plane + Wasted Spend framing absorbs the best of these while being the only
option that is novel, all-three, and ClickHouse-native.

---

## 10. Next steps (in order)

1. **ClickHouse data model spec** — exact ClickStack + Langfuse tables to join, view
   definitions, materialized views for the four golden signals, and the "impossible query."
2. **Wasted Spend SQL** — formal definition + the query.
3. **Trace-propagation spike in LibreChat** — prove one `trace_id` lands in both systems
   for a single chat request. This de-risks the whole build.
4. Build order: fallback correlation first → upgrade to true trace join → dashboard →
   RCA agent → synthetic 1B-span dataset → upstream PR → demo rehearsal.

**Naming candidates:** Continuum, Stitch, or lead with the metric itself — *Wasted Spend*.
