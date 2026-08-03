import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getAttentionAccumulator } from './attention.js';
import { getGlobalState } from './global-state.js';
import { runMetaSession } from './session.js';
import type { AttentionItem } from './types.js';

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function metaTick(): Promise<void> {
  if (ticking) return;
  if (!env().META_SUBAGENT_ENABLED) return;
  ticking = true;
  let flushed: AttentionItem[] = [];
  try {
    const state = getGlobalState();
    const callbacks = await state.drainCallbacks();
    const acc = getAttentionAccumulator();
    for (const cb of callbacks) {
      await acc.ingestAsync({
        chatId: cb.chatId,
        layer: 'L1_CALLBACK',
        reason: `callback:${cb.ok ? 'ok' : 'fail'}`,
        textPreview: cb.summary,
        payload: { taskId: cb.taskId },
      });
    }

    // Drain due Meta defer items → re-ingest as Attention for Meta session to
    // reconsider. 不重跑 gate（与 wait-resume 一致：defer-resume 直接进 Attention，
    // Meta 的 autoDispatch + LLM 是最终仲裁者）。
    if (env().META_DEFER_ENABLED) {
      try {
        const { drainDueMetaDefers } = await import('./defer.js');
        const due = await drainDueMetaDefers();
        for (const d of due) {
          await acc.ingestAsync({
            chatId: d.chatId,
            layer: d.layer,
            reason: `defer_replay:${d.reason}`,
            messageId: d.messageId,
            userId: d.userId,
            textPreview: d.textPreview,
            pressure: d.pressure,
            payload: {
              ...(d.payload ?? {}),
              deferCount: d.deferCount,
            },
          });
        }
        if (due.length) {
          logger.info({ count: due.length }, 'Meta defer: re-ingested due items');
        }
      } catch (err) {
        logger.warn({ err }, 'Meta defer drain in metaTick failed (non-critical)');
      }
    }

    if ((await acc.size()) === 0) return;
    flushed = await acc.flush();
    if (flushed.length === 0 && callbacks.length === 0) return;
    await runMetaSession(flushed, callbacks);
  } catch (err) {
    logger.warn({ err }, 'metaTick failed');
    if (flushed.length) {
      await getAttentionAccumulator().requeue(flushed);
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
  void metaTick();
}

export function stopMetaLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
