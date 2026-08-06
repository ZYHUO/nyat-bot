/**
 * L0 must autoDispatch before Meta LLM — regression for Meta scripting
 * 「简单说没事或本喵在看着」 on 「千雪怎么了」.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callWithFallback = vi.fn();
const enqueueCodeActJob = vi.fn(async () => undefined);
const isCodeActBusy = vi.fn(async () => false);
const tryClaimQuote = vi.fn(async () => true);
const tryMarkCodeActActive = vi.fn(async () => true);
const allQuotesAnswered = vi.fn(async () => false);
const isMetaSubagentChat = vi.fn(() => true);

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallback(...args),
}));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueCodeActJob(...args),
}));
vi.mock('../../../src/subagent/task-store.js', () => ({
  isCodeActBusy: (...args: unknown[]) => isCodeActBusy(...args),
  tryClaimQuote: (...args: unknown[]) => tryClaimQuote(...args),
  tryMarkCodeActActive: (...args: unknown[]) => tryMarkCodeActActive(...args),
  clearCodeActActive: vi.fn(async () => undefined),
  persistCodeActTask: vi.fn(async () => undefined),
}));
vi.mock('../../../src/meta/answered.js', () => ({
  allQuotesAnswered: (...args: unknown[]) => allQuotesAnswered(...args),
  isMessageAnswered: vi.fn(async () => false),
  markMessageAnswered: vi.fn(async () => undefined),
}));
vi.mock('../../../src/meta/flags.js', () => ({
  isMetaSubagentChat: (...args: unknown[]) => isMetaSubagentChat(...args),
}));
vi.mock('../../../src/meta/heart-refractory.js', () => ({
  shouldSuppressMetaHeartDispatch: vi.fn(async () => false),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 999001,
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    MASTER_UID: 6251541967,
    META_USAGE: 'judge',
    CODEACT_TIMEOUT_MS: 5000,
    CODEACT_BANNED_WORDS: [],
  }),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    lpush: vi.fn(async () => 1),
    ltrim: vi.fn(async () => 'OK'),
  }),
}));

import { _resetGlobalState } from '../../../src/meta/global-state.js';
import { runMetaSession } from '../../../src/meta/session.js';
import type { AttentionItem } from '../../../src/meta/types.js';

describe('L0 autoDispatch before Meta LLM', () => {
  beforeEach(() => {
    _resetGlobalState();
    callWithFallback.mockReset();
    // classifyWorkIntent calls callWithFallback during autoDispatchL0;
    // default: return 'chat' so L0 takes the normal short-reply path.
    callWithFallback.mockResolvedValue({ content: 'chat' });
    enqueueCodeActJob.mockClear();
    isCodeActBusy.mockReset();
    isCodeActBusy.mockResolvedValue(false);
    tryClaimQuote.mockClear();
    tryClaimQuote.mockResolvedValue(true);
    tryMarkCodeActActive.mockClear();
    tryMarkCodeActActive.mockResolvedValue(true);
  });

  it('dispatches L0 with replyTo-self direction and skips Meta LLM', async () => {
    const attention: AttentionItem[] = [
      {
        id: 'a1',
        chatId: -1003579270814,
        layer: 'L0',
        pressure: 100,
        reason: 'mention',
        messageId: 393495,
        userId: 6251541967,
        textPreview: '千雪怎么了',
        createdAt: Date.now(),
        payload: {
          username: 'Zh_Taiwan',
          replyTo: {
            messageId: 393494,
            uid: 999001,
            textSnippet: '哼 本喵刚醒 才没跟他玩',
          },
        },
      },
    ];

    const result = await runMetaSession(attention, []);

    expect(result.digest).toBe('l0_auto_only');
    // Unified CodeAct: autoDispatchL0 is pure rules — NO LLM classifier, NO Meta LLM.
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(enqueueCodeActJob).toHaveBeenCalledOnce();
    const task = enqueueCodeActJob.mock.calls[0]![0] as {
      contentDirection: string;
      quoteMessageIds?: number[];
      targetUserId?: number;
    };
    expect(task.quoteMessageIds).toEqual([393495]);
    expect(task.targetUserId).toBe(6251541967);
    expect(task.contentDirection).toMatch(/回复你的 #393494/);
    expect(task.contentDirection).toMatch(/千雪怎么了/);
    expect(task.contentDirection).toMatch(/禁止臆造/);
    expect(task.contentDirection).not.toMatch(/简单说没事|本喵在看着/);
  });

  it('busy L0 is requeued and still skips Meta LLM (no scripting)', async () => {
    isCodeActBusy.mockResolvedValueOnce(true);
    const attention: AttentionItem[] = [
      {
        id: 'a2',
        chatId: -1001,
        layer: 'L0',
        pressure: 100,
        reason: 'dm',
        messageId: 42,
        userId: 1,
        textPreview: '在吗',
        createdAt: Date.now(),
        payload: { username: 'u' },
      },
    ];

    const result = await runMetaSession(attention, []);
    expect(result.digest).toBe('l0_auto_only');
    // Unified CodeAct: autoDispatchL0 is pure rules — no LLM classifier involved.
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(enqueueCodeActJob).not.toHaveBeenCalled();
  });
});
