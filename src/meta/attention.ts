import { env } from '../env.js';
import type { AttentionItem, AttentionLayer } from './types.js';

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

/**
 * In-process attention accumulator (CGM Q3 analogue).
 * Keeps a queue (no overwrite) so burst messages are not dropped.
 */
export class AttentionAccumulator {
  private items: AttentionItem[] = [];
  private static readonly MAX = 500;

  ingest(partial: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'> & { pressure?: number }): AttentionItem {
    const id = `${partial.chatId}:${partial.layer}:${partial.messageId ?? 'x'}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const pressure = partial.pressure ?? layerBase(partial.layer);
    const item: AttentionItem = {
      ...partial,
      id,
      pressure,
      createdAt: Date.now(),
    };
    this.items.push(item);
    if (this.items.length > AttentionAccumulator.MAX) {
      this.items.splice(0, this.items.length - AttentionAccumulator.MAX);
    }
    return item;
  }

  size(): number {
    return this.items.length;
  }

  peek(topN?: number): AttentionItem[] {
    const n = topN ?? env().META_ATTENTION_TOP_N;
    return [...this.items]
      .sort((a, b) => b.pressure - a.pressure || a.createdAt - b.createdAt)
      .slice(0, n);
  }

  flush(topN?: number): AttentionItem[] {
    const picked = this.peek(topN);
    const ids = new Set(picked.map((p) => p.id));
    this.items = this.items.filter((it) => !ids.has(it.id));
    return picked;
  }

  /** Put items back (e.g. after a failed Meta session). */
  requeue(items: AttentionItem[]): void {
    for (const it of items) this.items.push(it);
  }

  clear(): void {
    this.items = [];
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
