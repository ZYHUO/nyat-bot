import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isNyatDbNativeAvailable,
  openNyatDbNative,
  nativeVersion,
} from '../../../packages/nyatdb/src/native.js';

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), '../../../native/nyatdb');
const built = existsSync(join(nativeDir, 'index.js'));

describe.skipIf(!built)('NyatDB native Step3', () => {
  it('loads addon', () => {
    expect(isNyatDbNativeAvailable()).toBe(true);
    expect(nativeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('chat + hot + double-close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyat-s3-'));
    try {
      const db = openNyatDbNative({ path: dir, syncEvery: 1, poolFrames: 64 });
      expect(db.stats().pages).toBeGreaterThanOrEqual(5);

      const chatId = -1002767093213;
      db.chatAppend(chatId, {
        messageId: 1,
        ts: 1_700_000_001,
        uid: 42,
        role: 'user',
        text: 'hello native',
      });
      db.chatAppend(chatId, {
        messageId: 2,
        ts: 1_700_000_002,
        uid: 42,
        role: 'assistant',
        text: 'hi',
      });

      expect(db.chatGet(chatId, 1)?.text).toBe('hello native');
      expect(db.chatRecent(chatId, 2).map((m) => m.messageId)).toEqual([1, 2]);

      db.hotSet('k', Buffer.from('v'));
      expect(db.hotGetString('k')).toBe('v');
      db.hotDel('k');
      expect(db.hotGetString('k')).toBeNull();

      db.checkpoint();
      expect(db.verify()).toBeGreaterThanOrEqual(5);
      expect(db.stats().indexed).toBe(2);
      expect(db.stats().chats).toBe(1);

      db.close(true);
      db.close(true);
      expect(() => db.stats()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('impulse + bond + recall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyat-s3b-'));
    try {
      const db = openNyatDbNative({ path: dir, syncEvery: 1 });
      db.impulseSchedule('j1', 1, Date.now() - 1, 'wait', Buffer.from('x'));
      expect(db.impulseDue(Date.now(), 10).some((j) => j.id === 'j1')).toBe(true);
      db.impulseAck('j1');
      expect(db.impulseDue(Date.now(), 10).some((j) => j.id === 'j1')).toBe(false);

      db.bondUpsert({ uid: 9, chatId: -1, score: 0.5, note: 'n' });
      expect(db.bondList(5)[0]?.uid).toBe(9);

      const vec = Float64Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
      db.recallUpsert(-1, 99, vec, 1);
      const hits = db.recallSearch(vec, -1, 3);
      expect(hits[0]?.messageId).toBe(99);
      expect(hits[0]!.score).toBeGreaterThan(0.9);

      db.close(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('facade chatGetBatch + getNyatDb native path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyat-s4-'));
    try {
      const { NyatDbNativeFacade } = await import('../../../packages/nyatdb/src/facade.js');
      const db = new NyatDbNativeFacade(
        openNyatDbNative({ path: dir, syncEvery: 1, poolFrames: 64 }),
      );
      const chatId = -42;
      for (let i = 1; i <= 20; i++) {
        db.chatAppend(chatId, {
          messageId: i,
          ts: i,
          uid: 1,
          role: 'user',
          text: `m${i}`,
        });
      }
      const batch = db.chatGetBatch(chatId, [1, 10, 20, 99]);
      expect(batch[0]?.text).toBe('m1');
      expect(batch[2]?.text).toBe('m20');
      expect(batch[3]).toBeNull();
      expect(db.stats().backend).toBe('native-rust');
      db.close({ skipCheckpoint: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopen after checkpoint keeps chatGet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyat-s3c-'));
    try {
      {
        const db = openNyatDbNative({ path: dir, syncEvery: 1 });
        db.chatAppend(-7, {
          messageId: 3,
          ts: 3,
          uid: 1,
          role: 'user',
          text: 'persist',
        });
        db.checkpoint();
        db.close(true);
      }
      const db2 = openNyatDbNative({ path: dir, verifyOnOpen: true });
      expect(db2.chatGet(-7, 3)?.text).toBe('persist');
      db2.close(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
