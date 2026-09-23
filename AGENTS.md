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
- ⚠️ **Use the service's Node when running tests**: the systemd unit runs `/opt/node22/bin/node` (v22.22.2) — check with `systemctl show xxb-ts -p ExecStart`. `better-sqlite3`'s prebuilt binary only loads under the v22 ABI, so any other Node breaks the suite with `Module did not self-register` (wrong Node → **113 files / 808 tests** fail spuriously). Prefix with `export PATH=/opt/node22/bin:$PATH`.
  - **Do not use `/root/.hermes/node/bin/node`**: that path was correct historically but is now **v26.8.2**, and it is the reason this warning kept getting re-learned. Always verify against the systemd unit rather than trusting a path written in docs.

## Non-obvious conventions (these bite)

- **Everything new is `env`-flag-gated, default OFF, and graylisted per chat.** Flags live in **`src/env-sections/*.ts`** (a zod schema split by subsystem; `src/env.ts` only composes them with spread). Read via the cached `env()` getter, **never `process.env` directly**. Graylists are comma-separated `chatId` → `number[]` (see `TURN_ACTOR_CHAT_IDS`). Cheap-LLM work routes via a `*_USAGE: z.string().default('summarize'|'judge')` flag. `.env` is gitignored and secret — **never commit it**.
  - The 12 sections: `infra` `memory` `timing` `judge` `cognition` `core` `self` `turn` `meta` `features` `social` `life`. Shared `booleanFromEnv` lives in `src/env-sections/_shared.ts` (one copy, not twelve).
  - Directory is `env-sections/`, **not** `env/sections/` — `src/env.ts` is a file, and a same-named directory makes relative imports resolve to the wrong place.
  - `tests/unit/env/schema-sections.test.ts` pins the key set (**488** as of 2026-09-21; the
    number moves as flags are added/retired — re-count, don't guess), plus no losses and no
    cross-section duplicates, and that every section file is actually imported **and**
    spread. Adding a file without wiring it makes that whole section silently vanish — the
    test catches it.
  - Split was done by `scripts/split-env-schema.py`; it asserts the line ranges tile the schema exactly before writing anything.
- **`chatId` sign discriminates DM vs group**: `> 0` = DM/private, `< 0` = group. Use `isDM`/`isGroup` from `src/shared/chat.ts`.
- **Migrations**: add a new `migrations/NNNN_name.sql` (4-digit, next after the highest — currently `0114`). Applied automatically on boot in **lexicographic filename order** (`src/db/sqlite.ts:runMigrations`), tracked in `_migrations`. Pure SQL, idempotent (`IF NOT EXISTS`/`ADD COLUMN`). **Never edit an already-applied migration.**
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

## Reading the production effect of a change

`npx tsx scripts/session-report.mts [days]` prints one table covering the things this
project changed most recently: send volume and per-task send distribution, heart health
(failure rate, `All labels exhausted`, empty responses, truncation retries, the
keep-addressed gate), the Meta/legacy split, and the ASI rubric's measured-vs-NULL ratio.

It also finds the **last `Bot started (polling)`** and reports a separate "after deploy"
column, because every change here takes effect on restart and a mixed window hides the
effect.

Section **2d** pulls `http://127.0.0.1:3001/metrics` for `llm_requests_total` split by
outcome — that is the denominator the log cannot give you. `Label failed, trying next`
firing 3,499 times a day means nothing on its own; against a total it becomes a rate. The
counters are in-process, so they reset on restart and measure exactly the after-deploy
window. Note the two rates answer different questions: this one is per *attempt* (one
`callWithFallback` may try several hops), the heart rate in section 2 is per *outcome*
(did we get a result at all). When the bot is asleep the after-deploy column is empty — the script says so
rather than printing 0, because "no data" and "effect is zero" are different things and
confusing them is the mistake this repo keeps making.

The per-task send distribution is the real frequency metric: before the send-budget fix,
79 tasks sent more than 6 messages (worst case 12 in 46 seconds). That tail should be
zero after it.

Section **2c, cron 产出率**, exists because of a run of six bugs found the same way: a cron
that ran for days at 0–13% yield while logging nothing that looked like a failure. The
method that found them was one question asked of every warning line — *how many times a
day does this fire, and is what it eats reasonable?* — so it is now a table instead of a
habit. Rows pair a failure message with its success message; the threshold for ⚠️ is
≥20 attempts under 50% yield.

Three rules when adding a row:
- If the success path writes **no** log line, pass `null` and report the failure count
  alone. Pairing it with an unrelated success message produces a fake ratio, and a fake
  ratio is worse than none.
- Keep the pair in one place. The failure and success strings drift apart when someone
  rewords a log line, and then the row silently reads 0/0.
- **The counted exits must cover every exit.** `post-task follow-up` paired "judge failed"
  with "continuation dispatched" and reported 10.7% yield — fake. The third exit, "judged
  and decided not to follow up", is the common case and logged nothing, so the failure rate
  looked ~10× worse than reality. That exit now logs (at `info` — a `debug` line is
  invisible at `LOG_LEVEL=info`, which puts the hole straight back), and the row reports
  all three counts.

## Measuring how much of the old architecture is left

`npx tsx scripts/arch-split.mts [days]` prints the Meta-vs-legacy split from the log:
inbound messages, legacy `Pipeline complete` exits broken down by reason, and Meta events
by class. The number that matters is the **legacy reply engine** line — how many messages
traversed `judge→gate→reply` and produced an exit. It was 16/9,380 (0.17%) on 2026-09-21 — 205 of the 221 legacy exits are bot denoise, which is what legacy is still legitimately for.

Two things to know when reading it:
- Meta and legacy are **not strictly complementary** — commands hand off Meta→legacy and
  leave traces on both sides, so the Meta figure means "passed through the Meta layer".
- Legacy's remaining work is command dispatch, bot denoise, and delegation receipts. Do
  not "finish the replacement" by routing bot messages to the Meta path without first
  unifying the two denoise criteria — legacy's L0 IGNOREs non-conversational bots at zero
  cost while the Meta classifier only denoises ad/verify/echo, so the rest would start
  burning heart calls. That is the "verify bot got 6 replies" bug.

## Before you commit

- Run `export PATH=/opt/node22/bin:$PATH && npm run typecheck && npm run lint && npm run test` — all must be **completely** clean; there are no known-noise exceptions.
- New feature → new `env` flag (default OFF) + graylist; new schema → new `migrations/00NN_*.sql` (idempotent, never edit old ones); new cron task → wrap in `safeRun`, flag-gate it.
- Match surrounding code: comment density, naming, ESM `import type` discipline, no `process.env` reads outside `env.ts`.

## Adding a feature — the path that actually works

Four gates stand between "I wrote it" and "it runs". Each exists because a previous
change passed the other three and still did nothing:

| gate | what it catches | command |
|---|---|---|
| typecheck | wrong import path, wrong shape | `npm run typecheck` |
| unit tests | the logic is wrong | `npm run test` |
| **dead-switch guard** | **the flag nobody reads** — `tests/unit/env/no-dead-switches.test.ts` fails if a flag is ON (in `.env` or by default) with zero readers in `src/`+`scripts/`+`packages/` | `npx vitest run tests/unit/env/no-dead-switches.test.ts` |
| **deploy verification** | **the change isn't in the bundle** — `scripts/verify-deploy.mts` greps `dist/index.js` for each mechanism (handles esbuild quote normalisation and `\uXXXX` CJK escaping) | `npx tsx scripts/verify-deploy.mts` |
| **integration smoke** | **green alone, broken composed** — `scripts/verify-integration.mts` exercises real compositions (search, anti-ad authorise→measure→render→deauthorise, kick gates, body-signal self-registration, plus behaviour checks that *call* the newest mechanisms) | `npx tsx scripts/verify-integration.mts` |

**A grep guard proves the string, not the logic.** `verify-deploy.mts` greps
`dist/index.js`, so it can only show that an identifier survived bundling. When a
mechanism is importable, add a check to `verify-integration.mts` that *calls* it and
asserts on the return value — that block exists precisely because a grep-style test kept
passing after `if (true) break;` was inserted into the very branch it claimed to cover.
When you add such a check, verify it by breaking the mechanism and watching it fail; and
run that from a script with `PATH=/opt/node22/bin` prepended, or the child process gets
Node 26, crashes on `better-sqlite3` before reaching your check, and reports exit 1 with
no ✗ lines — which reads exactly like "no failures found".

The last three are the ones people skip. History in this repo: `canSpeakActively()` had
exactly one reference — its own definition; `releasePressure` (the L0 integrator's main
drain) was never called; the join-screen's `extractJoinerName` was imported from the wrong
module so it threw on every call and was swallowed by a `catch`, while typecheck was red
and 3,227 tests were green.

**Checklist for a new flag-gated feature:**

1. **`src/env-sections/<subsystem>.ts`** — add the flag to the section it belongs to, with a
   comment saying *why it defaults where it does*. (If it needs a new subsystem, add a section
   file, import it in `src/env.ts`, spread it, and bump the key count in
   `tests/unit/env/schema-sections.test.ts` after re-counting.)
   If it defaults ON, the dead-switch guard will require a reader before you can commit.
2. Wire it at the **production** path, not just the obvious one. The Meta path
   (`META_SUBAGENT_ENABLED`) bypasses `processPipeline` entirely — anything added only to
   `pipeline.ts` never runs in production.
3. `migrations/NNNN_*.sql` for schema (idempotent; never edit an applied one).
4. `tests/unit/…` mirroring `src/`, **plus a regression test that fails when the wiring is
   removed** — verify it by temporarily reverting the wiring.
5. Add a line to `scripts/verify-deploy.mts`'s `CHECKS` so the mechanism is pinned in the
   bundle.
6. Update `docs/flag-census.md` by re-running `python3 scripts/flag-census.py` (it lists
   every flag, its default, its `.env` value, and its readers).

**Retiring a flag:** delete it from its `src/env-sections/<subsystem>.ts` and `.env`, leave a
comment in place of it saying why (so nobody re-adds it), and note it in the census's 已退役
section. Then re-run the census and bump the key count in `schema-sections.test.ts`. If a flag
must exist before its wiring lands, add it to `ALLOWLIST` in the dead-switch test *with a
reason* — that is an IOU, not an exemption.

## Editing files: write real newlines, never `\n` escapes

Multi-line insertions via python `"...\n..."` string literals land as **literal backslash-n**
in the file, and esbuild then fails with `Syntax error "n"` (round 118, and the same
family cost this session five rounds: `\uXXXX` for Chinese in round 42/63/67, `\\n` here).

Rules:

- Multi-line text: use the `write` tool, `printf`, or a heredoc with real newlines.
- Chinese into docs/README: write it directly. Never `\uXXXX` escapes — they mangle
  ("傲慢"→"僵慢") and the mangling survives sed.
- If a tool call needs a multi-line block, build it as a **list joined with `"\n"`**
  (`"\n".join([...])`), or append line by line — not as one escaped literal.

A syntax error from this is loud, which is the good case. The bad case is the one that
*silently* writes the wrong character — that only shows up when someone reads the file.

## Cross-checking two numbers: confirm they should be equal first

"两个数不相等 → 有 bug" 是这个会话最有效的发现手段（round 114 react 量具、
round 116 的 254 次失败、round 131 的闸、round 132 的双签都是这么挖出来的）。
但它空转过两次，原因都一样：

| 轮 | 我对的两个数 | 为什么不该相等 |
|---|---|---|
| 134 | `decision:reply` vs `host sendText` | sendText 是**所有**发送的公共出口（命令/代发/主动发言全走它） |
| 135 | 账本戳数 vs 带锚发送数 | 一个发送会标多个锚点（`firstReplyTo` + `defaultReplyTo` + `relatedQuoteIds`） |

Before comparing, answer one question: **是什么机制保证这两个数相等？**
答不上来就不是不变量，别把它当 bug 报。

三次真发现都答得上：`decision:pass` 与 `meta:pass`（同一次决策两条日志）、
react 决策与真发（同一次调用）、闸日志与我看到的发送（闸自己的日志更全）。

Also check units: the log's `time` is **milliseconds**, the answered bookkeeping is
**seconds**. Comparing them silently passes everything (round 135 lost ten minutes to this).
