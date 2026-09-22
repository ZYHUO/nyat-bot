import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import type { AttentionItem, AttentionLayer } from './types.js';

const REDIS_KEY = 'xxb:meta:attention';
const MAX = 500;
/** 丢弃过期 Attention，避免重启后把几小时前的 L0 再回一遍 */
const MAX_AGE_MS = 30 * 60_000;

/** Kick metaTick when coalesce quiet window ends (don't wait full META_TICK_MS). */
let coalesceWakeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCoalesceWake(delayMs: number): void {
  const ms = Math.max(50, Math.ceil(delayMs));
  if (coalesceWakeTimer) clearTimeout(coalesceWakeTimer);
  coalesceWakeTimer = setTimeout(() => {
    coalesceWakeTimer = null;
    void import('./loop.js')
      .then(({ metaTick }) => metaTick())
      .catch(() => {});
  }, ms);
  if (typeof coalesceWakeTimer === 'object' && coalesceWakeTimer && 'unref' in coalesceWakeTimer) {
    (coalesceWakeTimer as NodeJS.Timeout).unref?.();
  }
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
      if (it && typeof it.chatId === 'number' && it.id) out.push(it);
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
    this.local.push(item);
    if (this.local.length > MAX) this.local.splice(0, this.local.length - MAX);
    void this.persistPush(item);
    return item;
  }

  async ingestAsync(
    partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number },
  ): Promise<AttentionItem | null> {
    // 已回过的 message 不再进队列（重启残留 / 双路径）
    if (partial.messageId && partial.messageId > 0) {
      try {
        const { isMessageAnswered } = await import('./answered.js');
        if (await isMessageAnswered(partial.chatId, partial.messageId)) {
          logger.info(
            { chatId: partial.chatId, messageId: partial.messageId },
            'Attention skip ingest (already answered)',
          );
          return null;
        }
      } catch {
        /* fail-open */
      }
    }
    const item = buildItem(partial);
    try {
      await this.persistPush(item);
    } catch (err) {
      logger.warn({ err }, 'Attention Redis push failed — keeping local only');
      this.local.push(item);
      if (this.local.length > MAX) this.local.splice(0, this.local.length - MAX);
    }
    return item;
  }

  private async persistPush(item: AttentionItem): Promise<void> {
    const redis = getRedis();
    await redis
      .multi()
      .lpush(REDIS_KEY, JSON.stringify(item))
      .ltrim(REDIS_KEY, 0, MAX - 1)
      .exec();
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
    let droppedStale = 0;
    for (const it of byId.values()) {
      if (now - (it.createdAt || 0) > MAX_AGE_MS) {
        droppedStale += 1;
        continue;
      }
      notStale.push(it);
    }

    let droppedAnswered = 0;
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
    for (const it of notStale) {
      if (answeredSet && it.messageId && it.messageId > 0) {
        if (answeredSet.has(`${it.chatId}:${it.messageId}`)) {
          droppedAnswered += 1;
          continue;
        }
      }
      fresh.push(it);
    }
    if (droppedStale || droppedAnswered) {
      logger.info(
        { droppedStale, droppedAnswered, kept: fresh.length },
        'Attention flush dropped stale/answered',
      );
    }

    const sorted = fresh.sort(
      (a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt,
    );

    // Coalesce: group chats still receiving L0/L1 stay in Redis until quiet.
    const coalesceMs = env().META_L0_COALESCE_MS;
    let ready = sorted;
    let held: AttentionItem[] = [];
    if (coalesceMs > 0) {
      const latestAt = new Map<number, number>();
      for (const it of sorted) {
        if (it.chatId > 0) continue; // DM: no hold
        if (it.layer === 'L1_CALLBACK') continue;
        // round 1（新 goal）：**L0 direct 也不 hold。**
        //
        // 2026-09-22 用户报："消息从发出到bot收到4-6s、bot反应10-16s、发出去3-4s，
        // 叠加起来显得迟钝、前言不搭后语"。实测三段：
        //   发布 1.5s（不是4-6s）· 收到→任务启动 P50 12.7s · 任务→首条发出 P50 14s
        // 段1 那 12.7s = Heart decide 4.8s + reflect 1.2s + dispatch 0.9s + **合并窗 2.8s** +
        // 其余排队。
        //
        // 合并窗（META_L0_COALESCE_MS=2800）本来的目的是"连发→一回"：群里一口气
        // 刷三条，别回三条。但那对**用户直接找 bot**（@/回 bot/叫昵称）是纯亏——
        // 人家在等你答，你却又等了 2.8 秒。DM 早就豁免了（上一行），
        // 群里的 direct 却要陪跑，而注释里写的"@ / 回 bot 可走 timing hard-bypass"
        // 指的是 dispatch-gate 的节奏闸，**不是这个 attention 合并窗**——两回事。
        //
        // 连发合并仍然对 L2（被动消息）生效：那种确实是"看看要不要接话"，
        // 等一批再判更接近人的行为。
        if (it.layer === 'L0') continue;
        const t = it.createdAt || 0;
        latestAt.set(it.chatId, Math.max(latestAt.get(it.chatId) ?? 0, t));
      }
      const hot = new Set<number>();
      for (const [cid, t] of latestAt) {
        if (now - t < coalesceMs) hot.add(cid);
      }
      if (hot.size) {
        ready = [];
        held = [];
        let wakeIn = Number.POSITIVE_INFINITY;
        for (const it of sorted) {
          // hold 判据和上面 latestAt 的收集必须**同一套**：只 hold L2。
          // 第一版这里写的是 `(L0 || L1)`，而上面已经不收 L0 了——
          // 两处不一致的话，L0 数据在 latestAt 里没有，但 hold 判据仍认它，
          // 行为会随"群里同时有没有 L2"漂移。round 1 修。
          const hold =
            hot.has(it.chatId) &&
            it.chatId < 0 &&
            (it.layer === 'L2' || it.layer === 'L1');
          if (hold) held.push(it);
          else ready.push(it);
        }
        for (const cid of hot) {
          const t = latestAt.get(cid) ?? now;
          wakeIn = Math.min(wakeIn, coalesceMs - (now - t));
        }
        if (held.length) {
          logger.info(
            { held: held.length, hotChats: hot.size, coalesceMs, wakeInMs: wakeIn },
            'Attention coalesce hold (waiting for quiet)',
          );
          if (Number.isFinite(wakeIn) && wakeIn > 0) scheduleCoalesceWake(wakeIn + 30);
        }
      }
    }

    const picked = ready.slice(0, n);
    const remain = [...ready.slice(n), ...held];

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
    return Array.from(byId.values());
  }
}

let _acc: AttentionAccumulator | null = null;

export function getAttentionAccumulator(): AttentionAccumulator {
  if (!_acc) _acc = new AttentionAccumulator();
  return _acc;
}

export function _resetAttentionAccumulator(): void {
  _acc = null;
}
