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

- ⚠️ **`npx vitest run tests/unit/meta` (the directory alone) reports 2 false failures**
  — `bookkeeping-hooks.test.ts` ③ `bot 群消息 → 查代发回执` and ④
  `一个 hook 抛错不影响其他 hook`. They are **not a regression**: the same two files
  pass on the full suite (`npm run test` → 534 files / 4130 passed), and pass when run
  as individual files. Diagnosed round 92/93 by `git stash -u` (fails on clean HEAD too)
  and by running the full suite (green). The mock of `tryHandleDelegationReceipt` only
  takes effect when some *other* file has imported that module first. So verify meta
  changes with the full suite or a single file — never with the bare directory, or you
  will chase a regression that is not yours (the mistake this repo keeps making).

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

**A guard that greps for a *pattern* can match itself — one that reads an *artifact* cannot.**
When you write a grep-style guard, first ask whether the thing it searches contains the
guard's own source. Round 128 learned this the hard way: `no-unexplained-skip.test.ts`
has the strings `.skip(` and `it.todo(` in its own doc comment, so its first run went
red on *itself*. The fix is one line (`grep -v <own filename>`), but the reusable
distinction is deeper than "does the glob include tests/":

```
checks an artifact (AGENTS.md, dist/, docs/)  → the guard is not in the artifact → safe
checks a pattern   (code shapes under tests/)  → the guard has that pattern too  → self-exclude
```

So the default for any guard grepping `tests/` is **to exclude itself from the start** —
do not wait for the first red to discover it. And note the direction of the surprise:
a self-referential guard that *fires* is good news (it proves the guard runs), whereas
one you silently loosened until it passed green tells you nothing.

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

## Writing Chinese into files and commit messages

Three rules, each of which cost this session multiple rounds:

**1. Multi-line text: real newlines, never `\n` escapes.**
Python `"...\n..."` string literals land as **literal backslash-n** in the file, and
esbuild then fails with `Syntax error "n"` (round 118, and the same family cost this
session five rounds: `\uXXXX` for Chinese in round 42/63/67, `\\n` here).
If a tool call needs a multi-line block, build it as a **list joined with `"\n"`**
(`"\n".join([...])`), or use the `write`/`edit` tools — not one escaped literal.

**2. Chinese into docs/README: write it directly.** Never `\uXXXX` escapes — they mangle
("傲慢"→"僵慢") and the mangling survives sed (round 154/168/176; in round 175 a wrong
codepoint turned 吱 into 咚 and the prompt shipped it).
**Verify by reading it back** — the write action is not the proof.

**3. Commit messages with Chinese + backticks + braces: use `-F file`, never `-m`.**
`git commit -m "中文 + \`code\` + ${x} + {}"` breaks bash quoting (round 179, and many
times before). Write the message to a temp file and `git commit -F /tmp/msg.txt`.

Rule 2's corollary applies to all three: **after any non-trivial text write, read the
result back**. A syntax error is loud, which is the good case; the bad case is the one
that *silently* writes the wrong character — that only shows up when someone reads the
file (round 175's 咚 was in a production system prompt for one round).


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

### "No problem" conclusions need a second number

A measurement that leans **toward** a problem gets checked — something looks wrong, so
you look. A measurement that leans toward *fine* does not: there is nothing to trigger
the second look, so a wrong "0" goes straight into the conclusion.

Round 185 froze the 09-22 baseline and the first instrument read `All labels
exhausted = 0` (it looked in `d.msg`; the value lives in `d.err.message`). Real value:
598. That is a 598x error in the *reassuring* direction, and it was only caught because
an older count (1656) happened to be in the log to contradict it. Without that
coincidence the round would have concluded "09-22 was fine".

**Rule: before writing "X is healthy / unchanged / not a problem", find one independent
number that says the same thing.** A trend, a prior day, a counter — anything measured a
different way. If you cannot find one, say the number is unverified rather than fine.

### Same rule, sharper: the second number must share the denominator

Finding a second number is not enough on its own — a second number measured over a
**different window or against a different denominator** is not a second opinion, it is a
different measurement, and comparing them produces a fake trend.

Round 193: a doc said "33% swallowed by the gate → now 4%". Both numbers were real.
The 33% was 468/1421 over a *conservative window* (bot awake, and addressed only); the
"4%" came from a full-log ink that reported an absolute count with no rate. The two were
never the same ratio. Recomputing with the denominator written out gave 1190/48640 inbound
= 2.4%, or 9.7% against Heart decisions. Three numbers, three windows.

The same session had "shadow decision: 1654, today 259" where the three figures came from
three different windows (all log / 3 days / current window) and were being read as a trend.

**So the rule has two halves:**
1. find a second number, **and**
2. state the window and denominator of both. If they differ, they do not corroborate —
   say so, or recompute one of them to match.

A number without its denominator is not a finding. It is a shape that looks like one.

### And if you *know* the evidence is incomplete, do not ship the number anyway

Round 133 computed "3 of 23 guards have ever caught something" from **one** document
(`voice-tuning.md`) and shipped it — while explicitly noting in the same round that
commits and test output were also evidence. Round 134 redid it across four sources:
**9 of 16**. The first pass had missed the guard that caught this session's worst
incident (`no-tamper-leftovers`, round 66) purely because the log described it in
prose without naming the file.

The conclusion survived by luck — 3 and 9 point the same direction. But the *process*
was wrong, and had the true number been 0 the same reasoning would have produced the
opposite conclusion, backed by a statistic that looked rigorous.

**Rule: a number computed on a subset you already named is not a finding — it is a
hypothesis with a decimal point.** Either widen the evidence in the same round, or
write "3 of 16 *in voice-tuning only*; commits/known-issues not yet searched" and
leave it at that. The second is smaller and true; the first is bigger and false.

This is round 194's rule (a second number must share the denominator) in its third
form: the number can be right, the denominator can be right, and the **coverage** can
still be wrong.


### Do not extrapolate a number you did not read

Round 38 caught itself writing "deploy check 101/107" in a commit message when the
actual counts were 87 and 41. Those commands had timed out under the 60s harness cap,
so `tail -1` returned nothing, and the number was extrapolated from "last round plus what
I added". **It was never observed.**

This is the same failure as every stale number in `docs/` — but worse in one direction:
a stale number was once true, an extrapolated one never was. The count also went *up*
each round, which is what an extrapolation does when you keep adding checks.

**Rule: if a command times out or produces no readable output, write "unverified" — do
not carry forward.** A gate that could not be read is not a gate that passed.

Corollary that would have caught it: **the gate output is part of the evidence, so paste
the line you actually saw** rather than the number you expected. If the line is not
there, neither is the evidence.



## Docs: never wrap a path-shaped example in backticks

`tests/unit/docs/doc-references-exist.test.ts` extracts every `` `something.ext` `` from
the docs and asserts the file exists. It cannot tell "an example of a bad path" from
"a real reference" — and it should not have to. So this is a rule for the doc author, not
a thing to fix in the test.

**This guard caught me five times in one day** (round 37-39, 146, 150, 151, 153). Twice
the cause was writing `AGENTS.md` / `README.md` — repo-root files, which
`referenceExists` did not list until round 151. The rest were deliberate bad examples
(`src/does/not-exist-xyz.ts`, `skills-MISSING.md`) that I put in backticks while writing
up *how the guard works*.
### A guard that reports "0 times" has never once meant "didn't happen"

Three separate times this session a guard's counter read 0 and the natural reading —
"the scenario never occurred" — was wrong:

| round | guard | what "0" actually meant |
|---|---|---|
| 191 | same-text dedup | the skip is logged at `debug`, and `LOG_LEVEL=info` — invisible (391 criterion hits, 190 real duplicates) |
| 196 | same-text dedup (doc) | the doc said "scenario hasn't appeared"; it had, 390+ times |
| 201 | delegation arg guard | the fallback condition (`/[\u4e00-\u9fa5\w]{2,}/` on recent human messages) is almost always true in a busy group, so the guard could never fire — 36 real candidates |

**Before trusting a zero, replay the guard's own criterion against the log and see
whether the scenario occurred.** If it did
and the counter is still 0, the guard — or its observability — is the bug, not the traffic.

**The zero now has four readings, and only the first is bad news:**

| reading | what it means | round |
|---|---|---|
| **invisible** | it fires but logs at `debug`, or the value lives in a field you did not read | 185/191 |
| **unreplayable** | the log exists but lacks the field the criterion needs | 194 |
| **no sample** | the guard needs N occurrences that have not happened yet — **ask how many it needs** | 141/142 |
| **fixed** | it stopped firing because the behaviour it guarded stopped recurring | 142 |

The fourth is the expensive one to miss: rounds 96→142 chased a "silent" guard across
three wrong hypotheses (leak, insufficient uptime, sample) before measuring that the
process had been alive 39 min with 59 sends — enough sample — and concluding the
guard was quiet **because it had worked**. Two thresholds got swapped along the way
(2h is the zombie sweep's, 6-sends is topic-word's), which is round 194's rule again:
two numbers both present, answering different questions.

The general shape: a guard has three faces, and fixing one leaves the other two:

| face | what breaks when it's wrong |
|---|---|
| **behaviour** | the guard blocks nothing (round 201: condition too wide to ever be false) |
| **observability** | the guard blocks things but you cannot tell (round 191: `debug` under `LOG_LEVEL=info`) |
| **every call site** | the fix lands on one of two copies (round 192/198: two `SECTION_ORDER`s; round 173: key written inside the shard loop) |

Round 200's addendum lists the four fixes that were each "half applied". The lesson is
not "be careful" — it is **name the three faces before calling a guard done**, and check
each one with a different instrument: replay the criterion (behaviour), grep the log at
the level it's actually written (observability), grep for a second copy (call sites).

### A guard that reads an archive you will legitimately update must not pin its numbers

**And a guard that reads a file you will legitimately edit must not pin that file's
numbers.** Round 148 built a guard asserting `known-issues.md` contains `1100`; round 154
edited the ledger for a good reason (cleaning escapes) and the guard went red. Round 112
had already taught "a guard pinning production counts will go stale" — this is the second
form of the same disease, and it is the one I had not seen: **the guard reads an archive
that its owner is supposed to update.**

The test is one question: *will I change the file this guard reads, for a reason that is
not a regression?*
- **yes** (a measured table, a baseline ledger) → the guard may only check **shape**
  ("this row exists", "the timestamp matches `MM-DD HH:MM`"), never a value
- **no** (a schema, a script's logic) → pinning is right, and `package-json-intact`'s
  `toBe(25)` is the model: it exists to make you stop and confirm adding a dep

Note the two look identical ("it pins a number") and behave oppositely. Auditing all
eight doc-reading guards took one round (round 155) and found exactly one wrong — the
one built seven rounds earlier.

**Corollary that paid for itself (round 68): when you write a rule down, ask in the same
breath "what is its over-executed form?"** Six of this file's ten rules turned out to
have a boundary; two were actually over-executed before the boundary was found:

| rule | over-executed form | boundary |
|---|---|---|
| "an absent assertion target means fake-green" (r50) | delete anything constantly true | **sentinel vs decoration** (r51) — sentinels stay |
| "don't depend on finally" (r66) | convert every finally to a startup sweep | **if the leak self-heals (TTL / reboot-clear), don't** (r67) |
| "replay a 0's criterion" | replay every 0 | replay only proves **log/DB-derived** criteria (r41) |
| "real newlines only" | never use a heredoc | heredoc + real newlines is safe; **python string literals** are the hazard |
| "use a heredoc for Chinese text" | chain it with later commands in one call | the heredoc is fine; **chaining it with `git commit` etc. in the same shell call** dumps the rest of the command into the doc when the delimiters do not match (round 75: `MDEOF` opened, `EOF` closed — the tail of the command line landed in `docs/voice-tuning.md`). Run the heredoc in its own call. |
| "the second number must share the denominator" | never conclude without one | **"unverified" is a legal ending** (r37 stated it plainly) |
| "read Chinese back after writing" | re-read the whole file each time | spot-check the changed lines; re-reading everything is another waste |

Asking the question at write-time costs one line and saves the round that would have
found the boundary the hard way.

**But an answer produced by asking is a hypothesis, not a fact.** Round 68 asked and
wrote "heredoc + real newlines is safe"; round 75 broke a doc with a heredoc whose
delimers did not match. The asked-for version said "never use a heredoc"; the real
failure was "never *chain* a heredoc with later commands in one shell call". So mark
which boundaries are confirmed by a real break and which are still guesses:
confirmed = r50/r51, r66/r67, r41, r75; guesses = the "unverified is a legal ending"
and "spot-check the changed lines" rows. When one of the guesses does break, update the
row — do not add a new one, or the table grows into the same stale-copy problem it was
built to fix.

The two rules with no over-executed form:
`-F` for commit messages (its boundary is *shape*, not universality) and
"never extrapolate a number you did not read" (there is no cheaper direction).

### Auditing a fix sometimes means *not* writing one — and recording why

Three times this session the audit ended in "no change", and each time the value was
the boundary it produced:

| round | what I audited | why no change |
|---|---|---|
| 67 | `learner-gate`'s `finally` | the leak self-heals (Redis lock has a TTL, in-process Set dies on reboot) — sweeping at startup would be state that treats a disease it cannot catch |
| 113 | `package-json-intact`'s `toBe(25)` | a **structural commitment** should be hard-pinned (it forces a human to confirm adding a dep); only **production readings** should be shape-matched |
| 115 | `recoverLeftovers()` | its trigger (SIGKILL mid-audit) is still live, so it will run again; a startup sweep of `/tmp` would treat a currently-absent disease |

**The reusable form:** before adding a guard, ask *what value changed means I must do
something?*
- **yes** (a dep was added, a flag count moved) → hard-pin, so it forces you
- **no** (a production counter grew) → shape-match, so it does not cry wolf

And: a mechanism that only runs **when triggered** (B-grade in the round-115 audit)
is not a defect — but write down "its caller must come back" as an explicit
dependency, or it becomes a silent one. The case that would bite: deciding
"tamper-audit is done" while a `/tmp/tamper-audit-backup*` still holds your source.

### A "known issue" that never got a round number was never going to get fixed

Three times in a row (rounds 83, 84, 85) I picked a `待排期` item off
`docs/known-issues.md` and fixed it **in the same round**. Each time the cost was
lower than I had estimated when scheduling it:

| item | scheduled in | fixed in | cost |
|---|---|---|---|
| edit replays inflating the inbound denominator | 49, "known" | 83 | half an hour, one script, zero prod risk |
| counter names absent from every doc | 79 | 80 | one table + one guard |
| process-lifetime readability | 84 | 85 | one function, one cron registration |

The round-84 audit is the finding: **two of them had already been fixed, and neither
was fixed by a schedule — both were fixed "while I was in there"**. So the reason they
sat for 34, 1, and 0 rounds was not difficulty.

**Rule: when you mark a problem, decide which round it gets fixed in. If you cannot
decide, write "待排期" with the trigger ("after 3 days without a restart") — never
"已知".** "已知" is a state name that defers forever, because nothing points at it.
And corollary from rounds 83-85: **if you scheduled it and never scheduled it, the
estimate was probably wrong — try it once before escalating it to a plan.**


### A locating tool fails in three directions — all three are "the test was fine, the tool was blind"

`scripts/tamper-audit.mts` breaks a guard's own target and checks the test goes red.
Building it took six rounds (54–59) and each fixing round was a different failure direction:

| direction | what it looks like | fix |
|---|---|---|
| **wrong string** | picked a literal from elsewhere in the test file (round 56: the first `it` used a *variable*, so the regex fell through to the next literal) | take the literal from the `it` block that asserts it |
| **wrong position** | picked another occurrence of the same string (round 55: `taskId: opts.taskId` appears 3× in `host-api.ts`) | scope the search to the test's own slice |
| **wrong direction** | slice opened the wrong way (round 59: the test does `findIndex` then walks **up**; the window opened down) | `findIndex` anchors → backward window; `indexOf` anchors → forward |
| **wrong arity** | changed one of N copies (round 58: markdown claims appear 3×) | for docs, break **all** occurrences; for code, never — it breaks compilation confusingly |

In every one of these the **test was correct** — tampering the right thing made it red
immediately. So the tool's blind spots read as "the test is fake-green", and chasing that
wastes a round.

**Corollary, written at round 55 and re-confirmed at 59: the tool's output must include the
exact line it broke.** Without that line a human cannot tell "selected wrong" from
"assertion too weak" — the two have opposite fixes.

### A self-running tool must not depend on the process that caused the problem staying alive

Round 66 found the worst failure of this session, and it was caused by my own tool:
`scripts/tamper-audit.mts` edits source in place and restores it in a `finally`.
The harness's 60s cap is **SIGKILL** — `finally` does not run. Round 50's audit was
killed mid-flight and left `incrCounter('ZZ_BROKEN_ZZ', ...)` in
`src/subagent/host-api.ts`. Only the audited subset was run (green), so it was
committed, **and shipped in production for 15 rounds**.

The counter `send_topic_word_repeat_total` therefore had no data for 15 rounds —
while `OBJECTIVE-STATUS.md` still claimed it as production evidence.

**The root cause is not "forgot to restore" but "restoring depends on the process
exiting cleanly."** So the fix is not "remember to restore" but:

```
restore on the next run, not on this run's exit
```

`recoverLeftovers()` now scans `/tmp/tamper-audit-backup*` at startup and writes the
files back; each backup's first line is `// tamper-audit-original: <path>` (the
filename alone cannot encode it — paths contain both `_` and `.`).

The sharper form of round 62's rule:

> **"It will ring" must also mean "it does not depend on the process that caused the
> problem still being alive to ring."**

`try/finally` fails that. A startup sweep does not. And the guard
(`no-tamper-leftovers.test.ts`, which fails on any `ZZ_` marker in `src/` or `dist/`)
covers the case where the recovery itself never runs.


