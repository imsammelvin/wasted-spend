#!/usr/bin/env node
/**
 * Load generator for the wasted-spend demo. Zero dependencies — runs directly
 * with Node ≥ 23 (native TypeScript type-stripping):  node loadgen.ts
 *
 * Simulates N concurrent chat users against LibreChat, with the one behavior
 * that matters for the Wasted Spend metric: an IMPATIENT CLIENT. If the
 * assistant reply does not complete within PATIENCE_S, the user re-sends the
 * prompt (up to MAX_RETRIES). The abandoned generation keeps running server-side,
 * so each re-send is an extra fully-billed LLM call — that duplication is what
 * converts infra slowness into measurable wasted dollars. (Verified: failed
 * calls log $0 in Langfuse; duplicated successes carry the cost.)
 *
 * A background scorer posts a cheap quality score for recent Langfuse traces,
 * so the `scores` table (Quality golden signal) is live end-to-end.
 */

const env = (k: string, d: string) => process.env[k] ?? d;

const CFG = {
  baseUrl: env('LOADGEN_BASE_URL', 'http://localhost:3080'),
  email: env('LOADGEN_EMAIL', 'loadgen@anarix.ai'),
  password: env('LOADGEN_PASSWORD', 'WastedSpend!2026'),
  model: env('LOADGEN_MODEL', 'mock-gpt'),
  users: Number(env('LOADGEN_USERS', '3')),
  thinkS: Number(env('LOADGEN_THINK_S', '2')),
  patienceS: Number(env('LOADGEN_PATIENCE_S', '30')),
  maxRetries: Number(env('LOADGEN_MAX_RETRIES', '2')),
  newConvoPct: Number(env('LOADGEN_NEW_CONVO_PCT', '0.15')),
  durationS: Number(env('LOADGEN_DURATION_S', '0')), // 0 = run forever
  langfuseHost: env('LANGFUSE_HOST', 'http://localhost:3000'),
  langfusePk: env('LANGFUSE_PUBLIC_KEY', 'pk-lf-wastedspend-demo-2026'),
  langfuseSk: env('LANGFUSE_SECRET_KEY', 'sk-lf-wastedspend-demo-2026'),
  scoreEveryS: Number(env('LOADGEN_SCORE_EVERY_S', '20')),
};

// LibreChat's uaParser middleware rejects non-browser user agents
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PROMPTS = [
  'Summarize the plot of a random famous novel in two sentences.',
  'Give me three tips for writing readable SQL.',
  'What is the capital of Australia and one fun fact about it?',
  'Explain what a materialized view is in one paragraph.',
  'Write a haiku about observability.',
  'What causes a retry storm in distributed systems?',
  'Name two differences between OLTP and OLAP databases.',
  'How do vector databases work, briefly?',
];

// Realistic request size: real AI-app prompts carry RAG context, history and
// system instructions (500–2000 prompt tokens), not one bare question. This
// block (~450 tokens) rides along with every prompt so token counts and costs
// look like production traffic. Mock model → $0 actual spend regardless.
const CONTEXT_BLOCK = `

--- retrieved context (3 documents) ---
[doc 1] Quarterly infrastructure review: The platform served 41M requests in Q2 with a p95 latency of 340ms. Vector search accounted for 22% of request time on RAG-enabled routes. The embedding cache hit rate averaged 61%, leaving significant headroom; every cache miss adds an embedding call and roughly 80ms. Retry rates spiked twice, correlating with deploys on May 14 and June 3, both of which regressed connection pooling in the retrieval service.
[doc 2] Cost allocation report: LLM spend is now the second-largest infrastructure line item after compute. Average cost per assisted conversation rose 18% quarter over quarter, driven primarily by longer retrieved contexts (mean prompt size grew from 1,100 to 1,600 tokens) rather than by traffic growth. Duplicate generations from client-side retries were estimated at 4-7% of total generation volume but were not directly measurable with current tooling.
[doc 3] Incident postmortem 2026-06-03: A schema migration locked the metadata table for 41 seconds. Downstream, the retrieval service exhausted its connection pool, and user-facing requests timed out. Clients retried, tripling LLM call volume for the duration. Total incident cost was estimated afterwards by joining billing exports against request logs, a process that took two engineers most of a day.
--- end context ---

Using the context above where relevant, answer the following question. `;

const stats = { sent: 0, ok: 0, timeouts: 0, retries: 0, errors: 0, scored: 0 };
let halted = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

interface Message {
  messageId: string;
  parentMessageId?: string;
  isCreatedByUser: boolean;
  unfinished?: boolean;
  error?: boolean;
  text?: string;
  content?: { type: string; text?: string }[];
}

async function api<T>(
  url: string,
  opts: { body?: unknown; token?: string; basic?: string; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'User-Agent': UA, 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.basic) headers.Authorization = `Basic ${btoa(opts.basic)}`;
  const res = await fetch(url, {
    method: opts.body !== undefined ? 'POST' : 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

const login = async (): Promise<string> =>
  (await api<{ token: string }>(`${CFG.baseUrl}/api/auth/login`, {
    body: { email: CFG.email, password: CFG.password },
  })).token;

/** IDs of finished assistant messages currently in the conversation.
 * NB: LibreChat re-assigns message IDs server-side (the client-sent messageId is
 * discarded), so we detect replies as "a NEW finished assistant message appeared"
 * relative to a snapshot taken before sending. */
async function assistantIds(token: string, convoId: string | null): Promise<Set<string>> {
  if (!convoId) return new Set();
  try {
    const msgs = await api<Message[]>(`${CFG.baseUrl}/api/messages/${convoId}`, { token, timeoutMs: 10_000 });
    return new Set(
      (msgs ?? [])
        .filter(
          (m) =>
            !m.isCreatedByUser &&
            m.unfinished !== true &&
            (m.error === true ||
              Boolean(m.text) ||
              (m.content ?? []).some((p) => p.type === 'text' && p.text)),
        )
        .map((m) => m.messageId),
    );
  } catch {
    return new Set();
  }
}

const hasNew = (before: Set<string>, now: Set<string>): boolean =>
  [...now].some((id) => !before.has(id));

async function sendMessage(
  token: string,
  convoId: string | null,
  text: string,
): Promise<{ convoId: string; messageId: string }> {
  const messageId = crypto.randomUUID();
  const r = await api<{ conversationId?: string }>(`${CFG.baseUrl}/api/agents/chat/custom`, {
    token,
    timeoutMs: 20_000,
    body: {
      text,
      sender: 'User',
      isCreatedByUser: true,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId: convoId,
      messageId,
      endpoint: 'LiteLLM',
      endpointType: 'custom',
      model: CFG.model,
      key: null,
      isContinued: false,
      isTemporary: false,
    },
  });
  return { convoId: r.conversationId ?? convoId ?? '', messageId };
}

async function userLoop(): Promise<void> {
  let token: string | null = null;
  let convoId: string | null = null;
  while (!halted) {
    try {
      token ??= await login();
      if (convoId === null || Math.random() < CFG.newConvoPct) convoId = null; // new convo → title generation
      // nonce: distinct requests never hash-collide; genuine retries (same prompt
      // object re-sent below) DO — that's exactly what wasted-spend dedup keys on
      const prompt = `${CONTEXT_BLOCK}${pick(PROMPTS)} [req ${crypto.randomUUID().slice(0, 8)}]`;

      // impatient client: send, wait up to patienceS, re-send on timeout
      for (let attempt = 0; attempt <= CFG.maxRetries && !halted; attempt++) {
        const before = await assistantIds(token, convoId);
        const sent = await sendMessage(token, convoId, prompt);
        convoId = sent.convoId;
        stats.sent++;
        if (attempt > 0) stats.retries++;
        const deadline = Date.now() + CFG.patienceS * 1000;
        let done = false;
        while (Date.now() < deadline && !halted) {
          if (hasNew(before, await assistantIds(token, convoId))) {
            done = true;
            break;
          }
          await sleep(1500);
        }
        if (done) {
          stats.ok++;
          break;
        }
        stats.timeouts++; // server keeps generating; the re-send double-bills on purpose
      }

      await sleep(CFG.thinkS * 1000 * (0.5 + Math.random()));
    } catch (e) {
      if (e instanceof Error && /HTTP (401|403)/.test(e.message)) token = null; // re-login
      else stats.errors++;
      await sleep(2000);
    }
  }
}

/**
 * Cheap quality scorer: fills langfuse `scores` for recent unscored traces.
 * Heuristic v1 (swap for LLM-judge later): longer answers score higher, with
 * jitter; empty output scores low. Enough to light up the Quality signal.
 */
async function scorerLoop(): Promise<void> {
  const basic = `${CFG.langfusePk}:${CFG.langfuseSk}`;
  const scored = new Set<string>();
  while (!halted) {
    try {
      const r = await api<{ data: { id: string; output?: unknown }[] }>(
        `${CFG.langfuseHost}/api/public/traces?limit=20&orderBy=timestamp.DESC`,
        { basic, timeoutMs: 10_000 },
      );
      for (const t of r.data ?? []) {
        if (scored.has(t.id)) continue;
        const out = t.output ? String(t.output) : '';
        let value = out ? Math.min(9, 4 + out.length / 200) : 2;
        value = Math.round(Math.max(1, Math.min(10, value + (Math.random() * 3 - 1.5))) * 10) / 10;
        await api(`${CFG.langfuseHost}/api/public/scores`, {
          basic,
          body: { traceId: t.id, name: 'quality', value, dataType: 'NUMERIC' },
        });
        scored.add(t.id);
        stats.scored++;
      }
    } catch {
      /* langfuse briefly unavailable — retry next tick */
    }
    await sleep(CFG.scoreEveryS * 1000);
  }
}

async function main(): Promise<void> {
  console.log(
    `loadgen: ${CFG.users} users, model=${CFG.model}, patience=${CFG.patienceS}s, ` +
      `retries=${CFG.maxRetries}, duration=${CFG.durationS || '∞'}s`,
  );
  const workers = [...Array(CFG.users)].map(() => userLoop());
  const scorer = scorerLoop();
  const start = Date.now();
  const ticker = setInterval(() => {
    const s = Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s] ${s}`);
    if (CFG.durationS && Date.now() - start > CFG.durationS * 1000) halted = true;
  }, 10_000);
  process.on('SIGINT', () => (halted = true));
  await Promise.all([...workers, scorer]);
  clearInterval(ticker);
  console.log('loadgen: stopped.');
}

main();
