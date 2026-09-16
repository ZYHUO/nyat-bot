import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, string>();
const h = new Map<string, Record<string, string>>();
const z = new Map<string, string[]>();

const redisMock = {
  zrange: vi.fn(async (k: string) => z.get(k) ?? []),
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  hget: vi.fn(async (k: string, field: string) => h.get(k)?.[field] ?? null),
  scan: vi.fn(async () => ['0', [...z.keys()]]),
};

import type { ReplyObligation } from '../../../src/pipeline/turn/obligation.js';
import { listObligationSnapshots } from '../../../src/admin/obligations.ts';

describe('admin obligations snapshot', () => {
  beforeEach(() => {
    kv.clear(); h.clear(); z.clear();
  });

  it('lists obligation snapshots with active id', async () => {
    const o: ReplyObligation = {
      id: 'obl-1', chatId: -100, anchorMessageId: 1, anchorUid: 1, anchorFullName: 'A',
      targetUid: 1, targetFullName: 'A', kind: 'mention', state: 'pending', priority: 100,
      createdAt: 1, updatedAt: 2, directInteraction: true, mustReplyStrong: true,
      relatedMessageIds: [1], triggerUids: [1],
    };
    z.set('xxb:turn:obligations:-100', ['obl-1']);
    kv.set('xxb:turn:obligation:-100:obl-1', JSON.stringify(o));
    h.set('xxb:turn:obligation_meta:-100', { activeObligationId: 'obl-1' });
    const snapshots = await listObligationSnapshots(redisMock as never);
    expect(snapshots[0]?.chatId).toBe(-100);
    expect(snapshots[0]?.activeObligationId).toBe('obl-1');
    expect(snapshots[0]?.obligations[0]?.id).toBe('obl-1');
  });

  it('skips malformed obligation payloads', async () => {
    z.set('xxb:turn:obligations:-100', ['good', 'bad']);
    kv.set('xxb:turn:obligation:-100:good', JSON.stringify({
      id: 'good', chatId: -100, anchorMessageId: 1, anchorUid: 1, anchorFullName: 'A',
      targetUid: 1, targetFullName: 'A', kind: 'mention', state: 'pending', priority: 100,
      createdAt: 1, updatedAt: 2, directInteraction: true, mustReplyStrong: true,
      relatedMessageIds: [1], triggerUids: [1],
    } satisfies ReplyObligation));
    kv.set('xxb:turn:obligation:-100:bad', '{bad json');
    const snapshots = await listObligationSnapshots(redisMock as never);
    expect(snapshots[0]?.obligations).toHaveLength(1);
    expect(snapshots[0]?.obligations[0]?.id).toBe('good');
  });
});
