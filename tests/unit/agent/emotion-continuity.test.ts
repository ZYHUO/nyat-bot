import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InnerState, AffectEpisode } from '../../../src/agent/nyatos-contracts.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

let db: Database.Database;
let recent: FormattedMessage[] = [];
let beforeRecentRead: (() => void) | undefined;
const base = 1_700_000_000;
const config: Record<string, unknown> = { BOT_TOKEN: '123:test', EMOTION_CONTINUITY_ENABLED: true,
  COGNITIVE_EVENTS_ENABLED: true, MOOD_ENABLED: true, MOOD_INJECT_ENABLED: true,
  MOOD_DECAY_RATE_PER_HOUR: 0.3, MOOD_INJECT_THRESHOLD: 20 };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => logger };
  return { logger };
});
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => { beforeRecentRead?.(); return recent; } }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotIdentity: () => ({ uid: 123 }) }));
vi.mock('../../../src/tracking/scratchpad.js', () => ({ getScratch: async () => [] }));
vi.mock('../../../src/tracking/social-needs.js', () => ({ getSocialNeed: async () => 0.5 }));
vi.mock('../../../src/subagent/task-store.js', () => ({ loadCodeActTask: async () => null }));
vi.mock('../../../src/context-engine/index.js', () => ({ getContextEngine: () => ({
  assemble: async (providers: Array<{ provide: () => { text: string } }>) => ({ prompt: providers.map((p) => p.provide().text).join('\n') }),
}) }));

import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { buildConversationField, deriveInnerStateFromConversationField } from '../../../src/agent/conversation-field.js';
import { getInnerStateTendencies, observeInnerStateForEvent, projectInnerStateFromConversationField } from '../../../src/agent/emotion-continuity.js';
import { getLatestInnerState, recordInnerState, listAffectEpisodes, recordAffectEpisode } from '../../../src/agent/nyatos-state.js';
import { buildCognitiveWorkspace } from '../../../src/agent/cognitive-workspace.js';
import { listDueProcessWakes, requestProcessWake } from '../../../src/agent/cognitive-continuity.js';
import { runCognitiveProcessTick } from '../../../src/agent/cognitive-process-runtime.js';
import { applyMoodEvent, getChatMood, moodPromptHint } from '../../../src/tracking/mood.js';

const scope = { visibility: 'chat' as const, chatId: 42 };
function inner(updatedAt = base): InnerState {
  return { schema: 'inner_state.v1', attention: 0.9, energy: 0.3, curiosity: 0.8, connection: 0.8,
    confidence: 0.4, uncertainty: 0.65, unresolved: ['latest_user_question'], wants: ['understanding'],
    aversions: ['不替别人许诺'], commitments: ['答应核对公开资料'], currentNeed: 'feedback', updatedAt };
}
function inbound(at = base + 60, id = 1, accountId = '123') {
  const eventIdentity = createMessageEventIdentity({ ref: { id: String(id), conversation: {
    platform: 'telegram', accountId, idNamespace: 'telegram', id: '42', conversationKind: 'private',
  } }, occurredAt: at * 1000, receivedAt: at * 1000 });
  const message = { role: 'user', uid: 42, username: 'tester', fullName: 'Tester', timestamp: at,
    messageId: id, textContent: '这件事为什么会这样？', eventIdentity } as FormattedMessage;
  const event = appendCognitiveEvent({ source: 'telegram', type: 'message_received', scope, occurredAt: at,
    fact: { eventIdentity, messageId: id, userId: 42, chatId: 42 }, dedupeKey: `test:${eventIdentity.eventId}` })!.event;
  return { message, event };
}
function affect(id: string, updatedAt = base, status: AffectEpisode['status'] = 'active'): AffectEpisode {
  return { schema: 'affect_episode.v1', id, scope, kind: 'curiosity', intensity: 0.6, valence: 0.4,
    arousal: 0.3, startedAt: base, updatedAt, status, triggerEventIds: [] };
}
const stateCount = () => (db.prepare("SELECT COUNT(*) AS n FROM cognitive_events WHERE type='inner_state_updated'").get() as { n: number }).n;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime((base + 60) * 1000);
  config['EMOTION_CONTINUITY_ENABLED'] = true; config['BOT_TOKEN'] = '123:test';
  recent = []; beforeRecentRead = undefined;
  db = new Database(':memory:');
  for (const file of ['0017_chat_mood.sql', '0089_cognitive_events.sql', '0118_platform_identity.sql', '0128_emotion_projection.sql']) {
    db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('recorded emotion continuity', () => {
  it('preserves prior commitments and transitions gradually; 30 idle days relax numerical state', () => {
    const quiet = buildConversationField({ chatId: 42, botUid: 123, recent: [], nowSec: base + 60 });
    const first = deriveInnerStateFromConversationField(quiet, base + 60, inner());
    expect(first.attention).toBeGreaterThan(0.8);
    expect(first.attention).toBeLessThan(0.9);
    expect(first.commitments).toEqual(inner().commitments);
    expect(first.aversions).toEqual(inner().aversions);
    let state = first;
    for (let day = 1; day <= 30; day++) {
      const at = base + day * 86400;
      state = deriveInnerStateFromConversationField({ ...quiet, asOf: at }, at, state);
      expect(state.attention).toBeGreaterThanOrEqual(0);
      expect(state.attention).toBeLessThanOrEqual(1);
    }
    expect(state.attention).toBeLessThan(0.4);
    expect(state.commitments).toEqual(inner().commitments);
    expect(state.aversions).toEqual(inner().aversions);
    expect(state.wants).not.toContain('understanding');
  });

  it('real Meta workspace consumes a source-bound inbound exactly once, even on repeated/concurrent prompts', async () => {
    recordInnerState(inner(), { scope, causationId: 'host-seed', occurredAt: base });
    const input = inbound(); recent = [input.message];
    const views = await Promise.all(Array.from({ length: 3 }, () => buildCognitiveWorkspace({ chatId: 42, asOfEventId: input.event.id })));
    expect(stateCount()).toBe(2);
    expect(views[0]!.parts.some((part) => part.id === 'workspace:inner-state')).toBe(true);
    expect(getLatestInnerState(scope)!.value.commitments).toEqual(inner().commitments);
    const before = JSON.stringify(getLatestInnerState(scope));
    await buildCognitiveWorkspace({ chatId: 42 });
    expect(JSON.stringify(getLatestInnerState(scope))).toBe(before);
    expect(stateCount()).toBe(2);
  }, 15_000);

  it('plain reads, unknown anchors, foreign chats/accounts, or model anchors cannot mint experiences', async () => {
    const input = inbound(); recent = [input.message];
    expect(await observeInnerStateForEvent(77, input.event.id)).toBeNull();
    expect(await observeInnerStateForEvent(42, 'missing')).toBeNull();
    const model = appendCognitiveEvent({ source: 'model', type: 'message_received', scope, fact: input.event.fact })!.event;
    expect(await observeInnerStateForEvent(42, model.id)).toBeNull();
    config['BOT_TOKEN'] = '456:test';
    expect(await observeInnerStateForEvent(42, input.event.id)).toBeNull();
    expect(getInnerStateTendencies(42)).toEqual([]);
    expect(stateCount()).toBe(0);
  });

  it('old account state and no-provenance legacy states are not relabelled after a bot change', () => {
    recordInnerState(inner(), { scope, causationId: 'old-account', occurredAt: base });
    config['BOT_TOKEN'] = '456:test';
    expect(getLatestInnerState(scope)).toBeNull();
    config['BOT_TOKEN'] = '123:test';
    db.prepare("UPDATE cognitive_events SET fact_json=json_remove(fact_json,'$.conversationScope')").run();
    expect(getLatestInnerState(scope)).toBeNull();
    expect(stateCount()).toBe(1);
  });

  it('host process wake uses prior state and controllable elapsed time through the real runtime', async () => {
    recordInnerState(inner(), { scope, causationId: 'seed', occurredAt: base });
    requestProcessWake({ processId: 'chat-42:social', kind: 'social_mind', scope, wakeAt: base + 60, reason: 'message_received' });
    const result = await runCognitiveProcessTick(base + 60);
    expect(result).toMatchObject({ completed: 1, projected: 1, failed: 0, rescheduled: 1 });
    expect(getLatestInnerState(scope)!.value).toMatchObject({ commitments: inner().commitments, updatedAt: base + 60 });
    expect(getLatestInnerState(scope)!.value.attention).toBeGreaterThan(0.8);
    expect((await runCognitiveProcessTick(base + 60)).projected).toBe(0);
  });

  it('a wake from the previous bot account stays archived and cannot reschedule into a new account', async () => {
    const requested = requestProcessWake({ processId: 'chat-42:social', kind: 'social_mind', scope,
      wakeAt: base + 60, reason: 'message_received' })!;
    const original = db.prepare('SELECT fact_json FROM cognitive_events WHERE id=?').get(requested.eventId);
    config['BOT_TOKEN'] = '456:test';
    const fresh = inbound(base + 60, 2, '456'); recent = [fresh.message];
    const field = buildConversationField({ chatId: 42, botUid: 456, recent, nowSec: base + 60 });
    expect(projectInnerStateFromConversationField(field, { causationId: requested.eventId })).toBeNull();
    expect(await runCognitiveProcessTick(base + 60)).toMatchObject({ claimed: 0, projected: 0, rescheduled: 0 });
    expect(stateCount()).toBe(0);
    expect(db.prepare('SELECT fact_json FROM cognitive_events WHERE id=?').get(requested.eventId)).toEqual(original);
    expect((db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE type='cognitive_process_wake'").get() as { n: number }).n).toBe(1);
    // A current host request is independent even in the same chat/process/minute.
    const current = requestProcessWake({ processId: 'chat-42:social', kind: 'social_mind', scope,
      wakeAt: base + 60, reason: 'message_received' })!;
    expect(current.inserted).toBe(true);
    expect(current.eventId).not.toBe(requested.eventId);
    expect(await runCognitiveProcessTick(base + 60)).toMatchObject({ projected: 1, completed: 1, rescheduled: 1 });
  });

  it('a wake without saved account provenance is not stamped by a read or periodic reschedule', async () => {
    const requested = requestProcessWake({ processId: 'legacy', kind: 'observer', scope,
      wakeAt: base + 60, reason: 'message_received' })!;
    db.prepare("UPDATE cognitive_events SET fact_json=json_remove(fact_json,'$.conversationScope') WHERE id=?").run(requested.eventId);
    expect(listDueProcessWakes(base + 60)).toEqual([]);
    expect(await runCognitiveProcessTick(base + 60)).toMatchObject({ claimed: 0, projected: 0, rescheduled: 0 });
    expect(stateCount()).toBe(0);
    config['EMOTION_CONTINUITY_ENABLED'] = false;
    expect(listDueProcessWakes(base + 60).map((wake) => wake.wakeEventId)).toEqual([requested.eventId]);
  });

  it('an account change while reading context cannot convert a rejected wake into a new-account retry', async () => {
    requestProcessWake({ processId: 'async-account-change', kind: 'observer', scope,
      wakeAt: base + 60, reason: 'message_received' });
    beforeRecentRead = () => { config['BOT_TOKEN'] = '456:test'; };
    expect(await runCognitiveProcessTick(base + 60)).toMatchObject({ claimed: 1, failed: 1, projected: 0, rescheduled: 0 });
    expect(stateCount()).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE type='cognitive_process_checkpoint'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE type='cognitive_process_wake'").get() as { n: number }).n).toBe(1);
  });

  it('transaction failure leaves no partial experience and can retry the same recorded event', async () => {
    const input = inbound(); recent = [input.message];
    db.exec("CREATE TRIGGER block_inner BEFORE INSERT ON cognitive_events WHEN NEW.type='inner_state_updated' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(await observeInnerStateForEvent(42, input.event.id)).toBeNull();
    expect(stateCount()).toBe(0);
    db.exec('DROP TRIGGER block_inner');
    expect(await observeInnerStateForEvent(42, input.event.id)).not.toBeNull();
    expect(stateCount()).toBe(1);
  });

  it('feature off keeps the old projection behavior and never adds continuity writes', async () => {
    config['EMOTION_CONTINUITY_ENABLED'] = false;
    const input = inbound(); recent = [input.message];
    expect(await observeInnerStateForEvent(42, input.event.id)).toBeNull();
    expect(projectInnerStateFromConversationField(buildConversationField({ chatId: 42, botUid: 123,
      recent, nowSec: base + 60, asOfEventId: input.event.id }))).toBeNull();
    expect(stateCount()).toBe(0);
  });

  it('subtle mood hints expose a small recorded change without inventing rejection, anger or school events', () => {
    applyMoodEvent(42, 5, 'positive:user_replied');
    expect(moodPromptHint(getChatMood(42))).toContain('一点舒展');
    applyMoodEvent(42, -13, 'negative:explicit_negative');
    const hint = moodPromptHint(getChatMood(42));
    expect(hint).toContain('一点紧绷');
    expect(hint).not.toMatch(/被晾|被怼|上学|吃饭/);
    vi.setSystemTime((base + 30 * 86400) * 1000);
    expect(moodPromptHint(getChatMood(42))).toBe('');
  });

  it('read-only tendencies are bounded and age without mutating the ledger', () => {
    recordInnerState(inner(), { scope, causationId: 'seed', occurredAt: base });
    const count = stateCount();
    expect(getInnerStateTendencies(42)).toHaveLength(2);
    vi.setSystemTime((base + 30 * 86400) * 1000);
    const hints = getInnerStateTendencies(42);
    expect(hints).toHaveLength(2); // remembered commitment/boundary, not a fresh emotional event
    expect(hints.join('')).not.toContain('刚才的话题');
    expect(stateCount()).toBe(count);
  });
});

describe('affect revision projection', () => {
  it('same-second resolution replaces active version and delayed active replay cannot revive it', async () => {
    const active = affect('a');
    expect(recordAffectEpisode(active)?.inserted).toBe(true);
    expect(recordAffectEpisode({ ...active, status: 'resolved', resolution: '已缓和' })?.inserted).toBe(true);
    expect(listAffectEpisodes(scope)).toHaveLength(1);
    expect(listAffectEpisodes(scope)[0]!.value.status).toBe('resolved');
    expect(recordAffectEpisode({ ...active, updatedAt: base + 30 })).toBeNull();
    const workspace = await buildCognitiveWorkspace({ chatId: 42 });
    expect(workspace.parts.some((part) => part.id === 'workspace:affect')).toBe(false);
  });

  it('ranks latest version per episode before LIMIT and historical readers use the correct version', () => {
    recordAffectEpisode(affect('b'));
    for (let n = 1; n <= 20; n++) recordAffectEpisode({ ...affect('a', base + n), intensity: n / 20 });
    recordAffectEpisode(affect('a', base + 30, 'resolved'));
    const latest = listAffectEpisodes(scope, 2);
    expect(latest).toHaveLength(2);
    expect(latest.find((row) => row.value.id === 'a')!.value.status).toBe('resolved');
    expect(listAffectEpisodes(scope, 2, base + 10).find((row) => row.value.id === 'a')!.value.status).toBe('active');
  });

  it('a corrupt terminal version does not expose an older active version, and model feelings stay labelled candidates', async () => {
    recordAffectEpisode(affect('broken'));
    appendCognitiveEvent({ type: 'affect_episode_updated', source: 'host', scope, occurredAt: base + 10,
      fact: { value: { id: 'broken', status: 'resolved' } } });
    recordAffectEpisode(affect('candidate', base + 20));
    expect(listAffectEpisodes(scope).map((row) => row.value.id)).toEqual(['candidate']);
    const workspace = await buildCognitiveWorkspace({ chatId: 42 });
    expect(workspace.parts.find((part) => part.id === 'workspace:affect')?.text).toContain('模型感受候选，非外部事实');
  });
});
