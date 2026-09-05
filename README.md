<div align="center">

# 🐱 NyatBot

**A Telegram group-chat agent on the path from chatLLM to AGI.**

Not a bot that responds when poked — an agent that hangs out, reads the room, and only speaks when it has something worth saying.

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

**Being a group member**
- 🗣️ **Addressee & floor awareness** — explicit (mention/reply/quote) + implicit scoring for *who* is being talked to; thread disentangling; never interrupts a 1-on-1 streak
- 💬 **Natural pickup** — stays present after speaking: follows up questions/statements from either side without needing @ or quote; holds back in hot chats
- 🗣️ **Natural-language commands** — "check me in" → checkin, "show my album" → cards, "track bitcoin" → watch goal (lenient in DM, requires addressing in groups)
- 💬 **Multi-target replies** — one trigger can answer several people (JSON array), each quoting its own target
- ✍️ **Humanizer V2** — typo injection + silent edit correction, read delays, ack prefixes, delete-and-resend, sticker-only short replies, thinking interjections, afterthought edits, typing alignment, jitter, smart segmentation
- 😻 **Reactions, polls, forwards** — lightweight `setMessageReaction` acknowledgments (hard-capped per chat/day), polls as initiative carriers, taste-scored cross-group forwarding (see Taste below)
- 👥 **Social state** — member roster, per-chat mood, decaying per-user affinity, reputation, behavioral roles, social graph between members ("A and B interact a lot"), reply-outcome tracking

**Taste & curiosity (H3/H4)**
- 👅 **Taste scoring** — deterministic 0ms scoring of "worth forwarding" (funny / useful / resonant); LLM only *chooses* among candidates, never judges taste; 7-day cross-group dedup, ≤2 per chat
- 🎰 **Topic bandit** — ε-greedy topic recommendation driven by reaction reward (👍❤️😂 positive / 👎💩 negative / quoted follow-ups strongly positive); deterministic, no LLM on the hot path
- 🔭 **Proactive life** — RSS topics, missed-thread pickup, newcomer welcomes, dream journal (`data/dream-journal/`), nightly dreaming over the day's events, holiday/solar-term + weather awareness, school-day schedule driving chattiness

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
| H4 curiosity | Topic bandit + reaction reward reflux, spot-the-bot harness | #61 |
| H4.1/H4.2 hardening | Usage-level `jsonMode` defaults (kill dirty-JSON parse failures at the root), taste 0.5 recalibrated on 194-message replay | #62–#64 |

Next: reaction samples still at zero — the bandit/taste closed loops are live but waiting for their first real-world rewards. Offline replay (`scripts/offline-backfill.ts`) bootstraps norms/exemplars from history without sending a single message.

### 📏 Evaluation

- **Spot-the-bot harness** (`src/eval/spot-the-bot.ts`) — bot + human samples shuffled, outside judges mark bot-or-not. Core metric: `P(judged human | bot)` with `P(judged bot | human)` as calibration; assists: quote/reaction rate, mean survival rounds.
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
├── queue/                # BullMQ queue
├── shared/               # types + logging (pino) + config
├── eval/                 # spot-the-bot harness
└── tracking/             # activity + mood + relations + reputation + ASI + outcomes
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

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
