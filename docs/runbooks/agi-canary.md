# NyatBot AGI-like Agency canary runbook

This runbook is intentionally closed by default. It is for an internal group
and a human operator; the repository does not start Telegram, change the
production service, or widen authority by itself.

## Frozen baseline

1. Record the branch commit (`git rev-parse HEAD`) and a sanitized config
   snapshot. Keep `AGENCY_RUNTIME_MODE=shadow`, all authority transports off,
   and capture at least one complete observation window with the legacy path.
2. Freeze the event/task sample IDs and the time window. Do not mix a new code
   version or a new cohort into the frozen baseline.
3. Store the baseline report using the
   `agency_canary_acceptance_window` schema from `src/eval/agency-canary.ts`.

## Experiment group

Use one internal chat only, with an explicit allowlist:

```dotenv
AGENCY_RUNTIME_MODE=canary
AGENCY_CANARY_CHAT_IDS=-1001234567890
AGENCY_FAIL_CLOSED=true
AGENCY_CODEACT_TRANSPORT_ENABLED=false
AGENCY_REPLY_TRANSPORT_ENABLED=false
AGENCY_WAIT_TRANSPORT_ENABLED=false
```

The first experiment should observe/readonly actions only. Do not enable an
authority transport or irreversible adapter in the first window. The host must
continue to own acceptance, message IDs, task IDs, scope, and receipts.

## Acceptance and rollback

Run `evaluateCanaryWindow` with the frozen baseline and the experiment facts.
Rollback means changing the runtime mode back to `shadow` (or disabling the
specific adapter) and restarting only after a human approves that operational
step. Roll back immediately for any:

- scope/visibility violation, unauthorized side effect, or unresolved duplicate;
- false-success rate above the configured threshold;
- human intervention, latency, or token-cost regression above the threshold;
- missing event/receipt/outcome or a sandbox isolation failure.

Never delete events, receipts, evidence, or skill revisions during rollback.

## Report template

Every report must include code version, sanitized config, exact time window,
sample counts, baseline/experiment cohort, failure sample IDs, verified
success and false-success rates, Wilson 95% intervals, latency/tool/token
metrics, and the rollback decision. If the window is too small or lacks real
external acceptance, state that it is insufficient for an AGI-like conclusion.

## Human-only final steps

Merge, production restart, and opening a real internal Telegram canary are
human actions. This repository's tests and offline harness must pass before
those actions are considered.
