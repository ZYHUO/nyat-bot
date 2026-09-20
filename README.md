<div align="center">

# 🐱 NyatBot

**A Telegram group-chat agent on the path from chatLLM to AGI.**

Not a bot that responds when poked — an agent that hangs out, reads the room, and only speaks when it has something worth saying.

**v1.0** — the preview line ends here. What shipped in it: the Nyat Trench body layer (pressure / envelope / reflex), behavioural anti-ad with group-owner opt-in, the Meta+Subagent main path with per-task send budgets, StepFun search as the primary web route, and `step-5-preview` in the smart-group provider pool. A full flag census lives in [`docs/flag-census.md`](docs/flag-census.md) — 498 env keys, 221 boolean flags, 191 live in production, plus the 9 dead switches and 4 test-only phantoms the audit turned up.

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
