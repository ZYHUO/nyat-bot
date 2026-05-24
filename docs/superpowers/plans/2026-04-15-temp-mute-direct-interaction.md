# Temporary Mute On Direct Interaction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make natural-language mute requests temporary, and automatically clear that temporary mute on the user's next direct `@bot` or reply-to-bot interaction.

**Architecture:** Keep `/muteme` and hard mute behavior persistent, but mark natural-language soft mute as temporary in the existing `user_preferences` mute row. During pipeline processing, clear temporary mute before handling the next direct interaction so the current message is answered normally.

**Tech Stack:** TypeScript, Vitest, SQLite

---

### Task 1: Add Regression Tests For Temporary Mute Semantics

**Files:**
- Modify: `tests/unit/tracking/user-profile.test.ts`
- Modify: `tests/unit/pipeline/pipeline-paths.test.ts`

- [ ] **Step 1: Write failing storage-layer test**

Add a test showing natural-language soft mute can be stored as temporary and distinguished from persistent mute.

- [ ] **Step 2: Write failing pipeline test**

Add a test showing a temporary mute is cleared on the user's next direct mention or reply, while the current message continues through reply generation.

- [ ] **Step 3: Run the targeted tests and verify they fail**

Run: `npm test -- tests/unit/tracking/user-profile.test.ts tests/unit/pipeline/pipeline-paths.test.ts -t "temporary mute"`

Expected: failure because temporary mute state does not exist yet.

### Task 2: Implement Temporary Mute State And Auto-Clear

**Files:**
- Modify: `src/tracking/user-profile.ts`
- Modify: `src/pipeline/pipeline.ts`

- [ ] **Step 1: Add minimal mute-state support**

Represent temporary mute using the existing mute row so no migration is needed.

- [ ] **Step 2: Update natural-language soft mute handling**

Store `mute_soft_request` as temporary, while leaving `/muteme` and hard mute persistent.

- [ ] **Step 3: Auto-clear temporary mute on direct interaction**

Before the mute gate, detect direct `mention_self*` or `reply_to_self*` interactions and clear temporary mute so the current message proceeds normally.

- [ ] **Step 4: Re-run targeted tests and verify they pass**

Run: `npm test -- tests/unit/tracking/user-profile.test.ts tests/unit/pipeline/pipeline-paths.test.ts -t "temporary mute"`

Expected: PASS.
