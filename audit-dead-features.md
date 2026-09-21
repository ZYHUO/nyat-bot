# Dead-feature audit — NyatBot (`/root/xxb-ts`)

Window: `logs/app.log` 2026-09-15 07:32 → 2026-09-21 15:28 UTC, **209,648 lines**, `LOG_LEVEL=info`.
Denominator: **2,686 `CodeAct task start`** in that window.
`META_SUBAGENT_ENABLED=true` + `META_SUBAGENT_CHAT_IDS=` (empty) ⇒ `isMetaSubagentChat()` is **true for every chat**.

## The structural fact that makes most of this possible

`src/bot/handlers/message.ts:161-762` is the only router. The legacy `processPipeline` is reachable
**only** through `metaNeedsLegacyPipeline()` (`src/meta/ingress-intercepts.ts:27-38`), which returns
true for exactly two shapes:

1. text starts with `/`, or
2. the bot is addressed **and** `detectCommandIntent().kind === 'llm'` (i.e. `/checkin` / `/stats`).

Everything else goes to `tryMetaIngressIntercepts()` and returns `'done'` at message.ts:759 — it never
reaches line 764 (`isTurnActorChat` → `appendPending` → `processPipeline`). Verified in the log:
`Meta path: slash/checkin-stats → legacy pipeline` = **1010**, `Meta path: intercept → legacy` = **0**.

So *any* deterministic handler that lives in `src/pipeline/stages/intercepts.ts` and triggers on free
text is dead in production. That is the whole story below.

## Findings

| # | feature | file:line | why unreachable / unexercised | evidence | severity |
|---|---|---|---|---|---|
| 1 | **Deterministic "开/关反广告"** (`tryAntiAdCommand`) | `src/pipeline/stages/antiad-command.ts:40` ← only caller `src/pipeline/stages/intercepts.ts:217` (`tryPreMuteIntercepts`) ← only caller `src/pipeline/stages/post-judge.ts:184` | Wired **only** into the legacy pipeline. "开一下反广告" is not a slash command and not a checkin/stats NL intent, so `metaNeedsLegacyPipeline()` returns false and the message goes Meta → Attention → `taskToGroup` → swallowed as an interrupt. **This is the exact failure the fix was written for, re-introduced by the fix.** | git `5131460` touched only `antiad-command.ts` + `intercepts.ts` + its test — **not** `ingress-intercepts.ts`. Log: user message `"preview":"开一下反广告"` arrived 2026-09-21 10:43:13 UTC (line 194180, chat `-1003184176508`); `antiad command applied (deterministic path)` = **0**, `antiad command rejected: not group admin` = **0**, `host admin.setAntiAd` = **0** in 209,648 lines | **high** |
| 2 | **Anti-ad data pipeline** (`noteInbound`) | `src/pipeline/pipeline.ts:121-131` and `:188-195` | `antiAdOn = e.ANTIAD_ENABLED === true && (…)`. `noteInbound` has exactly one caller (`pipeline.ts:190`), and `ANTIAD_ENABLED` is `booleanFromEnv.default(false)` (`src/env-sections/features.ts:41`), unset in `.env`. The **reader** `renderAdPressure` (`src/nyatos/ad-pressure.ts:247`) only checks the per-chat key and *is* reachable on the Meta path via `src/subagent/room-awareness.ts:78` → `frame.ts:324`. Net: a group owner flipping the switch produces an empty `[噪声]` line forever. | `noteInbound` readers: 1 (`pipeline.ts:190`). `.env` has no `ANTIAD_ENABLED`. Not in `no-dead-switches.test.ts` `FAMILIES` (which lists only `MULTI_AGENT_ENABLED`) | **high** |
| 3 | **`bots.command`** host tool | `src/subagent/host-api.ts:2011-2043`, documented `src/subagent/executor.ts:69` | Only two callers of `tryDelegateCommand` exist: `routeLearnedCommand` (`command-router.ts:83`) and `bots.command` (`host-api.ts:2041`). All 4 delegations in the log carry **byte-identical timestamps** with `command-router: delegated learned command` ⇒ 1:1, all from the deterministic router. `bots.command` itself: **0 model invocations**. Same disease as `admin.setAntiAd` — only reachable by the LLM electing to call it, and a long task swallows the user's message as an interrupt. | `Delegation: command sent, awaiting receipt` = 4, `command-router: delegated learned command` = 4, timestamps `1789985799023 / 1789985897159 / 1789993885583 / 1790004442124`. `Delegation: auto-registered from typed command` = 0 | **high** |
| 4 | **`art.draw`** (the mandatory drawing path) | `src/subagent/host-api.ts:2201/2204/2231/2269/2271`, documented `src/subagent/executor.ts:49` ("画图必须用它，禁止自己用 PIL/代码涂鸦") | Every attempt logs exactly one of 5 lines; none is a success. 2 attempts in 6 days, **0 deliveries**. The fallback the prompt points at (`python3.10` + PIL via `computer.run`) is also dead in this deployment (bwrap missing), and `sandbox-prompt.ts` only rewrites the `computer.run` lines, not the PIL advice. | `host art.draw(async) failed` = **2** (`no_svg_in_output`, `llm_call_failed:All labels exhausted`); `host art.draw(async) delivered` = **0**; `host art.draw(async) job failed` = 0; `host art.draw done (sync)` = 0. `computer.run`: 5× `sandbox terminal: isolation unavailable, command denied` | **high** |
| 5 | **Sticker-dislike intercept** | `src/pipeline/stages/intercepts.ts:226-244`, only caller `post-judge.ts:492` | Legacy-only. Needs judge rule `sticker_dislike` (`rules.ts:174-175`) which requires `isReplyToSelf`; a reply to the bot's sticker is neither a slash command nor a checkin/stats NL intent, so it never reaches the legacy pipeline. `tryMetaIngressIntercepts` has no sticker branch. | `Sticker dislike recorded` = **0** in 209,648 lines | **medium** |
| 6 | **`self.*` family** (`editPrompt` / `readPrompt` / `listPrompts`) | `src/subagent/host-api.ts:2806+`, documented `executor.ts:75-77` + behavioural rule #15 (`executor.ts:135`) | 0 invocations in 2,686 tasks. `selfEditPrompt` logs on success, so absence is proof for `editPrompt`; `readPrompt`/`listPrompts` have no log line, so they are unproven either way. | `self-edit: prompt modified` (`src/agent/self-improve.ts:133`) = **0**. All `prompts/` mtimes ≥ 1 day old | **medium** |
| 7 | **`allowlist.apply`** | `src/subagent/host-api.ts:2313-2342`, documented `executor.ts:71` | Fully enabled and reachable (DM), but never invoked. | `host allowlist.apply` = **0**. `ALLOWLIST_ENABLED` / `ALLOWLIST_BOT_FLOW_ENABLED` / `ALLOWLIST_AUTO_AI_REVIEW` all `true` (`.env:113-123`); sibling `host allowlist.approve` = 3, so the flow itself is live | **medium** |
| 8 | `tryMetaIngressIntercepts` `'legacy'` return | `src/meta/ingress-intercepts.ts:21,53-162` | The function only ever returns `'handled'` or `'continue'`, so the `intercept === 'legacy'` fallthroughs at `message.ts:286-289` and `:747-749` are dead code. | `Meta path: intercept → legacy` = **0** | **low** |
| 9 | Tool families with a success log line and **0** occurrences across 2,686 tasks | `host-api.ts` | Each of these logs on its success path, so a zero count *is* proof of non-use. | `host sendPoll sent` = 0 (and `rejected daily cap` = 0) · `host forward delivered` = 0 · `host admin.unmute` = 0 · `host admin.pin` = 0 · `host admin.unpin` = 0 · `host admin.kick` = 0 · `host allowlist.reject` = 0 · `host pixiv.download` = 0 (`pixiv.search` tried once, ECONNRESET) · `host runtime.setPlan` = 0 (`executor.ts:122`) | **low** |
| 10 | `STEPFUN_CONSUMER_CONCURRENCY` (child ON, parent OFF) | `src/env-sections/self.ts:52` (default 4) under `src/env-sections/self.ts:48` `STEPFUN_CONSUMER_ENABLED` default false | Both readers (`cron/stepfun-consumer.ts:110`, `:147`) sit inside `runStepfunConsumer`, which returns at line 89 `if (!e.STEPFUN_CONSUMER_ENABLED) return;`. The cron isn't even registered (`cron/scheduler.ts:387` gates it). | Not present in `no-dead-switches.test.ts` `FAMILIES`/`PARENT_GATED` | **low** |
| 11 | `telegram.sendVoice` | `src/env-sections/life.ts:142` `TTS_ENABLED` default false; `src/ai/tts.ts:35` | Silent no-op returning `{skipped}` with **no log line**, so it leaves no trace. Advertised at `executor.ts:50,117`. Honestly worded ("TTS 关闭时返回 {skipped}，属正常") — capability gap, not a lie. | `.env` has no `TTS_ENABLED` | **low** |

### Bonus (exercised but lossy) — `stickers.pick`
`host sendSticker rejected bad fileId` = **32** and `host sendSticker failed (non-fatal)` = 13, out of ~45 sticker
attempts. Breakdown of the 32: `fileId:""` ×29 (`stickers.pick` returned empty and the model passed it
straight through) and **`fileId:"[object Promise]"` ×3** (the model forgot to `await`). The feature is alive;
the failure mode is model-side.

## Checked and fine — don't re-check

- **`detectCommandIntent` / `dispatchCommand` (task c).** All 9 intent shapes are producible, and every
  `kind:'intercept'` intent maps to a real `dispatchCommand` branch. `partyGame`
  (`src/pipeline/games/party.ts:47-54`) handles all four party modes. No dead intents.
- **`dispatchCommand` reachability (task b).** Reachable from *both* the legacy slash path and the Meta
  ingress NL path (`ingress-intercepts.ts:152-160`). The `/watch` (DM→goals) and `/skill` (master DM)
  branches are legacy-slash-only, but that path is alive: `Meta path: slash/checkin-stats → legacy
  pipeline` = 1010, and `/unmuteme` → `User self-unmuted` = 3. `/watch` = 1 preview, `/skill` = 0 previews
  (unused, not dead).
- **`routeLearnedCommand`** is dual-wired (legacy `intercepts.ts:193` **and** Meta `ingress-intercepts.ts:72`).
  The 4 delegations all post-date the ingress fix. The legacy copy is now redundant but harmless.
- **`tryMuteCommandIntercepts`** (`/muteme` / `/unmuteme`) is legacy-only *by design* and works: 3
  `User self-unmuted` from group chats. (`User self-muted` = 0 — nobody typed `/muteme`.)
- **Healthy tools with real production counts:** `telegram.sendText` 3731 (incl. `sendFinal`, which
  delegates to it at `host-api.ts:1439`), `web.search` 237, `admin.deleteMessage` 25, `admin.mute` 14,
  `members.find` 14, `chats.find` 7, `allowlist.approve` 3, `meta.request` 1, `goals.add` 1,
  `sendToChat` 1.
- **`computer.run` dead-by-deployment** is already handled: `src/subagent/sandbox-prompt.ts` rewrites the
  prompt to say "本机不可用". Boot line: *"Sandbox isolation unavailable; autonomous terminal execution
  is blocked"*.
- **`/status`, `/feature`, `/setdefault`** are in `WHITELISTED_COMMANDS` with no handler, but
  `buildHelpText()` (`src/bot/handlers/help.ts`) does not advertise them, so they degrade to a normal LLM
  reply. Not user-facing dead capability.
- **Flag-family scan (task d).** Schema-wide prefix scan over 459 flags / 204 ON produced exactly two
  other candidate families: `STEPFUN_CONSUMER_*` (finding 10) and `JUDGE_KNOWLEDGE_*`. The latter is
  **not** a violation — `src/core/state.ts:76-79` reads `JUDGE_KNOWLEDGE_GROUP`/`_PERMANENT` ungated, and
  `assembleState` is called from `src/core/loop.ts:94`, so they are live there. (`JUDGE_KNOWLEDGE_ENABLED=false`
  does make its own gate at `judge.ts:149-154` dead, but its children are not orphaned.)
  `MUNDO_ENABLED`/`DEEP_THINK_ENABLED` are both false, and `MEMORY_FRESHNESS_ENABLED` /
  `MOOD_TUNE_ENABLED` are **not** gated by them (`bookkeeping.ts:250` reads it directly) — no violation.
- **`sendPhoto` / `sendFile` / `memory.*` / `web.feed` / `self.readPrompt` / `computer.*`** emit **no
  success log line at all**, so no log-based claim can be made about them either way. Don't waste time
  grepping the log for these.

## Recommended order

1. Add a `tryAntiAdCommand` branch to `src/meta/ingress-intercepts.ts` (mirroring how `routeLearnedCommand`
   and the control directives were wired in round 135) — findings 1 and 2 are the same user complaint.
2. Turn on `ANTIAD_ENABLED` (or drop the `ANTIAD_ENABLED === true` conjunct at `pipeline.ts:122`) — otherwise
   the grant in (1) still yields an empty `[噪声]`.
3. Decide on `art.draw`: it is advertised as the *only* legal drawing path and has a 0% success rate, with
   its documented fallback (`computer.run`) also dead.
4. Add `STEPFUN_CONSUMER_*` to `FAMILIES` in `tests/unit/env/no-dead-switches.test.ts`, or retire the child.
