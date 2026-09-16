// ────────────────────────────────────────
// Tests: StickerCapture — context window extraction
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FormattedMessage } from '../../../../src/shared/types.js';

let testDb: Database.Database;

vi.mock('../../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

const { captureSticker } = await import('../../../../src/knowledge/sticker/capture.js');
const { getItem, getSamples } = await import('../../../../src/knowledge/sticker/store.js');

function initSchema(db: Database.Database): void {
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'migrations/0003_stickers.sql'),
    'utf-8',
  );
  db.exec(migrationSql);
}

function makeMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 42,
    username: 'test_user',
    fullName: 'Test User',
    timestamp: 1700000000,
    messageId: 100,
    textContent: '',
    isForwarded: false,
    sticker: {
      emoji: '😺',
      fileId: 'fid_test',
      fileUniqueId: 'fuid_test',
      setName: 'CatStickers',
      isAnimated: false,
      isVideo: false,
    },
    ...overrides,
  };
}

function makeContext(count: number): FormattedMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    uid: 100 + i,
    username: `user_${i}`,
    fullName: `User ${i}`,
    timestamp: 1699999990 + i,
    messageId: 90 + i,
    textContent: `context message ${i}`,
    isForwarded: false,
  }));
}

describe('StickerCapture', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should capture sticker from a message with sticker', () => {
    const msg = makeMessage();
    const context = makeContext(3);

    captureSticker(msg, -1001234, context);

    const item = getItem('fuid_test');
    expect(item).not.toBeNull();
    expect(item!.fileUniqueId).toBe('fuid_test');
    expect(item!.stickerFormat).toBe('static_webp');
    expect(item!.usageCount).toBe(1);
  });

  it('should store context window (max 5 messages)', () => {
    const msg = makeMessage();
    const context = makeContext(8); // more than window

    captureSticker(msg, -1001234, context);

    const samples = getSamples('fuid_test');
    expect(samples).toHaveLength(1);

    const parsed = JSON.parse(samples[0]!.contextBefore!) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(5); // capped at CONTEXT_WINDOW=5
  });

  it('should ignore messages without sticker', () => {
    const msg = makeMessage({ sticker: undefined });
    captureSticker(msg, -1001234, []);

    const item = getItem('fuid_test');
    expect(item).toBeNull();
  });

  it('should detect animated format', () => {
    const msg = makeMessage({
      sticker: {
        emoji: '😺',
        fileId: 'fid_anim',
        fileUniqueId: 'fuid_anim',
        setName: 'AnimSet',
        isAnimated: true,
        isVideo: false,
      },
    });

    captureSticker(msg, -1001234, []);

    const item = getItem('fuid_anim');
    expect(item!.stickerFormat).toBe('animated_tgs');
  });

  it('should detect video format', () => {
    const msg = makeMessage({
      sticker: {
        emoji: '😺',
        fileId: 'fid_video',
        fileUniqueId: 'fuid_video',
        setName: 'VideoSet',
        isAnimated: false,
        isVideo: true,
      },
    });

    captureSticker(msg, -1001234, []);

    const item = getItem('fuid_video');
    expect(item!.stickerFormat).toBe('video_webm');
  });

  it('should handle multiple captures of same sticker', () => {
    const msg1 = makeMessage();
    const msg2 = makeMessage({ messageId: 101, timestamp: 1700000001 });

    captureSticker(msg1, -1001234, []);
    captureSticker(msg2, -1001234, []);

    const item = getItem('fuid_test');
    expect(item!.usageCount).toBe(2);
    expect(item!.sampleCount).toBe(2);
  });

  it('should capture reply info when message is a reply', () => {
    const msg = makeMessage({
      replyTo: {
        messageId: 50,
        uid: 99,
        fullName: 'Bob',
        textSnippet: 'original message text',
      },
    });

    captureSticker(msg, -1001234, []);

    const samples = getSamples('fuid_test');
    expect(samples[0]!.replyToMessageId).toBe(50);
    expect(samples[0]!.replyTargetText).toBe('original message text');
  });
});
