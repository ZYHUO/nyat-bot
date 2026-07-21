import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getAttentionAccumulator } from './attention.js';
import { getGlobalState } from './global-state.js';
import { runMetaSession } from './session.js';

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function metaTick(): Promise<void> {
  if (ticking) return;
  if (!env().META_SUBAGENT_ENABLED) return;
  ticking = true;
  let flushed: ReturnType<ReturnType<typeof getAttentionAccumulator>['flush']> = [];
  try {
    const state = getGlobalState();
    const callbacks = state.drainCallbacks();
    const acc = getAttentionAccumulator();
    for (const cb of callbacks) {
      acc.ingest({
        chatId: cb.chatId,
        layer: 'L1_CALLBACK',
        reason: `callback:${cb.ok ? 'ok' : 'fail'}`,
        textPreview: cb.summary,
        payload: { taskId: cb.taskId },
      });
    }

    if (acc.size() === 0) return;
    flushed = acc.flush();
    await runMetaSession(flushed, callbacks);
  } catch (err) {
    logger.warn({ err }, 'metaTick failed');
    if (flushed.length) {
      getAttentionAccumulator().requeue(flushed);
    }
  } finally {
    ticking = false;
  }
}

export function startMetaLoop(): void {
  if (timer) return;
  if (!env().META_SUBAGENT_ENABLED) {
    logger.info('Meta loop not started (META_SUBAGENT_ENABLED=false)');
    return;
  }
  const ms = env().META_TICK_MS;
  timer = setInterval(() => {
    void metaTick();
  }, ms);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  logger.info({ tickMs: ms }, 'Meta+Subagent loop started');
  // Kick once so L0 during boot window isn't delayed a full tick
  void metaTick();
}

export function stopMetaLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
