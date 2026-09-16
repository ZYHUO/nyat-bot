/**
 * NyatDB native loader (Rust / napi-rs).
 * Host builds via `npm run build:nyatdb` → native/nyatdb/*.node
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Resolve addon dir for package src/dist, repo root, and host cwd.
 *
 * After tsup bundles @nyat/nyatdb into dist/index.js, `import.meta.url`
 * points at dist/ — the old relative paths (../../../native/nyatdb) break.
 * We probe multiple anchors and walk up from each looking for native/nyatdb.
 */
function resolveNativeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // Build candidate root anchors — each is walked up a few levels.
  const anchors = [
    process.cwd(), // systemd WorkingDirectory or dev cwd
    here, // this file's dir (src/ or dist/ or packages/nyatdb/src)
    dirname(process.argv[1] ?? ''), // main script dir (node dist/index.js)
  ];

  const probe = (root: string): string | null => {
    let dir = resolve(root);
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'native/nyatdb');
      if (existsSync(join(candidate, 'index.js'))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    return null;
  };

  for (const anchor of anchors) {
    const found = probe(anchor);
    if (found) return found;
  }

  // Last resort: try require.resolve on the optional peer package.
  try {
    const resolved = require.resolve('@nyat/nyatdb-native');
    return dirname(resolved);
  } catch {
    /* fall through */
  }

  // Fallback to cwd-based path (legacy behavior) so error messages are useful.
  return join(process.cwd(), 'native/nyatdb');
}

const NATIVE_DIR = resolveNativeDir();
const NATIVE_ENTRY = join(NATIVE_DIR, 'index.js');

export type NativeOpenOptions = {
  path: string;
  syncEvery?: number;
  poolFrames?: number;
  chatRingMax?: number;
  verifyOnOpen?: boolean;
};

export type NativeEngineStats = {
  pages: number;
  chats: number;
  recalls: number;
  indexed: number;
  lsn: string;
  backend: string;
  schema: number;
  poolCached: number;
  poolDirty: number;
};

export type NativeChatMessage = {
  messageId: number;
  ts: number;
  uid: number;
  role: number;
  roleName: string;
  text: string;
  bodyFormat?: string;
};

export type NativeChatAppend = {
  messageId: number;
  ts: number;
  uid: number;
  role: string;
  text: string;
  bodyFormat?: string;
};

export type NyatDbNativeHandle = {
  path(): string;
  stats(): NativeEngineStats;
  checkpoint(): void;
  verify(): number;
  chatAppend(chatId: number, msg: NativeChatAppend): void;
  chatRecent(chatId: number, limit?: number): NativeChatMessage[];
  chatGet(chatId: number, messageId: number): NativeChatMessage | null;
  chatGetBatch(chatId: number, messageIds: number[]): Array<NativeChatMessage | null>;
  chatTrimKeepLast(chatId: number, keep: number): void;
  hotSet(key: string, value: Buffer, ttlMs?: number): void;
  hotGet(key: string): Buffer | null;
  hotGetString(key: string): string | null;
  hotDel(key: string): void;
  impulseSchedule(
    id: string,
    chatId: number,
    runAt: number,
    kind: string,
    payload: Buffer,
  ): void;
  impulseDue(now?: number, limit?: number): Array<{
    id: string;
    chatId: number;
    runAt: number;
    kind: string;
    payload: number[];
  }>;
  impulseAck(id: string): void;
  bondUpsert(b: { uid: number; chatId: number; score: number; note: string }): void;
  bondList(limit?: number): Array<{ uid: number; chatId: number; score: number; note: string }>;
  recallUpsert(chatId: number, messageId: number, vector: Float64Array | number[], visibility?: number): void;
  recallSearch(
    query: Float64Array | number[],
    chatId?: number | null,
    topK?: number,
    minVisibility?: number,
  ): Array<{ chatId: number; messageId: number; score: number }>;
  close(skipCheckpoint?: boolean | null): void;
  ping(): string;
};

type NativeModule = {
  NyatDbNative: { open(opts: NativeOpenOptions): NyatDbNativeHandle };
  nativeVersion(): string;
  schemaVersion(): number;
};

let cached: NativeModule | null | undefined;

function tryLoad(): NativeModule | null {
  if (cached !== undefined) return cached;
  if (!existsSync(NATIVE_ENTRY)) {
    cached = null;
    return null;
  }
  try {
    const mod = require(NATIVE_ENTRY) as NativeModule;
    if (!mod?.NyatDbNative) {
      cached = null;
      return null;
    }
    cached = mod;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function isNyatDbNativeAvailable(): boolean {
  return tryLoad() !== null;
}

export function openNyatDbNative(opts: NativeOpenOptions): NyatDbNativeHandle {
  const mod = tryLoad();
  if (!mod) throw new Error('nyatdb_native_unavailable');
  return mod.NyatDbNative.open(opts);
}

export function nativeVersion(): string | null {
  return tryLoad()?.nativeVersion() ?? null;
}
