/**
 * Host adapter for @nyat/nyatdb — maps NYATDB_* env flags → package API.
 * Engine lives in packages/nyatdb; do not put storage logic here.
 */
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import {
  closeNyatDb as closePkg,
  getNyatDb as getPkg,
  openNyatDb as openPkg,
  setNyatDbLogger,
  isNyatDbNativeAvailable,
  type NyatDbHandle,
} from '@nyat/nyatdb';

export {
  NyatDb,
  NyatDbNativeFacade,
  PAGE_SIZE,
  RECALL_DIM,
  packChatLogBody,
  unpackChatLogRow,
  chatAppendFromFormatted,
  utf8ByteSlice,
  toChatLogPayload,
  CHAT_JSON_MAX_BYTES,
  isNyatDbNativeAvailable,
  openNyatDbNative,
  nativeVersion,
  type NyatDbHandle,
  type ChatLogPayload,
  type ChatLogLikeMessage,
} from '@nyat/nyatdb';

setNyatDbLogger({
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => {
    if (typeof obj === 'string') logger.warn(obj);
    else logger.warn(obj, msg ?? '');
  },
  debug: (obj, msg) => logger.debug(obj, msg),
});

export function shouldUseNyatDbNative(): boolean {
  return env().NYATDB_NATIVE && isNyatDbNativeAvailable();
}

export function getNyatDb(): NyatDbHandle | null {
  return getPkg({
    enabled: env().NYATDB_ENABLED,
    path: env().NYATDB_PATH,
    syncEvery: env().NYATDB_SYNC_EVERY,
    poolFrames: env().NYATDB_POOL_FRAMES,
    chatRingMax: env().NYATDB_CHAT_RING_MAX,
    verifyOnOpen: env().NYATDB_VERIFY_ON_OPEN,
    preferNative: env().NYATDB_NATIVE,
  });
}

export function openNyatDb(
  path: string,
  opts?: { syncEvery?: number; poolFrames?: number; preferNative?: boolean },
): NyatDbHandle {
  return openPkg(path, {
    syncEvery: opts?.syncEvery,
    poolFrames: opts?.poolFrames,
    preferNative: opts?.preferNative ?? env().NYATDB_NATIVE,
  });
}

export function closeNyatDb(): void {
  closePkg();
}
