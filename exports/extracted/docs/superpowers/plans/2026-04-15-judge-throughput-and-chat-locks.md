# Judge Throughput And Chat Locks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce group reply latency by removing avoidable AI judge hops and shrinking per-chat lock scope so same-chat jobs no longer wait behind full reply generation.

**Architecture:** Route direct `@bot` and reply-to-bot traffic through L0 with a deterministic direct reply default, then accept safe L1 `IGNORE` results without escalating to L2. Move the per-chat lock from the whole pipeline to two short critical sections: intake/judge and send/finalize, with a stale-reply recheck before sending.

**Tech Stack:** TypeScript, Vitest, BullMQ, Redis

---

### Task 1: Capture failing behavior with tests

**Files:**

- Modify: `tests/unit/judge/rules.test.ts`
- Create: `tests/unit/judge/judge.test.ts`
- Modify: `tests/unit/pipeline/pipeline-paths.test.ts`

- [ ] **Step 1: Add judge fast-path expectations**
- [ ] **Step 2: Run targeted tests to verify failures**

### Task 2: Implement judge shortcuts

**Files:**

- Modify: `src/pipeline/judge/rules.ts`
- Modify: `src/pipeline/judge/judge.ts`

- [ ] **Step 1: Return deterministic L0 results for direct mention / reply-to-self without lookup**
- [ ] **Step 2: Accept safe L1 ignore decisions without L2 escalation**
- [ ] **Step 3: Re-run judge-focused tests**

### Task 3: Narrow chat lock scope

**Files:**

- Modify: `src/pipeline/pipeline.ts`
- Modify: `src/queue/worker.ts`
- Modify: `src/queue/chat-lock.ts`
- Test: `tests/unit/pipeline/pipeline-paths.test.ts`

- [ ] **Step 1: Move chat locking into pipeline stages**
- [ ] **Step 2: Release intake lock before reply generation**
- [ ] **Step 3: Reacquire before send, then suppress stale proactive replies**
- [ ] **Step 4: Re-run pipeline tests**

### Task 4: Verify and ship

**Files:**

- Modify: `src/pipeline/judge/judge.ts`
- Modify: `src/pipeline/pipeline.ts`
- Modify: `src/queue/worker.ts`

- [ ] **Step 1: Run targeted tests**
- [ ] **Step 2: Run `npm run build`**
- [ ] **Step 3: Restart `xxb-ts` and confirm service health**
