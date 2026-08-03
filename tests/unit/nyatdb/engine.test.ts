import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NyatDb } from '../../../packages/nyatdb/src/engine.js';
import { PAGE_SIZE } from '../../../packages/nyatdb/src/format/constants.js';
import { Page } from '../../../packages/nyatdb/src/format/page.js';
import { PageType } from '../../../packages/nyatdb/src/format/constants.js';
import { RECALL_DIM } from '../../../packages/nyatdb/src/format/codec.js';
import { chatAppendFromFormatted, unpackChatLogRow } from '../../../packages/nyatdb/src/chat-log.js';

describe('NyatDB page format', () => {
  it('slotted insert + crc round-trip', () => {
    const p = Page.alloc(3, PageType.Chat);
    expect(p.insert(Buffer.from('hello'))).toBe(0);
    expect(p.insert(Buffer.from('world!!'))).toBe(1);
    expect(p.getTuple(0)!.toString()).toBe('hello');
    p.recomputeCrc();
    expect(p.checkCrc()).toBe(true);
    expect(p.buf.length).toBe(PAGE_SIZE);
  });
});

describe('NyatDB production primitives', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('secondary index chatGet + reopen from msg.idx', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-prod-'));
    const db1 = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 100 });
    for (let i = 1; i <= 30; i++) {
      db1.chatAppend(-100, {
        messageId: i,
        ts: 1000 + i,
        uid: 1,
        role: 'user',
        text: `t${i}`,
      });
    }
    expect(db1.chatGet(-100, 17)?.text).toBe('t17');
    expect(db1.stats().indexed).toBe(30);
    db1.checkpoint();
    db1.close();

    const db2 = NyatDb.open({ path: dir, syncEvery: 1 });
    expect(db2.chatGet(-100, 17)?.text).toBe('t17');
    expect(db2.chatRecent(-100, 5).map((m) => m.messageId)).toEqual([26, 27, 28, 29, 30]);
    db2.verify();
    db2.close();
  });

  it('hotDel / impulseAck / chatTrimKeepLast', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-prod-'));
    const db = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 50 });
    db.hotSet('k', 'v');
    expect(db.hotGetString('k')).toBe('v');
    db.hotDel('k');
    expect(db.hotGetString('k')).toBeNull();

    db.impulseSchedule({
      id: 'j1',
      chatId: 1,
      runAt: Date.now() - 1,
      kind: 'wait',
      payload: 'x',
    });
    expect(db.impulseDue().some((j) => j.id === 'j1')).toBe(true);
    db.impulseAck('j1');
    expect(db.impulseDue().some((j) => j.id === 'j1')).toBe(false);

    for (let i = 1; i <= 40; i++) {
      db.chatAppend(9, {
        messageId: i,
        ts: i,
        uid: 1,
        role: 'user',
        text: `x${i}`,
      });
    }
    db.chatTrimKeepLast(9, 10);
    expect(db.chatRecent(9, 100).length).toBeLessThanOrEqual(10);
    expect(db.chatGet(9, 1)).toBeNull();
    expect(db.chatGet(9, 40)?.text).toBe('x40');
    db.close();
  });

  it('ChatLog / HotState / Impulse / Bond / Recall smoke', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-prod-'));
    const db = NyatDb.open({ path: dir, syncEvery: 1, poolFrames: 16 });
    db.chatAppend(-100, {
      messageId: 1,
      ts: 1000,
      uid: 7,
      role: 'user',
      text: '你好本喵',
    });
    expect(db.chatRecent(-100, 10)[0]!.text).toBe('你好本喵');
    db.bondUpsert({ uid: 7, chatId: -100, score: 0.8, note: '熟' });
    const vec = new Float32Array(RECALL_DIM);
    vec[0] = 1;
    db.recallUpsert({ chatId: -100, messageId: 1, vector: vec });
    expect(db.recallSearch(vec, { topK: 1 })[0]!.messageId).toBe(1);
    db.close();
  });

  it('ChatLog JSON body preserves username/sticker for READ path', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-prod-'));
    const db = NyatDb.open({ path: dir, syncEvery: 1 });
    db.chatAppend(
      -1,
      chatAppendFromFormatted({
        role: 'user',
        uid: 42,
        username: 'nya',
        fullName: '喵',
        timestamp: 100,
        messageId: 9,
        textContent: '',
        isForwarded: false,
        sticker: { emoji: '🐱', fileId: 'f', fileUniqueId: 'u' },
      }),
    );
    const row = db.chatRecent(-1, 1)[0]!;
    expect(row.bodyFormat).toBe('json');
    const msg = unpackChatLogRow(row);
    expect(msg.username).toBe('nya');
    expect(msg.fullName).toBe('喵');
    expect(msg.sticker?.emoji).toBe('🐱');
    db.close();
  });

  it('recallSearch filters by visibility', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-recall-'));
    const db = NyatDb.open({ path: dir, syncEvery: 1, poolFrames: 16 });
    const v1 = new Float32Array(RECALL_DIM);
    v1[0] = 1;
    const v2 = new Float32Array(RECALL_DIM);
    v2[0] = 1;
    const v0 = new Float32Array(RECALL_DIM);
    v0[0] = 1;
    // public(2), contextual(1), private(0)
    db.recallUpsert({ chatId: -1, messageId: 10, vector: v1, visibility: 2 });
    db.recallUpsert({ chatId: -1, messageId: 11, vector: v2, visibility: 1 });
    db.recallUpsert({ chatId: -1, messageId: 12, vector: v0, visibility: 0 });

    const q = new Float32Array(RECALL_DIM);
    q[0] = 1;

    // Default (minVisibility=1): excludes private(0), includes contextual+public
    const noPrivate = db.recallSearch(q, { topK: 10 });
    expect(noPrivate).toHaveLength(2);
    expect(noPrivate.map((r) => r.messageId).sort()).toEqual([10, 11]);

    // minVisibility=0: include everything
    const all = db.recallSearch(q, { topK: 10, minVisibility: 0 });
    expect(all).toHaveLength(3);

    // minVisibility=2: only public
    const onlyPublic = db.recallSearch(q, { topK: 10, minVisibility: 2 });
    expect(onlyPublic).toHaveLength(1);
    expect(onlyPublic[0]!.messageId).toBe(10);
    db.close();
  });

  it('HotState preserves all keys on page overflow (no silent data loss)', () => {
    dir = mkdtempSync(join(tmpdir(), 'nyatdb-hot-overflow-'));
    const db = NyatDb.open({ path: dir, syncEvery: 1, poolFrames: 16 });
    // Write enough keys to overflow a single 4KB page.
    // Each hot tuple is ~key_len + value_len + ~20 overhead. Use 200-byte values.
    const val = 'x'.repeat(200);
    const keys: string[] = [];
    for (let i = 0; i < 40; i++) {
      const key = `hotkey_${String(i).padStart(3, '0')}`;
      db.hotSet(key, val);
      keys.push(key);
    }
    // All keys should survive — the old MVP code dropped all other keys on overflow.
    for (const key of keys) {
      expect(db.hotGetString(key)).toBe(val);
    }
    db.close();
  });
});
