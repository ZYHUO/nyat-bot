import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import type { AttentionItem, AttentionLayer } from './types.js';

const REDIS_KEY = 'xxb:meta:attention';
const MAX = 500;

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
    // Fire-and-forget Redis mirror; await variant for callers that need durability before return.
    void this.persistPush(item);
    return item;
  }

  /** Prefer this from ingress when crossing process boundaries. */
  async ingestAsync(
    partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number },
  ): Promise<AttentionItem> {
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

  /** Approximate: local + Redis length (best-effort). */
  async size(): Promise<number> {
    let remote = 0;
    try {
      remote = await getRedis().llen(REDIS_KEY);
    } catch {
      /* ignore */
    }
    return remote + this.local.length;
  }

  /** Sync size of local buffer only (tests / fail-soft). */
  localSize(): number {
    return this.local.length;
  }

  async peek(topN?: number): Promise<AttentionItem[]> {
    const n = topN ?? env().META_ATTENTION_TOP_N;
    const all = await this.loadAll();
    return [...all].sort((a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt).slice(0, n);
  }

  async flush(topN?: number): Promise<AttentionItem[]> {
    const n = topN ?? env().META_ATTENTION_TOP_N;
    const all = await this.loadAll();
    const sorted = [...all].sort((a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt);
    const picked = sorted.slice(0, n);
    const remain = sorted.slice(n);
    const ids = new Set(picked.map((p) => p.id));
    this.local = this.local.filter((it) => !ids.has(it.id));
    try {
      const redis = getRedis();
      const pipe = redis.multi().del(REDIS_KEY);
      for (const it of remain) pipe.rpush(REDIS_KEY, JSON.stringify(it));
      if (remain.length) pipe.ltrim(REDIS_KEY, 0, MAX - 1);
      await pipe.exec();
    } catch (err) {
      logger.warn({ err }, 'Attention Redis flush rewrite failed');
      // Keep remain in local so we don't lose them
      for (const it of remain) {
        if (!this.local.some((x) => x.id === it.id)) this.local.push(it);
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
