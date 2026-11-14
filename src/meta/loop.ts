import { env } from '../env.js';
import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { getAttentionAccumulator } from './attention.js';
import { getGlobalState } from './global-state.js';
import { runMetaSession } from './session.js';
import type { AttentionItem } from './types.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import type { CodeActActivationReason } from '../subagent/activation-policy.js';

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
// Keep a failed archive write in-process for retry; it must never become runnable
// Attention with a fresh timestamp. Deployment also archives the original queues.
const pendingHolds = new Map<string, { kind: 'callback' | 'defer'; raw: string; chatId: number; reason: CodeActActivationReason }>();

async function flushActivationHolds(): Promise<void> {
  if (!pendingHolds.size) return;
  try {
    const { getRedis } = await import('../db/redis.js');
    for (const [id, held] of pendingHolds) {
      await getRedis().hsetnx('xxb:meta:activation-held', id, held.raw);
      pendingHolds.delete(id);
      logger.warn({ kind: held.kind, chatId: held.chatId, reason: held.reason }, 'Meta replay input held by activation policy');
    }
  } catch {
    logger.warn({ pending: pendingHolds.size }, 'Meta activation archive unavailable; retaining rejected inputs in memory for retry');
  }
}

async function allowReplay(kind: 'callback' | 'defer', input: { chatId: number; createdAt?: number }): Promise<boolean> {
  const decision = checkCodeActActivation(input);
  if (decision.allowed) return true;
  const serialized = JSON.stringify(input);
  const id = `${kind}:${createHash('sha256').update(serialized).digest('hex')}`;
  if (!pendingHolds.has(id)) pendingHolds.set(id, {
    kind, chatId: input.chatId, reason: decision.reason,
    raw: JSON.stringify({ kind, reason: decision.reason, heldAt: Date.now(), input }),
  });
  await flushActivationHolds();
  return false;
}

export async function metaTick(): Promise<void> {
  if (ticking) return;
  if (!env().META_SUBAGENT_ENABLED) return;
  ticking = true;
  let flushed: AttentionItem[] = [];
  try {
    const state = getGlobalState();
    await flushActivationHolds();
    const drainedCallbacks = await state.drainCallbacks();
    const callbacks = [] as typeof drainedCallbacks;
    const acc = getAttentionAccumulator();
    for (const cb of drainedCallbacks) {
      // Check the original timestamp before ingestAsync assigns a new one.
      if (!await allowReplay('callback', cb)) continue;
      callbacks.push(cb);
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
        let replayed = 0;
        for (const d of due) {
          if (!await allowReplay('defer', d)) continue;
          await acc.ingestAsync({
            chatId: d.chatId,
            layer: d.layer,
            reason: `defer_replay:${d.reason}`,
            messageId: d.messageId,
            userId: d.userId,
            textPreview: d.textPreview,
            pressure: d.pressure,
            cognitiveAnchorEventId: d.cognitiveAnchorEventId,
            payload: {
              ...(d.payload ?? {}),
              deferCount: d.deferCount,
            },
          });
          replayed++;
        }
        if (replayed) {
          logger.info({ count: replayed }, 'Meta defer: re-ingested due items');
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
