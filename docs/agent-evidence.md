# Evidence-driven agent: scope and verification

This iteration is a foundation for reliable agency, **not an AGI implementation or an AGI benchmark result**. It preserves NyatBot's personality and LLM-directed tool use while separating scheduler completion from externally checkable achievement.

## Why this change

Previously, `auto_end_after_send` and `failsafe_plain_reply` could be `done`, and the experience verifier was passed zero tool/error/retry counts. Missing telemetry scored 0.8, exceeding the 0.7 success threshold. That could reward experiences without evidence they helped achieve a goal.

The corrected distinction is:
- **Lifecycle** (`queued/running/done/failed`): executor scheduling, retained for compatibility.
- **Assessment** (`verified/failed/unverified`): what host-side acceptance checks establish.
- **Telemetry**: real operation observations and real iteration counts, not model-written summaries.

No historical episode is retroactively certified.

## Acceptance contracts

A task caller can supply acceptance conditions before execution, e.g.:

```ts
acceptance: {
  source: 'caller',
  checks: [
    { kind: 'json_field', path: 'result.json', field: ['sum'], equals: 55 },
    { kind: 'nonempty_file', path: 'report.csv' },
  ],
}
```

The model may propose checks for its own work. Passing a model-proposed check is useful diagnostic feedback, but **does not independently prove that the user's request was met**. A caller contract is trusted only insofar as the caller actually represents external acceptance, not another self-grading model. An arbitrary external caller must never be allowed to smuggle `source: 'caller'` through free-form model output.

File checks are deliberately limited: nonempty, JSON field equality, SHA256. They reject malformed contracts and sandbox escapes and impose resource limits. A nonempty-file check proves only existence of nonempty bytes, not report truth, usability, delivery, or correctness. Choose checks matching the real goal; do not advertise `verified` as broader than the supplied contract.

## Learning

Only verified outcomes with observed acceptable execution quality may increment positive experience evidence. Unverified outcomes neither reward nor punish. Retrieval/use counts are not evidence that a skill improved performance. Existing legacy verified flags are not automatically erased; cleaning historical evidence requires a separately reviewed migration/experiment.

## Phase 2: evidence-gated goals and learning (flags default OFF)

`GOAL_EVIDENCE_GATE_ENABLED`, `SKILL_VERIFIED_USE_ENABLED`, `SELF_EDIT_GUARDRAILS_ENABLED` all default to `false`. When OFF, behavior matches pre-Phase-2 (legacy direct `achieved` path, no skill verified-use counting, ungated self-edit). When ON:

- Goal `achieved` requires host-verified evidence: `markGoalAchieved(id, 'verified', label)` throws on anything else; unverified model completion claims stay `active` via `recordUnverifiedCompletion` (new `verified_achievements` / `unverified_completions` / `last_evidence` columns from migration `0073`).
- Episodes derive outcome from assessment: lifecycle `done` + `unverified` is distilled as `failed`, so unverified claims cannot become skills or positive experience.
- Skill distillation reads verified episodes only (`JOIN task_evidence ... assessment='verified'`); rows without evidence (old data) are excluded, not assumed.
- `use_count` remains a retrieval counter; `verified_use_count` (migration `0074`) is the new learning signal, incremented only on `verified` tasks.
- Self-edit has a 24h cooldown and an 8000-char size cap, and never self-certifies (motive annotated with task assessment, not marked verified).

Still NOT proven by this phase: cross-domain generalization, memory/skill ON-vs-OFF learning gains, long-horizon recovery. Those need real held-out runs, not flag flips.

## Persistence

Migration `0072_task_evidence.sql` adds an evaluation sidecar instead of breaking the historical episodes schema. Evidence includes task ID, chat ID, assessment, lifecycle, bounded reason codes, actual turns, calls, failures and retries. Do not log tool bodies, secrets, private chat content, or generated code into these records. Persistence failures remain visible and do not make tasks successful.

## Run locally

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm run typecheck
npm test -- --maxWorkers=2
./node_modules/.bin/tsx scripts/eval-agent-evidence.ts
npm run lint
npm run build
```

The offline evaluation runs real child processes producing temporary files, and negative controls including missing, wrong, partial and malformed artifacts, self-check provenance, traversal and symlink escape. These are **engineering acceptance tests**. No model solves these tasks, so their pass rate is not a model intelligence score, generalization measurement or AGI evidence.

An explicit opt-in live component smoke test uses the configured StepFun provider and a deliberately restricted `write_file` action (no arbitrary generated code execution, no Telegram sends). The host independently checks a toy revenue calculation and can return failed checks for repair:

```bash
NYAT_LIVE_ENV=/root/xxb-ts/.env ./node_modules/.bin/tsx scripts/eval-agent-evidence-live.ts
```

It reads credentials without printing them, sends only the public toy task to the provider, limits to three attempts, and cleans its own temporary files. It is **not the full production bot loop**, a generalization benchmark, or a memory-learning experiment. Do not conflate this component test with end-to-end bot success.

## Safety and rollout

Development is isolated in `/root/nyat-agent-evidence`, baseline `0d14cc1` snapshots the previously uncommitted live code. Production `/root/xxb-ts`, `.env`, SQLite/Redis data and service are not modified by this implementation.

The existing `computer.run` terminal is **not an OS sandbox**: it runs a host shell with a command filter. File validator path checks do not fix that pre-existing boundary. Do not expand autonomous permissions or enable untrusted self-modification before isolating execution under a dedicated container/UID with restricted mounts and network access. This iteration does not claim containment of a malicious host-level process.

Rollout requires review of local-only baseline changes, backup of production code/config/data, migration compatibility checks and controlled canary evaluation. Rollback code without dropping the additive evidence table. No task success should depend on dropping data or rewriting previous migrations.

## Research milestones beyond this iteration

1. **External acceptance entry**: trusted structured caller goals and human approval of LLM-proposed criteria; natural-language planner alone is not ground truth.
2. **General task solving**: unseen tasks in programming, data work, information verification and document production, including tasks not covered by handcrafted tools.
3. **Long-horizon adaptation**: interrupt, restart, tool failure and changing-environment tests; inspect actual goal retention and recovery, not just checkpoint existence.
4. **Learning experiment**: frozen base model and budget, held-out paired tasks with skill/memory ON versus OFF. Measure success, false success, human interventions, cost and retention; report uncertainty.
5. **Safe policy improvement**: candidate changes tested against held-out regressions before promotion; independent verifier and rollback, not unrestricted self-editing.

Failure at any milestone is useful evidence and must be reported—not renamed to a higher AGI level.
