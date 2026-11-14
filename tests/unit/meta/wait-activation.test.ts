import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaWaitAnchor } from '../../../src/meta/timing-adapter.js';
const f = vi.hoisted(() => ({
  config: { META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, TIMING_GATE_ENABLED: true, META_SUBAGENT_CHAT_IDS: [42], META_ACTIVATED_AT_SEC: 100 },
  getdel: vi.fn(), archive: vi.fn(), ingest: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ getdel: f.getdel, hsetnx: f.archive }) }));
vi.mock('../../../src/meta/attention.js', () => ({ getAttentionAccumulator: () => ({ ingestAsync: f.ingest }) }));
vi.mock('../../../src/pipeline/timing/gate.js', () => ({ runTimingGate: vi.fn() }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: vi.fn(), isChatSuppressed: vi.fn(), recordGateContinue: vi.fn(), recordBotReply: vi.fn(), recordUserMessage: vi.fn(), transitionToWait: vi.fn(), transitionToRunning: vi.fn() }));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction: vi.fn() }));
vi.mock('../../../src/meta/defer.js', () => ({ scheduleMetaDeferReeval: vi.fn() }));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({ dispatchWaitViaAgency: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotDisplayName: () => 'synthetic', getBotUid: () => 1 }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { resumeMetaWaitAttention } from '../../../src/meta/timing-adapter.js';
const anchor = (overrides: Partial<MetaWaitAnchor> = {}): MetaWaitAnchor => ({ chatId: 42, layer: 'L1', reason: 'wait', createdAt: 101000, textPreview: 'synthetic', ...overrides });
beforeEach(() => { vi.clearAllMocks(); f.archive.mockResolvedValue(1); f.ingest.mockResolvedValue({}); f.getdel.mockResolvedValue(null); });

describe('Meta wait replay activation', () => {
  it.each([{ createdAt: 99000 }, { createdAt: undefined }, { chatId: -100 }])('holds %o before ingest can assign a fresh timestamp', async (overrides) => {
    const original = anchor(overrides);
    f.getdel.mockResolvedValueOnce(JSON.stringify(original));
    expect(await resumeMetaWaitAttention(42)).toBe(true);
    expect(f.ingest).not.toHaveBeenCalled();
    expect(f.archive).toHaveBeenCalledOnce();
    expect(JSON.parse(f.archive.mock.calls[0]![2])).toMatchObject({ kind: 'wait', input: JSON.parse(JSON.stringify(original)) });
  });
  it('replays only a valid current anchor', async () => {
    f.getdel.mockResolvedValueOnce(JSON.stringify(anchor()));
    expect(await resumeMetaWaitAttention(42)).toBe(true);
    expect(f.ingest).toHaveBeenCalledWith(expect.objectContaining({ chatId: 42, reason: 'wait_resume:wait' }));
    expect(f.archive).not.toHaveBeenCalled();
  });
  it('holds during archive outage and retries archival without replay or legacy fallback', async () => {
    f.getdel.mockResolvedValueOnce(JSON.stringify(anchor({ createdAt: 99000 })));
    f.archive.mockRejectedValueOnce(new Error('redis temporarily down'));
    expect(await resumeMetaWaitAttention(42)).toBe(true);
    expect(f.ingest).not.toHaveBeenCalled();
    expect(await resumeMetaWaitAttention(42)).toBe(false);
    expect(f.archive).toHaveBeenCalledTimes(2);
    expect(f.ingest).not.toHaveBeenCalled();
  });
});
