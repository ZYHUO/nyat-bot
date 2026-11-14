# OneBot adapter validation — 2026-11-14

Validation ran in an isolated Linux staging checkout with Node 22, its own
dependency directory, synthetic test credentials, and no production environment
file, chat database or conversation logs. Unit/integration tests use loopback QQ
fixtures. Separate live-client and provider checks are described below.

| Check | Observed result |
| --- | --- |
| TypeScript | Passed |
| ESLint | Passed |
| Build | Passed |
| Bundle verification | 129 / 129 checks passed |
| QQ cadence regression | 115 passed across 9 files, including real WebSocket bursts into shared ingress |
| Text delivery and host regressions | 70 passed across 10 files; subsequent session checks also passed |
| Video extraction and analysis | 30 passed across 2 files |
| Full Vitest run | 4,969 passed, 31 failed, 9 skipped across 612 files |

These focused runs overlap the full suite and are not additional test totals.
The earlier text-only adapter baseline had 4,646 passes, the same 31 environment
failures and 9 skips across 592 files.

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
for uncertain delivery. Three incoming sentences one second apart reach Heart
as one batch and create one task. Earlier addressing is retained when the last
sentence has no mention; same-author additions enter the active task in order
without a second Meta dispatch. Tests also cover recall, shutdown, delayed Heart
results, QQ-specific system prompt overrides and unchanged Telegram behavior.

Request tests cover owner-only approval/rejection, uncertain outcomes and restart
holds. Attachment tests cover same-chat handles, source recalls, bounded streams,
connection changes, upload confirmation, per-bubble ACK accounting and no resend
after an uncertain outcome.

Separate checks against NapCat 4.18.42 verified account authentication and a
140,000-byte chunk upload with matching SHA-256, without sending it to a chat.
The owner had already confirmed a real private text reply on the prior release.
Production-identity checks verified image understanding, audio transcription and
TTS. A restricted video decoder extracted three sampled PNG frames from a
synthetic clip; the actual vision provider identified their content. Playlist,
malformed and oversized inputs were rejected. Sampled frames contain no audio
and do not establish understanding of every video codec or event.

These checks do not substitute for a real user receiving an attachment or for
subjective group-conversation quality. Follow the
[setup and capability matrix](onebot-qq.md) for the remaining live-client checks.
