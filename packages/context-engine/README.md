# @nyat/context-engine

Tiered prompt assembly for Meta/Subagent (and anything else that wants a stable
prefix for prompt cache):

`static` → `delta` → `ephemeral` → `volatile`

Returns `{ prompt, manifest }` with per-part equality fingerprints (SHA-256, no
retained prompt plaintext). `cacheHitRatio` means unchanged text since the previous
assembly, **not** measured provider token-cache savings. Every call renders current
providers; omitted parts are never reused. Disabled mode clears equality history.
The process keeps at most 256 recently used engines, so idle conversations do not
retain unbounded metadata. Name engines by the trusted conversation scope.

## Usage

```ts
import {
  getContextEngine,
  staticText,
  deltaText,
  ephemeralText,
  volatileText,
  setContextEngineOptions,
} from '@nyat/context-engine';

setContextEngineOptions({ enabled: true });

const { prompt, manifest } = await getContextEngine('meta').assemble([
  staticText('persona', '…'),
  deltaText('task', '…'),
  ephemeralText('banned', '…'),
  volatileText('now', new Date().toISOString()),
]);
```

Host maps `CONTEXT_ENGINE_ENABLED` in `src/context-engine/` adapter.

Host-side history compression is separate from tiered assembly. Checkpoints are
versioned and bound to platform, account, conversation and topic. A referenced
checkpoint that is missing, unscoped or incompatible is held for review; it does
not silently restart work. Resumes rebuild the current system policy and identity.
Agent compaction only removes complete turns supplied to the summarizer; failure
retains unarchived history. Recent user corrections and unfinished task goals get
an independent bounded anchor, so an older full summary cannot displace them.

Mid-term summaries use the same provenance boundary and now reach the actual
CodeAct prompt as well as the legacy reply prompt. Legacy unscoped summaries stay
stored but are not injected. Input budgets are character ceilings, not tokenizer
measurements: whole messages outside the ceiling stay in context. Summaries retain
author/message/reply identifiers and tail anchors, but are historical evidence,
never authorization or a claim that an unfinished requirement is complete.
Redis topic summaries are isolated. The legacy NyatDB numeric topic-key format is
not safe for all identifiers; MTM for NyatDB-only non-General topics remains off
instead of falling back to another topic. No historical data is rewritten.
