# AGI Phase 2 Implementation Plan: Evidence-Gated Goals and Learning

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Close the remaining self-certification loops so goals, episodes, skills, and self-edits only advance on host-verified evidence.

**Architecture:** Keep the Phase 1 lifecycle/assessment split. Add goal evidence columns plus a gate API, derive distiller outcome from assessment, restrict skill-distill material to verified episodes, track skill verified-use separately, and add self-edit guardrails. All new behavior flag-gated default OFF, graylisted per chat, TDD with frequent commits.

**Tech Stack:** TypeScript ESM, Node 22, Vitest, better-sqlite3 migrations, existing CodeAct executor/host API.

---

### Task 1: Goal evidence columns migration

**Objective:** Persist per-goal verification state without rewriting history.

**Files:**
- Create: `migrations/0073_goal_evidence.sql`
- Test: `tests/unit/agent/goal-evidence-migration.test.ts`

**Step 1: Write failing test**

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('0073 goal evidence migration', () => {
  it('adds evidence columns and leaves existing goals untouched', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync('migrations/0055_goals.sql', 'utf8'));
    db.exec(`INSERT INTO goals (topic, origin, status, created_at, updated_at)
      VALUES ('watch coupons', 'master', 'active', 1, 1)`);
    db.exec(readFileSync('migrations/0073_goal_evidence.sql', 'utf8'));
    db.exec(readFileSync('migrations/0073_goal_evidence.sql', 'utf8'));
    const row = db.prepare('SELECT * FROM goals').get() as Record<string, unknown>;
    expect(row['status']).toBe('active');
    expect(row['verified_achievements']).toBe(0);
    expect(row['unverified_completions']).toBe(0);
    expect(row['last_evidence']).toBe('unverified');
  });
});
```

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/agent/goal-evidence-migration.test.ts --maxWorkers=2`
Expected: FAIL — "no such file: migrations/0073_goal_evidence.sql"

**Step 3: Write minimal implementation**

```sql
ALTER TABLE goals ADD COLUMN verified_achievements INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN unverified_completions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN last_evidence TEXT NOT NULL DEFAULT 'unverified';
CREATE INDEX IF NOT EXISTS idx_goals_evidence ON goals(status, last_evidence);
```

**Step 4: Run test to verify pass**

Run: same vitest command
Expected: PASS — 1 passed

**Step 5: Commit**

```bash
git add migrations/0073_goal_evidence.sql tests/unit/agent/goal-evidence-migration.test.ts
git commit -m "feat(goals): add evidence counters migration"
```

---

### Task 2: Goal evidence gate API

**Objective:** Goals only reach `achieved` through a host-side evidence check.

**Files:**
- Modify: `src/agent/goals.ts`
- Test: `tests/unit/agent/goals.test.ts` (append new describe block)

**Step 1: Write failing test**

```ts
describe('goal evidence gate', () => {
  it('rejects achieved without verified evidence', () => {
    const id = createGoal({ topic: 'evidence gate probe', origin: 'test' }, 50)!;
    expect(() => markGoalAchieved(id, 'unverified')).toThrow('needs verified evidence');
    expect(listGoals().find((g) => g.id === id)!.status).toBe('active');
  });

  it('records verified achievement with evidence label', () => {
    const id = createGoal({ topic: 'evidence gate pass', origin: 'test' }, 50)!;
    markGoalAchieved(id, 'verified', 'result.json:sum=55');
    const row = listGoals().find((g) => g.id === id)!;
    expect(row.status).toBe('achieved');
    expect(row.verified_achievements).toBe(1);
  });

  it('keeps unverified completion open and counted', () => {
    const id = createGoal({ topic: 'evidence gate open', origin: 'test' }, 50)!;
    recordUnverifiedCompletion(id, 'model said done');
    const row = listGoals().find((g) => g.id === id)!;
    expect(row.status).toBe('active');
    expect(row.unverified_completions).toBe(1);
  });
});
```

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/agent/goals.test.ts --maxWorkers=2`
Expected: FAIL — "markGoalAchieved is not defined"

**Step 3: Write minimal implementation**

```ts
export function markGoalAchieved(id: number, evidence: 'verified' | 'failed' | 'unverified', label?: string): void {
  if (evidence !== 'verified') throw new Error('goal achieved needs verified evidence');
  try {
    getDb().prepare(
      `UPDATE goals SET status = 'achieved', verified_achievements = verified_achievements + 1,
        last_evidence = 'verified', last_finding = COALESCE(?, last_finding), updated_at = ? WHERE id = ?`,
    ).run(label?.slice(0, 500) ?? null, nowSec(), id);
  } catch (err) {
    logger.warn({ err, id }, 'markGoalAchieved failed');
  }
}

export function recordUnverifiedCompletion(id: number, note?: string): void {
  try {
    getDb().prepare(
      `UPDATE goals SET unverified_completions = unverified_completions + 1,
        last_evidence = 'unverified', last_finding = COALESCE(?, last_finding), updated_at = ? WHERE id = ?`,
    ).run(note?.slice(0, 500) ?? null, nowSec(), id);
  } catch (err) {
    logger.warn({ err, id }, 'recordUnverifiedCompletion failed');
  }
}
```

Extend `GoalRow` with `verified_achievements: number; unverified_completions: number; last_evidence: string;`.

**Step 4: Run test to verify pass**

Run: same vitest command
Expected: PASS — full file green

**Step 5: Commit**

```bash
git add src/agent/goals.ts tests/unit/agent/goals.test.ts
git commit -m "feat(goals): gate achieved on verified evidence"
```

---

### Task 3: Executor goal writes go through the evidence gate

**Objective:** Stop `已完成:` summaries from self-certifying goals.

**Files:**
- Modify: `src/subagent/executor.ts:1169-1212`
- Test: extend `tests/unit/subagent/` goal backstop coverage if present, else add `tests/unit/subagent/goal-evidence-gate.test.ts`

**Step 1: Write failing test**

```ts
it('routes model 已完成 through unverified completion when assessment is not verified', async () => {
  // Arrange a [goal:N] task whose assessment is unverified.
  // Assert recordUnverifiedCompletion called and setGoalStatus('achieved') NOT called.
});
```

Use existing executor goal-block mocks; if no harness exists, assert at minimum that `setGoalStatus` import is removed from the goal-writeback path and replaced by `markGoalAchieved`/`recordUnverifiedCompletion`.

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/subagent/goal-evidence-gate.test.ts --maxWorkers=2`
Expected: FAIL — gate functions not wired

**Step 3: Write minimal implementation**

```ts
const evidence = task.assessment?.status ?? 'unverified';
if (achieved) {
  if (evidence === 'verified') {
    recordCheck(goalId, `已完成: ${achieved.slice(0, 480)}`);
    markGoalAchieved(goalId, 'verified', task.assessment?.checks.map((c) => `#${c.index}:${c.reason}`).join(','));
  } else {
    recordUnverifiedCompletion(goalId, `model completion claim without verification: ${achieved.slice(0, 200)}`);
  }
  return;
}
```

Keep `无法完成:` → `dropped` path unchanged. `found:` keeps `recordCheck` only, never `achieved`.

**Step 4: Run test to verify pass**

Run: same vitest command plus `tests/unit/agent/goals.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/subagent/executor.ts tests/unit/subagent/goal-evidence-gate.test.ts
git commit -m "feat(goals): route executor goal completion through evidence gate"
```

---

### Task 4: Distiller outcome derives from assessment

**Objective:** Unverified work must not be distilled as `done` episodes.

**Files:**
- Modify: `src/agent/distiller.ts:69-85`
- Test: `tests/unit/agent/distiller.test.ts`

**Step 1: Write failing test**

```ts
it('maps unverified lifecycle-done to failed episode outcome', async () => {
  // task.status='done', task.assessment={ status:'unverified', ... }
  // mock callWithFallback to capture the user prompt; expect `outcome: failed`.
});

it('keeps verified done as done', async () => {
  // task.status='done', task.assessment={ status:'verified', ... }
  // expect `outcome: done`.
});
```

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/agent/distiller.test.ts --maxWorkers=2`
Expected: FAIL — unverified still prompts `outcome: done`

**Step 3: Write minimal implementation**

```ts
const assessed: 'done' | 'failed' =
  outcome === 'done' && task.assessment?.status === 'verified' ? 'done' : 'failed';
```

Use `assessed` in the LLM prompt (`outcome: ${assessed}`) and `saveEpisode({ outcome: assessed, ... })`. Do not change `saveEpisode` schema.

**Step 4: Run test to verify pass**

Run: same vitest command
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/distiller.ts tests/unit/agent/distiller.test.ts
git commit -m "fix(distill): derive episode outcome from assessment"
```

---

### Task 5: Skill-distill reads only verified episodes

**Objective:** Skills must not be distilled from unverified claims.

**Files:**
- Modify: `src/cron/skill-distill.ts:recentMaterial`
- Test: `tests/unit/cron/skill-distill.test.ts` (check existing name first with `ls tests/unit/cron/`)

**Step 1: Write failing test**

```ts
it('ignores unverified episodes when building material', async () => {
  // Seed episodes: one outcome='done' linked to task_evidence assessment='unverified',
  // one outcome='done' with assessment='verified'.
  // Expect material to contain only the verified goal text.
});
```

Join `episodes.task_id = task_evidence.task_id AND task_evidence.assessment = 'verified'`. If no `task_evidence` row exists (old data), treat as unverified and exclude.

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/cron/skill-distill.test.ts --maxWorkers=2`
Expected: FAIL — unverified episode text present

**Step 3: Write minimal implementation**

```sql
SELECT e.goal, e.outcome, e.summary FROM episodes e
JOIN task_evidence t ON t.task_id = e.task_id AND t.assessment = 'verified'
WHERE e.created_at > ? ORDER BY e.created_at DESC LIMIT 20
```

Keep the 30-row `experience_entries` query unchanged in this task, but add a code comment marking it as Task 6 work.

**Step 4: Run test to verify pass**

Run: same vitest command
Expected: PASS

**Step 5: Commit**

```bash
git add src/cron/skill-distill.ts tests/unit/cron/skill-distill.test.ts
git commit -m "fix(skills): distill only from verified episodes"
```

---

### Task 6: Skill verified-use tracking (no retroactive credit)

**Objective:** Distinguish retrieval counts from verified helpfulness.

**Files:**
- Create: `migrations/0074_skill_verified_use.sql`
- Modify: `src/agent/skills.ts`, `src/subagent/executor.ts` (skill injection block ~636-655)
- Test: `tests/unit/agent/skill-verified-use.test.ts`

**Step 1: Write failing test**

```ts
it('bumps verified_use only on verified tasks, never rewrites use_count', () => {
  const id = saveSkill({ name: 'probe', triggerWhen: 'when x', steps: 'do x', tags: [] })!;
  recordSkillVerifiedUse([id], 'verified');
  recordSkillVerifiedUse([id], 'unverified');
  const row = getDb().prepare('SELECT use_count, verified_use_count FROM skills WHERE id = ?').get(id);
  expect(row).toMatchObject({ use_count: 0, verified_use_count: 1 });
});
```

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/agent/skill-verified-use.test.ts --maxWorkers=2`
Expected: FAIL — "no such file" or "recordSkillVerifiedUse is not defined"

**Step 3: Write minimal implementation**

```sql
ALTER TABLE skills ADD COLUMN verified_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN last_verified_use_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_skills_verified_use ON skills(archived, verified_use_count DESC);
```

```ts
export function recordSkillVerifiedUse(ids: number[], evidence: 'verified' | 'failed' | 'unverified'): void {
  if (evidence !== 'verified' || !ids.length) return;
  try {
    const stmt = getDb().prepare(
      `UPDATE skills SET verified_use_count = verified_use_count + 1, last_verified_use_at = ? WHERE id = ?`,
    );
    const ts = Math.floor(Date.now() / 1000);
    for (const id of ids) stmt.run(ts, id);
  } catch (err) {
    logger.warn({ err }, 'recordSkillVerifiedUse failed');
  }
}
```

In `executor.ts`, track injected skill ids in a local (like `injectedExperienceIds`) and call `recordSkillVerifiedUse(ids, task.assessment?.status ?? 'unverified')` next to the existing `recordInjectOutcome` call. Do NOT touch `use_count` semantics.

**Step 4: Run test to verify pass**

Run: same vitest command plus `tests/unit/agent/` skill-related files
Expected: PASS

**Step 5: Commit**

```bash
git add migrations/0074_skill_verified_use.sql src/agent/skills.ts src/subagent/executor.ts tests/unit/agent/skill-verified-use.test.ts
git commit -m "feat(skills): track verified use separately from retrieval"
```

---

### Task 7: Self-edit guardrails (cooldown, diff-size, assessment note)

**Objective:** Self-modification stays auditable and cannot self-certify.

**Files:**
- Modify: `src/agent/self-improve.ts`, `src/subagent/host-api.ts:1952-1953`
- Test: `tests/unit/agent/self-improve.test.ts` (check existing name first)

**Step 1: Write failing test**

```ts
it('rejects self-edit within cooldown', () => {
  selfEditPrompt('task/x.md', 'a'.repeat(100), 'first');
  const r = selfEditPrompt('task/y.md', 'b'.repeat(100), 'second');
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/cooldown/);
});

it('rejects oversized prompt rewrites', () => {
  const r = selfEditPrompt('task/x.md', 'c'.repeat(20000), 'too big', { skipCooldownForTest: true });
  expect(r.ok).toBe(false);
});
```

Cooldown: 1 edit per 24h per process (module-level timestamp; injectable clock optional). Size cap: new content ≤ 8000 chars. Keep existing traversal/`.md`/empty guards untouched.

**Step 2: Run test to verify failure**

Run: `PATH=/root/.hermes/node/bin:$PATH ./node_modules/.bin/vitest run tests/unit/agent/self-improve.test.ts --maxWorkers=2`
Expected: FAIL — second edit still succeeds

**Step 3: Write minimal implementation**

```ts
let lastEditAt = 0;
export function selfEditPrompt(path: string, content: string, motive: string, opts?: { skipCooldownForTest?: boolean }): SelfEditResult {
  if (!opts?.skipCooldownForTest && Date.now() - lastEditAt < 24 * 3600 * 1000) {
    return { ok: false, reason: 'self-edit cooldown: one edit per 24h' };
  }
  if (String(content ?? '').length > 8000) return { ok: false, reason: 'content too large (max 8000 chars)' };
  // ... existing guards and write ...
  lastEditAt = Date.now();
}
```

In `host-api.ts`, wrap the result: on success append the current task assessment (`unverified` unless proven) to the motive note via `recordMotive`-compatible text — do NOT mark the edit as verified. No new prompt-file writes in this task.

**Step 4: Run test to verify pass**

Run: same vitest command
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/self-improve.ts src/subagent/host-api.ts tests/unit/agent/self-improve.test.ts
git commit -m "feat(self-edit): add cooldown and size guardrails"
```

---

### Task 8: Env flags, docs, full verification, independent review

**Objective:** Ship Phase 2 behind flags with honest docs and a clean gate.

**Files:**
- Modify: `src/env.ts`, `docs/agent-evidence.md`, `docs/evidence-release-checks.md`
- Test: full suite + typecheck + lint + build + both eval scripts

**Step 1: Add flags (default OFF)**

```ts
GOAL_EVIDENCE_GATE_ENABLED: booleanFromEnv.default(false),
SKILL_VERIFIED_USE_ENABLED: booleanFromEnv.default(false),
SELF_EDIT_GUARDRAILS_ENABLED: booleanFromEnv.default(false),
```

Gate the Task 2/3/6/7 call sites on these flags. When OFF, behavior must match pre-Phase-2 (legacy `setGoalStatus` path preserved behind the flag). Document graylist expectation per AGENTS.md.

**Step 2: Update docs**

In `docs/agent-evidence.md`, add a "Phase 2" section stating: goal `achieved` now requires host-verified evidence; unverified completions stay open; episodes derive outcome from assessment; skill-distill reads verified episodes only; `use_count` is retrieval, `verified_use_count` is the new learning signal; self-edit has cooldown/size limits and never self-certifies. Explicitly list what is still NOT proven (cross-domain generalization, memory ON/OFF gains, long-horizon recovery).

**Step 3: Run full verification**

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm run typecheck
npm test -- --maxWorkers=2
./node_modules/.bin/tsx scripts/eval-agent-evidence.ts
npm run lint
npm run build
```

Expected: typecheck 0, tests 270+ files green (1 skipped file pre-existing), eval 13/13, lint 0, build success. Any failure is a real regression — fix, don't skip.

**Step 4: Independent review, then commit**

Run `independent-code-review` skill on the Phase 2 diff (fail-closed JSON). Fix blocking findings before commit.

```bash
git add src/env.ts docs/agent-evidence.md docs/evidence-release-checks.md
git commit -m "feat(flags): gate phase-2 evidence learning behind env flags"
```

---

## Explicitly out of scope (do NOT implement)

- New check kinds beyond `nonempty_file/json_field/sha256`
- Container/UID sandbox isolation for `computer.run` (documented pre-existing boundary)
- Retroactive rewrite of historical `verified` flags or episode outcomes
- Cross-domain held-out benchmarks or memory ON/OFF experiments (next research milestone, needs real runs)
- Any production deploys, `.env` edits, or database writes outside tests

## Remember

```
Bite-sized tasks (2-5 min each)
Exact file paths
Complete code (copy-pasteable)
Exact commands with expected output
Verification steps
DRY, YAGNI, TDD
Frequent commits
```
