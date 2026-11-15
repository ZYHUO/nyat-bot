import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { DeliveryResult } from '../../../src/shared/delivery-result.js';
const f = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  send: vi.fn(),
  context: vi.fn(),
  memory: vi.fn(),
  slot: vi.fn(),
  mark: vi.fn(),
  valid: true,
  changedAt: 0,
  sourceId: 'source-1',
  version: 1,
  cfg: {
    BACKGROUND_PUBLICATION_ENABLED: true,
    BOT_TOKEN: '12345:synthetic',
    MASTER_UID: 20,
    PROACTIVE_HOURLY_MAX_PER_CHAT: 2,
    META_PENDING_INTENT_ENABLED: false,
  },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/agent/background-evidence.js', () => ({
  readPublicationEvidence: () => ({
    kind: 'memory_source',
    sourceId: f.sourceId,
    version: f.version,
    hash: 'hash-' + f.version,
    chatId: 20,
    platform: 'telegram',
    accountId: '12345',
    threadId: 0,
    changedAt: f.changedAt,
    text: 'synthetic source',
  }),
  validatePublicationEvidence: () => f.valid,
}));
vi.mock('../../../src/cron/activation-policy.js', () => ({
  checkProactiveActivation: async () => ({ allowed: true }),
}));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({
  tryAcquireProactiveSlot: f.slot,
  markProactiveSent: f.mark,
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessageDetailed: f.send,
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: f.context,
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  memorizeAcknowledgedDelivery: f.memory,
}));
import {
  beginBackgroundTask,
  cancelBackgroundTask,
  finishBackgroundTask,
  prepareBackgroundTask,
  proposeBackgroundPublication,
  readBackgroundEvidence,
} from '../../../src/agent/background-publication.js';
function task(id = 'check1'): DispatchTask {
  return {
    id,
    chatId: 20,
    createdAt: Date.now(),
    status: 'queued',
    contentDirection: 'synthetic background check',
  };
}
function start(id = 'check1', since = Date.now() - 1000) {
  return beginBackgroundTask(
    prepareBackgroundTask(task(id), {
      kind: 'self_play',
      key: 'self_play',
      sinceAt: since,
    }),
  );
}
function draft(run: ReturnType<typeof start>, text = '新版本的合成结果') {
  const e = readBackgroundEvidence(run, { kind: 'message', messageId: 42 });
  return proposeBackgroundPublication(run, text, [e.handle]);
}
beforeEach(() => {
  vi.clearAllMocks();
  f.valid = true;
  f.changedAt = Date.now();
  f.sourceId = 'source-1';
  f.version = 1;
  f.cfg.BACKGROUND_PUBLICATION_ENABLED = true;
  f.cfg.MASTER_UID = 20;
  f.cfg.BOT_TOKEN = '12345:synthetic';
  f.cfg.PROACTIVE_HOURLY_MAX_PER_CHAT = 2;
  f.db = new Database(':memory:');
  f.db.exec(
    readFileSync('migrations/0131_background_publications.sql', 'utf8'),
  );
  f.slot.mockResolvedValue(true);
  f.send.mockImplementation(async (chatId, text, _reply, _thread, identity) => {
    try {
      identity.beforeSend();
    } catch {
      return {
        status: 'failed',
        chatId,
        intentId: identity.intentId,
        revision: identity.revision,
        parts: [],
        plannedPartCount: 1,
        reason: 'cancel_before_wire',
      };
    }
    return {
      status: 'sent',
      chatId,
      intentId: identity.intentId,
      revision: identity.revision,
      parts: [{ messageId: 99, text, partIndex: 0 }],
      plannedPartCount: 1,
    };
  });
});
afterEach(() => f.db.close());
describe('durable background draft and actual publication boundary', () => {
  it.each(['no_update', 'no_change', 'failed_tools', 'done'])(
    '%s never publishes even an existing valid draft',
    async (summary) => {
      const run = start();
      const d = draft(run);
      expect(d).toEqual({ proposalId: expect.any(String), state: 'proposed' });
      expect(d).not.toHaveProperty('messageId');
      expect(
        (await finishBackgroundTask(run, { status: 'done', summary })).state,
      ).toBe('suppressed');
      expect(f.send).not.toHaveBeenCalled();
      expect(f.slot).not.toHaveBeenCalled();
      expect(f.context).not.toHaveBeenCalled();
    },
  );
  it('cannot use invented web evidence or another task handle', async () => {
    const a = start('a'),
      b = start('b'),
      h = readBackgroundEvidence(a, { kind: 'message', messageId: 42 });
    expect(() =>
      proposeBackgroundPublication(b, '不能发布', ['https://example.com']),
    ).toThrow('source_unregistered');
    expect(() =>
      proposeBackgroundPublication(b, '不能发布', [h.handle]),
    ).toThrow('source_unregistered');
    expect(
      await finishBackgroundTask(b, { status: 'done', summary: 'finding' }),
    ).toMatchObject({ state: 'suppressed', reason: 'source_unregistered' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('sends one confirmed new version and persists only its real ACK', async () => {
    const run = start();
    draft(run);
    const out = await finishBackgroundTask(run, {
      status: 'done',
      summary: 'finding',
    });
    expect(out.state).toBe('sent');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![2]).toBeUndefined();
    expect(f.context).toHaveBeenCalledWith(
      20,
      { textContent: '新版本的合成结果', messageId: 99 },
      undefined,
    );
    expect(f.memory).toHaveBeenCalledWith(20, {
      messageId: 99,
      text: '新版本的合成结果',
      partIndex: 0,
    });
    await finishBackgroundTask(run, { status: 'done', summary: 'finding' });
    expect(f.send).toHaveBeenCalledOnce();
    expect(() => beginBackgroundTask(run.task)).toThrow(
      'background_replay_held',
    );
  });
  it('rejects old, retracted or changed source versions without transport', async () => {
    const old = start('old', Date.now());
    f.changedAt = Date.now() - 5000;
    draft(old);
    expect(
      await finishBackgroundTask(old, { status: 'done', summary: 'finding' }),
    ).toMatchObject({ reason: 'no_new_source_version' });
    const changed = start('changed');
    f.changedAt = Date.now();
    draft(changed);
    f.valid = false;
    expect(
      await finishBackgroundTask(changed, {
        status: 'done',
        summary: 'finding',
      }),
    ).toMatchObject({ reason: 'source_changed' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('fences cancellation after preparation at the sender actual-wire callback', async () => {
    const run = start();
    draft(run);
    const implementation = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (...args) => {
      cancelBackgroundTask(run.task.id);
      return implementation(...args);
    });
    const out = await finishBackgroundTask(run, {
      status: 'done',
      summary: 'finding',
    });
    expect(out).toMatchObject({ state: 'failed', delivery: { parts: [] } });
    expect(f.context).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT state FROM background_checks').get()).toEqual({
      state: 'cancelled',
    });
  });
  it('retains partial ACK and unknown status without any automatic replay', async () => {
    const run = start();
    draft(run);
    f.send.mockImplementation(async (chatId, _text, _reply, _thread, id) => {
      id.beforeSend();
      return {
        status: 'unknown',
        chatId,
        intentId: id.intentId,
        revision: id.revision,
        parts: [{ messageId: 88, text: '确认前半', partIndex: 0 }],
        plannedPartCount: 2,
      } satisfies DeliveryResult;
    });
    expect(
      (await finishBackgroundTask(run, { status: 'done', summary: 'finding' }))
        .state,
    ).toBe('unknown');
    await finishBackgroundTask(run, { status: 'done', summary: 'finding' });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.context).toHaveBeenCalledWith(
      20,
      { textContent: '确认前半', messageId: 88 },
      undefined,
    );
    expect(f.mark).not.toHaveBeenCalled();
    const saved = f.db
      .prepare('SELECT state,receipt_json FROM background_publications')
      .get() as { state: string; receipt_json: string };
    expect(saved.state).toBe('unknown');
    expect(JSON.parse(saved.receipt_json).parts).toEqual([
      { messageId: 88, text: '确认前半', partIndex: 0 },
    ]);
  });
  it('deduplicates an identical version even when concurrent tasks pass initial reads', async () => {
    const a = start('a'),
      b = start('b');
    draft(a);
    draft(b, '不同措辞同一个版本');
    const result = await Promise.all([
      finishBackgroundTask(a, { status: 'done', summary: 'finding' }),
      finishBackgroundTask(b, { status: 'done', summary: 'finding' }),
    ]);
    expect(result.filter((r) => r.state === 'sent')).toHaveLength(1);
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('separates check budget from durable per-chat notification budget', async () => {
    f.cfg.PROACTIVE_HOURLY_MAX_PER_CHAT = 1;
    const a = start('a');
    draft(a);
    await finishBackgroundTask(a, { status: 'done', summary: 'finding' });
    f.version = 2;
    const b = start('b');
    draft(b, '另一个新结果');
    expect(
      (await finishBackgroundTask(b, { status: 'done', summary: 'finding' }))
        .state,
    ).toBe('suppressed');
    expect(f.send).toHaveBeenCalledOnce();
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM background_checks').get(),
    ).toEqual({ n: 2 });
  });
  it('requires an explicit producer record and current account; a model-looking prefix grants nothing', () => {
    expect(() =>
      beginBackgroundTask({
        ...task(),
        executionMode: 'background',
        backgroundOrigin: { kind: 'self_play', key: 'self_play', sinceAt: 1 },
      }),
    ).toThrow('background_replay_held');
    const prepared = prepareBackgroundTask(task(), {
      kind: 'self_play',
      key: 'self_play',
      sinceAt: 1,
    });
    f.cfg.BOT_TOKEN = '67890:synthetic';
    expect(() => beginBackgroundTask(prepared)).toThrow(
      'background_scope_or_origin_changed',
    );
  });
  it('a definite rejected tail with an ACK prefix remains unknown and cannot be published anew', async () => {
    const first = start();
    draft(first);
    f.send.mockResolvedValue({
      status: 'failed',
      chatId: 20,
      intentId: 'synthetic',
      revision: 1,
      parts: [{ messageId: 88, text: '确认前半', partIndex: 0 }],
      plannedPartCount: 2,
    });
    expect(
      (
        await finishBackgroundTask(first, {
          status: 'done',
          summary: 'finding',
        })
      ).state,
    ).toBe('unknown');
    const second = start('retry');
    draft(second, '另一种表述');
    expect(
      (
        await finishBackgroundTask(second, {
          status: 'done',
          summary: 'finding',
        })
      ).state,
    ).toBe('suppressed');
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('goal cancellation or a changed check generation invalidates the captured origin before publication', async () => {
    f.db.exec(
      "CREATE TABLE goals(id INTEGER PRIMARY KEY,topic TEXT,origin TEXT,chat_id INTEGER,status TEXT,check_count INTEGER); INSERT INTO goals VALUES(1,'test','operator',20,'active',1)",
    );
    const run = beginBackgroundTask(
      prepareBackgroundTask(task(), {
        kind: 'goal',
        key: '1',
        sinceAt: Date.now() - 1000,
      }),
    );
    draft(run);
    f.db.exec("UPDATE goals SET status='dropped'");
    expect(
      await finishBackgroundTask(run, { status: 'done', summary: 'finding' }),
    ).toMatchObject({
      state: 'suppressed',
      reason: 'cancelled_or_scope_changed',
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['self_play', 'dreaming'] as const)('revoking the configured owner cancels queued %s publication without changing the bot account', async kind => {
    const run=beginBackgroundTask(prepareBackgroundTask(task(),{kind,key:kind,sinceAt:Date.now()-1000})); draft(run);
    f.cfg.MASTER_UID=21;
    expect(await finishBackgroundTask(run,{status:'done',summary:'finding'})).toMatchObject({state:'suppressed',reason:'cancelled_or_scope_changed'});
    expect(f.send).not.toHaveBeenCalled();
  });
  it('a stale owner cannot settle another owner’s proposed result', async () => {
    const run = start();
    draft(run);
    await finishBackgroundTask(
      { ...run, owner: 'stale-owner' },
      { status: 'done', summary: 'no_update' },
    );
    expect(
      f.db.prepare('SELECT state FROM background_publications').get(),
    ).toEqual({ state: 'proposed' });
    expect(f.db.prepare('SELECT state FROM background_checks').get()).toEqual({
      state: 'running',
    });
  });
});
