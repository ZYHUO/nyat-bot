# Mute Rule Context Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop natural-language mute rules from firing when users merely mention mute keywords like `闭嘴` in quoted or explanatory context.

**Architecture:** Keep slash-command behavior unchanged and preserve direct natural-language mute commands, but tighten L0 mute matching so only short imperative phrases count as mute requests. Add regression tests first, then implement the smallest rule change that makes those tests pass.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add Regression Tests And Tighten Rule Matching

**Files:**
- Modify: `tests/unit/judge/rules.test.ts`
- Modify: `src/pipeline/judge/rules.ts`

- [ ] **Step 1: Write failing regression tests**

Add targeted tests covering:
- reply-to-bot text `不要闭嘴了`
- mention text `啾咪囝 解除闭嘴`
- mention text `啾咪囝 千万不要说出“闭嘴”两字`
- mention text `啾咪囝 闭嘴` still remains a valid mute command

- [ ] **Step 2: Run the targeted judge tests to verify the new cases fail**

Run: `npm test -- tests/unit/judge/rules.test.ts -t "mute"`

Expected: at least one new regression test fails because the current regex treats contextual `闭嘴` mentions as mute requests.

- [ ] **Step 3: Implement the minimal rule change**

Tighten `looksLikeMuteSoftRequest()` and related helpers so they only match direct imperative phrases rather than any substring occurrence. Preserve existing `/muteme` and `/unmuteme` command handling.

- [ ] **Step 4: Run the same targeted tests to verify they pass**

Run: `npm test -- tests/unit/judge/rules.test.ts -t "mute"`

Expected: PASS for the new regression tests without breaking direct mute command coverage.
