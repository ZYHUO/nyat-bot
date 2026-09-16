import { describe, it, expect } from 'vitest';
import {
  pickMultiAnchorGroups,
  entryUid,
  entryDate,
  type AnchorCandidate,
} from '../../../../src/pipeline/turn/anchor-select.js';
import type { PendingEntry } from '../../../../src/pipeline/turn/types.js';

// anchor-select.ts 只 type-only import,无运行时依赖 → 无需 mock。

const c = (idx: number, uid: number, opts: Partial<AnchorCandidate> = {}): AnchorCandidate => ({
  idx,
  uid,
  direct: false,
  isEdit: false,
  ts: idx,
  ...opts,
});

const entry = (msg: unknown): PendingEntry =>
  ({ update: { message: msg }, chatId: -1, enqueuedAt: 0 }) as unknown as PendingEntry;

const channelEntry = (post: unknown): PendingEntry =>
  ({ update: { channel_post: post }, chatId: -1, enqueuedAt: 0 }) as unknown as PendingEntry;

describe('pickMultiAnchorGroups', () => {
  it('single person, multiple msgs → one anchor (last non-edit)', () => {
    const cs = [c(0, 7), c(1, 7), c(2, 7)];
    expect(pickMultiAnchorGroups(cs, 3)).toEqual([2]);
  });

  it('multi person, no direct, budget ≥ groups → all, newest ts first', () => {
    const cs = [c(0, 7, { ts: 100 }), c(1, 8, { ts: 200 }), c(2, 9, { ts: 50 })];
    // ts desc: 200(1), 100(0), 50(2)
    expect(pickMultiAnchorGroups(cs, 3)).toEqual([1, 0, 2]);
  });

  it('budget caps TOTAL including direct groups (M2: direct 不再绕过预算)', () => {
    // 4 人 @bot, budget 3 → 只取最新 3 个
    const cs = [
      c(0, 1, { direct: true, ts: 100 }),
      c(1, 2, { direct: true, ts: 200 }),
      c(2, 3, { direct: true, ts: 300 }),
      c(3, 4, { direct: true, ts: 50 }),
    ];
    const out = pickMultiAnchorGroups(cs, 3);
    expect(out).toHaveLength(3);
    // direct + ts desc: 300(2), 200(1), 100(0) 留下; 50(3) 丢
    expect(out).toEqual([2, 1, 0]);
  });

  it('direct groups prioritized over non-direct, then by ts', () => {
    const cs = [
      c(0, 1, { ts: 1000 }), // non-direct, 高 ts
      c(1, 2, { direct: true, ts: 10 }),
      c(2, 3, { direct: true, ts: 20 }),
    ];
    // direct 先: 20(2),10(1); 再 non-direct: 1000(0)
    expect(pickMultiAnchorGroups(cs, 3)).toEqual([2, 1, 0]);
  });

  it('within-group pick: last direct, else last non-edit', () => {
    // uid7: edit(0), normal(1), direct(2) → pick 2 (direct)
    // uid8: edit(3), normal(4) → pick 4 (无 direct, 回退最后非编辑)
    const cs = [
      c(0, 7, { isEdit: true, ts: 5 }),
      c(1, 7, { ts: 10 }),
      c(2, 7, { direct: true, ts: 15 }),
      c(3, 8, { isEdit: true, ts: 20 }),
      c(4, 8, { ts: 25 }),
    ];
    // direct 组(uid7→2)先, 再 uid8→4
    expect(pickMultiAnchorGroups(cs, 3)).toEqual([2, 4]);
  });

  it('all-edit group has no anchor (skipped)', () => {
    const cs = [c(0, 7, { isEdit: true, ts: 100 }), c(1, 8, { ts: 50 })];
    // uid7 全编辑 → 跳过; uid8 → 1
    expect(pickMultiAnchorGroups(cs, 3)).toEqual([1]);
  });

  it('budget 0 → none', () => {
    expect(pickMultiAnchorGroups([c(0, 7)], 0)).toEqual([]);
  });

  it('empty candidates → []', () => {
    expect(pickMultiAnchorGroups([], 3)).toEqual([]);
  });

  it('budget larger than group count → all groups', () => {
    const cs = [c(0, 7, { ts: 0 }), c(1, 8, { ts: 1 })];
    expect(pickMultiAnchorGroups(cs, 5)).toEqual([1, 0]);
  });
});

describe('entryUid', () => {
  it('regular user → from.id', () => {
    expect(entryUid(entry({ from: { id: 123, is_bot: false }, date: 1 }))).toBe(123);
  });

  it('anonymous admin → sender_chat.id (not GroupAnonymousBot 1087968824)', () => {
    expect(
      entryUid(entry({ from: { id: 1087968824 }, sender_chat: { id: -100999 }, date: 1 })),
    ).toBe(-100999);
  });

  it('channel-on-behalf (from.is_bot + sender_chat) → sender_chat.id', () => {
    expect(
      entryUid(entry({ from: { id: 777, is_bot: true }, sender_chat: { id: -100555 }, date: 1 })),
    ).toBe(-100555);
  });

  it('channel post (no from) → sender_chat.id', () => {
    expect(entryUid(channelEntry({ sender_chat: { id: -100333 }, date: 1 }))).toBe(-100333);
  });

  it('no from/sender_chat → 0', () => {
    expect(entryUid(entry({ date: 1 }))).toBe(0);
  });
});

describe('entryDate', () => {
  it('uses edit_date when present', () => {
    expect(entryDate(entry({ date: 100, edit_date: 200 }))).toBe(200);
  });
  it('falls back to date', () => {
    expect(entryDate(entry({ date: 100 }))).toBe(100);
  });
  it('0 when both missing', () => {
    expect(entryDate(entry({}))).toBe(0);
  });
});
