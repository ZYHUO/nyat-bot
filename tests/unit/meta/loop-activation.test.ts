import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, SubagentCallback } from '../../../src/meta/types.js';
import type { MetaDeferEntry } from '../../../src/meta/defer.js';

const mocks = vi.hoisted(() => ({
  env: { META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [42], META_ACTIVATED_AT_SEC: 1_800_000_000, META_DEFER_ENABLED: true },
  callbacks: vi.fn(), defers: vi.fn(), ingest: vi.fn(), session: vi.fn(),
  archive: vi.fn(), warn: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.env }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: mocks.archive }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: mocks.warn, info: vi.fn() } }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ drainCallbacks: mocks.callbacks,
  getTask: (id: string) => ({ id, chatId: 42, createdAt: 1_800_000_000_000, status: 'done', contentDirection: 'synthetic' }),
}) }));
vi.mock('../../../src/meta/defer.js', () => ({ drainDueMetaDefers: mocks.defers }));
vi.mock('../../../src/meta/session.js', () => ({ runMetaSession: mocks.session }));

const attention: AttentionItem[] = [];
vi.mock('../../../src/meta/attention.js', () => ({
  getAttentionAccumulator: () => ({
    ingestAsync: mocks.ingest,
    size: async () => attention.length,
    flush: async () => attention.splice(0),
    requeue: async (items: AttentionItem[]) => { attention.push(...items); },
  }),
}));
import { metaTick } from '../../../src/meta/loop.js';

const epoch = 1_800_000_000_000;
afterEach(() => vi.unstubAllEnvs());
const callback = (id: string, createdAt: number, chatId = 42): SubagentCallback => ({
  id, taskId: id, chatId, summary: `synthetic ${id}`, ok: true, createdAt,
});
const defer = (reason: string, createdAt?: number): MetaDeferEntry => ({
  chatId: 42, layer: 'L1', reason, createdAt, textPreview: `synthetic ${reason}`, deferCount: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  attention.length = 0;
  mocks.env.META_SUBAGENT_ENABLED = true;
  mocks.env.META_ACTIVATED_AT_SEC = epoch / 1000;
  mocks.callbacks.mockResolvedValue([]);
  mocks.defers.mockResolvedValue([]);
  mocks.archive.mockResolvedValue(1);
  mocks.session.mockResolvedValue(undefined);
  mocks.ingest.mockImplementation(async (input: Omit<AttentionItem, 'id' | 'createdAt' | 'pressure'>) => {
    // The real accumulator stamps a new time. Tests must prove rejection happens
    // before this conversion can make old input look newly activated.
    attention.push({ ...input, id: `fresh-${attention.length}`, pressure: 50, createdAt: epoch + 10_000 });
  });
});

describe('Meta replay activation boundaries', () => {
  it('never drains durable work when invoked on an ingress-only process', async () => {
    vi.stubEnv('XXB_ENABLE_WORKER', 'false');
    vi.stubEnv('XXB_ENABLE_CRON', 'false');
    vi.stubEnv('XXB_ENABLE_BOT_INGRESS', 'true');
    await metaTick();
    expect(mocks.callbacks).not.toHaveBeenCalled();
    expect(mocks.defers).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it('holds old callbacks before attention gets a fresh timestamp and passes current callbacks', async () => {
    const old = callback('old', epoch - 1);
    const current = callback('current', epoch);
    mocks.callbacks.mockResolvedValueOnce([old, current]);
    await metaTick();
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest.mock.calls[0]![0].payload).toEqual({ taskId: 'current' });
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(mocks.session.mock.calls[0]![1]).toEqual([current]);
    expect(mocks.archive).toHaveBeenCalledTimes(1);
    const [key, field, raw] = mocks.archive.mock.calls[0]!;
    expect(key).toBe('xxb:meta:activation-held');
    expect(field).toMatch(/^callback:[a-f0-9]{64}$/);
    expect(JSON.parse(raw)).toMatchObject({ reason: 'predates_activation', input: old });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(old.summary);
  });

  it('holds legacy or old defers and preserves only the valid deferred payload', async () => {
    mocks.defers.mockResolvedValueOnce([defer('old', epoch - 1), defer('legacy'), defer('current', epoch)]);
    await metaTick();
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.archive.mock.calls.map(call => JSON.parse(call[2]).reason))
      .toEqual(['predates_activation', 'invalid_created_at']);
    expect(mocks.ingest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'defer_replay:current' }));
    expect(mocks.session.mock.calls[0]![0]).toHaveLength(1);
  });

  it('rejects fresh callbacks outside the allowed chat scope', async () => {
    mocks.callbacks.mockResolvedValueOnce([callback('other-chat', epoch, -1001)]);
    await metaTick();
    expect(JSON.parse(mocks.archive.mock.calls[0]![2]).reason).toBe('chat_outside_scope');
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('does not replay rejected input when archive storage fails and retries the same original input', async () => {
    const old = callback('archive-retry', epoch - 1);
    mocks.callbacks.mockResolvedValueOnce([old]);
    mocks.archive.mockRejectedValueOnce(new Error('synthetic redis unavailable'));
    await metaTick();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    await metaTick();
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.archive.mock.calls[1]).toEqual(mocks.archive.mock.calls[0]);
    expect(JSON.parse(mocks.archive.mock.calls[1]![2]).input).toEqual(old);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('requires an explicit positive activation epoch before any replay', async () => {
    mocks.env.META_ACTIVATED_AT_SEC = 0;
    mocks.callbacks.mockResolvedValueOnce([callback('unconfigured', epoch)]);
    await metaTick();
    expect(JSON.parse(mocks.archive.mock.calls[0]![2]).reason).toBe('invalid_activation_epoch');
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('does not drain or ingest anything while Meta is disabled', async () => {
    mocks.env.META_SUBAGENT_ENABLED = false;
    await metaTick();
    expect(mocks.callbacks).not.toHaveBeenCalled();
    expect(mocks.defers).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});
