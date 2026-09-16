# @nyat/context-engine

Tiered prompt assembly for Meta/Subagent (and anything else that wants a stable
prefix for prompt cache):

`static` → `delta` → `ephemeral` → `volatile`

Returns `{ prompt, manifest }` with per-part cache-hit fingerprints.

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
