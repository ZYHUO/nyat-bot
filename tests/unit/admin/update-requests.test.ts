import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Update } from 'grammy/types';

const fixture = vi.hoisted(() => ({ config: {} as Record<string, unknown>, results: '', resultUid: 0,
  send: vi.fn(async () => 1), conversation: null as unknown, user: null as unknown,
  beforeLink: vi.fn<() => Promise<void> | void>(),
  downstream: vi.fn(() => { throw new Error('owner_command_reached_model_pipeline'); }) }));
vi.mock('../../../src/env.js', () => ({ env: () => fixture.config }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: fixture.send }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/platform/identity-store.js', () => ({
  isPlatformInternalId: (id: number) => Math.abs(id) >= 2 ** 52,
  findConversationRef: () => fixture.conversation, findUserRef: () => fixture.user,
}));
// Exercise the production ingress function with the real update bridge, while
// keeping unrelated model/queue modules outside this offline composition.
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: vi.fn(), getBotIdentity: vi.fn() }));
vi.mock('../../../src/bot/middleware/dedup.js', () => ({ isDuplicate: async () => false }));
vi.mock('../../../src/bot/middleware/rate-limit.js', () => ({ isRateLimited: fixture.downstream }));
vi.mock('../../../src/queue/producer.js', () => ({ enqueue: fixture.downstream }));
vi.mock('../../../src/pipeline/timing/direct-interaction.js', () => ({ detectDirectInteraction: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/actor.js', () => ({ isTurnActorChat: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/abort-registry.js', () => ({ interruptGeneration: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/focus.js', () => ({ bumpFocus: fixture.downstream }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: fixture.downstream }));
vi.mock('../../../src/tracking/bot-classifier.js', () => ({}));
vi.mock('../../../src/pipeline/formatter.js', () => ({ formatMessage: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/obligation-detect.js', () => ({ detectReplyObligation: fixture.downstream, isObligationCancelMessage: fixture.downstream }));
vi.mock('../../../src/pipeline/turn/obligation-store.js', () => ({}));
vi.mock('../../../src/meta/index.js', () => ({ isMetaSubagentChat: fixture.downstream }));
vi.mock('../../../src/meta/ingress-intercepts.js', () => ({}));
vi.mock('../../../src/meta/classify-layer.js', () => ({}));
vi.mock('../../../src/meta/heart-route.js', () => ({}));
vi.mock('../../../src/meta/bookkeeping.js', () => ({}));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendTelegramMessageEvent: fixture.downstream }));
vi.mock('../../../src/meta/qq-heart-batch.js', () => ({}));
vi.mock('../../../src/ingress/durable.js', () => ({ currentIngressIdentity: () => undefined, telegramEventIdentity: () => undefined }));
vi.mock('../../../src/meta/qq-heart-processor.js', () => ({}));
vi.mock('../../../src/ingress/background.js', () => ({ trackIngressTask: fixture.downstream }));
vi.mock('../../../src/meta/pending-intent.js', () => ({ pendingIntentEnabled: fixture.downstream }));
vi.mock('../../../src/admin/business-config.js', () => ({ tryHandleJournalConfigCommand: fixture.downstream }));
// Real filesystem operations, with a synchronization point before publication
// and synthetic supervisor ownership for unprivileged CI.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, link: async (...args: Parameters<typeof fs.link>) => {
    await fixture.beforeLink();
    return fs.link(...args);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    const path = await fs.realpath(args[0]);
    if (fixture.results && (path === fixture.results || path.startsWith(fixture.results + '/'))) {
      const stat = file.stat.bind(file);
      file.stat = async () => Object.assign(await stat(), { uid: fixture.resultUid });
    }
    return file;
  } };
});

import { tryHandleUpdateCommand } from '../../../src/admin/update-requests.js';
import { ingestChatUpdate } from '../../../src/bot/handlers/message.js';

const release = 'a'.repeat(40);
let root = '';
let requests = '';
function update(text = `/update activate ${release}`, overrides: Record<string, unknown> = {}): Update {
  return { update_id: 10, message: { message_id: 20, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false, first_name: 'Owner' },
    text, ...overrides } } as Update;
}
const contents = async () => JSON.parse(await readFile(join(requests, 'request.json'), 'utf8'));
const reply = () => fixture.send.mock.calls.at(-1)?.[1] as string | undefined;
const noRequest = async () => expect(await readdir(requests)).toEqual([]);

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'nyat-update-client-'));
  requests = join(root, 'requests'); fixture.results = join(root, 'results');
  await mkdir(requests, { mode: 0o700 }); await mkdir(fixture.results, { mode: 0o755 });
  fixture.resultUid = 0; fixture.conversation = null; fixture.user = null;
  fixture.config = { UPDATE_REQUESTS_ENABLED: true, UPDATE_CONTROL_CHAT_IDS: [123],
    UPDATE_REQUEST_DIR: requests, UPDATE_RESULT_DIR: fixture.results, MASTER_UID: 123,
    BOT_TOKEN: '999:TEST_TOKEN', ONEBOT_ACCOUNT_ID: '900', ONEBOT_OWNER_ID: '800' };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('bounded owner update request bridge', () => {
  it('production ingress queues an owner command before either model or legacy processing', async () => {
    await ingestChatUpdate(update());
    expect((await contents()).release).toBe(release);
    expect(fixture.downstream).not.toHaveBeenCalled();
  });

  it('production ingress consumes an unauthorized update command without model escalation', async () => {
    await ingestChatUpdate(update(undefined, { from: { id: 124, is_bot: false } }));
    await noRequest(); expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.downstream).not.toHaveBeenCalled();
  });

  it('publishes a complete typed request and accurately reports queued, never completed', async () => {
    expect(await tryHandleUpdateCommand(update())).toBe(true);
    const request = await contents();
    expect(request).toEqual({ version: 1, id: expect.stringMatching(/^[a-f0-9]{32}$/), action: 'activate', release });
    expect(await readdir(requests)).toEqual(['request.json']);
    expect(reply()).toContain('已排队，尚未完成');
  });

  it('uses the same request ID across ingress retries, without overwriting pending work', async () => {
    await tryHandleUpdateCommand(update('/update rollback'));
    const first = await contents();
    await tryHandleUpdateCommand(update('/update rollback'));
    expect(await contents()).toEqual(first);
    expect(reply()).toContain('本次未覆盖');
    await unlink(join(requests, 'request.json'));
    await tryHandleUpdateCommand(update('/update rollback'));
    expect(await contents()).toEqual(first);
  });

  it('preserves the existing request when concurrent commands arrive', async () => {
    // Race the real link operations after both handlers have loaded the sender.
    // Vitest 3 can bypass a factory mock during overlapping dynamic imports.
    const firstAtLink = Promise.withResolvers<void>();
    const secondAtLink = Promise.withResolvers<void>();
    fixture.beforeLink.mockImplementationOnce(() => {
      firstAtLink.resolve();
      return secondAtLink.promise;
    }).mockImplementationOnce(secondAtLink.resolve);
    const first = tryHandleUpdateCommand(update('/update rollback'));
    await firstAtLink.promise;
    await Promise.all([first,
      tryHandleUpdateCommand(update(`/update activate ${release}`, { message_id: 21 }))]);
    expect(await readdir(requests)).toEqual(['request.json']);
    expect(['rollback', 'activate']).toContain((await contents()).action);
    expect(fixture.send.mock.calls.filter(call => (call[1] as string).includes('已排队')).length).toBe(1);
    expect(fixture.send.mock.calls.filter(call => (call[1] as string).includes('本次未覆盖')).length).toBe(1);
  });

  it('is default-off and needs an explicit control chat allowlist', async () => {
    fixture.config.UPDATE_REQUESTS_ENABLED = false;
    expect(await tryHandleUpdateCommand(update())).toBe(false);
    fixture.config.UPDATE_REQUESTS_ENABLED = true; fixture.config.UPDATE_CONTROL_CHAT_IDS = [];
    expect(await tryHandleUpdateCommand(update())).toBe(true);
    await noRequest(); expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each([
    { from: { id: 124, is_bot: false } },
    { chat: { id: -123, type: 'group' } },
    { from: { id: 123, is_bot: true } },
    { forward_origin: { type: 'hidden_user', sender_user_name: 'Owner' } },
    { forward_date: 1 }, { via_bot: { id: 5 } }, { sender_chat: { id: 123 } },
    { sender_business_bot: { id: 5 } }, { business_connection_id: 'foreign-account' },
  ])('rejects group, forwarded, bot or non-owner command provenance: %j', async overrides => {
    await tryHandleUpdateCommand(update(undefined, overrides));
    await noRequest(); expect(fixture.send).not.toHaveBeenCalled();
  });

  it('consumes edited commands without executing them', async () => {
    const source = update();
    await tryHandleUpdateCommand({ update_id: 10, edited_message: source.message } as Update);
    await noRequest(); expect(fixture.send).not.toHaveBeenCalled();
  });

  it('rejects old or future commands instead of replaying queued rollbacks after downtime', async () => {
    for (const date of [Math.floor(Date.now() / 1000) - 301, Math.floor(Date.now() / 1000) + 60]) {
      await tryHandleUpdateCommand(update('/update rollback', { date }));
      expect(reply()).toContain('已过期');
    }
    await noRequest();
  });

  it.each(['/update activate main', `/update activate ${release}; pwd`, '/update rollback\n/update rollback',
    '/update status ../../secret', '/update rollback ', `/update activate ${release}\n`,
    '/update status ' + 'b'.repeat(32) + '\n', '/update activate ' + 'A'.repeat(40)])(
    'rejects non-exact commands and arbitrary paths: %s', async text => {
      await tryHandleUpdateCommand(update(text)); await noRequest(); expect(reply()).toContain('支持 /update');
    });

  it('authorizes QQ using its stored platform/account owner, never Telegram MASTER_UID', async () => {
    const id = 2 ** 52 + 1;
    fixture.config.UPDATE_CONTROL_CHAT_IDS = [id]; fixture.config.MASTER_UID = id;
    fixture.conversation = { platform: 'qq', accountId: '900', idNamespace: 'qq-number', id: '700', conversationKind: 'private' };
    fixture.user = { platform: 'qq', accountId: '900', idNamespace: 'qq-number', id: '700' };
    const command = update('/update rollback', { chat: { id, type: 'private' }, from: { id, is_bot: false } });
    await tryHandleUpdateCommand(command); await noRequest();
    fixture.conversation = { ...fixture.conversation as object, id: '800' };
    fixture.user = { ...fixture.user as object, id: '800' };
    await tryHandleUpdateCommand(command);
    expect((await contents()).action).toBe('rollback');
  });

  it('rejects a QQ owner from another account', async () => {
    const id = 2 ** 52 + 1;
    fixture.config.UPDATE_CONTROL_CHAT_IDS = [id];
    fixture.conversation = { platform: 'qq', accountId: '901', idNamespace: 'qq-number', id: '800', conversationKind: 'private' };
    fixture.user = { platform: 'qq', accountId: '901', idNamespace: 'qq-number', id: '800' };
    await tryHandleUpdateCommand(update('/update rollback', { chat: { id, type: 'private' }, from: { id, is_bot: false } }));
    await noRequest();
  });

  it('reads the fixed completed receipt and does not requeue its event', async () => {
    await tryHandleUpdateCommand(update('/update rollback'));
    const request = await contents();
    await unlink(join(requests, 'request.json'));
    await writeFile(join(fixture.results, request.id + '.json'), JSON.stringify({ version: 1, id: request.id,
      status: 'succeeded', activeRelease: release, error: null }), { mode: 0o644 });
    await tryHandleUpdateCommand(update('/update rollback'));
    expect(reply()).toContain('已完成'); await noRequest();
    await tryHandleUpdateCommand(update(`/update status ${request.id}`));
    expect(reply()).toContain(release);
  });

  it('reports missing results as unknown, rather than inventing a pending request', async () => {
    await tryHandleUpdateCommand(update('/update status ' + 'b'.repeat(32)));
    expect(reply()).toContain('或不存在'); await noRequest();
  });

  it('never follows result symlinks or displays raw controller content', async () => {
    const id = 'b'.repeat(32);
    const secret = join(root, 'private.txt'); await writeFile(secret, 'SECRET_DO_NOT_EXPOSE');
    await symlink(secret, join(fixture.results, id + '.json'));
    await tryHandleUpdateCommand(update(`/update status ${id}`));
    expect(reply()).toContain('无法确认'); expect(reply()).not.toContain('SECRET');
    await unlink(join(fixture.results, id + '.json'));
    await writeFile(join(fixture.results, id + '.json'), 'SECRET_DO_NOT_EXPOSE'.repeat(500));
    await tryHandleUpdateCommand(update(`/update status ${id}`));
    expect(reply()).toContain('无法确认'); expect(reply()).not.toContain('SECRET');
  });

  it('rejects malformed receipt IDs, unbounded errors and non-root supervisor ownership', async () => {
    const id = 'b'.repeat(32), path = join(fixture.results, id + '.json');
    for (const data of [{ id: 'c'.repeat(32), error: null }, { id, error: 'SECRET_DO_NOT_EXPOSE' },
      { id, error: 'failed\n' }, { id, error: null, activeRelease: release + '\n' }]) {
      await writeFile(path, JSON.stringify({ version: 1, status: 'failed', activeRelease: null, ...data }));
      await tryHandleUpdateCommand(update(`/update status ${id}`));
      expect(reply()).toContain('无法确认'); expect(reply()).not.toContain('SECRET');
    }
    fixture.resultUid = 1001;
    await tryHandleUpdateCommand(update()); await noRequest();
  });

  it('refuses unsafe directory aliases and writable supervisor directories', async () => {
    await chmod(fixture.results, 0o777);
    await tryHandleUpdateCommand(update()); await noRequest();
    await chmod(fixture.results, 0o755);
    const alias = join(root, 'alias'); await symlink(requests, alias);
    fixture.config.UPDATE_REQUEST_DIR = alias;
    await tryHandleUpdateCommand(update()); await noRequest();
  });
});
