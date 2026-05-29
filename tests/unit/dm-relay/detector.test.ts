import { describe, it, expect, vi } from 'vitest';

// detector.ts → handlers/schedule.ts pulls in db/sender deps at import time.
// Mock the leaves so the real detector + real parseScheduleTime load and run.
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(), sendChatAction: vi.fn() }));
vi.mock('../../../src/bot/sender/streaming.js', () => ({ StreamingSender: class { sendDirect = vi.fn(); } }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { detectDmIntent } = await import('../../../src/pipeline/dm-relay/detector.js');

const BOT = 'nyatbot';

describe('detectDmIntent — regex fast path', () => {
  it('detects on_speak relay with singular pronoun', () => {
    const r = detectDmIntent('等张三上线告诉他 晚上开黑', BOT);
    expect(r.type).toBe('relay_message');
    if (r.type === 'relay_message') {
      expect(r.mode).toBe('on_speak');
      expect(r.targetHandle).toBe('张三');
      expect(r.content).toBe('晚上开黑');
    }
  });

  it('on_speak relay does NOT leak plural pronoun 们 into content (review fix [1])', () => {
    const r = detectDmIntent('下次李四说话时叫他们来参加', BOT);
    expect(r.type).toBe('relay_message');
    if (r.type === 'relay_message') {
      expect(r.targetHandle).toBe('李四');
      expect(r.content).toBe('来参加'); // not "们来参加"
    }
  });

  it('detects scheduled relay and computes a future scheduledAt', () => {
    const r = detectDmIntent('明天9点告诉张三 交报告', BOT);
    expect(r.type).toBe('relay_message');
    if (r.type === 'relay_message') {
      expect(r.mode).toBe('scheduled');
      expect(r.targetHandle).toBe('张三');
      expect(r.content).toBe('交报告');
      expect(typeof r.scheduledAt).toBe('number');
      expect(r.scheduledAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('disambiguates: time + no target → plain schedule, not relay', () => {
    const r = detectDmIntent('明天9点提醒大家开会', BOT);
    expect(r.type).toBe('schedule');
  });

  it('detects profile tags', () => {
    const r = detectDmIntent('给张三打标签 程序员,北京', BOT);
    expect(r.type).toBe('set_profile_tags');
    if (r.type === 'set_profile_tags') {
      expect(r.targetHandle).toBe('张三');
      expect(r.tags).toBe('程序员,北京');
    }
  });

  it('detects note guess', () => {
    const r = detectDmIntent('猜纸条 #5 @张三', BOT);
    expect(r.type).toBe('note_guess');
    if (r.type === 'note_guess') {
      expect(r.noteId).toBe(5);
      expect(r.guessedHandle).toBe('张三');
    }
  });

  it('detects note reveal', () => {
    const r = detectDmIntent('公布纸条 #5', BOT);
    expect(r.type).toBe('note_reveal');
    if (r.type === 'note_reveal') expect(r.noteId).toBe(5);
  });

  it('guess/reveal do not shadow plain note creation', () => {
    const r = detectDmIntent('纸条 你今天很棒', BOT);
    expect(r.type).toBe('note');
  });

  it('detects set_default_group with and without index', () => {
    const withIdx = detectDmIntent('默认群 2', BOT);
    expect(withIdx.type).toBe('set_default_group');
    if (withIdx.type === 'set_default_group') expect(withIdx.groupIndex).toBe(2);

    const noIdx = detectDmIntent('默认群', BOT);
    expect(noIdx.type).toBe('set_default_group');
    if (noIdx.type === 'set_default_group') expect(noIdx.groupIndex).toBeUndefined();
  });

  it('plain immediate relay still works (no mode → immediate at dispatch)', () => {
    const r = detectDmIntent('告诉张三 今晚开黑', BOT);
    expect(r.type).toBe('relay_message');
    if (r.type === 'relay_message') {
      expect(r.targetHandle).toBe('张三');
      expect(r.mode === undefined || r.mode === 'immediate').toBe(true);
    }
  });

  it('returns normal_chat for casual messages', () => {
    expect(detectDmIntent('哈哈哈你好可爱', BOT).type).toBe('normal_chat');
  });
});
