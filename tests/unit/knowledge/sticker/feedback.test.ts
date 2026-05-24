// ────────────────────────────────────────
// Tests: StickerFeedback — intent matching and sticker selection
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

const {
  normalizeIntent,
  shouldSend,
  shouldSendTextAfterSticker,
  pickFileId,
} = await import('../../../../src/knowledge/sticker/feedback.js');

const { recordStickerUsage, storeAnalysisResult } = await import(
  '../../../../src/knowledge/sticker/store.js'
);

function initSchema(db: Database.Database): void {
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'migrations/0003_stickers.sql'),
    'utf-8',
  );
  db.exec(migrationSql);
  const feedbackSql = readFileSync(
    resolve(process.cwd(), 'migrations/0006_sticker_feedback.sql'),
    'utf-8',
  );
  db.exec(feedbackSql);
}

function seedReadySticker(
  fileUniqueId: string,
  fileId: string,
  emotionTags: string[],
  moodMap: Record<string, number> = {},
  personaFit = true,
): void {
  recordStickerUsage(
    {
      fileUniqueId,
      fileId,
      setName: 'TestSet',
      emoji: '😺',
      stickerFormat: 'static_webp',
    },
    {
      fileUniqueId,
      chatId: -1001234,
      messageId: 100,
      date: 1700000000,
      fromUserId: 42,
      username: 'tester',
      replyToMessageId: null,
      replyTargetText: null,
      contextBefore: null,
    },
  );
  storeAnalysisResult(fileUniqueId, {
    emotionTags,
    moodMap,
    personaFit,
    description: 'test sticker',
  });
}

describe('StickerFeedback', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('normalizeIntent', () => {
    it('should return valid intents as-is', () => {
      expect(normalizeIntent('cute')).toBe('cute');
      expect(normalizeIntent('happy')).toBe('happy');
      expect(normalizeIntent('love')).toBe('love');
    });

    it('should lowercase and trim', () => {
      expect(normalizeIntent('CUTE')).toBe('cute');
      expect(normalizeIntent(' happy ')).toBe('happy');
    });

    it('should return null for invalid intents', () => {
      expect(normalizeIntent('unknown_intent')).toBeNull();
      expect(normalizeIntent('totally_fake_intent_xyz')).toBeNull();
      expect(normalizeIntent('')).toBeNull();
    });

    it('should return null for undefined', () => {
      expect(normalizeIntent(undefined)).toBeNull();
    });
  });

  describe('shouldSend', () => {
    const enabledConfig = {
      enabled: true,
      mode: 'ai' as const,
      maxReplyChars: 140,
      sendPosition: 'before' as const,
    };

    it('should return true for valid conditions', () => {
      expect(shouldSend(enabledConfig, 'REPLY', 'Hello!', 'json')).toBe(true);
    });

    it('should return false when disabled', () => {
      expect(shouldSend({ ...enabledConfig, enabled: false }, 'REPLY', 'Hello!', 'json')).toBe(false);
    });

    it('should return false when mode is off', () => {
      expect(shouldSend({ ...enabledConfig, mode: 'off' }, 'REPLY', 'Hello!', 'json')).toBe(false);
    });

    it('should return false for non-REPLY action', () => {
      expect(shouldSend(enabledConfig, 'REPLY_PRO', 'Hello!', 'json')).toBe(false);
    });

    it('should return false for invalid reply source', () => {
      expect(shouldSend(enabledConfig, 'REPLY', 'Hello!', 'fallback')).toBe(false);
    });

    it('should return false when reply text exceeds maxReplyChars', () => {
      const longText = 'x'.repeat(200);
      expect(shouldSend(enabledConfig, 'REPLY', longText, 'json')).toBe(false);
    });

    it('should return false for empty reply text', () => {
      expect(shouldSend(enabledConfig, 'REPLY', '', 'json')).toBe(false);
      expect(shouldSend(enabledConfig, 'REPLY', '   ', 'json')).toBe(false);
    });
  });

  describe('shouldSendTextAfterSticker', () => {
    it('should return true when no sticker was sent', () => {
      expect(
        shouldSendTextAfterSticker({ enabled: true, mode: 'ai', maxReplyChars: 140, sendPosition: 'before' }, false),
      ).toBe(true);
    });

    it('should return true when mode is ai and sticker was sent', () => {
      expect(
        shouldSendTextAfterSticker({ enabled: true, mode: 'ai', maxReplyChars: 140, sendPosition: 'before' }, true),
      ).toBe(true);
    });

    it('should return false when mode is sticker_only and sticker was sent', () => {
      expect(
        shouldSendTextAfterSticker(
          { enabled: true, mode: 'sticker_only', maxReplyChars: 140, sendPosition: 'before' },
          true,
        ),
      ).toBe(false);
    });
  });

  describe('pickFileId', () => {
    it('should return null when no ready stickers exist', () => {
      expect(pickFileId('cute')).toBeNull();
    });

    it('should return a fileId when matching sticker exists', () => {
      seedReadySticker('fuid_1', 'fid_1', ['cute', 'adorable']);

      const result = pickFileId('cute');
      expect(result).toBe('fid_1');
    });

    it('should return null when no stickers match the intent', () => {
      seedReadySticker('fuid_1', 'fid_1', ['angry', 'fierce']);

      const result = pickFileId('cute');
      expect(result).toBeNull();
    });

    it('should not pick stickers with persona_fit = false', () => {
      seedReadySticker('fuid_1', 'fid_1', ['cute'], {}, false);

      const result = pickFileId('cute');
      expect(result).toBeNull();
    });

    it('should handle synonym matching', () => {
      seedReadySticker('fuid_1', 'fid_1', ['adorable', 'sweet']);

      const result = pickFileId('cute');
      expect(result).toBe('fid_1');
    });

    it('should select from multiple candidates', () => {
      seedReadySticker('fuid_1', 'fid_1', ['cute']);
      seedReadySticker('fuid_2', 'fid_2', ['adorable', 'cute']);

      const result = pickFileId('cute');
      expect(result).not.toBeNull();
      expect(['fid_1', 'fid_2']).toContain(result);
    });
  });
});
