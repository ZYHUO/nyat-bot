# OneBot adapter validation — 2026-11-14

Validation ran in an isolated Linux staging checkout with Node 22, its own
dependency directory, synthetic test credentials, and no production environment
file, chat database or conversation logs. No live QQ client was connected.

| Check | Observed result |
| --- | --- |
| TypeScript | Passed |
| ESLint | Passed |
| Build | Passed |
| Bundle verification | 129 / 129 checks passed |
| Platform, sender-boundary and unknown-delivery tests | 147 passed across 12 files; zero failed |
| Full Vitest run | 4,646 passed, 31 failed, 9 skipped across 592 files |

The full suite is **not fully green** in this clean environment. Its 31 failing
assertions are in these ten existing tests:

| Test | Failed assertions | Missing environment or fixture |
| --- | --- | --- |
| [judge-chain-cross-account](../tests/unit/ai/judge-chain-cross-account.test.ts) | 4 | Private provider configuration |
| [no-tiny-maxtokens](../tests/unit/ai/no-tiny-maxtokens.test.ts) | 1 | Private provider configuration |
| [reflection-label-isolation](../tests/unit/ai/reflection-label-isolation.test.ts) | 1 | Private provider configuration |
| [usage-labels-exist](../tests/unit/ai/usage-labels-exist.test.ts) | 11 | Configured provider labels |
| [coherence-decision](../tests/unit/scripts/coherence-decision.test.ts) | 2 | Historical runtime data |
| [log-count](../tests/unit/scripts/log-count.test.ts) | 5 | Historical application log |
| [measure-split-failed-pass](../tests/unit/scripts/measure-split-failed-pass.test.ts) | 1 | Historical log for the fixed replay date |
| [session-report-runs](../tests/unit/scripts/session-report-runs.test.ts) | 2 | Runtime SQLite and logs |
| [topic-repeat-production-replay](../tests/unit/subagent/topic-repeat-production-replay.test.ts) | 3 | Historical application log |
| [asi-rubric-budget](../tests/unit/tracking/asi-rubric-budget.test.ts) | 1 | Private provider configuration |

The [artist test](../tests/unit/agent/artist.test.ts) was excluded from this run
because its native model dependency previously raised an illegal-instruction
fault on this host's CPU. It is not counted as passing. The nine reported skips
are separate from that exclusion. Production credentials and chat logs were not
copied into staging to satisfy environment-specific assertions.

The passing QQ tests include real loopback WebSocket frames, authentication and
account checks, SQLite identity persistence, shared message ingress, scoped
mentions and quotes, Telegram boundary rejection, reconnect, and durable holds
for uncertain delivery. They do not verify QQ login, an external client's media
support, or actual messages reaching QQ. Follow the
[setup and capability matrix](onebot-qq.md) for the remaining live-client checks.
