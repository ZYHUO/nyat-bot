import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import type { AttentionItem, AttentionLayer } from './types.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import { holdMetaScopeInput, inspectMetaAttention } from './input-scope.js';
import { getStartupOwnership, ownsMetaLoop } from '../startup/ownership.js';
import { pendingIntentEnabled, inspectPendingIntent, hasUnansweredIntentRevision } from './pending-intent.js';

const REDIS_KEY = 'xxb:meta:attention';
const MAX = 500;
/** 丢弃过期 Attention，避免重启后把几小时前的 L0 再回一遍 */
const MAX_AGE_MS = 30 * 60_000;

/** Kick metaTick when coalesce quiet window ends (don't wait full META_TICK_MS). */
let coalesceWakeTimer: ReturnType<typeof setTimeout> | null = null;
let coalesceWakeAt = 0;

function scheduleCoalesceWake(delayMs: number): void {
  // Ingress persists work for the owning process; it may not start a second Meta.
  if (!ownsMetaLoop(getStartupOwnership())) return;
  const ms = Math.max(50, Math.ceil(delayMs));
  const wakeAt = Date.now() + ms;
  // This timer is shared across chats. A passive chat's quiet window must not
  // postpone another chat's direct wake (nor may a steady stream of L0 reset
  // its 50 ms deadline forever). flush() rechecks each chat's own quiet window.
  if (coalesceWakeTimer && coalesceWakeAt <= wakeAt) return;
  if (coalesceWakeTimer) clearTimeout(coalesceWakeTimer);
  coalesceWakeAt = wakeAt;
  coalesceWakeTimer = setTimeout(() => {
    coalesceWakeTimer = null;
    coalesceWakeAt = 0;
    void import('./loop.js')
      .then(({ metaTick }) => metaTick())
      .catch(() => {});
  }, ms);
  if (typeof coalesceWakeTimer === 'object' && coalesceWakeTimer && 'unref' in coalesceWakeTimer) {
    (coalesceWakeTimer as NodeJS.Timeout).unref?.();
  }
}

function directCoalesceWindow(): { quietMs: number; maxMs: number } {
  const config = env();
  const maxMs = config.META_DIRECT_COALESCE_MAX_MS ?? 2000;
  return { quietMs: Math.min(config.META_DIRECT_COALESCE_MS ?? 0, maxMs), maxMs };
}

/** Atomic claim: LRANGE + DEL in one Lua script (no cross-process gap). */
const CLAIM_ALL_LUA = `
local key = KEYS[1]
local items = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return items
`;

function layerBase(layer: AttentionLayer): number {
  switch (layer) {
    case 'L0':
      return 100;
    case 'L1_CALLBACK':
      return 80;
    case 'L1':
      return 60;
    case 'L2':
      return 30;
    default:
      return 10;
  }
}

function buildItem(
  partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number },
): AttentionItem {
  const id = `${partial.chatId}:${partial.layer}:${partial.messageId ?? 'x'}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  return {
    ...partial,
    id,
    pressure: partial.pressure ?? layerBase(partial.layer),
    createdAt: Date.now(),
  };
}

function parseItems(raw: string[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of raw) {
    try {
      const it = JSON.parse(r) as AttentionItem;
      if (it && typeof it === 'object') out.push(it);
    } catch {
      /* drop */
    }
  }
  return out;
}

/**
 * Attention accumulator — Redis-backed so ingress and Meta loop can split processes.
 * Local buffer remains as fail-soft when Redis is down (same-process only).
 */
export class AttentionAccumulator {
  private local: AttentionItem[] = [];

  ingest(partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number }): AttentionItem {
    const item = buildItem(partial);
    const scope = inspectMetaAttention(item);
    if (scope.status !== 'valid') {
      if (scope.status === 'unavailable') this.local.push(item);
      else void holdMetaScopeInput('attention', item, scope.reason).then(held => { if (!held) this.local.push(item); });
      scheduleCoalesceWake(1000);
      return item;
    }
    this.local.push(scope.value);
    if (this.local.length > MAX) this.local.splice(0, this.local.length - MAX);
    void this.persistPush(scope.value);
    return scope.value;
  }

  async ingestAsync(
    partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number },
    options?: { requireDurable?: boolean },
  ): Promise<AttentionItem | null> {
    const original = buildItem(partial);
    const scope = inspectMetaAttention(original);
    if (scope.status !== 'valid') {
      const held = scope.status === 'invalid' && await holdMetaScopeInput('attention', original, scope.reason);
      if (!held && options?.requireDurable) throw new Error('attention_scope_not_persisted');
      if (!held) { this.local.push(original); scheduleCoalesceWake(1000); }
      return null;
    }
    // 已回过的 message 不再进队列（重启残留 / 双路径）
    if (partial.messageId && partial.messageId > 0) {
      try {
        const { isMessageAnswered } = await import('./answered.js');
        if (!hasUnansweredIntentRevision(partial.pendingIntent) && await isMessageAnswered(partial.chatId, partial.messageId)) {
          logger.info(
            { chatId: partial.chatId, messageId: partial.messageId },
            'Attention skip ingest (already answered)',
          );
          return null;
        }
      } catch (err) {
        if (options?.requireDurable) throw err;
        /* fail-open */
      }
    }
    const item = scope.value;
    try {
      await this.persistPush(item, options?.requireDurable);
    } catch (err) {
      if (options?.requireDurable) throw err;
      logger.warn({ err }, 'Attention Redis push failed — keeping local only');
      this.local.push(item);
      if (this.local.length > MAX) this.local.splice(0, this.local.length - MAX);
    }
    // Direct messages schedule their own wake instead of waiting for the full
    // Meta interval. Optional short batching applies to both QQ and Telegram;
    // zero retains the existing 50 ms fast path. Wake only after persistence.
    if (item.layer === 'L0') scheduleCoalesceWake(directCoalesceWindow().quietMs);
    return item;
  }

  private async persistPush(item: AttentionItem, requireDurable = false): Promise<void> {
    const redis = getRedis();
    const result = await redis
      .multi()
      .lpush(REDIS_KEY, JSON.stringify(item))
      .ltrim(REDIS_KEY, 0, MAX - 1)
      .exec();
    if (requireDurable && (!result || result.some(([error]) => error))) throw new Error('attention_redis_transaction_failed');
  }

  async size(): Promise<number> {
    let remote = 0;
    try {
      remote = await getRedis().llen(REDIS_KEY);
    } catch {
      /* ignore */
    }
    return remote + this.local.length;
  }

  localSize(): number {
    return this.local.length;
  }

  async peek(topN?: number): Promise<AttentionItem[]> {
    const n = topN ?? env().META_ATTENTION_TOP_N;
    const all = await this.loadAll();
    return [...all].sort((a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt).slice(0, n);
  }

  /**
   * Atomically claim Redis items, merge local, return top-N.
   * Remain is written back; items arriving after claim stay in Redis safely.
   */
  async flush(topN?: number): Promise<AttentionItem[]> {
    const n = topN ?? env().META_ATTENTION_TOP_N;
    const byId = new Map<string, AttentionItem>();
    const now = Date.now();

    // Drain local first (same-process)
    const localSnap = this.local.splice(0, this.local.length);
    for (const it of localSnap) byId.set(it.id, it);

    try {
      const redis = getRedis();
      const raw = (await redis.eval(CLAIM_ALL_LUA, 1, REDIS_KEY)) as string[];
      for (const it of parseItems(raw ?? [])) byId.set(it.id, it);
    } catch (err) {
      logger.warn({ err }, 'Attention Redis atomic claim failed — using local only');
    }

    // Drop stale + already-answered (restart / busy-requeue leftovers)
    // Batch the answered-check into a single MGET instead of N serial GETs.
    const notStale: AttentionItem[] = [];
    const unreadScopeState: AttentionItem[] = [];
    let droppedStale = 0;
    for (const it of byId.values()) {
      const scope = inspectMetaAttention(it);
      if (scope.status !== 'valid') {
        if (scope.status === 'unavailable' || !await holdMetaScopeInput('attention', it, scope.reason)) unreadScopeState.push(it);
        continue;
      }
      if (now - (it.createdAt || 0) > MAX_AGE_MS) {
        let explicitHold = false;
        if (pendingIntentEnabled() && it.pendingIntent) {
          try {
            const intent = inspectPendingIntent(it.pendingIntent);
            explicitHold = intent.state === 'held' || (intent.state === 'pending' && now - intent.changedAt <= MAX_AGE_MS);
          } catch { unreadScopeState.push(it); continue; }
        }
        if (!explicitHold) { droppedStale += 1; continue; }
      }
      notStale.push(scope.value);
    }

    let droppedAnswered = 0;
    let droppedRecalled = 0;
    const unreadRecallState: AttentionItem[] = [];
    const fresh: AttentionItem[] = [];
    const toCheck: Array<{ chatId: number; messageId: number }> = [];
    for (const it of notStale) {
      if (it.messageId && it.messageId > 0) {
        toCheck.push({ chatId: it.chatId, messageId: it.messageId });
      }
    }
    let answeredSet: Set<string> | null = null;
    if (toCheck.length) {
      try {
        const { batchMessagesAnswered } = await import('./answered.js');
        answeredSet = await batchMessagesAnswered(toCheck);
      } catch {
        /* fail-open: keep all */
      }
    }
    for (const candidate of notStale) {
      let it = candidate;
      if (pendingIntentEnabled() && it.pendingIntent) {
        try {
          if (it.pendingIntent.chatId !== it.chatId || it.pendingIntent.senderId !== it.userId
            || it.pendingIntent.threadId !== (it.messageThreadId ?? 0)) continue;
          const intent = inspectPendingIntent(it.pendingIntent);
          if (intent.state === 'cancelled' || intent.state === 'settled' || intent.state === 'stale') continue;
          if (intent.state === 'held') { unreadScopeState.push(it); continue; }
        } catch { unreadScopeState.push(it); continue; }
      }
      if (answeredSet && it.messageId && it.messageId > 0) {
        if (answeredSet.has(`${it.chatId}:${it.messageId}`) && !hasUnansweredIntentRevision(it.pendingIntent)) {
          droppedAnswered += 1;
          continue;
        }
      }
      try {
        if (it.messageId && isOneBotMessageRecalled(it.chatId, it.messageId)) {
          droppedRecalled += 1;
          continue;
        }
        const quote = it.payload?.['replyTo'];
        if (quote && typeof quote === 'object' && 'messageId' in quote && typeof quote.messageId === 'number' &&
          isOneBotMessageRecalled(it.chatId, quote.messageId)) {
          // A copied quote is content too: do not revive it through a queued
          // Attention payload after the shared context reader has removed it.
          it = { ...it, payload: { ...it.payload, replyTo: undefined } };
        }
      } catch {
        // The Redis claim already consumed the item. Preserve it for retry,
        // but never dispatch when the QQ recall store cannot be checked.
        unreadRecallState.push(it);
        continue;
      }
      fresh.push(it);
    }
    if (unreadRecallState.length || unreadScopeState.length) {
      logger.warn({ held: unreadRecallState.length + unreadScopeState.length }, 'Attention scope/recall state unavailable — holding for retry');
      scheduleCoalesceWake(1000);
    }
    if (droppedStale || droppedAnswered || droppedRecalled) {
      logger.info(
        { droppedStale, droppedAnswered, droppedRecalled, kept: fresh.length },
        'Attention flush dropped stale/answered/recalled',
      );
    }

    const sorted = fresh.sort(
      (a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt,
    );

    // Keep each chat's burst independent. Direct batching has both a quiet
    // window and a maximum age; a continuous stream cannot postpone it forever.
    // Original timestamps survive busy requeue, so retries do not restart it.
    const coalesceMs = env().META_L0_COALESCE_MS;
    const directWindow = directCoalesceWindow();
    const lane = (it: AttentionItem): string => pendingIntentEnabled()
      ? it.pendingIntent?.laneKey ?? `${it.chatId}:${it.userId ?? 'unknown'}:${it.messageThreadId ?? 0}` : String(it.chatId);
    const directBursts = new Map<string, { first: number; latest: number }>();
    if (directWindow.quietMs > 0) {
      for (const it of sorted) {
        if (it.layer !== 'L0') continue;
        const previous = directBursts.get(lane(it));
        directBursts.set(lane(it), {
          first: Math.min(previous?.first ?? it.createdAt, it.createdAt),
          latest: Math.max(previous?.latest ?? it.createdAt, it.createdAt),
        });
      }
    }
    const directDeadlines = new Map([...directBursts].map(([chatId, burst]) => [
      chatId, Math.min(burst.latest + directWindow.quietMs, burst.first + directWindow.maxMs),
    ]));
    const passiveLatest = new Map<string, number>();
    const passiveFirst = new Map<string, number>();
    if (coalesceMs > 0) {
      for (const it of sorted) {
        if (it.chatId > 0 || it.layer === 'L0' || it.layer === 'L1_CALLBACK') continue;
        passiveLatest.set(lane(it), Math.max(passiveLatest.get(lane(it)) ?? 0, it.createdAt));
        passiveFirst.set(lane(it), Math.min(passiveFirst.get(lane(it)) ?? it.createdAt, it.createdAt));
      }
    }
    const ready: AttentionItem[] = [];
    const held: AttentionItem[] = [];
    let wakeIn = Number.POSITIVE_INFINITY;
    for (const it of sorted) {
      // A direct burst brings that chat's passive context with it, rather than
      // letting an older passive item dispatch separately while L0 is held.
      // Task callbacks never wait for user typing.
      const deadline = it.layer === 'L1_CALLBACK' ? undefined
        : directDeadlines.get(lane(it)) ?? (it.layer !== 'L0' && passiveLatest.has(lane(it))
          ? Math.min(passiveLatest.get(lane(it))! + coalesceMs, pendingIntentEnabled()
            ? passiveFirst.get(lane(it))! + Math.max(coalesceMs, 4000) : Infinity) : undefined);
      if (deadline !== undefined && deadline > now) {
        held.push(it);
        wakeIn = Math.min(wakeIn, deadline - now);
      } else {
        ready.push(it);
      }
    }
    if (held.length) {
      logger.info({ held: held.length, coalesceMs, directCoalesceMs: directWindow.quietMs, wakeInMs: wakeIn },
        'Attention coalesce hold (waiting for quiet)');
      scheduleCoalesceWake(wakeIn);
    }

    // Old source bubbles stay useful context, but only a lane containing its
    // newest revision can dispatch. A late Heart result cannot bless stale text.
    const eligible = pendingIntentEnabled() ? ready.filter(it => {
      if (!it.pendingIntent) return true;
      try {
        const current = inspectPendingIntent(it.pendingIntent);
        return current.state === 'pending' && ready.some(sibling => sibling.pendingIntent?.intentId === it.pendingIntent!.intentId
          && sibling.pendingIntent.revision === current.currentRevision);
      } catch {
        // CLAIM_ALL has already removed this item from Redis. Retain it below
        // when the final scope read fails, rather than losing accepted input.
        return false;
      }
    }) : ready;
    const picked = eligible.slice(0, n);
    const remain = [...eligible.slice(n), ...ready.filter(it => !eligible.includes(it)), ...held, ...unreadRecallState, ...unreadScopeState];

    if (remain.length) {
      try {
        const redis = getRedis();
        const pipe = redis.multi();
        for (const it of remain) pipe.rpush(REDIS_KEY, JSON.stringify(it));
        pipe.ltrim(REDIS_KEY, 0, MAX - 1);
        await pipe.exec();
      } catch (err) {
        logger.warn({ err }, 'Attention remain rewrite failed — keeping local');
        this.local.push(...remain);
      }
    }

    return picked;
  }

  async requeue(items: AttentionItem[]): Promise<void> {
    for (const it of items) {
      try {
        await this.persistPush(it);
      } catch {
        this.local.push(it);
      }
    }
  }

  clear(): void {
    this.local = [];
    void getRedis()
      .del(REDIS_KEY)
      .catch(() => {});
  }

  private async loadAll(): Promise<AttentionItem[]> {
    const byId = new Map<string, AttentionItem>();
    for (const it of this.local) byId.set(it.id, it);
    try {
      const raw = await getRedis().lrange(REDIS_KEY, 0, -1);
      for (const it of parseItems(raw)) byId.set(it.id, it);
    } catch (err) {
      logger.debug({ err }, 'Attention Redis load failed — using local');
    }
    return Array.from(byId.values()).flatMap(item => {
      const scope = inspectMetaAttention(item);
      return scope.status === 'valid' ? [scope.value] : [];
    });
  }
}

let _acc: AttentionAccumulator | null = null;

export function getAttentionAccumulator(): AttentionAccumulator {
  if (!_acc) _acc = new AttentionAccumulator();
  return _acc;
}

export function _resetAttentionAccumulator(): void {
  if (coalesceWakeTimer) clearTimeout(coalesceWakeTimer);
  coalesceWakeTimer = null;
  coalesceWakeAt = 0;
  _acc = null;
}
