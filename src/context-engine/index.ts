/**
 * Host adapter for @nyat/context-engine — maps CONTEXT_ENGINE_ENABLED + pino.
 */
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import {
  setContextEngineOptions,
  getContextEngine as getPkg,
  _resetContextEngines,
  ContextEngine,
  type ContextEngineOptions,
} from '@nyat/context-engine';

export type {
  AssembleResult,
  ContextManifest,
  ContextManifestEntry,
  ContextPart,
  ContextProvider,
  ContextTier,
} from '@nyat/context-engine';
export { staticText, deltaText, ephemeralText, volatileText } from '@nyat/context-engine';
export { ContextEngine, _resetContextEngines };

let wired = false;

function ensureWired(): void {
  if (wired) return;
  wired = true;
  setContextEngineOptions({
    enabled: env().CONTEXT_ENGINE_ENABLED,
    logger: {
      warn: (obj, msg) => logger.warn(obj, msg),
      debug: (obj, msg) => logger.debug(obj, msg),
    },
  });
}

/** Same singleton API as before; refreshes options from env each call. */
export function getContextEngine(name: string, opts?: ContextEngineOptions): ContextEngine {
  ensureWired();
  // Keep enabled in sync with live env (admin may flip flags later via restart mostly).
  setContextEngineOptions({
    enabled: env().CONTEXT_ENGINE_ENABLED,
    logger: {
      warn: (obj, msg) => logger.warn(obj, msg),
      debug: (obj, msg) => logger.debug(obj, msg),
    },
  });
  return getPkg(name, opts);
}
