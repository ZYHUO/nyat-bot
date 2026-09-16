/**
 * @nyat/nyatdb — page-store engine (no host env / Telegram deps).
 */
import { NyatDb } from './engine.js';
import { NyatDbNativeFacade } from './facade.js';
import {
  isNyatDbNativeAvailable,
  openNyatDbNative,
  nativeVersion,
} from './native.js';

export { NyatDb } from './engine.js';
export { NyatDbNativeFacade } from './facade.js';
export { PAGE_SIZE } from './format/constants.js';
export { RECALL_DIM } from './format/codec.js';
export {
  packChatLogBody,
  unpackChatLogRow,
  chatAppendFromFormatted,
  utf8ByteSlice,
  toChatLogPayload,
  CHAT_JSON_MAX_BYTES,
  type ChatLogPayload,
  type ChatLogLikeMessage,
} from './chat-log.js';
export {
  isNyatDbNativeAvailable,
  openNyatDbNative,
  nativeVersion,
  type NativeOpenOptions,
  type NyatDbNativeHandle,
} from './native.js';

export type NyatDbHandle = NyatDb | NyatDbNativeFacade;

export type NyatDbOpenOptions = {
  path: string;
  syncEvery?: number;
  poolFrames?: number;
  chatRingMax?: number;
  verifyOnOpen?: boolean;
  /** Prefer Rust addon when built; falls back to TS. */
  preferNative?: boolean;
};

export type NyatDbLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
};

const noopLogger: NyatDbLogger = {
  info: () => undefined,
  warn: () => undefined,
};

let _db: NyatDbHandle | undefined;
let _logger: NyatDbLogger = noopLogger;

/** Optional process-wide logger (host injects pino wrapper). */
export function setNyatDbLogger(logger: NyatDbLogger): void {
  _logger = logger;
}

/**
 * Open (or return) the process-local singleton.
 * Pass `enabled: false` to no-op (host maps NYATDB_ENABLED here).
 */
export function getNyatDb(opts: NyatDbOpenOptions & { enabled?: boolean }): NyatDbHandle | null {
  if (opts.enabled === false) return null;
  if (!_db) {
    _db = openNyatDb(opts.path, opts);
  }
  return _db;
}

export function openNyatDb(path: string, opts?: Omit<NyatDbOpenOptions, 'path'>): NyatDbHandle {
  const open = {
    path,
    syncEvery: opts?.syncEvery ?? 1,
    poolFrames: opts?.poolFrames ?? 32,
    chatRingMax: opts?.chatRingMax,
    verifyOnOpen: opts?.verifyOnOpen,
  };
  const preferNative = opts?.preferNative !== false;
  if (preferNative && isNyatDbNativeAvailable()) {
    const native = openNyatDbNative(open);
    const handle = new NyatDbNativeFacade(native);
    _logger.info(
      { path: open.path, backend: 'native-rust', version: nativeVersion(), stats: handle.stats() },
      'NyatDB opened (native)',
    );
    return handle;
  }
  if (opts?.preferNative && !isNyatDbNativeAvailable()) {
    _logger.warn('preferNative=true but addon missing; falling back to TS engine');
  }
  const handle = NyatDb.open(open);
  _logger.info({ path: open.path, backend: 'typescript', stats: handle.stats() }, 'NyatDB opened');
  return handle;
}

export function closeNyatDb(): void {
  if (_db) {
    _db.close({ skipCheckpoint: false });
    _db = undefined;
  }
}
