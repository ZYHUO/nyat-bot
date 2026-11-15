import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  env: { BOT_TOKEN: '123:synthetic', ONEBOT_ACCOUNT_ID: '42', KNOWLEDGE_CRON_CHAT_IDS: [] as number[], KNOWLEDGE_CRON_HASH_PATH: '' },
  scan: vi.fn(), zrange: vi.fn(), getRecent: vi.fn(), getAll: vi.fn(), llm: vi.fn(),
}));
vi.mock('../../../../src/env.js', () => ({ env: () => f.env }));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => ({ scan: f.scan, zrange: f.zrange }) }));
vi.mock('../../../../src/nyatdb/index.js', () => ({ getNyatDb: () => null }));
vi.mock('../../../../src/pipeline/context/manager.js', () => ({ getRecent: f.getRecent, getAll: f.getAll }));
vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: f.llm }));
vi.mock('../../../../src/knowledge/manager.js', () => ({ getDynamicKnowledge: vi.fn(), updateKnowledge: vi.fn() }));
vi.mock('../../../../src/bot/bot.js', () => ({ getBotUid: () => 123 }));
vi.mock('../../../../src/shared/config.js', () => ({ getConfig: () => ({ promptsDir: 'unused' }), loadPrompt: () => '' }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../src/admin/obligations.js', () => ({ listObligationSnapshots: vi.fn() }));
vi.mock('../../../../src/agent/cognitive-route-observations.js', () => ({ getCognitiveRouteWindow: vi.fn() }));
vi.mock('../../../../src/agent/agency-runtime.js', () => ({ listAgencyRunSummaries: vi.fn() }));
vi.mock('../../../../src/agent/task-runtime-events.js', () => ({ getTaskRecoverySummary: vi.fn() }));
vi.mock('../../../../src/core/skills/revisions.js', () => ({ listSkillRevisionVerificationSummaries: vi.fn() }));
vi.mock('../../../../src/admin/feature-status.js', () => ({ getFeatureStatusReport: vi.fn() }));
vi.mock('../../../../src/platform/onebot-runtime.js', () => ({ getOneBotRuntimeStatus: vi.fn() }));

import { contextRedisKey, parseContextRedisKey, resolveStorageScope } from '../../../../src/pipeline/context/storage-scope.js';
import { createMonitorApi } from '../../../../src/admin/monitor.js';
import { runKnowledgeSync } from '../../../../src/cron/knowledge-sync.js';

let dir: string;
const key = (chatId: number, threadId = 0) => contextRedisKey(resolveStorageScope(chatId, threadId)!);
const rawKey = (fields: unknown[]) => 'xxb:ctx:v2:' + JSON.stringify(fields);

describe('source-scoped context key metadata discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'context-key-discovery-'));
    f.env.BOT_TOKEN = '123:synthetic';
    f.env.KNOWLEDGE_CRON_HASH_PATH = join(dir, 'hashes.json');
    f.env.KNOWLEDGE_CRON_CHAT_IDS = [];
    f.zrange.mockResolvedValue([]);
    f.getRecent.mockImplementation(async (chatId: number) => [{ timestamp: 1, messageId: 1, textContent: 'safe context ' + chatId }]);
    f.getAll.mockResolvedValue([]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses only canonical complete keys for the current account and exact kind/topic', () => {
    expect(parseContextRedisKey(key(77))).toEqual(resolveStorageScope(77));
    expect(parseContextRedisKey(key(-1001234567890, 2))).toEqual(resolveStorageScope(-1001234567890, 2));
    for (const bad of [
      rawKey(['telegram', '456', 77, 'private', 0]),
      rawKey(['qq', '123', 77, 'private', 0]),
      rawKey(['telegram', '123', 77, 'group', 0]),
      rawKey(['telegram', '123', 77, 'private', 1]),
      rawKey(['telegram', '123', 77, 'private', -1]),
      rawKey(['telegram', '123', 77, 'private', 0, 'extra']),
      'xxb:ctx:v2:' + JSON.stringify(['telegram', '123', 77, 'private', 0], null, 1),
      'xxb:ctx:v2:broken', 'xxb:ctx:77',
    ]) expect(parseContextRedisKey(bad)).toBeNull();
    const previousAccount = key(77);
    f.env.BOT_TOKEN = '456:synthetic';
    expect(parseContextRedisKey(previousAccount)).toBeNull();
  });

  it('the real monitor route discovers a current v2 DM and legacy ID, ignoring foreign/invalid keys', async () => {
    f.scan.mockResolvedValue(['0', [key(77), 'xxb:ctx:88',
      rawKey(['telegram', '456', 99, 'private', 0]), 'xxb:ctx:v2:broken', 'xxb:ctx:100junk']]);
    const getChat = vi.fn(async () => ({ title: 'Synthetic chat' }));
    const api = createMonitorApi({ redis: { scan: f.scan, zrange: f.zrange } as never,
      bot: { api: { getChat } } as never, env: { MONITOR_TOKEN: 'synthetic-monitor' } as never });
    const response = await api.request('http://localhost/chats?token=synthetic-monitor');
    expect(response.status).toBe(200);
    const result = await response.json() as { chats: Array<{ chatId: number }> };
    expect(result.chats.map((chat) => chat.chatId).sort()).toEqual([77, 88]);
    expect(f.getRecent.mock.calls.map(([chatId]) => chatId).sort()).toEqual([77, 88]);
    expect(f.getAll).not.toHaveBeenCalled();
  });

  it('the real knowledge cron retains group-only discovery and delegates bodies to safe getAll', async () => {
    f.scan.mockResolvedValue(['0', [key(-77), key(77), key(-88, 3), 'xxb:ctx:-99', 'xxb:ctx:-101:t2',
      rawKey(['telegram', '456', -102, 'group', 0]), 'xxb:ctx:v2:broken', 'xxb:ctx:-103junk']]);
    await runKnowledgeSync();
    expect(f.getAll.mock.calls.map(([chatId]) => chatId).sort((a, b) => a - b)).toEqual([-101, -99, -88, -77]);
    expect(f.llm).not.toHaveBeenCalled();
    expect(f.getRecent).not.toHaveBeenCalled();
  });
});
