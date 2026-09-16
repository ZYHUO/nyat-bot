# Humanizer V2 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make xxb-ts bot output indistinguishable from a real human in Telegram groups.

**Architecture:** Extend humanizer.ts with new features, integrate into pipeline.ts send loop. All features are code-driven (no LLM calls), configurable via runtime override, and respect existing segmenter/timing logic.

**Tech Stack:** TypeScript, grammY, existing humanizer.ts + pipeline.ts

---

## Current State (V1)

✅ Typo injection — edit-based correction (no more `X*` messages)
✅ Read delay — wait before typing
✅ Ack prefix — short "嗯"/"…" before long replies
✅ Delete & resend — occasional delete+repost with minor word tweak
✅ Jitter — ±20% on all delays
✅ Code-based segmentation (segmenter.ts) — replaces LLM splitter for single long replies

## Issues to Fix

1. **Delete-resend delay too long** (5-15s → should be 1-4s, humans notice typos fast)
2. **shouldSkipTypo too conservative** — skips any char adjacent to non-CJK, kills mixed text
3. **`humanizeReply()` unused** — pipeline calls individual functions directly, but `humanizeReply()` still has old `X*` correction format

## New Features

### F1: Natural Delete-Resend Timing
Current: `deleteResendDeleteDelay: 2.0` (fixed), total 5-15s with typing delay.
Real humans: notice mistakes in 1-3s, delete almost immediately, resend in 2-4s.
→ Change defaults: `deleteResendDeleteDelay: 1.5` (1-3s with jitter).
→ Delete typing delay should be shorter (0.8-1.5s not full typing calc).

### F2: Occasional Pure Emoji/Sticker Short Replies
~20% probability when reply length ≤ 15 chars: replace with a pure emoji response.
Emoji pool: common Chinese chat emojis 👌😂🙏👍❤️😊🤔😅😍🥺💪
If sticker available and matches mood, use sticker instead.

### F3: Typing Indicator Alignment
Current: `sendChatAction('typing')` fires but may not align with actual send time.
→ Ensure typing action fires BEFORE each delay, and re-fire typing if delay > 5s.
→ Add `sendChatAction('typing')` before every `setTimeout` in the send loop.

### F4: "Thinking" Interjection
10% probability on long replies (≥80 chars, ≥3 segments): insert a short "thinking" 
segment between the first and second real segments: "我想想", "等下", "嗯..."
This is a NEW segment inserted into the reply list, not appended to existing text.

### F5: Casual Edit-After-Send
5% probability: after sending a message, edit it 2-5s later to add/remove trailing 
punctuation, swap a synonym, or add an emoji. This is DIFFERENT from typo correction —
it's a deliberate "afterthought" edit that makes minor wording tweaks.
Use the same `editMessage` path, but with a casual tweak function.

### F6: Relaxed Typo Adjacency Check
Current `shouldSkipTypo` skips any char with a non-CJK neighbor. This kills mixed 
Chinese-English text (very common in practice).
→ Change: only skip if neighbor is emoji, punctuation (CJK or ASCII), or whitespace.
Allow CJK chars next to letters/digits.

### F7: Mixed-Language Style
Occasionally (15%) add common Chinese internet style to replies:
- Remove spaces around English words (already natural in Chinese IM input)
- Add "hh" or "hhh" instead of "哈哈" (10% when "哈哈" appears)
- Add "233" instead of "哈哈哈" (5% when "哈哈哈" appears)
This is LOW priority — internal prompt tweaks handle most of this already.

---

## Tasks

### Task 1: Clean up humanizeReply() and delete stale X* correction format
**Files:** `src/pipeline/reply/humanizer.ts`
**Objective:** Remove the dead `humanizeReply()` function that still uses old X* correction format. The pipeline calls individual functions directly.

**Steps:**
1. Delete the `humanizeReply()` function (lines 355-398)
2. Delete the `HumanizerResult` interface (lines 334-345)
3. Verify build passes: `npm run build`

### Task 2: Fix shouldSkipTypo — relax adjacency check
**Files:** `src/pipeline/reply/humanizer.ts`
**Objective:** Allow typos next to letters/digits, only skip next to emoji/punctuation/whitespace.

**Steps:**
1. Replace `shouldSkipTypo` (lines 126-138) with new version that uses character class checks:
   - Skip first/last char (keep as-is)
   - Skip non-CJK chars (keep)
   - Skip if neighbor is: emoji (range check), CJK punctuation (0x3000-0x303F, 0xFF00-0xFFEF), ASCII punctuation, or whitespace
   - Allow neighbors that are CJK (0x4E00-0x9FFF), ASCII letters, or digits
2. Verify build: `npm run build`

### Task 3: Shorten delete-resend delay range
**Files:** `src/pipeline/reply/humanizer.ts`, `src/pipeline/pipeline.ts`
**Objective:** Change delete delay from 2.0s default to 1.5s, and use shorter typing delay for resend.

**Steps:**
1. In `humanizer.ts` DEFAULT_HUMANIZER_CONFIG: change `deleteResendDeleteDelay` from `2.0` to `1.5`
2. In `pipeline.ts` find the delete-and-resend block. Change the resend typing delay from `calculateTypingDelay(deleteResend.modifiedText)` to `Math.min(calculateTypingDelay(deleteResend.modifiedText), 1.5)` — cap resend typing at 1.5s max
3. Verify build: `npm run build`

### Task 4: Emoji-only short replies
**Files:** `src/pipeline/reply/humanizer.ts`
**Objective:** Add `decideEmojiReply()` that sometimes replaces a short reply (≤15 chars) with a pure emoji.

**Steps:**
1. Add config fields to `HumanizerConfig`:
   - `emojiReplyEnabled: boolean` (default: true)
   - `emojiReplyRate: number` (default: 0.15)
   - `emojiReplyMaxLength: number` (default: 15)
   - `emojiPool: string[]` (default: ['👌','😂','🙏','👍','❤️','😊','🤔','😅','😍','🥺','💪','🎉','👀','💀','🫡','🙃'])
2. Add `EmojiReplyResult` interface: `{ shouldReplace: boolean, emoji: string }`
3. Add `decideEmojiReply(replyLength: number, config?)` function:
   - If `!emojiReplyEnabled || replyLength > emojiReplyMaxLength → { shouldReplace: false }`
   - If random < emojiReplyRate → pick random emoji, return `{ shouldReplace: true, emoji }`
4. Export the new function
5. Verify build: `npm run build`

### Task 5: Integrate emoji reply into pipeline send loop
**Files:** `src/pipeline/pipeline.ts`, `src/admin/runtime-config.ts`
**Objective:** When a short text reply is eligible, replace it with a pure emoji. Skip sticker for emoji-replaced messages.

**Steps:**
1. Import `decideEmojiReply` in pipeline.ts
2. In the send loop, before sending: check `decideEmojiReply(reply.replyContent.length, humanizerConfig)`
3. If `shouldReplace`: set `effectiveText = emoji`, `isStickerOnly = true` (to skip the text send path), skip quote-reply on emoji messages (pass `undefined` as replyToId for emoji-only)
4. Add emoji reply fields to `RuntimeOverride.humanizer` interface in `runtime-config.ts`
5. Add emoji reply parsing in `loadRuntimeOverrideMap`
6. Verify build: `npm run build`

### Task 6: Typing indicator alignment — re-fire before every delay
**Files:** `src/pipeline/pipeline.ts`
**Objective:** Ensure typing action fires before every delay, including before read delay and between delete-resend.

**Steps:**
1. Check every `setTimeout` in the send loop (read delay, ack prefix, typing delay between segments, delete-resend delay, correction delay) has a `sendChatAction('typing')` call BEFORE it
2. For delays > 5s (read delay can be up to 5s), add a re-fire: `setTimeout(() => sendChatAction('typing'), 4500)` to re-trigger the 5-second Telegram typing indicator before it expires
3. Verify no `setTimeout` in the send loop is missing a prior typing action
4. Verify build: `npm run build`

### Task 7: "Thinking" interjection segment
**Files:** `src/pipeline/reply/humanizer.ts`
**Objective:** Occasionally insert a short "thinking" segment between the 1st and 2nd reply segments.

**Steps:**
1. Add config fields to `HumanizerConfig`:
   - `thinkingInterjectionEnabled: boolean` (default: true)
   - `thinkingInterjectionRate: number` (default: 0.10)
   - `thinkingInterjectionMinTotalLength: number` (default: 80)
   - `thinkingInterjectionMinSegments: number` (default: 3)
   - `thinkingPool: string[]` (default: ['我想想', '等下', '嗯...', '让我看看', '怎么说呢'])
2. Add `ThinkingResult` interface: `{ shouldInsert: boolean, text: string }`
3. Add `decideThinkingInterjection(totalLength, segmentCount, config?)` function
4. Export the function
5. Verify build: `npm run build`

### Task 8: Integrate thinking interjection into pipeline
**Files:** `src/pipeline/pipeline.ts`, `src/admin/runtime-config.ts`
**Objective:** Conditionally insert a "thinking" segment between 1st and 2nd replies.

**Steps:**
1. Import `decideThinkingInterjection` in pipeline.ts
2. After segmentation (replies array built), before the send loop, call `decideThinkingInterjection(totalLength, replies.length, humanizerConfig)`
3. If `shouldInsert`: splice a new reply into `replies` at index 1 with `{ replyContent: text, targetMessageId: replies[0]!.targetMessageId, replyQuote: false }`
4. Add thinking interjection fields to `RuntimeOverride.humanizer` in `runtime-config.ts`
5. Verify build: `npm run build`

### Task 9: Casual afterthought edit
**Files:** `src/pipeline/reply/humanizer.ts`, `src/pipeline/pipeline.ts`
**Objective:** 5% chance: after sending, edit the message 2-5s later with a minor wording tweak (add/remove punctuation, add emoji, swap particle).

**Steps:**
1. Add config fields to `HumanizerConfig`:
   - `afterthoughtEditEnabled: boolean` (default: true)
   - `afterthoughtEditRate: number` (default: 0.05)
   - `afterthoughtEditDelay: number` (default: 3.0)
2. Add `AfterthoughtResult` interface: `{ shouldEdit: boolean, editedText: string }`
3. Add `decideAfterthoughtEdit(text: string, config?)` function:
   - If `!enabled || random > rate` → no edit
   - Only on messages ≥ 4 chars
   - Apply a minor casual tweak (different from delete-resend tweak pool):
     - Add trailing emoji (😂/👍/🤣/✨/💕) — 35%
     - Add trailing particle (啊/呢/呀/哦) — 25%
     - Remove trailing period/comma — 20%
     - Add trailing period if none — 15%
     - Swap a common word (真的→真, 非常→特别, 这个→这) — 5%
4. Export the function
5. In pipeline.ts, AFTER sending each non-sticker message, check `decideAfterthoughtEdit`
6. If `shouldEdit`: `setTimeout(afterthoughtEditDelay * 1000)` then `editMessage(chatId, messageId, editedText)`
7. Add afterthought fields to runtime-config.ts
8. Verify build: `npm run build`

### Task 10: Final integration test — build + restart + verify
**Files:** None (verification only)
**Objective:** Clean build, restart, test all features live.

**Steps:**
1. `npm run build` — must pass with 0 new errors
2. `systemctl restart xxb-ts`
3. Check logs for any new errors
4. Send a test message to the bot and verify:
   - Read delay works (gap between placeholder and first reply)
   - Typing indicator appears during delays
   - Segmentation still works (multi-message replies)
   - Emoji-only short replies fire occasionally
   - Thinking interjection appears on long replies
   - Afterthought edits happen ~5% of the time
5. Commit all changes

---

## Dependency Graph

```
Task 1 (cleanup) ← independent, do first
Task 2 (typo fix) ← independent
Task 6 (typing align) ← independent  
Task 3 (delay shorten) ← independent

Task 4 (emoji config) ← must come before Task 5
Task 5 (emoji pipeline) ← depends on Task 4

Task 7 (thinking config) ← must come before Task 8
Task 8 (thinking pipeline) ← depends on Task 7

Task 9 (afterthought) ← independent

Task 10 (final test) ← depends on ALL
```

## Estimated Time
- Task 1-3: 15 min
- Task 4-5: 15 min  
- Task 6: 10 min
- Task 7-8: 15 min
- Task 9: 20 min
- Task 10: 10 min
- **Total: ~85 min**