# Release checks — evidence-driven agent

## Baseline

- Isolated source snapshot: `0d14cc1b29df4c1ad4af6e223c532cef722e1011`.
- Snapshot includes pre-existing local changes; these are NOT authored by this implementation.
- Baseline typecheck: passed.
- Baseline full test run: 264 files passed, 1 skipped; 2332 tests passed, 6 skipped.
- Existing toolchain warning: Vite/esbuild does not recognize `ES2024` target in tsconfig; separate tsup Node22 build succeeds. This warning predates the evidence integration.
- No production service restart or database migration performed.

## Verification discipline

- RED/GREEN persistence tests exercised an actual in-memory SQLite database and the real new migration.
- Persisted `lifecycle=done, assessment=unverified` remains explicitly unverified.
- Same-ID updates are idempotent; cross-chat collisions are rejected; invalid counts and missing schemas return failure.
- Final code review and regression results are appended after integration, not inferred from this baseline.

## Phase 2 gate (all flags default OFF)

- `GOAL_EVIDENCE_GATE_ENABLED=1`: goal `achieved` requires host-verified evidence; unverified claims stay active.
- `SKILL_VERIFIED_USE_ENABLED=1`: `verified_use_count` increments only on verified tasks.
- `SELF_EDIT_GUARDRAILS_ENABLED=1`: 24h cooldown + 8000-char cap on self-edit.

Verify: `tests/unit/env.test.ts` (defaults OFF + override), `tests/unit/agent/goals.test.ts` (gate),
`tests/unit/cron/skill-distill.test.ts` (verified-only material),
`tests/unit/agent/skill-verified-use.test.ts` (no `use_count` rewrite),
`tests/unit/agent/self-improve.test.ts` (cooldown + size, env-mocked ON).
