# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NyatBot (`nyat-bot`) — a Telegram AI 群聊喵娘 bot. TypeScript, Node ≥22, ESM. grammY (bot) · BullMQ + Redis (queue/state) · better-sqlite3 (structured) · Qdrant (vectors) · Vercel AI SDK + native fetch (LLMs).

## Commands

- Build: `npm run build` (tsup → `dist/index.js`). Typecheck only: `npm run typecheck` (`tsc --noEmit`).
- Test: `npm run test` (`vitest run`). Watch: `npm run test:watch`. Single file: `npx vitest run tests/unit/xxx.test.ts`. By name: `npx vitest run -t "部分名字"`.
- Lint: `npm run lint` (`eslint src/`). Format: `npm run format` (prettier).
- Dev: `npm run dev` (`tsx watch src/index.ts`). Prod is a systemd service: `sudo systemctl restart xxb-ts` (runs `node dist/index.js`; logs to `logs/app.log` as JSON lines — `tail -c … logs/app.log | python3 -c '…json.loads…'` to inspect, not `journalctl`).

Baseline: the vitest suite is **fully green**; any failure is a real regression. `tsc --noEmit` has two known pre-existing unused-var warnings (`message.ts:57`, `prompt-builder.ts:169`) — filter those out, treat anything else as new.

## Non-obvious conventions

- **Everything new is `env` flag-gated, default OFF, and graylisted per chat.** Flags live in `src/env.ts` (a zod schema; read via the cached `env()` getter, never `process.env` directly). Graylist lists are comma-separated `chatId` → `number[]` (see `TURN_ACTOR_CHAT_IDS`). Cheap-LLM work routes via a `*_USAGE: z.string().default('summarize'|'judge')` flag. Secrets are in `.env` (gitignored — never commit it).
- **chatId sign is the DM/group discriminator**: `chatId > 0` = DM/private, `chatId < 0` = group. Use `isDM`/`isGroup` from `src/shared/chat.ts` in new code.
- **Migrations**: drop a new `migrations/NNNN_name.sql` (4-digit, next after the highest — currently 0049). Applied automatically on boot in **lexicographic filename order** (`src/db/sqlite.ts:runMigrations`), tracked in `_migrations`. Pure SQL, idempotent (`IF NOT EXISTS`/`ADD COLUMN`). Never edit an already-applied migration.
- **`src/memory/chroma.ts` is Qdrant, not ChromaDB** (renamed after migration; collection `xxb_group_history`, 384-dim local `@xenova/transformers` embeddings, no external embedding API). `src/memory/importance.ts` is the SQLite sidecar.
- **AI routing**: `callWithFallback({ usage, messages, … })` in `src/ai/fallback.ts` resolves `usage` → a provider chain (`AI_USAGE_<NAME>_LABEL`/`_BACKUPS` in `.env`, defaults in `src/ai/labels.ts`). Providers are `AI_PROVIDER_<NAME>_*` env vars (ENDPOINT/KEY/MODEL/FORMAT/REASONING/THINKING/TIMEOUT/MAX_TOKENS/INSECURE), parsed by `getProviders()` in `env.ts`. Two API formats: OpenAI (default, `/chat/completions` + `Bearer`) and Claude-native (`FORMAT=claude` → `/v1/messages` + `x-api-key`, see `src/ai/provider.ts`). Redis key `xxb:admin:model_routing:override` overrides `.env` at runtime.
  - **Current reply chain** (2026-07): `reply` = **grok-4.5** (label `grok45`, OpenAI-format aggregator, `REASONING=low`) → `scnet` (SCNET 超算 DeepSeek-V4-Flash, Claude-format) → `sub2gpt55` → `stepfun`. `reply_pro` (hard/tool replies) = `grok45med` (grok reasoning=medium). `judge`/`heart` decision layer stays on **stepfun/stepfunjudge** (deliberately — cheap gate); `heart` has an optional post-decision **念头 reflection** (`HEART_REFLECT_ENABLED`, usage `heart_reflect` on a fast model). Provider-authenticity is a live concern: verify with behavioral fingerprints (China-sensitivity, system-prompt leak), not self-report — see the `xxb-reply-model-grok` memory.
- **Docs are the source of truth for the big subsystems** — read `docs/` before touching them: `timing-gate-maibot-deep-dive.md`, `turn-actor/`, `maibot-framework-gap-analysis.md`, `dm-group-memory-cybergroupmate-plan.md`.

## Architecture (the big picture)

**Ingress → queue → pipeline.** `src/index.ts` wires it: ingress (polling by default, auto webhook-failover via `src/ingress/failover.ts`, controlled by Redis key `xxb:ingress:mode`) → BullMQ jobs → `src/queue/worker.ts` dispatches by `job.data.type` (`message` / `chat_turn` / `wait_resume` / `defer_resume`) → `processPipeline` (`src/pipeline/pipeline.ts`).

**The decision pipeline** (`pipeline.ts`, per message): format → bookkeeping (context save, memory write, activity/profile tracking) → **judge** → gate → **retriever** → **reply** → send. Judge decides *whether* to reply via three tiers: **L0 rules** (`src/pipeline/judge/rules.ts`, deterministic, 0ms) → L1 mini-AI → L2 full-AI. Reply orchestration is `src/pipeline/reply/reply.ts`; the 5-layer system prompt is assembled in `src/pipeline/reply/prompt-builder.ts`.

**Two operating modes, both flag-gated, that wrap the pipeline:**
- **Turn Actor** (`src/pipeline/turn/`, `TURN_ACTOR_ENABLED`) — MaiBot-style per-chat cognition loop. Messages go into a Redis pending buffer (`buffer.ts`) instead of one-job-per-message; a single scheduled "turn" (`queue/turn-scheduler.ts` + `actor.ts`) drains the burst, treats it as one thought, handles interrupt→replan (new message aborts in-flight generation), multi-anchor (reply to several people), and wait-resume. `turnContext` (in-process, on `ChatJob`, never serialized) carries per-turn signals: `signal`, `epoch`, `isWaitReplay`, `isDeferReplay`, `gateBypass`, etc.
- **Heart** (`src/pipeline/heart/`, `HEART_ENABLED`) — replaces judge+gate for L0-miss group messages with **one** persona-aware "心流" call returning reply/wait/pass. In production this is the main path (so timing/gate changes must be wired into the heart branch in `pipeline.ts`, not just the standalone gate).

**Timing gate** (`src/pipeline/timing/`) — rhythm control aligned with MaiBot: `gate.ts` (continue/wait/no_action), `chat-runtime.ts` + `state-store.ts` (per-chat RUNNING/WAIT/STOP state machine in Redis), `defer.ts` (cooldown/threshold → re-evaluate later without dropping the message, via a `defer_resume` BullMQ job carrying the entry as its sole copy — must be idempotent), `talk-value.ts` (deterministic message-count threshold before the LLM gate), continuation window (skip the gate while actively in conversation). All default-off `TIMING_*`/`TURN_*` flags.

**Memory & person model** — long-term memory is Qdrant (per-chat isolated by default: `searchMemory` filters by `chatId`). The **person model has two layers**: per-`(chat_id, uid)` profiles (`user_profiles`, `chat_relationships` in `src/tracking/`) and a **global** per-`uid` `person_identity` (`src/tracking/person-identity.ts`). Cross-DM/group connectedness (`docs/dm-group-memory-*.md`) is gated by a **privacy `visibility` layer** (`src/memory/visibility.ts`): every memory carries `visibility` (`private`/`contextual`/`public`) + `sourceChatId`; DM defaults to private; cross-context reads (`searchMemoryByUser`, cross-context injection) are scrubbed so DM/sensitive content never leaks across chats. `src/pipeline/context/manager.ts` holds Redis context lists (`xxb:ctx:{chatId}`) + reverse indexes (`getUserGroups` = groups only for dm-relay; `getUserContexts` = groups ∪ DM).

**Cron** (`src/cron/scheduler.ts`) — ~25 `node-cron` jobs, each wrapped in `safeRun` (timeout + in-flight dedup + logging; don't add your own try/catch). Flag-gated jobs follow the `if (env().X_ENABLED) tasks.push(schedule(...))` pattern.

**Data layer**: SQLite via `getDb()` (`src/db/sqlite.ts`, WAL, single connection); Redis via `getRedis()` (`src/db/redis.ts`) — context, pending buffers, timing state, rate/dedup.

## Testing conventions

Vitest, `globals: true`, tests mirror `src/` under `tests/unit/`. No redis-mock library — hand-mock `getRedis()` with an object of `vi.fn()`s (see `tests/unit/cron/proactive-scan.test.ts`). For SQLite, `new Database(':memory:')`, load the **real** migration file(s) into it, and `vi.mock` `../../../src/db/sqlite.js`'s `getDb` (see `tests/unit/memory/importance.test.ts`, `tests/unit/tracking/*.test.ts`). Mock `env()` as a plain object to toggle flags per test. Mock `callWithFallback` to return `{ content: '…json…' }` for LLM-dependent code.
