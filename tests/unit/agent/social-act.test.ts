import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildLegacySocialActShadow,
  isSocialActShadowChat,
  listSocialActProposals,
  listSocialActOutcomes,
  parseSocialActProposal,
  recordSocialActOutcome,
  recordMetaSocialActShadow,
  replaySocialActs,
  recordLegacySocialActOutcome,
  recordLegacySocialActShadow,
} from '../../../src/agent/social-act.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

const message = {
  role: 'user' as const,
  uid: 42,
  username: 'u',
  fullName: 'User',
  timestamp: 1_700_000_000,
  messageId: 7,
  textContent: 'private text must not be copied',
  isForwarded: false,
};

describe('SocialAct shadow contract', () => {
  it('uses the existing judge without storing message text or reasoning', () => {
    const proposal = buildLegacySocialActShadow({
      chatId: -100,
      message,
      cognitiveAnchorEventId: 'event-1',
      judgeResult: {
        action: 'REPLY',
        level: 'L2_AI',
        replyPath: 'direct',
        rule: 'mention_self',
        confidence: 0.8,
        reasoning: 'private chain of thought that must not persist',
        latencyMs: 42,
      },
    });
    expect(proposal).toMatchObject({
      schema: 'social_act.v1',
      intent: 'answer',
      replyToMessageId: 7,
      triggerEventId: 'event-1',
      thoughtUnits: [],
      bubbles: [],
    });
    expect(proposal?.targetUserId).toBeUndefined();
    const recorded = recordLegacySocialActShadow({
      chatId: -100,
      message,
      cognitiveAnchorEventId: 'event-1',
      judgeResult: proposal!.judge!,
    });
    expect(recorded?.inserted).toBe(true);
    const row = db.prepare('SELECT type, fact_json, causation_id FROM cognitive_events').get() as { type: string; fact_json: string; causation_id: string };
    expect(row.type).toBe('social_act_proposed');
    expect(row.causation_id).toBe('event-1');
    expect(row.fact_json).not.toContain('private text');
    expect(row.fact_json).not.toContain('chain of thought');
    expect(listSocialActProposals({ chatId: -100 })).toEqual([
      expect.objectContaining({ messageId: 7, intent: 'answer', judgeAction: 'REPLY', judgeLevel: 'L2_AI' }),
    ]);
  });

  it('records host delivery outcomes only after a proposal and replays bounded metrics', () => {
    const input = {
      chatId: -100,
      message,
      judgeResult: { action: 'REPLY' as const, level: 'L1_MICRO' as const, latencyMs: 8 },
    };
    expect(recordLegacySocialActShadow(input)?.inserted).toBe(true);
    expect(recordLegacySocialActOutcome({
      chatId: -100,
      messageId: 7,
      status: 'sent',
      plannedBubbleCount: 2,
      deliveredBubbleCount: 2,
      targetMessageIds: [7],
      deliveredMessageIds: [8, 9],
      media: { reactions: 1 },
    })?.inserted).toBe(true);
    expect(recordLegacySocialActOutcome({
      chatId: -100,
      messageId: 7,
      status: 'sent',
      plannedBubbleCount: 2,
      deliveredBubbleCount: 2,
      targetMessageIds: [7],
      deliveredMessageIds: [8, 9],
    })?.inserted).toBe(false);
    expect(listSocialActOutcomes({ chatId: -100 })).toHaveLength(1);
    expect(replaySocialActs({ chatId: -100, nowSec: 1_700_000_100 })).toMatchObject({
      totalProposals: 1,
      totalOutcomes: 1,
      missingOutcomes: 0,
      orphanOutcomes: 0,
      statusCounts: { delivered: 1 },
      delivery: { plannedBubbles: 2, deliveredBubbles: 2, multiBubbleProposals: 1, multiBubbleDeliveries: 1 },
      prediction: { eligible: 1, meanError: 0, exactRate: 1 },
    });
  });

  it('rejects an outcome whose scope carries a different user/task boundary', () => {
    const input = {
      chatId: -100,
      message,
      judgeResult: { action: 'REPLY' as const, level: 'L1_MICRO' as const, latencyMs: 8 },
    };
    expect(recordLegacySocialActShadow(input)?.inserted).toBe(true);
    expect(recordSocialActOutcome({
      schema: 'social_act_outcome.v1',
      scope: { visibility: 'chat', chatId: -100, userId: 42 },
      status: 'delivered',
      completedAt: 1_700_000_001,
      plannedBubbleCount: 1,
      deliveredBubbleCount: 1,
      targetMessageIds: [7],
      deliveredMessageIds: [8],
      media: { stickers: 0, voices: 0, polls: 0, reactions: 0 },
    }, { messageId: 7 })).toBeNull();
    expect(listSocialActOutcomes({ chatId: -100 })).toHaveLength(0);
  });

  it('rejects scope mismatches and accepts negative Telegram group ids', () => {
    const proposal = buildLegacySocialActShadow({
      chatId: -100,
      message,
      judgeResult: { action: 'IGNORE', level: 'L0_RULE', latencyMs: 0 },
    });
    expect(proposal).not.toBeNull();
    expect(parseSocialActProposal({
      ...proposal,
      capability: { ...proposal!.capability, scope: { visibility: 'chat', chatId: -200 } },
    })).toBeNull();
    expect(parseSocialActProposal(proposal)).toMatchObject({ scope: { chatId: -100 } });
  });

  it('adapts a Meta dispatch without persisting its free-form direction', () => {
    const recorded = recordMetaSocialActShadow({
      chatId: -100,
      messageId: 22,
      layer: 'L1',
      decision: 'proposed',
      targetUserId: 42,
      taskId: 'task-22',
      cognitiveAnchorEventId: 'event-22',
    });
    expect(recorded?.inserted).toBe(true);
    const row = db.prepare('SELECT source, fact_json FROM cognitive_events WHERE type = ?').get('social_act_proposed') as { source: string; fact_json: string };
    expect(row.source).toBe('model');
    expect(row.fact_json).toContain('task-22');
    expect(row.fact_json).not.toContain('contentDirection');
  });

  it('deduplicates the same message and keeps chat scopes separate', () => {
    const input = {
      chatId: -100,
      message,
      judgeResult: { action: 'IGNORE' as const, level: 'L1_MICRO' as const, latencyMs: 3 },
    };
    expect(recordLegacySocialActShadow(input)?.inserted).toBe(true);
    expect(recordLegacySocialActShadow(input)?.inserted).toBe(false);
    expect(listSocialActProposals({ chatId: -100 })).toHaveLength(1);
    expect(listSocialActProposals({ chatId: -200 })).toEqual([]);
  });

  it('requires explicit enablement and honors a chat graylist', () => {
    expect(isSocialActShadowChat(-100, { enabled: false, chatIds: [] })).toBe(false);
    expect(isSocialActShadowChat(-100, { enabled: true, chatIds: [-200] })).toBe(false);
    expect(isSocialActShadowChat(-100, { enabled: true, chatIds: [-100] })).toBe(true);
    expect(isSocialActShadowChat(-100, { enabled: true, chatIds: [] })).toBe(true);
    expect(isSocialActShadowChat(0, { enabled: true, chatIds: [] })).toBe(false);
  });

  it('rejects invalid message and judge inputs without a write', () => {
    expect(buildLegacySocialActShadow({
      chatId: 0,
      message,
      judgeResult: { action: 'REPLY', level: 'L0_RULE', latencyMs: 0 },
    })).toBeNull();
    expect(recordLegacySocialActShadow({
      chatId: -100,
      message: { ...message, messageId: 0 },
      judgeResult: { action: 'REPLY', level: 'L0_RULE', latencyMs: 0 },
    })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM cognitive_events').get()).toEqual({ count: 0 });
  });
});
