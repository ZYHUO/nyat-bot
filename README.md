<div align="center">

# 🐱 NyatBot

**A Telegram group-chat agent on the path from chatLLM to AGI.**

Not a bot that responds when poked — an agent that hangs out, reads the room, and only speaks when it has something worth saying.

**v1.0** — the preview line ends here. What shipped in it: the Nyat Trench body layer (pressure / envelope / reflex), behavioural anti-ad with group-owner opt-in, the Meta+Subagent main path with per-task send budgets, StepFun search as the primary web route, and `step-5-preview` in the smart-group provider pool. A full flag census lives in [`docs/flag-census.md`](docs/flag-census.md) — **488 env keys, 216
boolean flags, 187 live in production**. The audit that produced it found 9 dead switches
and 4 test-only phantoms; all of them are now gone — `dead_and_on` and
`phantom_only_in_tests` are both **0**, and `tests/unit/env/no-dead-switches.test.ts`
fails the build if either stops being true.

(Numbers verified against `python3 scripts/flag-census.py` on 2026-09-21. The census is
regenerated, not hand-edited — if you change a flag, re-run it rather than trusting the
figure above.)

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![grammy](https://img.shields.io/badge/grammy-Bot_Framework-009DC4)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## Why this exists

Most chat bots are **responding** systems: cue in, text out. Real group members are **participating** systems: they lurk, follow threads, sense the vibe, and speak only when it matters. The whole project is organized around closing that gap:

- **Participate, don't respond** — per-chat cognition turns (burst merging, interrupt→replan, wait→genuinely come back), timing gates with human-like delay distributions, silence as a first-class decision.
- **Equal footing, no servility** — sycophancy is a structural RLHF artifact, not a tone bug. Persona carries flaws and edges (sharp tongue, grudges, favorites); the human holds top interrupt rights but is not a master to grovel to.
- **Telegram primitives are sensors** — mentions/reply-chains = addressee signals, reactions = unsupervised reward, polls/forwards = initiative carriers, topic ids = floor state. ~30% of the API surface was used; we're pushing that toward 100%.
- **Verifiable, not self-certified** — nothing counts as "working" because the LLM says so. Spot-the-bot harnesses, offline replay over real history, reaction-driven bandits: every claim needs an external artifact.

## What it does now

**Cognition & timing**
- ❤️ **Heart layer** — one persona-aware call replaces three filters: L0 rules miss → a single heart decision (reply / wait / pass). The self that decides *whether* to speak is the same self that decides *how* — with first-person self-state (mood/focus/social) and optional post-decision reflection (`HEART_REFLECT_ENABLED`)
- 🔄 **Turn Actor** — MaiBot-style per-chat turns: bursts judged as one thought, mid-generation interrupts trigger replans, "wait for them to finish" genuinely resumes, bounded self-continuation
- ⏱️ **Timing gate** — LLM three-way decision (continue / wait / no_action) with cooldowns, talk-value thresholds, defer-resume jobs that never drop messages, lognormal human-like delays, typing indicators, burst multi-bubble replies
- 🧭 **Meta + Subagent + CodeAct** (optional, default off) — Attention → Meta tick → JS dispatch → Subagent host APIs (telegram/memory/stickers) → callback; graylisted per chat (`META_SUBAGENT_CHAT_IDS`), see [`docs/meta-subagent/`](docs/meta-subagent/)
- 🧱 **Context Engine** — `static|delta|ephemeral|volatile` assembly + Manifest (stable prefix for prompt-cache-friendly providers); shared by Meta/Subagent
- 🧠 **3-level judge pipeline** — L0 local rules → L1 micro AI → L2 full AI (fallback path when Heart is off; Meta graylist chats skip it to avoid double replies)
- 🎯 **Multi-model routing + Smart Group** — per-usage provider chains (reply / judge / vision / summarize / deep_think) with auto-assign from a live health/latency pool, hedged requests, circuit breakers, Redis runtime overrides

**Nyat Trench — the live body layer** ([`docs/plans/2026-09-19-nyat-trench.md`](docs/plans/2026-09-19-nyat-trench.md))

The stance: *the model decides what to say and whether to say it; the host only reports the state of your throat.* Every mechanism below is a **measurement the host holds and the model reads**.

Honest correction, after an independent literature review (§九·补八): the earlier wording
"never a verdict, never a quota" was **false**. The 6-hour pinned-pressure watchdog and the
150/100 burst envelope *are* rules and a quota. What is actually true — and what the review
confirmed as the genuinely unusual part — is that those rules live on the **host side,
where the model can read them but not change them**, instead of being judgments written into
the model's path. The review also found no publication or repo for this architecture and no
baseline, so "best-performing" is unevidenced; the paper records what is genuinely new
(obligation decay discharged by the replying act, the host-reports/model-decides position
between rule-gating and RL) and what is a re-derivation (the integrator is a leaky bucket,
the four-signal score is the same shape as AgentPulse's bot score).

- 🩺 **L0 Bed** (`src/nyatos/trench.ts`) — a bounded integrator: speech pressure `P ∈ [0,12]`, shore `θ`, a time-based pump (halves every 60 min), sleep-phase accumulation, and a self-unlock watchdog that force-resets a group pinned at `P_MAX`. Bounded, observable, force-unlockable — the four properties a vetoer must have.
- 🧱 **L1 Wall** (`src/nyatos/envelope.ts`) — burst envelope (150 addressed / 100 proactive per hour), send-time gate, anchor dedup, and the outbound text guards that stop internal bookkeeping, tool placeholders **and tool-call syntax** from ever reaching a chat.
- 🪞 **L2 Reflex** (`src/agent/echo.ts`) — `Echo`, the only learner: whether what the bot said was picked up. Settles on every live outcome, so E actually moves.
- 💸 **Directed debt** (`src/nyatos/debt.ts`) — a per-`(chat, sender)` "you owe them a line" ledger. Decay is driven by *replying*, not by the clock — which is the difference between a living loop and a spasm.
- 🛡️ **Anti-ad, by behaviour not keywords** (`src/nyatos/ad-pressure.ts`) — four behavioural signals (burst / echo / repeat / cross-chat spread) composed into one bounded `adP`. **No content keywords anywhere.** Corpus analysis showed this ecosystem's noise is other bots, not human ad copy — phone numbers, crypto and porn links were all *zero* in the sample — so content matching would raise false positives and still miss the target. The Frame reports *"8560347478 在刷屏：8 条/5 分钟，0 人接，4 条重复。管不管、怎么管，你定。"* and the model decides, using the admin tools that already exist. Group-owner opt-in only (`ANTIAD_CHAT_IDS` or the per-chat Redis key); unauthorised groups pay nothing.
- 🔌 **Body-signal registry** (`src/nyatos/body-signal.ts`) — adding a body signal is *one file plus one `registerBodySignal` call*; `frame.ts` never changes. Measured before the refactor: adding directed debt had touched 10+ files, eight under `src/agent/`.
- 🔍 **StepFun web search** (`src/pipeline/tools/search.ts`) — `POST /v1/search` is the primary route, returning title/snippet/content/time directly with no model in the loop. Gemini grounding / grok / SearxNG / DDG remain as fallbacks. No model in the path also means one fewer surface for tool tags to leak into reply text.

> Honest status, from the first real wake-up after the layer went live: the **physics works** — pressure carried correctly into the first minutes (12 / 5 / 4.5 / 3 / 2.5 / 1.125 across groups, none pinned that shouldn't be), the watchdog created *and* cleared its timer on a genuinely pinned group, E moved on live settlements, and the debt-discharge call site fired with both guards satisfied. Two **transmissions are not established**: `P=12` did not produce speech (that group was silent 19 hours while the heart kept routing "reply" to Attention), and directed debt is seen but rarely chosen (0/13 in the wake window, 18% over a day). Both gaps have pre-registered, revertible experiments with criteria written down before running them. Net code change so far is **+12,102 lines, not −21,000** — the architecture added a body on top of the old system rather than replacing it, and the paper's 13 retracted claims are listed in its Appendix C.


**Being a group member**
- 🗣️ **Addressee & floor awareness** — explicit (mention/reply/quote) + implicit scoring for *who* is being talked to; thread disentangling; never interrupts a 1-on-1 streak
- 💬 **Natural pickup** — stays present after speaking: follows up questions/statements from either side without needing @ or quote; holds back in hot chats
- 🗣️ **Natural-language commands** — "check me in" → checkin, "show my album" → cards, "track bitcoin" → watch goal (lenient in DM, requires addressing in groups)
- 💬 **Multi-target replies** — one trigger can answer several people (JSON array), each quoting its own target
- ✍️ **Humanizer V2** — typo injection + silent edit correction, read delays, ack prefixes, delete-and-resend, sticker-only short replies, thinking interjections, afterthought edits, typing alignment, jitter, smart segmentation
- 😻 **Reactions, polls, forwards** — lightweight `setMessageReaction` acknowledgments (hard-capped per chat/day), polls as initiative carriers, taste-scored cross-group forwarding (see Taste below)
- 👥 **Social state** — member roster, per-chat mood, decaying per-user affinity, reputation, behavioral roles, social graph between members ("A and B interact a lot"), reply-outcome tracking
- 🧾 **Self-awareness** — the bot sees its own recent acts *with how they landed* (nobody replied / someone did / it got pushback), how much of the current stretch was its own talking, and how long since it last spoke. It regulates itself from that instead of being silently overridden by a timer.
- 🩹 **Relationship repair** (`src/tracking/repair.ts`) — when one of its own lines landed badly and it never came back to it, that is surfaced as a fact ("10 分钟前你说…，对方的反应不太好，之后你没再提"). The model decides whether to return to it; nothing auto-apologises.
- 🧵 **Cross-day threads** (`src/tracking/open-threads.ts`) — explicit commitments survive past the 30-minute working-memory TTL, so it can say "对了，昨天你说那个…" the way a person does. Only explicit promises are recorded; it never dredges up a conversation the human moved past.
- 😤 **Edges that include teeth** — the persona may swear when genuinely provoked, and the CodeAct path may say "让我想想" *before* going off to work, rather than going silent for thirty seconds and answering in one lump.

**Taste & curiosity (H3/H4)**
- 👅 **Taste scoring** — deterministic 0ms scoring of "worth forwarding" (funny / useful / resonant); LLM only *chooses* among candidates, never judges taste; 7-day cross-group dedup, ≤2 per chat
- 🎰 **Topic bandit** — ε-greedy topic recommendation driven by reaction reward (👍❤️😂 positive / 👎💩 negative / quoted follow-ups strongly positive); deterministic, no LLM on the hot path
- 🔭 **Proactive life** — RSS topics, missed-thread pickup, newcomer welcomes, dream journal (`data/dream-journal/` — morning diary / midday 随手 note / bedtime diary, three slots with three different voices), nightly dreaming over the day's events, holiday/solar-term + weather awareness, school-day schedule driving chattiness

**Memory · learning · self-evolution**
- 🧲 **Long-term semantic memory** — local multilingual embeddings + Qdrant recall, optional FTS5 BM25 lexical bypass with RRF fusion, importance scoring + forgetting, protected/permanent tiers
- 📖 **Shared group history** — cron-distilled "what happened" injected as callbacks like an old member would; correlation-scored retrieval (no accidental overlaps)
- 🧵 **Continuous mind** — the previous thought/stance carries across messages; judging and writing share one first-person narrative
- 📚 **Dialect exemplars & group norms** — per-chat style examples (content-free, style-only) + inferred implicit norms ("short messages, fast meme pickup") injected into prompts
- 🎯 **Self-scored quality (ASI)** — multi-dimensional self-rating with rolling EMA feeding humanizer self-tuning
- 🌱 **Skill distillation** — small skills distilled every 6h, merged weekly; hobby distillation from group members into self-state

**DM · collecting · games**
- 📨 **DM assistant** — relay messages to groups, anonymous notes (+ guess-the-author game), tree-hollow confessions, fate draws, natural-language reminders, member profiles
- 🐾 **Collectible cards + party games** — free (no-gacha) cat-girl cards unlocked by checkin, wishlist-matched trading, `/game tod|dare|wyr|nhie|guess`
- ✅ **Checkin, reputation, allowlist** — streaks/rankings/milestones, AI-reviewed join verification

**Infrastructure**
- 📦 **BullMQ queue** (Redis) · 🗃️ **Redis + SQLite + Qdrant + optional NyatDB** page-store ChatLog · 🔁 **polling ⇄ webhook auto-failover** · 🔭 **read-only chat monitor** (`/monitor`, token-gated) · ⏰ **Cron fleet** (health, profiles, proactive, ingest, dreaming, learning, cleanup) · 🔐 **SSRF guards, rate limits, atomic Lua ops, dedup locks** · 📡 **public channel ingest** · 🔥 **Firecrawl fallback for JS/Cloudflare pages** · 🔌 **Skill plugin system** (`data/skills/*.json`) · 🚀 **one-shot deploy** (`scripts/deploy.sh`) · 🧪 **vitest, fully green baseline** · 🪦 **graceful shutdown contract**

### 🏗️ Architecture

```
Telegram Update  (long polling ⇄ webhook auto-failover)
  │
grammY Bot
  │
  ├─【optional META_SUBAGENT】Attention (Redis) ──→ Meta loop (tick)
  │       │                                          │
  │       │                                     Meta CodeAct
  │       │                                          │ dispatch.taskToGroup
  │       │                                          ▼
  │       │                                   Subagent CodeAct
  │       │                             (telegram / memory / stickers)
  │       └────────────────────────────── callback ──┘
  │         (graylist chats: skip BullMQ / Turn Actor, no double replies)
  │
  └─【default path】Turn Buffer (Redis) ──→ chat_turn (BullMQ)
                 │
                 Pipeline Orchestrator (pipeline.ts)
                     │
                 Formatter ──→ Context (Redis ± NyatDB dual-write)
                     │
                 L0 rules ──miss──→ ❤️ Heart (reply / wait / pass)
                     │                    │   (+ optional thought reflection)
                     │                    │   (interrupt → replan · wait → resume)
                IGNORE / NL-cmd / DM    REPLY
                    intercepts            │
                     │              Reply Pipeline (stages/deliver)
                     │                     ├─ 4-Way Context Retrieval
                     │                     │   ├─ Recent Window
                     │                     │   ├─ Thread Trace (reply chain)
                     │                     │   ├─ Entity Mentions
                     │                     │   └─ Semantic (Qdrant, int8)
                     │                     ├─ 5-Layer Prompt Builder
                     │                     │   (+profile/nickname/mood/relation)
                     │                     ├─ Tool Executor (search, fetch...)
                     │                     ├─ Multi-Reply Parser
                     │                     ├─ Humanizer (self-tuning)
                     │                     └─ Streaming Sender
                     ▼
                 DM Assistant (relay/notes/hollow/draws/timers/profiles)
                 · Cards & Games (/cards /wish /game) · Checkin

  ├─ Member Registry (Redis Hash)      ├─ Mood / Relationship / Reputation
  ├─ Bot Interaction Tracker (SQLite)  ├─ Outcome + ASI quality tracking
  ├─ Rate Limiter (Redis Lua)          ├─ Learners (jargon / expression)
  ├─ Dedup Lock (Redis NX)             └─ Memory (importance + forgetting)
  └─ Allowlist + Join Verify

Hono HTTP Server
  ├─ /health   ├─ /monitor (read-only chat viewer)   └─ /webhook (failover)

Cron: model health · profile sync · idle proactive · channel ingest
      · memory dream · dream-journal · learner scan · cleanup
      · relationship summarize · sleep cycle · pm-nudge
      · school day-plan · resident-sticker vision · taste/topic scans
```

### 🧭 Cognition roadmap (H0–H4, all shipped)

| Stage | Goal | Landed |
|-------|------|--------|
| H0 equal footing | De-kneel prompts: no groveling, legal refusal, master = top interrupt, not a lord | #56 |
| H1 timing | Floor/addressee, group pace, silence convergence | #54 |
| H2 style | Dialect exemplar cold-start + hard constraints, per-message feed | #55, #58 |
| H3 initiative | Taste scoring + cross-group share, polls in main flow, mention unlock + heard-but-pass | #57, #59, #60 |
| H4 curiosity | Topic bandit + reaction reward reflux | #61 |
| H4.1/H4.2 hardening | Usage-level `jsonMode` defaults (kill dirty-JSON parse failures at the root), taste 0.5 recalibrated on 194-message replay | #62–#64 |

Next: reaction samples still at zero — the bandit/taste closed loops are live but waiting for their first real-world rewards. Offline replay (`scripts/offline-backfill.ts`) bootstraps norms/exemplars from history without sending a single message.

### 🕳️ Known traps (learned the hard way)

This codebase has repeatedly contained code that *exists, compiles, and passes its own tests* while doing nothing at runtime. Three distinct failure shapes, all found by replaying real data rather than reading code:

1. **Written but never read** — `core_blackboard` had 1,752 observation rows and no reader (`visibleToL1` was exported and never called).
2. **Read but never written** — the World projection consumed `world_change` events, but nothing in the repo ever emitted one, so `world_entities` stayed empty. `action-board` defines a `repair` action with a priority weight; nothing produced it.
3. **Present but wrong** — `world_entities` held 2,711 rows of reply instructions mis-stored as entity names, and they were being injected into the live prompt.

Two habits keep finding these:

- **Replay real data.** `grep` over logs answers a different question than you think: the `rule` field is only logged on the sleep path, so counting it said "0 hits" for rules that fire constantly. Replaying the real function over real messages found them immediately.
- **Check the built bundle.** `grep -c 'src/path/file.ts' dist/index.js` answers "is this in the running program" far more reliably than any import-graph analysis — it caught six genuinely dead files, and correctly flagged two that static analysis had wrongly cleared.
- **A test is not evidence of liveness.** Several deleted files had passing tests that only imported the module itself. Passing tests prove the code *works*, never that it *runs*.

### 📏 Evaluation

- **Long-horizon evaluation** (`src/eval/long-horizon.ts`, `long-horizon-report.ts`) — frozen-baseline vs expanded runs with external acceptance, crash/restart and interrupt/goal-change injection; driven by `scripts/eval-long-horizon-live.ts` and compared via `scripts/compare-long-horizon-reports.ts`. Engineering evidence only — 16 cases with no 1/7-day retention, so the delta is not a learning claim.
- **Agency canary** (`src/eval/agency-canary.ts`) — deterministic window evaluation over `agency_runs`; no real Telegram canary yet.
- **Offline replay** (`scripts/offline-backfill.ts`) — real Redis history through norms/exemplar/taste with `--dry` preview; read-only on history, write-only on tables.
- **Full suite is the gate** — `npm test` fully green is the merge bar; a failing test is a real regression, never skipped.

### 📁 Project structure

```
src/
├── index.ts              # entry — bot + API + worker + cron
├── env.ts                # zod env validation
├── admin/                # Hono Admin API + HMAC-SHA256 auth
├── ai/                   # AI layer
│   ├── provider.ts       #   Vercel AI SDK unified calls
│   ├── fallback.ts       #   fallback chains + hedged requests
│   ├── labels.ts         #   model routing + Smart Group auto-assign
│   └── token-counter.ts  #   tiktoken
├── allowlist/            # allowlist — DM application + AI review + master verdict
├── bot/                  # grammY bot
│   ├── handlers/         #   updates + member events
│   ├── middleware/       #   allowlist + rate limits
│   └── sender/           #   streaming sender + Telegram API
├── cron/                 # scheduled jobs (node-cron)
├── db/                   # Redis (ioredis) + SQLite (better-sqlite3)
├── knowledge/            # knowledge base + stickers + nicknames
├── learners/             # jargon mining + expression gating
├── memory/               # Qdrant semantic memory + importance/forgetting
├── meta/                 # Meta orchestration (Attention / loop / CodeAct session)
├── subagent/             # Subagent CodeAct + host API (telegram/memory/stickers)
├── context-engine/       # static|delta|ephemeral|volatile assembly
├── nyatdb/               # host adapter: NYATDB_* → @nyat/nyatdb (engine in packages/nyatdb)
├── ingress/              # polling ⇄ webhook failover
├── pipeline/             # core message pipeline (Heart / Turn Actor)
│   ├── pipeline.ts       #   orchestrator
│   ├── stages/           #   media / intercepts / stale-reply / deliver
│   ├── heart/            #   decision + self-state + mind + engagement
│   ├── turn/             #   turn actor (buffer/scheduler/focus/self-continue)
│   ├── context/          #   context mgmt + compression + 4-way retrieval
│   ├── judge/            #   3-level judge (rules + micro + full AI)
│   ├── reply/            #   generation + parsing + prompt building
│   │   ├── segmenter.ts  #     code-driven smart segmentation
│   │   └── humanizer.ts  #     humanizer (typos/delays/recalls/stickers/self-tune...)
│   ├── dm-relay/         #   DM assistant
│   ├── gacha/            #   card collecting + wishlist trading
│   ├── games/            #   party games
│   ├── rhythm/           #   taste scoring + forwarding
│   ├── nl-commands.ts    #   natural language → command routing
│   ├── timing/           #   rhythm/sequence state (gate + chat runtime)
│   └── tools/            #   tool system
├── nyatos/               # NyatOS: Frame assembly + single-decision shadow + participation budget
├── queue/                # BullMQ queue
├── shared/               # types + logging (pino) + config
├── eval/                 # long-horizon runner + agency canary
└── tracking/             # activity + mood + relations + reputation + ASI + outcomes
                          #   + self-history (own acts with outcomes) + repair + open-threads
prompts/                  # AI prompt templates (Markdown)
├── identity/             #   persona: persona.md + behavior-style.md (reply or not)
├── safety/               #   guardrails
├── contract/             #   output formats (JSON Schema)
├── style/                #   tone
├── task/                 #   task instructions (reply / heart / judge / timing-gate / codeact…)
├── meta/                 #   Meta/Subagent direction (background-dreaming etc.)
└── system/               #   system prompts (summaries etc.)
migrations/               # SQLite migrations (applied in order)
packages/nyatdb/          # @nyat/nyatdb page engine (TS; no Telegram deps in host)
native/nyatdb/            # NyatDB Rust napi addon (optional; https://github.com/ZYHUO/nyatdb)
docs/meta-subagent/       # Meta+Subagent+CodeAct switches / cutover / journal
docs/nyatdb/              # NyatDB production notes
scripts/                  # install / update / migrate / offline-backfill
```

### 🛠️ Tech stack

| Part | Tech |
|------|------|
| Runtime | Node.js 22+ / TypeScript 5 |
| Bot framework | [grammY](https://grammy.dev/) |
| AI SDK | [Vercel AI SDK](https://sdk.vercel.ai/) + @ai-sdk/openai |
| HTTP | [Hono](https://hono.dev/) |
| Queue | [BullMQ](https://bullmq.io/) (Redis) |
| Database | SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3), WAL) |
| Cache/queue | Redis ([ioredis](https://github.com/redis/ioredis)) |
| Vectors | [Qdrant](https://qdrant.tech/) (HNSW + int8) · local embeddings [@xenova/transformers](https://github.com/xenova/transformers.js) (`paraphrase-multilingual-MiniLM-L12-v2`, 384-dim; overridable via `MEMORY_EMBED_MODEL`) · optional FTS5 BM25 hybrid |
| Embedded ChatLog (optional) | [NyatDB](https://github.com/ZYHUO/nyatdb) (`@nyat/nyatdb` TS / Rust napi, default off) |
| Logging | [pino](https://getpino.io/) |
| Validation | [zod](https://zod.dev/) |
| Token counting | [tiktoken](https://github.com/openai/tiktoken) |
| Build | [tsup](https://tsup.egoist.dev/) |
| Tests | [vitest](https://vitest.dev/) |
| Deploy | Docker / systemd |

### 🚀 Quick start

#### Requirements

- Node.js ≥ 22
- Redis ≥ 7
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- OpenAI-compatible API key (OpenAI / Gemini / Anthropic / self-hosted proxy, …)
- Qdrant (optional; `scripts/deploy.sh` installs it automatically — semantic memory is empty without it)

#### One-shot deploy (recommended)

**Minimal: one command** (installs git + clones + guided config):

```bash
curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash
```

> Pass flags with `-s --`, e.g. China mirror: `curl -fsSL .../install.sh | sudo bash -s -- --china`
> Custom dir / mirror: `NYATBOT_DIR=/opt/nyatbot NYATBOT_REPO=https://ghproxy.com/https://github.com/ZYHUO/nyat-bot.git`

Or clone first (equivalent):

```bash
git clone https://github.com/ZYHUO/nyat-bot.git && cd nyat-bot
sudo ./scripts/deploy.sh        # guided Q&A, no manual file editing
```

`deploy.sh` / `scripts/install.sh` is an end-to-end, repeatable installer:
- **Interactive config**: asks for BOT_TOKEN (verified live via Telegram `getMe`, username auto-filled) + one AI endpoint (fanned out to all usages) → writes `.env` (mode 600). It won't pretend to succeed with missing config.
- **Environment self-check/heal**: arch (x86_64/ARM64), Node 22 (auto-install), build tools, **optional Rust** (builds [NyatDB](https://github.com/ZYHUO/nyatdb) native; otherwise the TS engine is used), memory/swap, disk, Redis (required, can start it).
- **Installs everything**: deps → Qdrant (musl static + systemd) → (optional) `npm run build:nyatdb` → build → systemd → **traffic-light self-check** (Qdrant/Redis/service/Bot started), ending with a redacted `deploy-report.txt`.

```bash
sudo ./scripts/deploy.sh --update        # fast update: git pull + rebuild (+ NyatDB native if Rust) + restart
sudo ./scripts/deploy.sh --doctor        # checkup only, no changes
sudo ./scripts/deploy.sh --reconfigure   # re-enter token / AI config
sudo ./scripts/deploy.sh --uninstall     # stop and remove units (keep data)
```

More flags: `--dry-run` (preview) `--yes` (non-interactive) `--china` (CN npm mirror) `--minimal` (low-memory) `--skip-{qdrant,build,deps}` `--no-restart`.
Behind a firewall: `export HTTPS_PROXY=…` when downloads stall, or pre-download Qdrant and use `QDRANT_TARBALL=/path`; embedding models can use `HF_ENDPOINT=https://hf-mirror.com`.

#### Daily updates

```bash
# manual (recommended): pull + deps + optional NyatDB native + build + restart
sudo ./scripts/deploy.sh --update
# or: curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash -s -- --update
```

Production hosts can also attach `scripts/systemd/xxb-autoupdate.{timer,service}` (aligns with `origin/main` every 5 min): `package-lock` / `native/nyatdb` changes trigger `npm ci` / `npm run build:nyatdb`, failed main builds roll back instead of restarting. Logs: `logs/auto-update.log`.

#### Manual install

```bash
git clone https://github.com/ZYHUO/nyat-bot.git
cd nyat-bot
npm install
# optional: build NyatDB native (needs Rust; otherwise the TS engine is used)
#   curl https://sh.rustup.rs -sSf | sh && npm run build:nyatdb
cp .env.example .env
# Edit .env with your Bot Token and AI API config
# optional Meta: META_SUBAGENT_ENABLED=true (graylist via META_SUBAGENT_CHAT_IDS first)
# see docs/meta-subagent/
# optional NyatDB: NYATDB_ENABLED=true (DUAL_WRITE first, then consider READ)
# engine repo: https://github.com/ZYHUO/nyatdb
```

#### Developing

```bash
npm run dev            # tsx watch hot reload
npm run build          # production build
npm run build:nyatdb   # optional: Rust ChatLog engine (needs Rust)
npm run start          # start production service
npm run test           # vitest
npm run lint           # ESLint
```

#### Docker

```bash
docker compose up -d    # Redis + Bot
```

#### systemd

Prefer the one-shot script above (it sets up Qdrant + both systemd units). Manual equivalent:

```bash
npm run build
sudo ./scripts/install-systemd.sh   # installs xxb-ts.service (logs to logs/app.log)
# Qdrant (semantic memory) — handled by deploy.sh; standalone:
#   download the musl static build to /usr/local/bin/qdrant, apply deploy/systemd/qdrant.service.template
sudo systemctl restart xxb-ts
sudo systemctl status xxb-ts qdrant
```

Day-to-day:

```bash
sudo systemctl restart xxb-ts        # restart bot
sudo systemctl status xxb-ts qdrant  # bot + vector DB status
tail -f logs/app.log                 # logs (JSON lines, NOT journalctl)
```

#### PM2

```bash
npm run build
pm2 start ecosystem.config.cjs --env production
```

PM2 is kept as a manual fallback only; systemd is preferred for permanent hosting.

### ⚙️ Configuration

Everything is env-driven, see [`.env.example`](.env.example). Core knobs:

| Variable | Purpose | Default |
|------|------|--------|
| `BOT_TOKEN` | Telegram Bot Token | (required) |
| `AI_PROVIDER_<NAME>_*` | Provider definitions: `ENDPOINT`/`KEY`/`MODEL`/`REASONING`(none/low/…)/`TIMEOUT`/`RAW` etc. | — |
| `AI_USAGE_<ROLE>_LABEL` / `_BACKUPS` | Usage routing: reply / judge / vision / summarize / reply_pro main+backup chains | — |
| `AI_USAGE_<ROLE>_JSON_MODE` | Force `response_format: json_object` for a usage (judge/summarize default on) | — |
| `REDIS_URL` | Redis address | `redis://127.0.0.1:6379/0` |
| `HEDGE_DELAY_MS` | Hedged-request delay (0=off) | `2000` |
| `CONTEXT_MAX_LENGTH` | Max Redis context messages | `600` |
| `BOT_NICKNAMES` | Bot nicknames (comma-separated) | `xxb,啾咪囝` |
| `MASTER_UID` | Owner Telegram UID (top interrupt rights, not a lord to grovel to) | `0` |
| `ALLOWLIST_ENABLED` | Group allowlist | `false` |
| `ALLOWLIST_BOT_FLOW_ENABLED` | Allowlist bot flow (DM application + AI review + master verdict) | `false` |
| `ALLOWLIST_REVIEW_ON_JOIN` | Auto AI-review when the bot is added to a group | `false` |
| `GEMINI_API_KEY` | Gemini web-search key (AI Studio); empty = xAI/DDG fallback | (optional) |
| `GEMINI_SEARCH_MODEL` / `GEMINI_SEARCH_PROXY` | Search model / proxy when egress is restricted | `gemini-2.5-flash-lite` / — |
| `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` | Scrape fallback (self-hosted can be localhost) | (optional) |
| `RESIDENT_STICKER_PACKS` | Resident sticker pack set_names (comma-separated) | (optional) |
| `META_SUBAGENT_ENABLED` | Meta+Subagent+CodeAct orchestration | `false` |
| `META_SUBAGENT_CHAT_IDS` | Graylist chatIds (comma-separated; **empty = all**) | (empty=all) |
| `META_TICK_MS` / `META_USAGE` | Meta loop interval / cheap-model usage | `5000` / `judge` |
| `TIMING_GATE_TIMEOUT_MS` | Per-hop LLM budget for Heart/gate (shared by primary+hedge) | `15000` |
| `SUBAGENT_MEMORY_ENABLED` | Subagent CodeAct long-memory section (visibility-layer scrubbed) | `true` |
| `REFLECTION_ENABLED` / `REFLECTION_INTERVAL_MIN` / `REFLECTION_WINDOW_MSGS` | Deep-reflection cron (recent per-chat digest → [this group's lately]); `STARVED` alert on total miss | `true` / `10` / `200` |
| `CODEACT_USAGE` / `CODEACT_MAX_TURNS` | Subagent CodeAct model + turns | `reply` / `6` |
| `CONTEXT_ENGINE_ENABLED` | Context Engine segmented assembly | `true` |
| `DREAM_JOURNAL_ENABLED` | Dream-journal cron (can post to a channel) | `false` |
| `DREAM_JOURNAL_CRON` | Comma-separated UTC crons; slot (morning/随手/bedtime) is inferred from Shanghai time | `0 23 * * *,0 4 * * *,0 15 * * *` |
| `SCHOOL_SCHEDULE_ENABLED` | Daily schedule (school timetable / summer day-plan) driving tone | `true` |
| `DAILY_LIFE_PROFILE` | `auto` (7–8 月 → summer) \| `school` \| `summer` | `auto` |
| `DREAM_JOURNAL_CHAT_ID` | Journal target (channel/group; positive numbers auto-converted to `-100…`) | `0` |
| `NYATDB_ENABLED` | Embedded [NyatDB](https://github.com/ZYHUO/nyatdb) ChatLog | `false` |
| `NYATDB_DUAL_WRITE` | Write ChatLog (legacy name; sole writer when `REDIS_MIRROR=false`) | `false` |
| `NYATDB_READ` | Prefer NyatDB on reads (Redis fallback when empty) | `false` |
| `NYATDB_REDIS_MIRROR` | Also write Redis ctx (effective when `DUAL_WRITE` is on) | `false` |
| `NYATDB_NATIVE` | Use the Rust addon (requires `npm run build:nyatdb` first) | `false` |

> Model routing is `AI_PROVIDER_<NAME>_*` + `AI_USAGE_<NAME>_*` (provider/usage split, runtime-overridable via Redis `xxb:admin:model_routing:override`). Feature switches are all `*_ENABLED` (default off, graylisted rollout). See [`docs/meta-subagent/`](docs/meta-subagent/) and [`docs/nyatdb/README.md`](docs/nyatdb/README.md).

### 📊 Prompt system

**Writing replies** (`prompt-builder`) stays 5 layers:

| Layer | File | Purpose |
|------|------|------|
| L1 Identity | `prompts/identity/persona.md` | who it is (owner/recognition/schedule/priorities) |
| L2 Safety | `prompts/safety/guardrails.md` | guardrails (harmful content, anti-injection) |
| L3 Contract | `prompts/contract/reply-schema.json` | JSON Schema output contract |
| L4 Style | `prompts/style/tone.md` | tone (short lines, chat style) |
| L5 Task | `prompts/task/reply.md` (+ `reply-pro` / `reply-max`) | task brief; deeper tiers stack on `replyTier` |

**Whether to speak** (decision path) is kept separate from writing, so Timing/Heart never carry full persona prose:

| Purpose | File | Notes |
|------|------|------|
| Participation rules | `prompts/identity/behavior-style.md` | only "reply or not / when"; primary Timing Gate input |
| Heart | `prompts/task/heart.md` + persona identity block + behavior-style | one call decides reply / wait / pass |
| 3-level judge | `prompts/task/judge.md` | fallback when Heart is off; `normal` / `pro` / `max` |
| Rhythm gate | `prompts/task/timing-gate.md` | continue / wait / no_action |
| CodeAct | `prompts/task/codeact-reply.md` | Meta→Subagent writer persona layer |

Prompts are hot-cached in-process; edit + restart takes effect, no rebuild.

### 💬 Command reference

Slash commands, or **natural language** (any intent in DM; groups require @ or replying to the bot):

| Command | Purpose | NL example |
|------|------|------|
| `/checkin` | Daily checkin (streaks/rankings/milestones, free card unlocks) | "check me in" |
| `/stats` | Group checkin leaderboard | "show the ranking" |
| `/cards` | My card album | "show my album" |
| `/wish` | Wishlist `add <name>` · `holders` · `wanted` | "I want Nine-Tail" / "who has what I want" |
| `/game` | Party games `tod`/`dare`/`wyr`/`nhie`/`guess` | "truth or dare" / "give me a would-you-rather" |
| `/watch` `/unwatch` `/watches` | Watch goals (DM) | "track bitcoin" → goal, followed up on time |
| `/muteme` `/unmuteme` | Ask it to ignore me / listen again | "stop replying to me" / "you can reply again" |
| `/feature` | Per-group feature switches (admins) | — |
| `/remember` | Remember my preference | "remember I like cats" |
| `/help` | Help | "what can you do" |

**DM-only**: relaying, anonymous notes, tree-hollow, fate draws, timed reminders, member profiles — just say it in natural language ("tell the group…", "note for XX …", "wake me at 6am tomorrow").

### 🔐 Security

- **Telegram WebApp HMAC-SHA256 auth** — constant-time comparison
- **SSRF protection** — private-IP / DNS-rebinding checks, same for skill HTTP calls
- **Path traversal protection** — fileUniqueId regex validation
- **Atomic Redis Lua ops** — race-free rate limits + context pruning
- **NX dedup locks** — double dedup on submit + result
- **API key stripping** — frontend responses never leak secrets
- **Response size caps** — web-fetch tool 512KB ceiling
- **Skill sandbox** — script type disabled (RCE guard), SSRF-filtered HTTP skills, name allowlist

### 🔧 Tool system

Tools the bot can call while replying:

| Tool | Purpose |
|------|------|
| `WEB_SEARCH` | Web search (Gemini Google-Search grounding → xAI / SearxNG / DuckDuckGo fallback) |
| `WEB_FETCH` | Page fetch (direct → local browser bypass → Jina Reader → self-hosted Firecrawl; HTML→text) |
| `BOT_KNOWLEDGE` | Group bot knowledge base |
| `IP_QUALITY` | IP quality/risk lookup |
| `SET_TIMER` | Timers |
| `LIST_TIMERS` | List timers |
| `DELETE_TIMER` | Delete timers |

### 🔌 Skill plugin system

Drop a JSON file into `data/skills/` to add a custom tool, no code changes:

```json
{
  "name": "WEATHER",
  "description": "Weather for a city",
  "parameters": {
    "city": { "type": "string", "description": "city name" }
  },
  "execute": {
    "type": "http",
    "url": "https://wttr.in/{{city}}?format=j1",
    "method": "GET",
    "resultPath": "current_condition.0"
  }
}
```

Supports `type: "http"` (SSRF-guarded). See `data/skills/README.md`.
---

### Enforcement, when the owner asks for it

The measurement is deliberately toothless on its own. `admin.kick(uid, {deleteMessages?})`
exists for the cases where deleting and muting are not enough — it is `ban` + immediate
`unban`, which is Telegram's actual "remove from group" semantics, so the person can
rejoin and it is not a permanent ban.

Four gates run in order, and the first one is the point:

```
ANTIAD_KICK_ENABLED !== true   -> admin_kick_disabled   (default OFF — kicking is not reversible the way deleting is)
target === MASTER_UID           -> admin_no_master
target === getBotUid()          -> admin_no_self
assertAdminPerm + the same per-chat hourly rate gate as mute
```

The model-facing doc calls it a last resort and asks it to consider whether delete + mute
was already enough, because one wrong kick and a real person does not come back. Nothing
kicks automatically — the Frame reports the behavioural facts, the model decides.

#### The second card: letting another bot do the punishing

`admin.kick` is one card. There is a second one, and it exists because of a hard Telegram
limit: **a bot cannot press another bot's inline keyboard button.** `callback_query` is only
ever produced by a human tapping a button — there is no API to synthesise a click. So when
`nmnmfunbot` posts a join-verification message, the buttons on it are unreachable:

```
入群验证 · 5 buttons
  在 App 中验证      -> url   telegram.me/nmnmfunbot/panel?startapp=…
  打开浏览器验证     -> url   nmbot.nmnm.fun/#/web-verify/{chat}/{uid}
  通过               -> jv_{"admin":"approve"}
  拒绝               -> jv_{"admin":"reject"}
  拒绝并举报骚扰     -> jv_{"admin":"spam"}

验证失败被封禁 · 2 buttons         Anti-Spam 识别骚扰 · 2 buttons
  解除封禁  ban_{"isUnban":true}    解除封禁 / 添加到白名单 spam_whitelist
  举报骚扰  ban_{"isUnban":false}
```

Those counts are measured, not guessed: `formatter.ts` captures other bots' inline keyboards
into `inlineKeyboard`, NyatDB persists that field, and a scan of 1,578 `nmnmfunbot` messages
across 21 groups found 1,251 carrying a keyboard (arithmetic-challenge variants run 8
buttons: six numbers plus 通过/拒绝).

What *is* reachable is a command. `/spam` is `needs_reply=1`, 18 observations,
confidence 0.95, `status=ready` in `bot_command_profiles` — and it must be a **reply**. So:

```js
// host.bots.command — 回复那条广告发命令，效果 = 有人按了「拒绝并举报骚扰」
bots.command({ bot: 'nmnmfunbot', command: '/spam', replyToMessageId: 265999 })
```

`nmBot` then bans the account and files a report to itself. This is the only channel a bot
has to that outcome, and it is gated exactly as hard as kicking:

```
BOT_REPLY_DELEGATION_ENABLED !== true        -> not sent
!ANTIAD_KICK_ENABLED && !antiAdEnabled(chat) -> not sent   (same owner grant as admin.kick)
replyToMessageId not in the last 60 messages -> not sent   (no hallucinated ids)
whyNotReplyInvocable(profile) !== null       -> not sent   (blocked / needs_admin /
                                                              not a reply command /
                                                              immature / unreachable receipt)
per-chat hourly cap (3) + 60s spacing        -> not sent
```

The allowlist is not a hardcoded list in the host — it is **the learned command archive
itself**. Only commands that were observed `needs_reply=1`, `needs_admin=0`, mature, and with
a reachable text receipt may be sent that way; today that is `/spam@nmnmfunbot` and
`/pickbottle@kmuav2bot`. Pick the wrong one and the tool answers with the legal menu instead
of a bare refusal.

The Frame tells the model the card exists, per group, only when the owner granted it:

```
[授权] 本群群主已开反广告，你可用的手段：admin.kick(uid) 把号请出群（不可逆）；
bots.command 回复那条消息发 /spam@nmnmfunbot（举报群内违规用户并触发封禁）。
管不管、用哪张牌，你按 [噪声] 的事实自己定——先想删消息+禁言是不是已经够了。
```

No grant, no line — and no card.

### How much of the old architecture is left — measured, not asserted

`scripts/arch-split.mts` answers this from the log with a reproducible criterion
(full log, 34.6 MB):

```
inbound messages (message in):           25,951
Meta path events                         32,462    ← the new architecture
legacy processPipeline exits               1,057    4.07%
  ├─ denoise: bot ad/verify/echo           1,002    3.86%
  ├─ floor: not addressed                    27    0.10%
  ├─ heart=pass                              24    0.09%
  └─ asleep, queued                           4    0.02%

legacy reply engine (judge→gate→reply) reaching an exit: 55  0.21%
```

Two conclusions, and they must be stated separately:

1. **The legacy reply engine is replaced.** Of 25,951 inbound messages, only 55 (0.21%)
   traversed `judge→gate→reply→send` and produced an exit — and none of them generated a
   reply to a human. That path no longer does work in production.
2. **Legacy still does three things, none of them "replying":** slash/NL command dispatch
   (811 handoffs in this window), bot-message denoise (1,002 zero-millisecond
   short-circuits), and delegation-receipt claiming (`tryHandleDelegationReceipt` is only
   called from there).

So "remove the pipeline entirely" now has an exact form: **reply deciding and generating
are entirely on the Meta path; legacy has degenerated into a command dispatcher plus a bot
denoiser.** That is a division of labour, not a half-open state — but it is still two
code paths, and bot denoise exists twice (the Meta path's classifier was added in round 1;
legacy's L0 `bot_message` rule is the original).

Why they were *not* merged here: routing all bot messages to the Meta path sounds like a
pure simplification but carries a regression risk — legacy's L0 IGNOREs non-conversational
bots at zero cost, while the Meta path's classifier only denoises `ad`/`verify`/`echo` and
would let the rest burn heart calls. That is exactly the cause of the "verify bot got 6
replies" bug fixed earlier. Merging requires unifying the two denoise criteria first,
which is its own round of work.

One caveat on the numbers: Meta and legacy are **not strictly complementary** — commands
hand off Meta→legacy and leave traces on both sides. So the Meta figure means "passed
through the Meta layer", not "only through Meta".

### How much the bot talks, and what actually bounds it

Frequency is not one knob, it is three rulers of different sizes, and each one was
added because the one above it turned out not to bite.

**Measured before any of this (3 days, 3,008 group sends):** hourly window
p50 = 6 / p90 = 26 / p99 = 63 / max = 107; 5-minute window p50 = 2 / p90 = 8 / max = 20;
the four busiest groups averaged 14.7–19.4 sends/hour. The single worst hour was 106.

| ruler | value | applies to | why it exists |
|---|---|---|---|
| Participation budget | 6/hour | **proactive** only | Phase 2.3's negative result: told as a plain fact "you sent 4 in 2 minutes and 3 got no reply", the model still chose to speak |
| Min gap — proactive | 90 s | proactive only | the count budget cannot stop 6 messages inside one minute |
| Min gap — addressed | 30 s | **everyone**, including replies | added 2026-09-21 — this path had *no* gap at all, and it carries nearly all production traffic |
| Envelope (L1 Wall) | 30/h addressed, 20/h proactive | everyone | the physical ceiling. Was 150/100, which `envelope-backtest` showed blocked **0.0%** of real traffic — decorative |
| Per-task send budget | 6 total | one agent task, **across segments** | was 6 *per segment* × up to 10 segments = 60 |

Two of those rows were bugs, not design:

- **The per-task budget reset every segment.** Each segment rebuilds the host API, so
  `textSent` went back to zero and the "6" was really 60. The delivery-count distribution
  jumps exactly at 6 (31 tasks at 5 sends → 51 at 6), and the worst task sent 12 messages
  in 46 seconds. `sendsUsed` now lives on the task and is saved into *and* restored from the
  checkpoint — plugging only the save side would have been a no-op.
- **The addressed path had no spacing at all.** The min-gap only guarded proactive speech,
  but 2,702 `host sendText` calls in three days split 1,356 explicit `replyTo` / 1,340
  task-default anchor — i.e. essentially all traffic was exempt. That is where "three
  replies inside five seconds" came from.

When a ruler fires it does not silently drop the message: the reason is thrown back into
the model's turn as a fact ("你 12 秒前才在这个群回过话，连得太密了"), so it can merge the
answers into one message or wait. Silent dropping was the old gate's shape and is exactly
what the budget module was written to replace.

### Video understanding — and the silent bug that blocked it

The bot reads images. It did not read video: `multimodal.ts` had a single line,
`[视频：用户发送了一段视频]`, plus a comment saying "description not supported yet".
That comment was **true when written and false now**.

Measured against the live API: `step-5-preview` (the 1M-context model wired into
smart-group this round) accepts a base64 `video_url` part and described a 6-second test
clip accurately — colour bars, the rainbow diagonal, the moving blocks, the timer in the
corner. So video is now described, in the same shape as images and audio.

Four things had to be right, and three of them were traps:

1. **A dedicated `video` usage, not the `vision` chain.** The same `video_url` part sent
   to `step-3.7-flash` returns HTTP 200 with **empty content** — it burns the whole token
   budget on reasoning and hits `finish_reason: length`. A 200 is not a yes. So
   `AI_PROVIDER_STEP5_VIDEO=true` is an explicit capability declaration, and smart-group's
   video profile only accepts labels that declare it. Note the deliberate asymmetry with
   `vision`: an undeclared *vision* label is still tried (most providers never declared),
   an undeclared *video* label never is.
2. **`max_tokens` must be generous.** Reasoning counts toward completion; 400 tokens
   yields an empty answer.
3. **A hard duration cap (300 s) checked *before* download.** Telegram's own 20 MB bot
   download limit (10 MB in code) means a 5-minute video almost never fits anyway — so in
   practice this describes *short* clips, and longer ones get a neutral placeholder that
   states the duration rather than "无法识别" (which would read as the bot malfunctioning).
4. **Never hand the provider a Telegram file URL.** That URL is
   `https://api.telegram.org/file/bot<TOKEN>/<path>` — passing it to a third party leaks
   the bot token. Base64 inline, at 1.33× the size.

**The trap worth naming:** wiring all of that up still produced *"我没看到你说的视频呀"*
with a plausible token count. Cause: for `FORMAT=claude` labels, `callModel` mapped content
parts with `p.type === 'text' ? p.text : ''` — **images, audio and video were all replaced
with empty strings.** No error, no warning, and the prompt-token count matched (only the
text survived). Media-bearing calls now bypass the claude branch and use the
OpenAI-compatible raw path, which StepFun's `/step_plan/v1` also serves. Regression tests
pin both the video part and the image part actually reaching the request body, plus that
pure text still goes to `/messages`.

### Self-cognition: the input was a dry well

The bot writes self-model notes (`self_model_notes` → world-projection → injected into the
prompt as hypotheses about itself). The hourly cron that feeds it, `runFeedbackAggregate`,
read exactly one table: `feedback_events`.

**That table has 4 rows. Ever.** Two in the last week, both positive. Meanwhile
`reply_outcomes` — *did what I said land?* — has **12,752 rows** with a `signal` column, and
it was never read by anything in the self-cognition path.

The consequence was measurable: the newest self-model note was dated **2026-09-11**. For ten
days the model saw nothing new about itself, because the only pipe in was dry.

The cron now aggregates `reply_outcomes` too. With the real numbers, the state of the bot is
not subtle:

```
近 3 天 1208 条回复结果
  ignored_5_msgs      738   ← "I sent 5 messages and nobody answered"
  user_replied         85
  user_mentioned_bot   68
  explicit_positive    58
```

So it writes a note that says what the data says — `我说的话大部分没人接：近 3天 95 条里
90 条（95%）发出去之后群里没人接` — with the counts in `evidence`, and lets the model decide
what to do about it. The host measures; it does not issue the verdict, same as everywhere else.

Two guards, because the old shape had both failure modes:

- **Dedup.** `saveSelfNotes` is a bare `INSERT` with no unique constraint, and the two
  original note strings were literals — sustained negative sentiment would have inserted the
  *same sentence* every hour, and `getActiveSelfNotes` takes the latest 5 for the prompt.
  Same note now won't repeat inside 6 hours, but will after (a self-model that can never
  update is as useless as one that only repeats).
- **Minimum sample of 20.** Below that it writes nothing rather than drawing a portrait from
  noise.

### The provider pool: 5 of 33 labels have ever succeeded

Not a code bug, but it changes how the bot should be read, so it belongs here.

`.env` declares **23 providers whose endpoint is `http://127.0.0.1:3000/v1`. Nothing
listens on that port.** The relay that *is* running (`cliproxyapi`) serves port **8317**
with a different key — and its 217-model catalog does not contain a single one of the model
names those 23 providers ask for (`deepseek-v4-flash`, `grok-4.6`, `gpt-5.6-luna`,
`claude-opus-5`, `kimi-k3`, `glm-5.3`, `qwen3.8-max`, `MiniMax-M3` … all absent). So this
is not a stale port that can be repointed; it is 23 labels aimed at an upstream that no
longer exists in this form.

The measured consequence, from smart-group's own health ledger:

```
healthy:            5    stepfunthink (53,922 ok) · stepfunvision (6,539) · spark13 (636)
                         · stepfun (2) · step5 (1)
zero successes:    28
```

The bot keeps working because auto-assign *deprioritises* rather than removes failed
labels — but that is also why the outage could sit quietly for days. `initSmartGroup()` now
logs a startup line naming the never-succeeded labels, so "configured but unreachable" is
loud instead of silent.

Two follow-ups this deliberately does **not** do: repoint those endpoints (that would mean
inventing model mappings), or delete the labels (they may come back with the upstream).
Both need a decision about what should serve them.

### Error-level log lines that were not errors

`unhandledRejection` and `uncaughtException` were producing **130 error-level lines a
day**, of which 86 were `sendText_limit:6` and 44 were `echo_self_text`.

Every one of those is something `host-api` **deliberately throws**: the per-task send
budget ran out, the model was repeating itself, the model passed a non-string. When the
model's CodeAct writes `telegram.sendText(...)` without `await`, those rejections surface
as unhandled rejections.

The cost was never the volume — it was the **cry-wolf effect**. 130 false alarms a day at
`error` level trains you to read the log as background noise, and a real failure hides in
it.

Known sandbox control-flow shapes now log at `info` with a message that says
`(expected)`; everything else stays at `error`. The patterns are anchored so a typo'd
lookalike (`sendText_limitX`) still counts as an error rather than being silently
swallowed.

### Long-term memory writes now survive a Qdrant hiccup

`Memory write failed (non-critical)` was firing **700 times a day**:

```
terminated: other side closed   431
Connect Timeout Error           181
socket disconnected              50
read ECONNRESET                  38
```

Every one of those is a connection-level transient — the local Qdrant server blinked —
and every one of them permanently lost that message's long-term memory, because
`memorizeMessage` had no retry and its caller is fire-and-forget.

The vector write now retries three times (0 / 150 / 400 ms backoff) and **only** for
transient network errors. A malformed payload or a dimension mismatch throws immediately:
retrying that just doubles the same mistake. If all three attempts fail the warning still
fires — the failure does not become quieter, it just stops being thrown away by a blink.

The retry wraps the vector write only. The lexical index goes through SQLite and already
swallows its own errors, so wrapping it would be dead code; and it is written *after* the
vector write succeeds, so BM25 can never see a memory the vector store doesn't have.

### "All labels exhausted" that never tried anything

`callWithFallback` has two very different ways to end in `All labels exhausted`, and until
now they were indistinguishable:

- **every label really failed** → look at the provider's key, endpoint, quota
- **every label was skipped** because its model is cooling down or circuit-broken → wait
  ~45 seconds; or notice that the chain is full of aliases for one model

`stepfun`, `stepfunjudge`, `stepfunvision`, `stepfunthink` and `stepfunasi` are five
labels on **one** model (`step-3.7-flash`), so a single breaker trip kills all five at
once. Treating that as "the providers are down" sends you hunting for a problem that is
about to fix itself.

The second branch now logs a warning naming every skipped label and its remaining cooldown,
and throws a message that says `all candidates cooling down` instead of the bare
`All labels exhausted`. Verified by reverting the branch: three of the five new tests fail.

The path that exposed it was self-inflicted — repeated probe runs tripped the
`step-3.7-flash` breaker, after which dreaming's four candidates were all cooling and the
call failed in 25 ms with zero per-label log lines. Which is the point: a failure that
leaves no evidence is a failure you will misdiagnose.

### Two call sites that asked for JSON and never said so

Fixing `jsonMode` at the provider layer only helps callers that actually pass it. A scan of
every `callWithFallback` site whose result is fed to a JSON parser found two that ask for
JSON **in the prompt** but never set the flag:

- **`post-task-window.ts`** — the follow-up judge. `POST_TASK_FOLLOWUP_USAGE=reflection`,
  and the `reflection` usage carries no `jsonMode`, so the model was free to answer in
  prose into `parseJudgeResult`. Measured: 2,104 batch failures, of which 1,407 were
  `Empty response` (the 200-token budget being eaten by reasoning — now caught by the
  provider floor) and the rest largely this.
- **`bot-delegation.ts`** — the delegation-receipt answer. It uses `usage: 'reply'`, whose
  `REPLY_JSON_MODE=false` is deliberate: the reply writer wants natural prose, not JSON.
  But this one call says "输出 JSON" and then calls `parseReplyResponse`, so it must not
  follow the global setting.

Both now pass `jsonMode: true` explicitly. The lesson written into the option's doc comment:
**if the prompt asks for JSON and the caller parses it, pass the flag — do not rely on
usage-level configuration**, because a usage can easily be shared between a structured
caller and a prose one.

### `jsonMode` was silently ignored on every Claude-format label

Reading the cron log counts turned up two more jobs that were running at almost nothing:

- **dreaming**: `dreaming output unparseable — skipped` **805 times**, and
  `dreaming consolidated` — the success line — **had never appeared once**. 0% yield.
- **distiller**: 473 unparseable vs 73 parsed = 13.4%.

Both call an LLM with `jsonMode: true`, and both parse the result with `JSON.parse`.
Neither logged *what* came back, so 1,278 discarded outputs carried no information at all.

The cause is the same disease as the ASI rubric bug fixed earlier, but at a different
layer: `jsonMode` was only ever honoured on the raw-fetch OpenAI path, where it sets
`response_format`. Claude-format labels (`FORMAT=claude` — which includes `stepfun`, the
default label for `judge` and `summarize`) go through `callClaude`, the Anthropic
`/messages` endpoint, which **has no `response_format` and was not looking at the flag at
all**. So the model received a prompt asking for JSON and nothing forcing it, and answered
in Chinese prose. `JSON.parse` failed, the call was thrown away.

Earlier this was worked around by giving ASI a dedicated OpenAI-format label. Now it is
fixed where it lives: when `jsonMode` is set and the label is Claude-format, `callClaude`
appends an assistant message containing only `{` — Anthropic's documented prefill
technique. The model can only continue from that brace, so the output is JSON by
construction. The brace is stitched back onto the returned text, because callers' parsers
expect a complete object.

Callers that don't ask for `jsonMode` are untouched, and a conversation that already ends
with an assistant message is left alone rather than getting a second prefill.

Both parse-failure sites now log the raw output (truncated to 300 chars). Before this, the
failure mode was diagnosable only by guessing — which is how 805 of them accumulated.

### A cron that had been running at 1% for days, because nobody read one field

`runTopicScan` logs `{ chats, observed }` every tick. `observed` is how many topic labels
it actually extracted. Nobody looked at it — so a cron that burns 20 LLM calls every four
minutes had been running for days at **1.0%** (533 ticks, 10,660 chats scanned, 108
labels) with no alarm anywhere.

The cause was the 24-token budget described above. The fix was the provider floor, and the
production evidence is unusually clean because it is the *same* job on both sides of a
restart:

| | before | after |
|---|---|---|
| tick at 20:31 | observed **1**, 21 truncations in the batch | — |
| tick at 20:40 | observed **0**, 21 truncations | — |
| tick at 20:48 | — | observed **10**, **0** truncations |

So the floor is not just unit-tested — the same cron went from extracting 0–1 labels out of
20 chats to 10, with the truncations gone entirely.

Two things were added so this cannot hide again:

- **A low-yield alert** in `topic-scan`: five consecutive ticks below 15% extraction raise a
  warning. The threshold is deliberately not zero — when a group genuinely has no topic the
  model correctly answers `NONE`, and a single zero tick is normal. What is not normal is
  *sustained* zero.
- **A `topic-scan 抽取率` section in `scripts/session-report.mts`**, which is where the
  1.0% number above came from.

And one logging change: the truncation retry now logs at `info` the **first** time per label
and `debug` thereafter. The first one says "this model thinks too much, noted"; the other
192 were noise. The retry count in the report is therefore "how many labels were found to
truncate", not "how many retries happened".

#### Reading a yield ratio without fooling yourself

`session-report.mts` has a **cron 产出率** section that pairs a failure log line with its
success line. Three rules, each bought with a mistake:

1. **If the success path writes no log line, report the failure count alone.** Pairing it
   with an unrelated success message produces a fake ratio, and a fake ratio is worse than
   none — `Memory write failed` was first paired with `memory near-duplicate merged`, which
   is a different code path, and reported 0% when successful memory writes simply log
   nothing.
2. **Keep the pair in one place.** The two strings drift apart when someone rewords a log
   line, and then the row silently reads 0/0.
3. **The counted exits must cover every exit.** `post-task follow-up` paired "judge failed"
   with "continuation dispatched" and reported 10.7% yield — fake. The third exit, "judged
   and decided not to follow up", is the common case and logged nothing, so the failure rate
   looked roughly ten times worse than reality. The feature was not broken; it was correctly
   staying quiet most of the time. That exit now logs — at `info`, because a `debug` line is
   invisible at `LOG_LEVEL=info`, which would put the hole straight back — and the row
   reports all three counts.

### Where the 23 "dead providers" were actually supposed to point

For several rounds the provider pool had 23 labels pointing at
`http://127.0.0.1:3000/v1`, where nothing listened, and the only other local relay
(cliproxyapi on 8317) served none of the model names they asked for. The question
"what should serve port 3000" had no answer from inside the repo.

It does have one on the box. There are **three** local relays, not one:

| port | service | key | state |
|---|---|---|---|
| 8317 | cliproxyapi | `sk-81686ee5…` | 217 models, none matching |
| 8800 | tabbit2api | `sk-tabb2-66fd…` | 14 models, upstream 403 |
| **7864** | **workbuddy2api-global** | **`wb2a-g-725a…`** | **10 models — the ones `.env` asks for** |

Port 7864's catalog is exactly what the dead labels request: `glm-5.2`, `glm-5.1`,
`kimi-k2.7`, `minimax-m3`, `hy3`, `hy3-preview`, `hy3-preview-agent`,
`deepseek-v4-pro`, `deepseek-v4-flash`. Its `state.json` explains the outage precisely:

```json
"credits": 0,
"reason": "429 rate limit",
"last_success": "2026-09-19T02:59:09+08:00"
```

**All three accounts have zero credits.** So the pool did not have a routing bug — it
had a billing one. The labels now point at 7864 with the right key and the right model
names, so they recover on their own when credits come back; until then they fail
cleanly and stay deprioritized rather than pretending to work.

The 15 labels whose vendors have no counterpart on 7864 (gpt-5.x, claude-opus,
gemini, qwen, grok, mimo) were left alone. They cannot work anywhere local, and
inventing a mapping for them would be guesswork dressed as a fix.

### The typesafe judge substrate was timing out, not failing

`judge substrate: typesafe breaker OPEN → chat fallback` fired 34 times. The breaker
opens after `JUDGE_SUBSTRATE_BREAKER_FAILS` (3) consecutive failures and stays open for
60s, so 34 openings means the typesafe backend was failing almost continuously.

The API itself was fine — a direct call returned 200 with a valid answer. Measuring its
latency showed why:

```
200 in 1.27s
200 in 3.33s   ← over the limit
200 in 1.11s
```

`JUDGE_SUBSTRATE_TIMEOUT_MS` was **3000ms**. The third call exceeded it, aborted, counted
as a failure, and three of those tripped the breaker. So the substrate spent roughly a
third of its life in cooldown, falling back to the chat LLM, and the log line said only
"unavailable" — which reads like an outage.

The timeout is now 9000ms, and the fallback log carries `status` and `err` so the next
occurrence distinguishes timeout from auth from 5xx instead of requiring a curl session
to find out.

Verified by calling `judge()` four times in a row: `backend=typesafe, ok=true` on all
four, where before the change both probe calls came back `backend=chat`.

### Four flags are ON and permanently unreachable — "has a reader" ≠ "reachable"

`MULTI_AGENT_PERSONA_ENABLED`, `MULTI_AGENT_PERSONA_CRITIC_ENABLED`,
`MULTI_AGENT_MEMORY_ENABLED` and `MULTI_AGENT_DIRECTOR_ENABLED` are all `true` in `.env`.
Each has a reader in `src/pipeline/multiagent/orchestrator.ts`, so the dead-switch guard
passes. Their parent, `MULTI_AGENT_ENABLED`, is `false` — so the whole orchestrator has
never run, and `Multi-agent: persona-critic rewrite` has appeared zero times.

**A reader inside a branch the parent flag switched off is not a reader.** The guard
checked the wrong property.

`tests/unit/env/no-dead-switches.test.ts` now also carries a `FAMILIES` /
`PARENT_GATED` pair: any child that is ON while its parent is OFF must either be turned
off or carry a written reason. The four above carry one — the persona specialist and
persona critic are the mechanisms behind "strengthen identity awareness", and the parent
being off is a production choice (parallel experts are expensive and have no production
evidence), not an oversight. A second self-check fails when a parent gets switched on, so
the reasons cannot rot.

Verified by removing one reason and watching the check fail.

### A reachability probe — and why its output is a shortlist, not an answer

Seven "wired only into legacy" bugs were found one at a time across rounds 33–75. Round 76
finally computed the set instead of stumbling through it: `scripts/legacy-only-modules.mts`
builds the module import graph and reports modules whose every importer sits inside
`processPipeline`'s subtree. 411 modules with importers collapse to **26 candidates**.

It is a shortlist, not an answer. At least three of the 26 are false positives —
`tracking/obsessions.ts`, `pipeline/turn/turn-lock.ts`,
`agent/agency-reply-observation.ts` are all reached by **dynamic** `await import(...)`,
which the probe's path resolution misses, so they look importerless and get classified as
legacy-only. The script says so at the bottom of its own output.

The value is the compression: every one of the seven hand-found cases appears in the 26,
and each candidate needs one `grep` for dynamic imports before it counts. Without the
probe the same search costs 411 modules of reading; with it, 26 greps.

The lesson generalises past this repo: **a reachability analysis over a dynamic-import
codebase is a filter, never a verdict** — and a filter that does not label its own false
positive rate will be believed as a verdict.

### Batch crons need a batch-level gate, not just per-call limits

Round 65 found `deep-reflection` ticks running 629s against a 600s interval, caused by
two individually-correct fixes multiplying (per-hop timeout 12→20s, plus wait-if-cooling
up to 15s, across 15 chats).

Asking "same cause elsewhere?" over every cron that loops over chats found five more with
**no deadline at all**: `topic-scan`, `knowledge-sync`, `bot-command-scan`, `memory-dream`,
`tic-penalty`. `topic-scan` was the worst of them — `extractTopic` set no `maxTimeoutMs`,
so it inherited the `judge` usage's 120s:

```
20 chats × 3 hops × 120s = 7200s theoretical ceiling for one tick
measured: adjacent tick gaps up to 993s against a 480s interval
```

Both now carry a wall-clock budget (`REFLECTION_TICK_BUDGET_SEC`,
`TOPIC_SCAN_TICK_BUDGET_SEC`, default 180s) plus a per-hop cap, and the tick log reports
`skippedForBudget` so a budget that starts biting is visible rather than silent.

Measured after the deploy — this is the before/after the fix was waiting for:

```
deep-reflection   before: 629s / 603s / 600s per tick, reflecting 0–2 of 15 chats
                  after:  14s per tick, reflecting 10 of 15, skippedForBudget 1–2
topic-scan        before: gaps up to 993s against a 480s interval (~8min ticks)
                  after:  14s per tick, 20 chats scanned, skippedForBudget 0
```

`skippedForBudget` being non-zero on reflection is the budget doing its job: those one or
two chats would otherwise have pushed the tick back toward ten minutes, and they get
picked up next tick anyway.

The rule this leaves behind: **for anything that loops, the unit of measurement is the
loop, not the iteration.** A per-call limit tells you one call is bounded; it says nothing
about the batch, and "reasonable × N" is how a 12s fix becomes a two-hour tick.

### Fixing the merged tool-writer exposed what its failure had been hiding

Round 45 got it running for the first time — 7 successes, all through `spark13`, after 195
exhaustions with zero finishes. That looked like the end of the story. Measuring what the
successes actually cost:

```
TW latency      → next send
15103ms         +43418ms
28363ms         +29782ms
21503ms         +19853ms
32608ms         +1942ms
```

**19–43 seconds end to end**, and `toolsUsed` was `[]` on all seven — not one tool call.

Before the fix the writer exhausted its chain instantly and fell back to the plain-text
writer (3–9s). The failure had been acting as a latency guard: it was fast *because* it
never worked. Once it worked, the cost appeared.

So the writer is now restricted to the `direct` path, where opening read-only tools is the
point. The `planned` path goes back to the plain-text writer, which is what it wants
anyway. The `reply_tools` usage stays correct — it just is not on the hot path.

The general shape: **a mechanism that has never run has never had its cost measured.** "It
is broken" and "it is cheap" can be the same fact viewed from two sides, and fixing the
first can silently bill you the second.

### The merged tool-writer had never once succeeded

`Merged tool-writer exhausted labels, fall back to legacy` appeared **195 times** in the
log. `Merged tool-writer finished` appeared **zero** times. `Merged tool-writer label
failed` — zero.

Zero per-label failures with 195 total failures is the tell: the loop never called
anything. `generateReplyWithTools` builds its chain from `[usage.label,
...usage.backups]`, and the `reply` usage defaults to `stepfun` + `stepfunjudge` — both
`apiFormat: 'claude'`. The writer drives the AI SDK's tool calling, which needs an
OpenAI-compatible endpoint, so every candidate hit `if (!apiKey || label.apiFormat ===
'claude') continue;` and the loop fell straight through to the exhaustion warning.

So the merged writer had been silently falling back to the plain-text writer on every
single reply since it shipped, and the log made that indistinguishable from "the chain
was tried and failed".

The fix is a dedicated usage, `reply_tools`, pointing at `spark13` — the only label that
is both healthy (800 successes) and not Claude-format. The skip paths now log and count
`reply_merged_writer_skipped_total{label, reason}`, so a chain that cannot be used says
so instead of just exhausting.

Verified by calling the writer directly with the new usage:
`failed=false, label=spark13, content: "去啊，明天一起去海边吹吹风多爽啊！"` — the
first successful run it has ever had.

### `unified tick: shared` has never fired — and that is correct

The cross-group `share` action has produced zero log lines since it shipped. The chain
that would have to break is `shareCandidates → prompt line → LLM picks share → four
hard gates`, and the first link is where it stops: `scoreTaste(m)` has to reach
`SHARE_THRESHOLD = 0.5`.

Measured over the five shadow groups' last 109 human messages: `0.00×103 / 0.35×4 /
0.45×2`. Nothing reaches 0.5.

The tempting fix is to lower the threshold. That would have been wrong: **0.5 is a
deliberate design decision**, pinned by a test — one signal plus substance is only 0.45,
and letting that through would forward any slightly-longer "哈哈哈" between groups.

The actual defect was upstream in the scorer. `USEFUL_RE` contained `怎么|如何`, which
are *question words*, not usefulness signals. They were handing 0.35 to ordinary
questions like "kddi怎么没解锁claude吗？", which made the 0.35 tier look artificially
close to the line. Remove them and the remaining 0.35s are genuine short jokes, which
the design says should not be forwarded.

So: the regex is fixed and pinned by a test, the threshold is unchanged, and `share`
staying at zero is the scorer correctly refusing to forward command spam and
speed-test bot output. **A feature that never fires because its input genuinely never
qualifies is not a bug — it is the feature working.**

### Video and image descriptions now demonstrably reach the model

Both media features shipped without a single production sample to prove they worked.
Both now have one.

**Video** — two `Video described` info lines, both through `step5`:

```
fileId=BAACAgUAAyEFAATqUDGr…  label=step5  ms=6651   chars=74
fileId=BAACAgUAAyEFAATqUDGr…  label=step5  ms=12860  chars=60
```

**Image** — the decisive check is not "was a description computed" but "is it in the
context the model reads". Querying `getRecent()` for the live chats returns:

```
[图片: 《你的名字。》里的宫水三叶身着红白巫女服，站在神社场景前举着系有红绳的神乐铃，面带活泼笑意。]
```

That line is the round-34/38 fix landing: the description is in `textContent`, which is
the only field the Meta path reads. Before it, the same sentence was computed, cached,
and discarded.

### The distiller's JSON was being cut in half — 1287 times

`distill output unparseable — skipping episode` fired 1287 times. Round 10 had already
fixed the *sibling* bug in `dreaming.ts` (jsonMode silently ignored on Claude-format
labels) and added raw-output logging there, but not here. Once this one also logged its
raw output, 14 samples showed the shape unmistakably:

```
len=61   {"summary": "本次任务要求自然接话回应群内@GundamWarrior的#245609消息，禁止复读原话
len=236  {"summary": "…", "lessons": ["群聊短回不能仅做简单附和，需顺着对方提及的核心点延续…
len=911  …
```

The model was producing exactly the right JSON. It just ran out of tokens before the
closing braces.

**Why the provider layer's truncation retry never fired:** `callModel` only escalates
when `!finalText` — an empty body. A half-written JSON object is non-empty, so from the
provider's side the call succeeded. This is the third instance of the round-12 /
round-40 disease (a small `maxTokens` on a reasoning model), but with a different
symptom: those two produced *empty* bodies, this one produces *half a body*.

Two fixes:

- `maxTokens: 1200 → 3000`
- `repairTruncatedJson()` — walk the string tracking the open-quote/bracket/object
  stack and close whatever is still open, then retry the parse. A truncated output
  whose `summary` did arrive now keeps that summary instead of being discarded whole.

The existing assertion `expect(callArg.maxTokens).toBeLessThanOrEqual(1200)` had been
pinning the very budget that caused the failure.

**A second shape, found the same way.** After the budget fix the distiller ran at 32.5%
yield instead of 13%, and the raw-output logging showed a new failure head:
`{```json\n{\n  "summary": …` — the model emits a stray `{`, *then* opens a fence. The
fence stripper only matched at the start of the string, so nothing was stripped; and the
leftover `{ {` is not parseable because an object's key cannot be `{`. Truncation repair
could not save it either, since closing the braces still leaves `{ {...}}`.

Now the fence is stripped anywhere and the parse starts at the first `{"`, so anything the
model says before its JSON is discarded rather than fatal. 26 of the last 24h's 360
failures carried a readable head; this shape is the one that was recoverable from them.

**And the yield was better than the report said.** The 2c table showed 33.7% with a ⚠️.
Measuring from *round 47's* deploy instead of the last restart:

```
round-47 deploy onward:  130 distilled / 26 unparseable  = 83.3%
last-24h window:         183 / 360                     = 33.7%  ← 10h of it is pre-fix
```

The fix had been working for ten hours while the table kept flagging it. Section 2c now
prints a post-deploy line and says outright that the full window mixes pre- and post-fix
data — because the question "did this fix work" is answered from *that* deploy, not from
the most recent one.

### Experience recall had the same bug — and the codebase already had the cure

Round 60 fixed `skills_fts`. Asking "same cause elsewhere?" over the four FTS5 tables
showed the write side differs per table:

| table | write side | query side | |
|---|---|---|---|
| `memory_fts` | `segment()` | `segment()` | ok |
| `session_digests_fts` | pre-segmented `seg` column | `segment()` | ok |
| `skills_fts` | trigger, raw fields | punctuation split | **fixed r60** |
| `experience_fts` | trigger, raw content | punctuation split | **broken** |

`experience_fts` had exactly the round-60 bug: the trigger stores raw content, the query
splits on punctuation, and Chinese has none — so every clause is one token that can never
equal a field. Stored: 「接话前未核对自身此前发言内容…禁止复读上一句…」; queried
「接话前要注意不要复读上一句」→ 0 hits.

The fix reuses `segment()` from `src/memory/lexical.ts` — the segmenter the memory path
already validated, whose header comment records that FTS5's `trigram` tokenizer cannot
find two-character Chinese words at all. Query side segmented, matched with `LIKE` against
the raw content so the write side needs no migration.

**Correction to the first version of this section.** It claimed experience recall "had
exactly the round-60 bug" and implied it never worked. It did work — `experience recall
injected` had been firing since 09-15, 1,226 times. Measuring old-vs-new on the same 25
real task directions:

```
OLD  3,0,3,0,3,3,3,2,3,3,3,3,3,3,3,3,3,3,3,3,3,0,3,3,0   → 21/25 non-empty
NEW  3,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3   → 25/25 non-empty
```

So it was **84% → 100%**, not 0% → 100%. Skills really was 0-for-6; experience was
already finding most things because real task directions contain short Latin tokens
(`@nlkio`, `#175213`, `uid:7648729949`) that survive punctuation splitting and do match.
The Chinese half of the query was dead weight.

The lesson is about how the first version got written: I fixed skills, saw the identical
code copied into `episodes.ts`, and reported it as the identical bug without measuring the
before. **Same code does not mean same symptom** — the surrounding data decides that.

Two things worth recording:

- **The default `botId` is a footgun.** `findRelevantExperience` defaults to `'self'`,
  but every stored row has `origin_bot = 'hunhebi_bot'` (from `BOT_USERNAME`). Querying
  with the default returns nothing and looks exactly like the tokenizer bug. Production
  passes `env().BOT_USERNAME` so it is fine, but a probe that forgets it will mislead you
  — mine did, twice, before I checked the data.
- `allowShared` defaults to **true**, meaning "also return other bots' *verified*
  experiences". That is the production intent (`EXPERIENCE_SHARE_ENABLED`), but it means
  a cross-bot query still returns hits — which reads like a leak until you read the
  `verified = 1` guard.

### Skill recall had never worked — the FTS tokenizer eats Chinese

`skill recall injected` appeared **zero** times in the whole log, while the skills table
holds 20 rows (4 `big`, not archived). Six realistic task directions all returned nothing.

The cause was not the query parsing, which is where it looked. `skills_fts` is an FTS5
external-content table with the default `unicode61` tokenizer, and measured directly:

```
"人设群聊接梗"  (skill 17's name, verbatim)   → 1 hit
"承诺跟踪"      (skill 20's name, verbatim)   → 2 hits
"人设" → 7,8      "群聊" → 5,7,11,12           (whole runs in other fields)
"承诺" / "交付" / "口吻" / "语气" / "跟踪"     → 0
"人" / "设" / "承" / "诺"                     → 0
```

So the tokenizer keeps each contiguous CJK run as **one** token, and a phrase query only
matches when it equals a whole field. `findRelevantSkills` split the query on punctuation —
which Chinese does not use — producing clauses like `回复群友关于节点延迟的调侃` that can
never equal any field. The retrieval had never succeeded once.

Replaced with bigram + `LIKE` over a concatenated haystack, scoring by how many bigrams
hit. Twenty rows, so a full scan costs microseconds and the ranking is legible. Four of
seven probe queries now return the right `big` skill; a genuinely unrelated query still
returns none.

One trap worth recording: the score expression appears in both `SELECT` and `WHERE`, so
writing it twice doubles the `?` placeholders and silently misaligns every bound
parameter. Wrapping it in a subquery keeps it in the text once.

### The diary writes notes now, not only diaries

The ask was "日记功能，不一定只能写日记，还能随笔记". The `free` slot exists for exactly
that, and `slotGuidance()` tells the model it is *not* a diary and may be two or three
sentences. Until 2026-09-21 it had never produced anything — every previous day's file
had zero 随手 sections.

Today's file, `data/dream-journal/2026-09-21.md`:

```markdown
## 08:04 · 起床/早上
哈欠…刚掀开眼皮就被签到成功的提示震了一下喵，连3天累计34次，今天第4个签到还摸到了
稀有「偶像喵」…脑子还沉得像灌了浆糊，再躺五分钟能不能再续个签到喵。

## 11:23 · 随手
蹲了半小时kddi系节点全躺，移动电信当场断气，联通也半死不活，等得本喵下巴都快磕键盘
上了喵。刚刷到群里发的野生狗奶阴间梗图直接笑喷，手里的冰美式都晃出来三滴。

## 12:00 · 随手
蹲到SpeedTest_bot终于跑完，队列里还排着267个，进度条爬得让人想打瞌睡喵。转头就看见
とくめ说机场没吃到好的只能多吃两碗饭，本喵手里的鼠标瞬间不香了，太阳都看饿了。
```

The morning section is a diary — how the bot feels about waking up. The two 随手 sections
are notes: what happened in the last hour, observed rather than reflected on. Different
register, same voice.

### The send ceiling scales with how lively the group is

Before this, `TRENCH_BURST_MAX` / `TRENCH_BURST_MAX_ACTIVE` were flat constants — a dead
group and a roaring one shared the same ceiling, so in a quiet room the bot could still
insert itself 20 times an hour. The user's requirement was the opposite shape: *"daily
frequency is too high; only be highly active when everyone else is."*

The envelope now scales its ceiling by the group activity the host **already measures**
(`xxb:activity:{chatId}`, written on every inbound message — no new instrumentation):

| messages in last 5 min | factor |
|---|---|
| ≥ 20 (热聊) | ×1.5 |
| ≥ 10 (活跃) | ×1.25 |
| ≥ 3 (正常) | ×1.0 |
| ≥ 1 (冷清) | ×0.5 |
| 0 (沉寂) | ×0.25 |

Two deliberate bounds: the floor is **1**, never 0 — a ceiling of zero would turn the
envelope from a guardrail into a mute, and a directly-addressed message still has to get
out (ignoring a direct question is a different failure). And if activity can't be read,
the factor is 1.0, i.e. exactly the previous flat behaviour — an infrastructure hiccup
must not change behaviour.

### The system prompt was recommending a capability this machine doesn't have

`computer.run` needs bwrap userns isolation. This machine's apt sources have **no bwrap
package** (`apt-get install bwrap` → `Unable to locate package`), so every
`executeCommand` returns `sandbox isolation unavailable`.

Meanwhile `EXECUTOR_SYSTEM` said, in two places:

- `computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}`
- `写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。`

**The prompt was recommending something permanently broken.** The model would follow it,
fail, and possibly burn turns retrying. Same disease as everything else in this session: a
thing that reads as usable, with a dead path underneath.

The fix rewrites both lines *at prompt-assembly time* based on
`getSandboxCapability()` — unavailable becomes "本机不可用…别用它验证任何东西", and when
bwrap comes back the original text returns untouched. It is a separate module
(`src/subagent/sandbox-prompt.ts`) precisely so it can be unit-tested without running the
whole CodeAct loop.

Two details worth keeping: if neither source line is found the function returns the prompt
unchanged rather than throwing — a prompt refactor must not fail every task — and
`terminalEnabled: false` and `isolationRequired: false` are *different* states from "on but
broken", so neither triggers the rewrite.

The rewrite covers every terminal-dependent line, not just the obvious one: the section
header (`## 电脑使用（SANDBOX_ENABLED 时可用）` — true but misleading, since the section's
command-based advice is all dead), the `python3.10` + PIL image-processing suggestion, and
the "写完 grep charset" verification step. `grep` is a command too. What survives is what
genuinely works: `computer.writeFile/readFile/listFiles` and the browser tools.

Separately, the boot-time line about this was `error` and fired **205 times**. It is a
static environmental fact, not a regression, so it is now `warn` and says so. The capability
really is unavailable; it just should not be shouting.

### Two selection bugs that put dead providers in live chains

**A label with zero successes was ranked as if it worked.** `healthy` in the health ledger
means "the circuit breaker hasn't tripped" (`errorCount < 5`) — not "this provider can do
the job". A label starts at `healthy: true, successCount: 0`, and one or two failures don't
change that. So it collected the same newcomer-median score as a provider with 522
successes, and because its (non-existent) latency was assumed to be the median, it could
rank *above* a proven-but-slow one.

Measured: `dsv4flash` — which points at `127.0.0.1:3000`, where nothing listens — sat in
the health ledger as `healthy=1 succ=0 err=3` and took **second place in the judge chain**.
`grok45` was the same shape.

The fix doesn't touch `healthy` (it really is only about the breaker). Instead, a
zero-success label is scored below every label with measured latency — specifically
`-(slowest measured + median)`, so it is strictly last among the healthy. One success
promotes it back into normal ordering, so a genuinely new provider still gets in; it just
has to prove itself once first.

**The vision chain accepted text-only labels.** The filter excluded only labels that
*explicitly* declared `vision: false`; undeclared ones passed. The chain came out as
`spark13(undeclared) / stepfunthink(undeclared) / step5(vision=true)` — the first two
cannot read images at all, so every image call burned two doomed attempts before reaching
the one that could. `Vision failed, returning placeholder` fired **434 times a day**, and
the bot saw `[图片]` instead of the picture.

The loose rule made sense when vision-capable providers were scarce. They aren't any more —
seven labels declare `vision: true`, two of them healthy — so vision is now strict, same
direction as video: **undeclared means excluded**.

Both fixes were verified by reverting each one and watching the corresponding test fail.
One existing test (`filters vision profile by capability`) had been pinning the bug with
the comment `undefined = 未知,保留` — that expectation is now the bug's epitaph.

### The fallback chain is diversified by upstream

Smart-group picks a usage's chain from the whole provider pool, ordered by measured
latency. That ordering has a failure mode: four of the five healthy labels —
`stepfun`, `stepfunjudge`, `stepfunthink`, `stepfunvision` — share **the same endpoint and
the same API key**. Sorted by latency they line up consecutively, so an account-level rate
limit or maintenance window kills all four at once and the chain is left with nothing. The
log shows exactly that shape: their `Empty response` counts are 1,481 / 133 / 1,481 / 685 —
they fail in batches.

`SMART_GROUP_DIVERSIFY_UPSTREAM` (default on) changes the ordering to *distinct upstreams
first*: the best label from each `(endpoint, apiKey)` pair fills the leading slots, and only
then are the remaining slots backfilled from the same upstreams. A chain of five now starts
with three different accounts instead of two. When everything is healthy the only cost is a
different ordering.

Labels are not removed from the pool — this only changes *who travels together in one
chain*.

### A token floor for reasoning models, learned from the truncations

The previous section described the retry. It was not enough, and the diagnostic proved it
within an hour of shipping: **193 empty-content events in 50 minutes**, all
`label: stepfun`, all `stop_reason: max_tokens`, all `blocks: ['thinking']` — and the
`max_tokens` values were **24, 48, 1200, 4000, 800, 400, 120, 60**.

The 24 came from `src/cron/topic-scan.ts`, which asks the model for a 4–12 character topic
label and therefore passes `maxTokens: 24`. That reads as sensible right up until you
notice the model is a reasoning one: the thinking chain burns the budget before a single
character of label exists. So topic-scan had been producing **nothing**, silently, every
four minutes across 21 groups. And the retry could not save it — 24 doubled to 48 is still
not enough (48 appears 73 times in the diagnostic, i.e. the retries failed too).

So the provider layer now keeps a floor instead of a multiplier:

- `REASONING_TOKEN_FLOOR = 1200` — measured: step-3.7-flash uses ~840 tokens of
  reasoning + text on a short prompt.
- A label observed to truncate is remembered **in-process**, and every later call to it
  starts at the floor rather than at whatever small number the caller wrote. The first
  truncation re-teaches it after a restart, and truncations log a warning, so "fails to
  learn" is not a reachable state.
- The floor is a floor, not a ceiling: a caller who explicitly asks for 8,000 still gets
  8,000, and the retry still doubles on top of it.
- `topic-scan` now passes 1200 directly, with a comment saying why — the floor is a
  backstop, not a licence to keep writing 24.

### Grep guards prove the string, not the logic

`verify-deploy.mts` greps `dist/index.js` for each mechanism, which can only show that an
identifier survived bundling. It cannot show that the branch it guards is reachable.

That limit was demonstrated this session: a grep-style test kept passing after
`if (true) break;` was inserted into the very branch the test claimed to cover — the
string was still there. Deleting the block entirely is what caught it.

So `verify-integration.mts` now has a block that **calls** the newest mechanisms and
asserts on return values: `decideBotMessage` for the bot gates, `smartGroupAutoAssign`
for the vision filter and upstream diversification, `applySandboxAvailabilityNotes` for
the sandbox prompt. Each was verified by breaking its mechanism and watching the
corresponding check go red.

A trap found while verifying those: running the break-test from a script without
prepending `PATH=/opt/node22/bin` gives the child Node 26, which crashes on
`better-sqlite3` *before* reaching the new checks — exit code 1 with no ✗ lines. That
reads exactly like "no failures found". A guard that cannot fail is not a guard.

### A silent fallthrough in media serialisation, closed with `never`

`serializeContent` handled `text`, `audio` and `video_url` explicitly and then had a bare
`return` for images — i.e. **image was the fallthrough**. Anything not matched by the
earlier branches became `{type:'image_url', image_url:{url: <undefined>}}`.

With today's four part types that is correct. It is also a trap: the moment someone adds a
fifth part type, it silently degrades into a malformed `image_url` and you get either an
incomprehensible upstream 400 or — worse — an empty payload.

This session already ate that exact shape once: the Claude branch mapped every non-text
part to `''`, so the model received only text and answered "I don't see the image", with
prompt token counts that looked perfectly consistent.

So `image` is now an explicit branch and the function ends with
`const _exhaustive: never = p` plus a throw. Verified by temporarily adding a fifth part
type to `ContentPart`: typecheck fails at exactly that line with
`Type '{ type: "document"; … }' is not assignable to type 'never'`. Adding a media kind
without deciding how it serialises is now a compile error rather than a production
surprise.

The runtime throw stays because a caller can still construct a part through `as` or JSON,
where the type system cannot see it. The test for that has to pair the unknown part with a
known media part — `hasMediaContent` does not recognise an unknown type, so a lone
`document` part takes the Claude path and never reaches `serializeContent` at all.

### When a reasoning model spends its whole budget thinking

The single most frequent LLM failure in this system is not a timeout or a rate limit —
it is `Empty response`, **2,882 occurrences** in the log (stepfunthink 1,481 ·
stepfunvision 685 · stepfun 583 · stepfunjudge 133). It is the main feed for the
heart's `All labels exhausted` (64% of heart failures, and heart failures are 25% of all
heart decisions).

The cause: StepFun's models are reasoning models, and `reasoning_content` counts toward
`max_tokens`. When the thinking consumes the whole budget the response arrives with
`stop_reason: 'max_tokens'` and **no text block at all**. The old code noticed this and
wrote a comment about it, then deliberately returned the empty string and let the fallback
chain cope — which usually meant trying another label **on the same upstream account**,
hitting the same ceiling, and dying together.

`callClaude` now distinguishes the two shapes that both used to look like "empty":

- `stop_reason: 'max_tokens'` + no text → **truncated**. Retry once with double the budget
  (capped at 32k). Only this shape retries — content rejections, timeouts and rate limits
  gain nothing from a second attempt and would just double the latency.
- `stop_reason: 'end_turn'` + no text → the model genuinely said nothing. No retry.

Either way, an empty response now logs *why* it is empty (stop reason, block types, output
tokens, budget). Before this, 2,882 failures carried no diagnosable information at all —
just a comment asserting a cause nobody had measured.

### A pre-gate for when the decision layer itself is down

The heart's LLM call is the single highest-frequency LLM call in the system, and it
fails often. Measured from the log: **1,867 `heart LLM failed` events against 7,443
heart decisions — 25%.** The causes: 64% `All labels exhausted` (the whole fallback
chain dead), the rest timeouts, rate limits, and content rejections.

Every one of those used to end in `pass` — the message was **dropped permanently**.
For an unaddressed group message that is fine. For a message that directly asked the
bot something it is not: someone @'d it, the infrastructure fell over, and the
question evaporated. That is the same principle as "ignoring a direct question is a
different failure" — only here the failing party is the wire, not the model.

So `HEART_LLM_FAIL_KEEP_ADDRESSED` (default on) adds a deterministic pre-gate on that
path: when the LLM cannot decide, a message that **is** addressed to the bot becomes
`wait` (re-evaluated shortly, via the existing wait-anchor machinery) instead of
`pass`. Unaddressed messages still `pass`, so an outage does not queue the whole
group's chatter for retry.

Addressing is detected the same way `precheck.ts` detects its complement: reply-to-bot,
`@username`, or a nickname. It never guesses — an empty message is not addressed.

### Sleep, schedule, and holidays

The bot has a body clock, and it was already running before this round — verified, not
assumed: `xxb:sleep:laststate = asleep`, `xxb:sleep:greeted:<chat>:goodnight:<date>` keys
for 09-19 and 09-20, and the sleep-cycle cron ticking. Festival awareness is a lookup in
`src/shared/beijing-time.ts` (solar festivals + lunar festivals + solar terms, data through
2027) that lands in the prompt through `formatBeijingNowLine()`, so the bot knows it is 七夕
without being told.

What was missing was the *schedule* half. `school_overrides` — the table that says "today is
a holiday" or "this Saturday is a makeup school day" — had **zero rows** since it was created,
while `SCHOOL_SCHEDULE_ENABLED=true`. That does not degrade to "no holiday awareness"; it
degrades the other way:

- 2026-10-01…10-07 (National Day, 7 days) — 10/1 Thu, 10/2 Fri, 10/5 Mon, 10/6 Tue, 10/7 Wed
  are all ordinary weekdays, so the bot played a high-school timetable *through the holiday*
- 2026-10-10 (Saturday, a makeup workday) was treated as a free weekend

`migrations/0114_seed_2026_holidays.sql` registers all seven 2026 holiday blocks and all six
makeup days from the State Council notice (国办发明电〔2025〕7号, published 2025-11-04, on
gov.cn) — 33 holiday rows + 6 makeup rows, `INSERT OR IGNORE` so it is idempotent and a
re-run adds nothing. Chinese holiday shuffling cannot be derived algorithmically, which is
why the data lives in a migration with its source URL rather than in code.

One honest caveat, recorded in the migration itself: the notice says "work on 10/10" but not
*which weekday's classes* that day makes up. `makeup_dow` is filled with the widely reported
interpretation (9/20 and 10/10 make up 10/6–10/7, i.e. Tue/Wed) and `1` elsewhere as a
truthy placeholder — it only selects the day's subject list, never the holiday/weekend
decision. 2027's arrangement needs its own migration once the notice is out.

### Running the Phase 1 experiment

Everything about it is pre-registered in the paper — criteria (§九·补三), sample size
(§九·补七/B: σ 23–26% ⇒ 5–13 days per arm), control group, and falsifiers. The runbook
fixes the *order* so the flip day needs no improvised decisions:

```bash
bash scripts/phase1-runbook.sh pre      # gates: baseline ≥5 days, envelope enforce, no bypass in flight
                                       # + records the pre-flip reading you will compare against
bash scripts/phase1-runbook.sh grant    # timed bypass, 180 min, TTL restores by itself
bash scripts/phase1-runbook.sh read     # experiment chat / whole-group curve / debt hit rate
bash scripts/phase1-runbook.sh verdict  # prints the pre-registered criteria next to the readings
```

`pre` refuses to proceed when the baseline is short, because a single day's reading against
σ≈23% is unattributable — the experiment chat has been observed at 19%, 28%, 59% and 71% on
different days of the same slot.

---

### Verifying the composition, not just the parts

Every silent failure found while building this layer had the same shape: **each piece passed
its own unit test and the composition was wrong.**

```
npx tsx scripts/verify-integration.mts     # 9 checks, exit 0 on success
```

It exercises the joins rather than the units — StepFun search through the production path,
anti-ad authorise → measure → render → de-authorise (proving an unauthorised group pays
nothing), the three self-registered body signals, and the kick gate's four guards plus its
shared authorisation with anti-ad.

Run it after touching `src/nyatos/` or `src/subagent/host-api.ts`. The unit suite being
green (414 files) has never implied these nine hold; that gap is exactly what this closes.

---

### Pairing with the verification bot (`nmnmfunbot`)

This ecosystem's groups run a join-verification bot (2,363 messages across 8 groups). The
gap was not that it was unclassified — it was that **classification only ran inside
`processPipeline`**, and the production main path (`META_SUBAGENT_ENABLED`) diverts to the
heart-adapter *without entering the queue or `processPipeline`*. So on the main path
`botClass` was never computed, denoise never applied, and the verification bot's prompts
received heart verdicts and replies — six of them, including after denoise was already
enabled and logging 930 events.

The Meta path now classifies before the heart and honours `BOT_DENOISE_ENABLED` for
`verify` / `ad` / `echo`. No new rule was added: the host already computed that fact, the
main path just was not asking for it.

**Two things the pairing actually buys you.** First, join screening: `nmnmfunbot`'s
"X has passed the group verification." line carries the new member's *unmasked* name, so the
Frame reports three account facts per joiner — no profile photo, name shape, and "we have
never seen this uid before" as a proxy for a fresh account (the Bot API does not expose
registration date, and the comment says so). Facts only; whether it is a black-industry
account is the model's call, and airport/proxy sellers are explicitly out of scope per the
owner. Second, the buttons on its messages — which the bot cannot press, but can work around;
see [the second card](#the-second-card-letting-another-bot-do-the-punishing).

---

## 🛡️ Anti-ad: how a group owner turns it on

Anti-ad is **off everywhere by default** and is never a content filter. It measures four
behavioural signals per `(chat, sender)` — burst, echo, repeat, cross-chat spread — and
reports them as facts. The model decides whether to delete, mute, or ask you; the host
never acts on its own.

**Per-group, three equivalent ways:**

```bash
# 1. 群主自助（推荐）—— 在群里直接跟 bot 说"开反广告"
#    bot 用 getChatMember 校验**发起人**真的是本群管理员/群主，fail-closed：
#    权限读失败按非管理员处理。非管理员会拿到 admin_not_group_admin。
#    对应工具 admin.setAntiAd(开/关, {minutes?, requesterUid})

# 2. .env graylist (persistent, comma-separated chatIds)
ANTIAD_ENABLED=true
ANTIAD_CHAT_IDS=-1002750574953,-1003184176508

# 3. runtime, this group only, with a TTL (hours) — no restart needed
redis-cli -n 5 set xxb:trench:antiad:-1002750574953 "$(date +%s)" EX 21600

# turn it back off
redis-cli -n 5 del xxb:trench:antiad:-1002750574953
```

Without one of those the module is inert: no measurement, no Frame line, no cost.

**What the model sees** (a fact, not an instruction):

```
[噪声] 8560347478 在刷屏：8 条/5分钟，0 人接，4 条重复。管不管、怎么管，你定。
[入群] xK9mQ2pLwR7v：没有头像｜名字：12 字符，纯字母数字无空格，长串字母数字混合｜
      我们第一次见到它（12 秒前）。是不是黑产广告号，你判；机场/代理那类不用管。
[授权] 本群群主已开反广告，你可用的手段：admin.kick(uid) 把号请出群（不可逆）；
      bots.command 回复那条消息发 /spam@nmnmfunbot（举报群内违规用户并触发封禁）。
```

Three lines, three different jobs: what the behaviour is, who just arrived, and what you are
allowed to do about it. The third one only appears when the owner granted anti-ad.

**What it deliberately does not do:** match keywords. In this ecosystem's corpus the
classic human-ad signals were *zero* (phone numbers, crypto, porn links, QQ groups) while
the actual noise was other bots — parser errors, network-test progress bars, game bots.
Those are behavioural, so that is what gets measured.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
