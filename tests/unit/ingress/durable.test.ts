import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ config: { BOT_TOKEN: '123:synthetic', DURABLE_INGRESS_ENABLED: true }, db: undefined as unknown as Database.Database }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { acceptInbox, claimInbox, expireInboxClaims, getInboxEntry, listPendingInbox, settleInbox } from '../../../src/ingress/inbox-store.js';
import { durableTelegramMiddleware, installDurablePollingErrorHandler, runDurableIngress, startInboxRecovery, telegramEventIdentity } from '../../../src/ingress/durable.js';
import { canonicalJson, createMessageEventIdentity } from '../../../src/shared/event-identity.js';
const update = (id = 1, text = 'synthetic body'): Update => ({ update_id: id, message: { message_id: id, date: 100,
  chat: { id: 9, type: 'private', first_name: 'fixture' }, from: { id: 9, is_bot: false, first_name: 'fixture' }, text } });
const input = (id = 1) => ({ lane: 'telegram' as const, chatId: 9, identity: telegramEventIdentity(update(id), '123')!, payload: update(id) });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); f.db = new Database(':memory:');
  f.db.exec(readFileSync('migrations/0125_durable_ingress.sql', 'utf8')); f.config.BOT_TOKEN = '123:synthetic'; });
afterEach(() => { f.db.close(); vi.useRealTimers(); });
describe('durable input ownership and four times', () => {
  it('persists the full body before handler execution; duplicate original keeps first body', async () => {
    const handler = vi.fn(async () => { expect(listPendingInbox('telegram')).toHaveLength(0);
      expect(getInboxEntry(input().identity.eventId)?.payload).toEqual(update()); });
    await runDurableIngress(input(), handler);
    await runDurableIngress({ ...input(), payload: update(1, 'changed replay') }, handler);
    expect(handler).toHaveBeenCalledOnce();
    expect(getInboxEntry(input().identity.eventId)?.state).toBe('handler_returned');
    // This state deliberately is not "delivered" or "succeeded".
    expect(getInboxEntry(input().identity.eventId)?.identity).toMatchObject({ occurredAt: 100000, receivedAt: 1000000, processedAt: 1000000, editedAt: null });
  });
  it('recovers an accepted but never-started input once, not an active or expired attempt', async () => {
    const entry = acceptInbox(input()); const active = acceptInbox(input(2)); const claim = claimInbox(active.eventId)!;
    expect(claimInbox(active.eventId)).toBeNull();
    const handler = vi.fn(async () => {});
    const stop = startInboxRecovery('telegram', row => runDurableIngress({ ...input(), identity: row.identity, payload: row.payload }, handler));
    await vi.advanceTimersByTimeAsync(1000); stop();
    expect(handler).toHaveBeenCalledOnce(); expect(getInboxEntry(entry.eventId)?.state).toBe('handler_returned');
    expect(getInboxEntry(active.eventId)?.state).toBe('processing');
    vi.advanceTimersByTime(121000); expect(expireInboxClaims()).toBe(1);
    expect(getInboxEntry(active.eventId)?.state).toBe('unknown');
    expect(claimInbox(active.eventId)).toBeNull(); expect(settleInbox(claim, 'settled')).toBe(false);
  });
  it('holds a started failure and account change rather than re-running external work', async () => {
    const sideEffect = vi.fn();
    const handler = async () => { sideEffect(); throw new Error('synthetic failure after possible send'); };
    await runDurableIngress(input(), handler); await runDurableIngress(input(), handler);
    expect(sideEffect).toHaveBeenCalledOnce(); expect(getInboxEntry(input().identity.eventId)?.state).toBe('unknown');
    acceptInbox(input(2)); f.config.BOT_TOKEN = '456:synthetic';
    await runDurableIngress(input(2), handler);
    expect(getInboxEntry(input(2).identity.eventId)?.state).toBe('held'); expect(sideEffect).toHaveBeenCalledOnce();
  });
  it('processes the first accepted pending payload rather than changed retransmission text', async () => {
    acceptInbox(input());
    const observed: unknown[] = [];
    await runDurableIngress({ ...input(), payload: update(1, '/changed-command') }, async (_identity, payload) => { observed.push(payload); });
    expect(observed).toEqual([update()]);
  });
  it('keeps message identity stable but distinct edits in one second and both platforms apart', () => {
    const one = update(); const message = one.message!;
    const a = telegramEventIdentity({ update_id: 2, edited_message: { ...message, edit_date: 101, text: 'first' } }, '123')!;
    const b = telegramEventIdentity({ update_id: 3, edited_message: { ...message, edit_date: 101, text: 'second' } }, '123')!;
    expect(a.messageKey).toBe(b.messageKey); expect(a.eventId).not.toBe(b.eventId);
    expect(a).toMatchObject({ occurredAt: 100000, editedAt: 101000, receivedAt: 1000000, processedAt: null });
    expect(telegramEventIdentity({ message, update_id: 999 }, '123')?.eventId).toBe(input().identity.eventId);
    const qq = createMessageEventIdentity({ ref: { id: '1', conversation: { platform: 'qq', accountId: '123', idNamespace: 'qq-number', conversationKind: 'private', id: '9' } }, occurredAt: 100000 });
    expect(qq.eventId).not.toBe(input().identity.eventId);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it('does not silently truncate pending recovery after 500 records', () => {
    f.db.transaction(() => { for (let id = 1; id <= 601; id++) acceptInbox(input(id)); })();
    let cursor = 0, count = 0;
    while (true) { const page = listPendingInbox('telegram', cursor, 64); if (!page.length) break;
      count += page.length; cursor = page[page.length - 1]!.sequence; }
    expect(count).toBe(601);
  });
});
describe('actual grammY middleware ordering', () => {
  const bot = () => new Bot('123:synthetic', { botInfo: { id: 123, is_bot: true, first_name: 'fixture', username: 'fixture_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
  it('authorized commands are accepted before next; denied bodies are never stored', async () => {
    const app = bot(); const handler = vi.fn(async () => {});
    app.use(async (ctx, next) => { if (ctx.message?.text !== 'denied') await next(); });
    app.use(durableTelegramMiddleware()); app.on('message', handler);
    await app.handleUpdate(update()); await app.handleUpdate(update()); await app.handleUpdate(update(2, 'denied'));
    expect(handler).toHaveBeenCalledOnce(); expect(f.db.prepare('SELECT COUNT(*) AS n FROM ingress_inbox').get()).toEqual({ n: 1 });
  });
  it('grammY downstream sees the stored pending body and not a replacement command', async () => {
    acceptInbox(input());
    const app = bot(); const texts: string[] = [];
    app.use(durableTelegramMiddleware()); app.on('message:text', ctx => { texts.push(ctx.message.text); });
    await app.handleUpdate(update(1, '/changed-command'));
    expect(texts).toEqual(['synthetic body']);
  });
  it('storage failure rejects before the handler; post-accept failure is held and ACK-safe', async () => {
    const app = bot(); const handler = vi.fn(async () => { throw new Error('after possible side effect'); });
    app.use(durableTelegramMiddleware()); app.on('message', handler);
    await expect(app.handleUpdate(update())).resolves.toBeUndefined();
    expect(getInboxEntry(input().identity.eventId)?.state).toBe('unknown');
    f.db.exec('DROP TABLE ingress_inbox');
    await expect(app.handleUpdate(update(2))).rejects.toMatchObject({ error: { name: 'IngressNotAcceptedError' } });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('actual polling catch terminates before getUpdates confirms the failed update offset', async () => {
    const app = bot(); const fatal = new Error('synthetic process exit');
    const fallback = vi.fn(); const terminate = vi.fn((_code: number): never => { throw fatal; });
    const offsets: unknown[] = []; const handler = vi.fn(); const stop = vi.spyOn(app, 'stop');
    app.api.config.use(async (_previous, method, payload) => {
      if (method === 'getUpdates') { offsets.push((payload as { offset?: number }).offset); return { ok: true, result: [update()] }; }
      if (method === 'deleteWebhook') return { ok: true, result: true };
      throw new Error('unexpected synthetic API');
    });
    app.use(durableTelegramMiddleware()); app.on('message', handler);
    installDurablePollingErrorHandler(app, fallback, terminate);
    f.db.exec('DROP TABLE ingress_inbox');
    await expect(app.start()).rejects.toBe(fatal);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(1); expect(handler).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(offsets).toEqual([1]); // No next offset=2 acknowledges update_id=1.
  });
});
