import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveScope } from '../../../src/shared/cognitive-scope.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

let db: Database.Database;
const config: Record<string, unknown> = {
  BOT_TOKEN: '123:test', META_INJECT_LEARNED_ENABLED: true,
  COGNITIVE_EVENTS_ENABLED: true, COGNITIVE_OUTBOX_ENABLED: false,
};
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => logger };
  return { logger };
});
vi.mock('../../../src/shared/config.js', () => ({ loadCachedPrompt: () => '', loadPrompt: () => '' }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 123, getBotIdentity: () => ({ uid: 123 }) }));
vi.mock('../../../src/learners/dialect-exemplar.js', () => ({ getExemplars: () => [] }));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { projectCognitiveEvent } from '../../../src/agent/cognitive-projector.js';
import { applyHypothesisObservation } from '../../../src/agent/hypothesis-updates.js';
import { getActiveSelfNotes, pruneSelfNotes, saveSelfNotes, saveVerifiedSelfNotes } from '../../../src/tracking/self-model.js';
import { buildLearnedContext } from '../../../src/subagent/learned-context.js';
import { buildMessages } from '../../../src/pipeline/reply/prompt-builder.js';
import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import { resolveConversationScope } from '../../../src/shared/privacy-scope.js';
import { buildScopedWorldProjection } from '../../../src/agent/world-projection.js';

beforeEach(() => {
  config['BOT_TOKEN'] = '123:test';
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of ['0056_self_model.sql', '0089_cognitive_events.sql', '0109_hypothesis_update_audit.sql',
    '0118_platform_identity.sql', '0124_self_note_provenance.sql']) {
    db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
});
afterEach(() => db.close());

function decision(chatId: number | null, note = '技术问题先给结论', extra: Record<string, unknown> = {}) {
  const scope: CognitiveScope = chatId === null ? { visibility: 'global' } : { visibility: 'chat', chatId };
  const notes = [{ note, evidence: '已核验的反馈' }];
  const evidence = { accepted: true };
  const event = appendCognitiveEvent({ type: 'task_observation', scope, source: 'host', fact: {
    hypothesisKind: 'self', hypothesisSubject: 'bot', notes, evidence,
    ...(chatId === null ? { selfNoteGlobalApproved: true } : {}),
    ...extra,
  } })!.event;
  return { event, notes, input: { sourceEventId: event.id, source: 'host' as const, scope, evidence } };
}
const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('self-note evidence and scoped consumption', () => {
  it('real event → projector → Meta and legacy prompts consumes only its chat', async () => {
    const d = decision(42, '私聊特有的核验提醒');
    expect(projectCognitiveEvent(d.event, { createDebts: false }).hypothesisUpdates).toBe(1);
    expect((await buildLearnedContext({ chatId: 42 })).block).toContain('私聊特有的核验提醒');
    expect((await buildLearnedContext({ chatId: -42 })).block).not.toContain('私聊特有的核验提醒');
    const message: FormattedMessage = { role: 'user', uid: 42, timestamp: 10, messageId: 8, textContent: '现在聊什么' };
    const prompt = (chat: number) => buildMessages('system', '', message, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, chat).map((m) => m.content).join('\n');
    expect(prompt(42)).toContain('私聊特有的核验提醒');
    expect(prompt(-42)).not.toContain('私聊特有的核验提醒');
    expect(getActiveSelfNotes()).toEqual([]);
    expect(buildScopedWorldProjection({ visibility: 'chat', chatId: 42 }).self[0])
      .toMatchObject({ statement: '私聊特有的核验提醒', scopeKey: 'chat:42' });
    expect(buildScopedWorldProjection({ visibility: 'chat', chatId: -42 }).self).toEqual([]);
  });

  it('does not widen user/task-scoped approval into the whole chat', () => {
    const d = decision(42);
    for (const scope of [{ visibility: 'user' as const, chatId: 42, userId: 7 },
      { visibility: 'task' as const, chatId: 42, taskId: 'task-a' }]) {
      const event = appendCognitiveEvent({ type: 'task_observation', scope, source: 'host', fact: d.event.fact })!.event;
      expect(saveVerifiedSelfNotes(d.notes, { ...d.input, scope, sourceEventId: event.id })).toBe(0);
    }
    expect(count('self_model_notes')).toBe(0);
  });

  it('a random event ID, wrong source, unrelated event, changed notes or scope cannot certify a note', () => {
    const d = decision(42);
    expect(saveVerifiedSelfNotes(d.notes, { ...d.input, sourceEventId: 'not-an-event' })).toBe(0);
    expect(saveVerifiedSelfNotes(d.notes, { ...d.input, source: 'scheduler' })).toBe(0);
    expect(saveVerifiedSelfNotes(d.notes, { ...d.input, scope: { visibility: 'global' } })).toBe(0);
    expect(saveVerifiedSelfNotes(d.notes, { ...d.input, evidence: { accepted: false } })).toBe(0);
    expect(saveVerifiedSelfNotes([{ note: '被替换的私聊内容' }], d.input)).toBe(0);
    const event = appendCognitiveEvent({ type: 'message_received', source: 'host', scope: d.input.scope, fact: { notes: d.notes } })!.event;
    expect(saveVerifiedSelfNotes(d.notes, { ...d.input, sourceEventId: event.id })).toBe(0);
    expect(count('self_model_note_evidence')).toBe(0);
  });

  it('new self events receive host scope while duplicate old events and model claims never acquire authority', () => {
    const d = decision(42, '检查来源快照真实性', { conversationScope: { chatId: -77, accountId: 'evil' } });
    expect(d.event.fact['conversationScope']).toEqual(resolveConversationScope(42));
    const input = { type: 'task_observation' as const, scope: d.input.scope, source: 'host' as const,
      dedupeKey: 'old-self-note', fact: d.event.fact };
    const old = appendCognitiveEvent(input)!.event;
    db.prepare('UPDATE cognitive_events SET fact_json = ? WHERE id = ?').run(JSON.stringify({
      ...old.fact, conversationScope: undefined,
    }), old.id);
    const replay = appendCognitiveEvent(input)!;
    expect(replay.inserted).toBe(false);
    expect(replay.event.fact['conversationScope']).toBeUndefined();
    const model = appendCognitiveEvent({ ...input, source: 'model', dedupeKey: 'model-self-note' })!.event;
    expect(model.fact['conversationScope']).toBeUndefined();
  });

  it('model self-certification and missing global approval remain inactive', () => {
    const d = decision(null, '需要人工批准的全局提醒', { selfNoteGlobalApproved: false });
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(0);
    expect(applyHypothesisObservation({ kind: 'self', subjectKey: 'bot', source: 'model',
      scope: { visibility: 'global' }, sourceEventId: d.event.id, notes: d.notes, evidence: { accepted: true } }).status).toBe('candidate');
    expect(getActiveSelfNotes()).toEqual([]);
  });

  it('old unknown source and old account evidence remain archived, never relabelled to current account', () => {
    const d = decision(42);
    db.prepare('UPDATE cognitive_events SET fact_json = ? WHERE id = ?').run(JSON.stringify({
      ...d.event.fact, conversationScope: undefined,
    }), d.event.id);
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(0);
    const valid = decision(42);
    expect(saveVerifiedSelfNotes(valid.notes, valid.input)).toBe(1);
    config['BOT_TOKEN'] = '456:test';
    expect(getActiveSelfNotes(5, undefined, 42)).toEqual([]);
    expect(saveVerifiedSelfNotes(valid.notes, valid.input)).toBe(0);
    expect(count('self_model_note_evidence')).toBe(1);
  });

  it('QQ and Telegram, and two QQ accounts, do not share same raw-ID notes', () => {
    const ref = { platform: 'qq' as const, accountId: '99', idNamespace: 'qq-number' as const, conversationKind: 'private' as const, id: '42' };
    const qq = getOrCreateConversationId(ref);
    const other = getOrCreateConversationId({ ...ref, accountId: '100' });
    const d = decision(qq, '只适用于这个 QQ 会话');
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(1);
    expect(getActiveSelfNotes(5, undefined, qq)).toHaveLength(1);
    expect(getActiveSelfNotes(5, undefined, 42)).toEqual([]);
    expect(getActiveSelfNotes(5, undefined, other)).toEqual([]);
  });

  it('filters authority before LIMIT and never reuses notes verified after the requested snapshot', () => {
    const own = decision(42, '当前私聊有效提醒');
    saveVerifiedSelfNotes(own.notes, own.input);
    for (let i = 0; i < 8; i++) {
      const other = decision(-77, `其他会话提醒 ${i}`);
      saveVerifiedSelfNotes(other.notes, other.input);
    }
    expect(getActiveSelfNotes(1, undefined, 42)[0]?.note).toBe('当前私聊有效提醒');
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE self_model_notes SET created_at = ?').run(now - 60);
    expect(getActiveSelfNotes(1, now - 1, 42)).toEqual([]);
  });

  it('fails closed without evidence/provenance schema and does not delete uncertain legacy data', () => {
    saveSelfNotes([{ note: '未验证的模型原话' }]);
    db.exec('DROP TABLE self_model_note_evidence');
    expect(getActiveSelfNotes(5)).toEqual([]);
    pruneSelfNotes(0, 0);
    expect(count('self_model_notes')).toBe(1);
  });

  it('candidate floods cannot evict verified notes; verified retention is per scope', () => {
    const d = decision(42, '保留的有效自我提醒');
    saveVerifiedSelfNotes(d.notes, d.input);
    for (let i = 0; i < 25; i++) saveSelfNotes([{ note: `混合来源候选 ${i}` }], {
      origin: 'self_reflect', sourceChatIds: [42, -42],
    });
    for (let i = 0; i < 4; i++) {
      const other = decision(-42, `另一会话已验证 ${i}`);
      saveVerifiedSelfNotes(other.notes, other.input);
    }
    pruneSelfNotes(2, 1);
    expect(count('self_model_notes')).toBe(4); // Two candidates, one verified per chat.
    expect(getActiveSelfNotes(5, undefined, 42)[0]?.note).toBe('保留的有效自我提醒');
    expect(getActiveSelfNotes(5, undefined, -42)[0]?.note).toBe('另一会话已验证 3');
  });

  it('promotion is atomic on a mid-write failure; replay and retention cannot duplicate or resurrect it', () => {
    const d = decision(42);
    db.exec("CREATE TRIGGER fail_note_receipt BEFORE INSERT ON self_model_note_promotions BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(0);
    expect(count('self_model_notes')).toBe(0);
    expect(count('self_model_note_evidence')).toBe(0);
    db.exec('DROP TRIGGER fail_note_receipt');
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(1);
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(1);
    expect(count('self_model_notes')).toBe(1);
    pruneSelfNotes(0, 0);
    expect(count('self_model_notes')).toBe(0);
    expect(saveVerifiedSelfNotes(d.notes, d.input)).toBe(1);
    expect(count('self_model_notes')).toBe(0);
    expect(count('self_model_note_promotions')).toBe(1);
  });

  it('only explicit globally approved host decisions are reusable as global self rules', () => {
    const d = decision(null, '不确定的事实要承认不确定');
    expect(projectCognitiveEvent(d.event, { createDebts: false }).hypothesisUpdates).toBe(1);
    expect(getActiveSelfNotes(5, undefined, 42)[0]?.note).toBe(d.notes[0]!.note);
    expect(getActiveSelfNotes(5, undefined, -42)[0]?.note).toBe(d.notes[0]!.note);
  });
});
