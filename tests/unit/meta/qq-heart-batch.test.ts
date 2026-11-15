import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QqHeartCandidate } from '../../../src/meta/qq-heart-batch.js';
const f = vi.hoisted(() => ({ recalled: vi.fn(), answered: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_QQ_GROUP_COALESCE_MS: 1500, META_QQ_GROUP_COALESCE_MAX_MS: 4000 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recalled }));
vi.mock('../../../src/meta/answered.js', () => ({ isMessageAnswered: f.answered }));
import { _resetQqHeartBatches, closeQqHeartBatches, enqueueQqHeartBatch } from '../../../src/meta/qq-heart-batch.js';
const item = (id: number, chatId = -1): QqHeartCandidate => ({ chatId, layer: 'L2', addressed: false,
  formatted: { role: 'user', uid: 10, fullName: 'fixture', username: '', timestamp: 1, messageId: id, textContent: `fixture ${id}`, isForwarded: false } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); vi.clearAllMocks(); f.recalled.mockReturnValue(false); f.answered.mockResolvedValue(false); _resetQqHeartBatches(); });
afterEach(() => { closeQqHeartBatches(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('QQ pre-Heart batching bounds', () => {
  it('uses a per-chat quiet deadline and a hard maximum before judgment', async () => {
    const process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    enqueueQqHeartBatch(item(1), process);
    for (let id = 2; id <= 4; id++) { await vi.advanceTimersByTimeAsync(1000); enqueueQqHeartBatch(item(id), process); }
    enqueueQqHeartBatch(item(50, -2), process);
    await vi.advanceTimersByTimeAsync(999); expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]![0].map((entry: QqHeartCandidate) => entry.formatted.messageId)).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(500); expect(process).toHaveBeenCalledTimes(2);
    expect(process.mock.calls[1]![0][0]!.chatId).toBe(-2);
  });

  it('deduplicates pending IDs and bounds both chat count and per-chat candidates', async () => {
    const process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    for (let id = 1; id <= 32; id++) expect(enqueueQqHeartBatch(item(id), process)).toBe(true);
    expect(enqueueQqHeartBatch(item(1), process)).toBe(true);
    expect(enqueueQqHeartBatch(item(33), process)).toBe(false);
    for (let chatId = -2; chatId >= -64; chatId--) expect(enqueueQqHeartBatch(item(1, chatId), process)).toBe(true);
    expect(enqueueQqHeartBatch(item(1, -65), process)).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.mock.calls[0]![0]).toHaveLength(32);
  });

  it('limits global in-flight decisions and serializes later input within a chat', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => { await blocked; });
    for (let chatId = -1; chatId >= -5; chatId--) enqueueQqHeartBatch(item(1, chatId), process);
    await vi.advanceTimersByTimeAsync(1500); expect(process).toHaveBeenCalledTimes(4);
    enqueueQqHeartBatch(item(2), process);
    await vi.advanceTimersByTimeAsync(1500); expect(process).toHaveBeenCalledTimes(4);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(process).toHaveBeenCalledTimes(6);
    expect(process.mock.calls.filter(call => call[0][0]!.chatId === -1)).toHaveLength(2);
  });

  it('filters recalled and answered messages; recall storage failure cannot release a batch', async () => {
    const process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    f.recalled.mockImplementation((_chat: number, id: number) => id === 1);
    f.answered.mockImplementation(async (_chat: number, id: number) => id === 2);
    [1, 2, 3].forEach(id => enqueueQqHeartBatch(item(id), process));
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.mock.calls[0]![0].map((entry: QqHeartCandidate) => entry.formatted.messageId)).toEqual([3]);
    f.recalled.mockImplementation(() => { throw new Error('fixture'); });
    enqueueQqHeartBatch(item(4), process); await vi.advanceTimersByTimeAsync(1500);
    expect(process).toHaveBeenCalledOnce();
  });
});
