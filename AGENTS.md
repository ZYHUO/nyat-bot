# AGENTS.md

Guidance for any AI coding agent working in this repository. Concise and tool-agnostic; for depth go to `CLAUDE.md` (Claude-specific notes) and `docs/` (subsystem design docs).

## What this is

NyatBot (`nyat-bot`) — a Telegram AI 群聊喵娘 bot: a humanlike reply engine running a per-chat cognition loop (Turn Actor / Heart), optional Meta+Subagent+CodeAct orchestration (`META_SUBAGENT_ENABLED`), long-term vector memory, person modeling, and a large feature surface (checkin, gacha, DM relay, stickers, learning, crons, dream-journal). TypeScript, Node ≥22, **ESM** (`"type": "module"`).

## Tech stack

- **Bot**: grammY · **Queue/state**: BullMQ + Redis · **Structured DB**: better-sqlite3 (WAL, single connection via `getDb()`) · **Vectors**: Qdrant (384-dim local `@xenova/transformers` embeddings, no external embedding API) · **LLM**: Vercel AI SDK + native `fetch`.
- **Monorepo**: npm workspaces — see [`docs/modules.md`](docs/modules.md). Packages: `@nyat/nyatdb` (`packages/nyatdb`), `@nyat/context-engine` (`packages/context-engine`); host adapters under `src/nyatdb/`, `src/context-engine/`.
- **Tooling**: `tsup` (build) · `tsx` (dev) · `vitest` (test) · `eslint` + `prettier` · `tsc --noEmit` (typecheck).
- `tsconfig.json` is `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` → **always use `import type` for type-only imports**, and mind possibly-undefined index access.

## Commands

```bash
npm run dev          # tsx watch src/index.ts
npm run build        # tsup → dist/index.js
npm run typecheck    # tsc --noEmit
npm run test         # vitest run (baseline is fully green — any failure is a real regression)
npm run test:watch
npx vitest run tests/unit/xxx.test.ts          # single file
npx vitest run -t "部分名字"                      # by test name
npm run lint         # eslint src/
npm run format       # prettier --write .
```

Production is a systemd service: `sudo systemctl restart xxb-ts` (runs `node dist/index.js`); logs are JSON lines in `logs/app.log`, **not** journalctl.

## Baseline & known noise

- Vitest suite is **fully green**. A failing test is a real regression — fix it, don't skip it.
- `tsc --noEmit` and `eslint` are **clean — zero warnings**. Anything they print is new. (This file used to claim one known `prompt-builder.ts:169` warning and CLAUDE.md claimed two; both were stale.)
- ⚠️ **Use the service's Node when running tests**: `/usr/local/bin/node` is v25, the service runs v22 (`/root/.hermes/node/bin/node`), and `better-sqlite3`'s prebuilt binary only loads under v22. Wrong Node → **226 spurious failures** (`Module did not self-register`). Prefix with `export PATH=/root/.hermes/node/bin:$PATH`.

## Non-obvious conventions (these bite)

- **Everything new is `env`-flag-gated, default OFF, and graylisted per chat.** Flags live in `src/env.ts` (a zod schema; read via the cached `env()` getter, **never `process.env` directly**). Graylists are comma-separated `chatId` → `number[]` (see `TURN_ACTOR_CHAT_IDS`). Cheap-LLM work routes via a `*_USAGE: z.string().default('summarize'|'judge')` flag. `.env` is gitignored and secret — **never commit it**.
- **`chatId` sign discriminates DM vs group**: `> 0` = DM/private, `< 0` = group. Use `isDM`/`isGroup` from `src/shared/chat.ts`.
- **Migrations**: add a new `migrations/NNNN_name.sql` (4-digit, next after the highest — currently `0049`). Applied automatically on boot in **lexicographic filename order** (`src/db/sqlite.ts:runMigrations`), tracked in `_migrations`. Pure SQL, idempotent (`IF NOT EXISTS`/`ADD COLUMN`). **Never edit an already-applied migration.**
- **`src/memory/chroma.ts` is Qdrant, not ChromaDB** (renamed after migration; collection `xxb_group_history`). `src/memory/importance.ts` is the SQLite sidecar.
- **AI routing**: `callWithFallback({ usage, messages, … })` in `src/ai/fallback.ts` resolves `usage` → a provider chain. The main reply model is **Claude via native `/v1/messages`** (`apiFormat: 'claude'`, `x-api-key`), **not** OpenAI format — see `src/ai/provider.ts`. Redis key `xxb:admin:model_routing:override` overrides `.env` at runtime.
- **Two pipeline wrappers, both flag-gated**: **Turn Actor** (`src/pipeline/turn/`, `TURN_ACTOR_ENABLED`) = MaiBot-style per-chat cognition (burst merge, interrupt→replan, wait-resume); **Heart** (`src/pipeline/heart/`, `HEART_ENABLED`) = one persona-aware call replacing judge+gate for L0-miss group messages. In production the **Heart branch is the main path** — timing/gate changes must be wired into the heart branch in `pipeline.ts`, not just the standalone gate.
- **`turnContext` is in-process only** (on `ChatJob`, never serialized to Redis/BullMQ).
- **Privacy `visibility` layer** (`src/memory/visibility.ts`): every memory carries `visibility` (`private`/`contextual`/`public`) + `sourceChatId`; DM defaults private; cross-context reads are scrubbed so DM/sensitive content never leaks across chats.
- **Cron**: `src/cron/scheduler.ts` wraps each job in `safeRun` (timeout + in-flight dedup + logging) — **don't add your own try/catch** around cron tasks. Flag-gated jobs follow `if (env().X_ENABLED) tasks.push(schedule(...))`.
- **Docs are source of truth for big subsystems** — read `docs/` before touching them: `meta-subagent/`, `timing-gate-maibot-deep-dive.md`, `turn-actor/`, `maibot-framework-gap-analysis.md`, `dm-group-memory-cybergroupmate-plan.md`.

## Architecture (big picture)

**Ingress → queue → pipeline.** `src/index.ts` wires it: ingress (polling by default, auto webhook-failover via `src/ingress/failover.ts`, controlled by Redis key `xxb:ingress:mode`) → BullMQ jobs → `src/queue/worker.ts` dispatches by `job.data.type` (`message` / `chat_turn` / `wait_resume` / `defer_resume`) → `processPipeline` (`src/pipeline/pipeline.ts`).

**Decision pipeline** (per message): format → bookkeeping (context save, memory write, activity/profile tracking) → **judge** → gate → **retriever** → **reply** → send. Judge tiers: **L0 rules** (`src/pipeline/judge/rules.ts`, deterministic, 0ms) → L1 mini-AI → L2 full-AI. Reply orchestration: `src/pipeline/reply/reply.ts`; the layered system prompt is assembled in `src/pipeline/reply/prompt-builder.ts`.

**Timing gate** (`src/pipeline/timing/`): `gate.ts` (continue/wait/no_action), `chat-runtime.ts` + `state-store.ts` (per-chat RUNNING/WAIT/STOP state machine in Redis), `defer.ts` (cooldown/threshold → re-evaluate later without dropping the message, via a `defer_resume` BullMQ job carrying the entry as its sole copy — **must be idempotent**), `talk-value.ts` (deterministic message-count threshold before the LLM gate). All default-off `TIMING_*`/`TURN_*` flags.

**Memory & person model**: long-term memory is Qdrant (per-chat isolated by default: `searchMemory` filters by `chatId`). Person model has two layers: per-`(chat_id, uid)` profiles (`user_profiles`, `chat_relationships` in `src/tracking/`) and a **global** per-`uid` `person_identity` (`src/tracking/person-identity.ts`). `src/pipeline/context/manager.ts` holds Redis context lists (`xxb:ctx:{chatId}`) + reverse indexes.

**Data layer**: SQLite via `getDb()` (`src/db/sqlite.ts`); Redis via `getRedis()` (`src/db/redis.ts`) — context, pending buffers, timing state, rate/dedup.

## Testing conventions

Vitest, `globals: true`, tests mirror `src/` under `tests/unit/`.

- **No redis-mock library** — hand-mock `getRedis()` with an object of `vi.fn()`s (see `tests/unit/cron/proactive-scan.test.ts`).
- **SQLite**: `new Database(':memory:')`, load the **real** migration file(s) into it, and `vi.mock` `../../../src/db/sqlite.js`'s `getDb` (see `tests/unit/memory/importance.test.ts`, `tests/unit/tracking/*.test.ts`).
- **`env()`**: mock as a plain object to toggle flags per test.
- **`callWithFallback`**: mock to return `{ content: '…json…' }` for LLM-dependent code.
- **Test-vs-production isolation is enforced, not optional**: under `VITEST`, `getRedis()` rewrites the URL to **db 0** and `getDb()` forces **`:memory:`** — `env.ts` loads the real `.env` via dotenv, so without this an unmocked dynamic import writes production (2026-08-21: a test fixture landed in the master's DM context and the bot repeated it as fact). **Mock the direct behavior module** (e.g. `weather.js`), not just its deps — `vi.mock(env.js)` does not reliably propagate through deep dynamic-import chains (observed: real env leaked through, a live fetch fired). If a test fails on `:memory:` "no such table", that test was secretly touching prod — mock it properly.
- A flaky pattern exists: the **first full `vitest run` right after editing src** occasionally reports one spurious failure that never reproduces on immediate rerun (suspected transform-cache timing). Rerun before believing it; three green runs = clean.

## Before you commit

- Run `export PATH=/root/.hermes/node/bin:$PATH && npm run typecheck && npm run lint && npm run test` — all must be **completely** clean; there are no known-noise exceptions.
- New feature → new `env` flag (default OFF) + graylist; new schema → new `migrations/00NN_*.sql` (idempotent, never edit old ones); new cron task → wrap in `safeRun`, flag-gate it.
- Match surrounding code: comment density, naming, ESM `import type` discipline, no `process.env` reads outside `env.ts`.
