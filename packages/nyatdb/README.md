# @nyat/nyatdb

Page-store embedded ChatLog engine for NyatBot (TypeScript + optional Rust napi).

Standalone mirror: https://github.com/ZYHUO/nyatdb

## Usage

```ts
import { openNyatDb, closeNyatDb, packChatLogBody } from '@nyat/nyatdb';

const db = openNyatDb('./data/nyatdb', { preferNative: true });
// …
closeNyatDb();
```

Host bot wires flags via a thin adapter (`src/nyatdb/` in nyat-bot) — this package does **not** read `process.env`.

## Build native (optional)

```bash
npm run build:nyatdb   # from repo root → native/nyatdb
```
