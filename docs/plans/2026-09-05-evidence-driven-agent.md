# Evidence-driven Nyat Agent Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Deliver a tested first foundation for general-purpose agency: distinguish termination from verified success, observe actual execution, and permit learning only from trustworthy outcomes. This is not a claim to have built AGI.

**Architecture:** Preserve the current chat and CodeAct scheduler. Add evidence assessment independently of legacy lifecycle status, actual bounded host-operation telemetry, and deterministic artifact validators. Goal validation contracts supplied by the caller are distinguished from model-proposed checks. Persist assessment with DispatchTask and episode evaluation data; never infer success from a summary string or a Telegram send alone. Keep LLM-driven planning, no keyword intent classifier.

**Tech Stack:** TypeScript ESM, Node 22, Vitest, SQLite migrations, existing sandbox host API.

## Safety and baseline
- Work only in /root/nyat-agent-evidence (isolated clone of live tracked+untracked source).
- Baseline commit 0d14cc1 contains previously uncommitted user changes; never squash these into a new change without explicit provenance.
- Production /root/xxb-ts, .env, databases, services remain untouched.
- Use Node 22 PATH=/root/.hermes/node/bin:$PATH. Do not print secrets. Baseline typecheck passes.
- New optional interfaces preserve existing callers. Existing unverifiable history must not be relabelled as verified.

## Task 1 — Learning integrity and true iteration counts
Files: src/agent/path-quality.ts, src/agent/experience-verify.ts, src/subagent/executor.ts, src/agent/distiller.ts, associated tests.
1. RED: no observed execution must not count as positive evidence; outcome done without independent verification cannot promote experience.
2. GREEN: explicit evidence gate with safe default; unknown evidence neither rewards nor punishes. Explicit failure can remain failure feedback when observed.
3. Track actual executor iterations including failed LLM attempts and segment resume without double counting. Separate lifecycle completion from assessed achievement.
4. Verify selected tests, typecheck. Do not change episode legacy status schema incompatibly.

## Task 2 — Bounded operation evidence and artifact checks
Files: src/agent/task-evidence.ts and tests/unit/agent/task-evidence.test.ts.
1. RED: sending text or returning a success-looking summary alone is unverified; empty contract cannot verify a goal; model-supplied checks cannot certify caller goals.
2. GREEN: bounded real operation telemetry, normalized failures (thrown errors, ok:false, nonzero exitCode), deterministic acceptance checks for sandbox files (nonempty, JSON field equality, SHA256) with byte budget and symlink/path escape rejection.
3. Expose pure assessment and validator API, no DB/env/network dependency. Findings contain evidence, reasons, not secret output. Separate caller-provided vs proposed contracts.
4. RED/GREEN: missing/malformed/oversized files, stale or fabricated receipts, unsupported checks, model summary claims, partial progress, explicit execution failure, actual verified artifact.

## Task 3 — Integrate evidence into real CodeAct
Files: src/meta/types.ts, src/subagent/host-api.ts, src/subagent/executor.ts, migrations/0072_task_evidence.sql, src/agent/task-evidence-store.ts, tests/unit/subagent/*evidence*.test.ts.
1. Host creates receipt events from actual tool returns; model cannot supply arbitrary verdicts or forge receipts via runtime.
2. Add runtime acceptance proposals and host-run verification for artifact goals, plus caller contract carried on DispatchTask. Keep provenance distinct.
3. Persist task assessment and bounded counts separately from lifecycle. Goal checking and policy/experience success use verified evidence, not endSummary substring.
4. Feed failed checks back to executor so model can repair within existing budget rather than silently declaring completion. No new unlimited retry loop.
5. Test integration with existing host mocks and in-memory DB using real migration.

## Task 4 — Repeatable evaluation and release evidence
Files: scripts/eval-agent-evidence.ts, docs/agent-evidence.md, tests/unit/agent/*.
1. Build offline, deterministic artifact tasks with independently declared checks: CSV/data output, JSON computation, missing artifact, malformed artifact, traversal, partial output, failure/recovery. Use real filesystem artifacts, not fabricated API responses.
2. Execute harness and report validation metrics honestly as engineering acceptance tests, not AGI or model benchmark scores.
3. Run full unit tests, lint/typecheck/build; compare baseline failures if any. Independent spec review then quality review; fix findings.
4. Deliver local commits/patch and execution report. Remote PR must exclude private local-only baseline data and be reviewed for scope before publishing. No automatic production deployment this iteration.

## Beyond this first deliverable
Generalization evaluation with held-out tasks; controlled skill-memory ON/OFF trials; durable multi-step planning and environment-change recovery; learned policy promotion guarded by evaluation and rollback. These require actual experiments and may fail—no promised AGI attainment date.
