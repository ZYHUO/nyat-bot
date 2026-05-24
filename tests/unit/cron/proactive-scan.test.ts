// ────────────────────────────────────────
// Tests: Proactive Scan cron (Stage C)
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

// ── Mocks ──

const mockRedis = {
  zremrangebyscore: vi.fn().mockResolvedValue(0),
  zrange: vi.fn().mockResolvedValue(['-1001']),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  hget: vi.fn().mockResolvedValue(JSON.stringify({ approved: true, enabled: true })),
};

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => mockRedis,
}));

const envValues: Record<string, unknown> = {
  PROACTIVE_SCAN_ENABLED: true,
  PROACTIVE_SCAN_INTERVAL_MIN: 5,
  PROACTIVE_SCAN_USAGE: 'judge',
  PROACTIVE_SCAN_MIN_INTERVAL_SEC: 900,
  PROACTIVE_SCAN_MAX_CHATS_PER_TICK: 3,
  PROACTIVE_SCAN_RECENT_MSG_COUNT: 15,
  PROACTIVE_SCAN_MIN_HUMAN_MSGS: 5,
  PROACTIVE_SCAN_HOUR_START: 0,
  PROACTIVE_SCAN_HOUR_END: 23,
  ALLOWLIST_ENABLED: false,
  BOT_USERNAME: 'xxb_bot',
  ALLOWLIST_REDIS_PREFIX: 'xxb:mal:',
  ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE: false,
  ALLOWLIST_MAX_SUBMISSIONS_PER_DAY: 20,
  ALLOWLIST_AUTO_AI_REVIEW: true,
  ALLOWLIST_AI_MESSAGE_LIMIT: 100,
  ALLOWLIST_AI_CONTEXT_MAX_CHARS: 24000,
  ALLOWLIST_AI_AUTO_ENABLE: true,
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: 0.85,
};

vi.mock('../../../src/env.js', () => ({
  env: () => envValues,
}));

vi.mock('../../../src/allowlist/allowlist.js', () => ({
  isGroupAllowed: vi.fn().mockResolvedValue(true),
}));

const mockGetChatState = vi.fn().mockResolvedValue({ state: 'RUNNING' });
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: (...args: unknown[]) => mockGetChatState(...args),
}));

const mockRunTimingGate = vi.fn().mockResolvedValue({
  action: 'continue',
  reason: 'llm',
  shortCircuited: false,
  latencyMs: 50,
});
vi.mock('../../../src/pipeline/timing/gate.js', () => ({
  runTimingGate: (...args: unknown[]) => mockRunTimingGate(...args),
}));

const mockCallWithFallback = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => mockCallWithFallback(...args),
}));

const mockSendDirect = vi.fn().mockResolvedValue({ messageId: 1 });
vi.mock('../../../src/bot/sender/streaming.js', () => ({
  StreamingSender: class {
    sendDirect = mockSendDirect;
  },
}));

vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 123456,
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: (path: string) => {
    if (path === 'task/proactive-scan.md') return '你是 {bot_name}，判断是否加入。输出JSON。';
    if (path === 'identity/persona.md') return '一只猫娘';
    return '';
  },
}));

function makeMessages(count: number, isBot = false): FormattedMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    uid: isBot ? 123456 : 1000 + i,
    username: isBot ? 'bot' : `user${i}`,
    fullName: isBot ? 'Bot' : `User ${i}`,
    timestamp: Math.floor(Date.now() / 1000) - (count - i) * 60,
    messageId: 100 + i,
    textContent: `Message ${i}`,
    isForwarded: false,
    isBot,
  }));
}

const mockGetRecent = vi.fn().mockResolvedValue(makeMessages(10));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => mockGetRecent(...args),
}));

const { runProactiveScan, isWithinActiveHours, pickCandidates } = await import(
  '../../../src/cron/proactive-scan.js'
);

describe('ProactiveScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to enabled defaults
    envValues.PROACTIVE_SCAN_ENABLED = true;
    envValues.PROACTIVE_SCAN_HOUR_START = 0;
    envValues.PROACTIVE_SCAN_HOUR_END = 23;
    // Default mocks
    mockCallWithFallback.mockResolvedValue({
      content: '{"join": true, "topic": "技术讨论", "reason": "有趣"}',
    });
    mockGetRecent.mockResolvedValue(makeMessages(10));
    mockGetChatState.mockResolvedValue({ state: 'RUNNING' });
    mockRunTimingGate.mockResolvedValue({
      action: 'continue',
      reason: 'llm',
      shortCircuited: false,
      latencyMs: 50,
    });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.zrange.mockResolvedValue(['-1001']);
  });

  it('disabled → noop', async () => {
    envValues.PROACTIVE_SCAN_ENABLED = false;
    await runProactiveScan();
    expect(mockRedis.zrange).not.toHaveBeenCalled();
  });

  it('outside active hours → noop', async () => {
    // Test the helper directly since we can't control system time easily
    expect(isWithinActiveHours(23, 23)).toBe(false);
  });

  it('happy path: sends proactive message', async () => {
    mockCallWithFallback
      .mockResolvedValueOnce({ content: '{"join": true, "topic": "Rust讨论", "reason": "有见解"}' })
      .mockResolvedValueOnce({ content: '我觉得Rust的所有权系统确实很优雅' });

    await runProactiveScan();
    expect(mockSendDirect).toHaveBeenCalledWith(-1001, '我觉得Rust的所有权系统确实很优雅');
    expect(mockRedis.set).toHaveBeenCalled();
    expect(mockRunTimingGate).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: -1001, isDirectInteraction: false }),
    );
  });

  it('gate returns wait → no message sent', async () => {
    mockCallWithFallback.mockResolvedValue({
      content: '{"join": true, "topic": "话题", "reason": "有见解"}',
    });
    mockRunTimingGate.mockResolvedValue({
      action: 'wait',
      waitSec: 30,
      reason: 'too_soon',
      shortCircuited: false,
      latencyMs: 50,
    });

    await runProactiveScan();
    expect(mockSendDirect).not.toHaveBeenCalled();
  });

  it('gate returns no_action → no message sent', async () => {
    mockCallWithFallback.mockResolvedValue({
      content: '{"join": true, "topic": "话题", "reason": "有见解"}',
    });
    mockRunTimingGate.mockResolvedValue({
      action: 'no_action',
      reason: 'not_relevant',
      shortCircuited: false,
      latencyMs: 50,
    });

    await runProactiveScan();
    expect(mockSendDirect).not.toHaveBeenCalled();
  });

  it('throttle hit → skips chat', async () => {
    const recentTime = String(Math.floor(Date.now() / 1000) - 60); // 60s ago, within 900s
    mockRedis.get.mockResolvedValue(recentTime);

    await runProactiveScan();
    expect(mockCallWithFallback).not.toHaveBeenCalled();
    expect(mockSendDirect).not.toHaveBeenCalled();
  });

  it('shouldChimeIn=false → skips', async () => {
    mockCallWithFallback.mockResolvedValue({
      content: '{"join": false, "topic": "", "reason": "纯闲聊"}',
    });

    await runProactiveScan();
    expect(mockSendDirect).not.toHaveBeenCalled();
    expect(mockRunTimingGate).not.toHaveBeenCalled();
  });

  it('not enough human messages → skips', async () => {
    mockGetRecent.mockResolvedValue(makeMessages(2)); // only 2 messages < 5

    await runProactiveScan();
    expect(mockCallWithFallback).not.toHaveBeenCalled();
  });

  it('chat state not RUNNING → skips', async () => {
    mockGetChatState.mockResolvedValue({ state: 'WAIT' });

    await runProactiveScan();
    expect(mockCallWithFallback).not.toHaveBeenCalled();
  });

  it('pickCandidates returns at most max items', () => {
    const ids = [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10];
    const result = pickCandidates(ids, 3);
    expect(result).toHaveLength(3);
    for (const id of result) {
      expect(ids).toContain(id);
    }
  });

  it('single chat failure does not stop others', async () => {
    mockRedis.zrange.mockResolvedValue(['-1001', '-1002']);
    mockGetChatState
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue({ state: 'RUNNING' });

    mockCallWithFallback
      .mockResolvedValueOnce({ content: '{"join": true, "topic": "话题", "reason": "ok"}' })
      .mockResolvedValueOnce({ content: '回复内容' });

    await runProactiveScan();
    // First chat fails at getChatState, second succeeds
    expect(mockSendDirect).toHaveBeenCalledTimes(1);
  });
});
