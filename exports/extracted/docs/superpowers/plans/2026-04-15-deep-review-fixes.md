# Deep Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all P0/P1/P2 issues found in the deep code review on 2026-04-15.

**Tech Stack:** TypeScript, Vitest, Redis, SQLite

---

### Task 1 (P0): Fix webhook secret timing attack

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `===` comparison with `crypto.timingSafeEqual`**

Replace the string equality check on `X-Telegram-Bot-Api-Secret-Token` header with a constant-time comparison to prevent timing attacks:

```ts
import { timingSafeEqual } from 'node:crypto';

const incoming = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
const expected = config.WEBHOOK_SECRET ?? '';
const match =
  incoming.length === expected.length &&
  timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
if (!match) return c.json({ ok: false }, 403);
```

---

### Task 2 (P0): Fix chat lock stale reference on re-acquire

**Files:**
- Modify: `src/queue/chat-lock.ts`

- [ ] **Step 1: Read current lock logic and identify the stale-reference bug**
- [ ] **Step 2: Ensure old lock is released before re-acquiring**

Before calling `acquire` a second time, verify the previous lock handle is explicitly released or invalidated so concurrent callers don't hold a reference to a released lock.

---

### Task 3 (P1): Fix lastProactiveTs memory leak

**Files:**
- Modify: `src/tracking/interaction.ts`

- [ ] **Step 1: Add size cap to lastProactiveTs Map**

After inserting a new entry, if the Map exceeds a threshold (e.g. 500 entries), delete the oldest entries:

```ts
const MAX_PROACTIVE_TS_ENTRIES = 500;
if (lastProactiveTs.size > MAX_PROACTIVE_TS_ENTRIES) {
  const oldest = lastProactiveTs.keys().next().value;
  if (oldest !== undefined) lastProactiveTs.delete(oldest);
}
```

---

### Task 4 (P1): Skip getMuteState query in DM context

**Files:**
- Modify: `src/tracking/user-profile.ts`

- [ ] **Step 1: Short-circuit getMuteState for DM chats**

DM chat IDs are positive. Mute state is only meaningful in group chats (negative IDs):

```ts
export function getMuteState(chatId: number, userId: number): MuteState {
  if (chatId > 0) return { muted: false, level: 1 }; // DM — no mute concept
  // ... existing DB query
}
```

---

### Task 5 (P1): Preserve original error in hedgedCall

**Files:**
- Modify: `src/ai/fallback.ts`

- [ ] **Step 1: Extract original errors from AggregateError**

When `Promise.any` rejects with `AggregateError`, surface the individual errors rather than losing them:

```ts
.catch((err: unknown) => {
  if (err instanceof AggregateError) {
    throw err.errors[0] ?? new AIError('Hedged call failed', 'unknown', 'unknown', 'AI_HEDGE_FAILED');
  }
  throw err;
});
```

---

### Task 6 (P2): Fix auth_date NaN bypass in admin auth

**Files:**
- Modify: `src/admin/auth.ts`

- [ ] **Step 1: Validate auth_date is a finite number**

```ts
const authDate = Number(data.auth_date);
if (!Number.isFinite(authDate)) return { valid: false, reason: 'invalid auth_date' };
```

---

### Task 7 (P2): Fix retriever thread merge priority

**Files:**
- Modify: `src/pipeline/context/retriever.ts`

- [ ] **Step 1: Ensure thread messages take priority over recent in dedup**

Currently `allMerged = [...thread, ...recent, ...]` is correct for dedup order, but verify `appendExtrasWithinBudget` doesn't drop thread messages when budget is tight. Thread messages should always be included before semantic/entity extras.

---

### Task 8 (P2): Add batch limit to user profile cron

**Files:**
- Modify: `src/tracking/user-profile.ts`

- [ ] **Step 1: Cap users processed per cron run**

Add a `PROFILE_SYNC_BATCH_SIZE` constant (e.g. 20) and limit `runUserProfileSync` to process at most that many users per invocation to avoid long-running cron jobs.
