import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaitRecoveryFence } from '../../../src/meta/types.js';
const f = vi.hoisted(() => ({ state: vi.fn(), hold: vi.fn(), release: vi.fn(), react: vi.fn(), sticker: vi.fn(), action: vi.fn(), forward: vi.fn(), rate: vi.fn(), account: '123' }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_BANNED_WORDS: [], META_PENDING_INTENT_ENABLED: false }) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: f.state }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: (chatId: number) => ({ chatId,
  accountId: f.account, platform: 'telegram', conversationKind: 'group' }) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: f.hold, eval: f.release, incr: f.rate, expire: vi.fn(async () => 1) }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected_database_access'); } }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ reactToMessage: f.react, sendChatAction: f.action, sendMessage: vi.fn(), sendSticker: f.sticker, forwardMessage: f.forward }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import { selectWaitRecovery, isTaskWaitRecoveryCurrent } from '../../../src/meta/wait-recovery-fence.js';
import { withCodeActDeliveryIntent } from '../../../src/subagent/delivery-hold.js';
import { createHostApi } from '../../../src/subagent/host-api.js';
const fence: WaitRecoveryFence = { chatId: -100, threadId: 7, platform: 'telegram', accountId: '123', generation: 'claimed' };
const task = { chatId: -100, messageThreadId: 7, waitRecovery: fence };
beforeEach(() => {
  vi.clearAllMocks(); f.account = '123'; f.state.mockReset().mockResolvedValue({ state: 'RUNNING', waitGeneration: 'claimed' });
  f.hold.mockReset().mockResolvedValue(1); f.release.mockResolvedValue(1); f.react.mockResolvedValue(true);
  f.action.mockReset().mockResolvedValue(undefined); f.sticker.mockResolvedValue(42);
  f.rate.mockReset().mockResolvedValue(1); f.forward.mockResolvedValue(43);
});

describe('host WAIT recovery authority with pending-intent disabled', () => {
  it('binds the actual selected quote/chat/topic and cannot infer a token for another source', () => {
    const sources = [{ chatId: -100, messageId: 10, messageThreadId: 7, waitRecovery: fence },
      { chatId: -100, messageId: 11, messageThreadId: 7 }];
    expect(selectWaitRecovery(sources, -100, 7, [10])).toEqual(fence);
    expect(selectWaitRecovery(sources, -100, 7, [11])).toBeUndefined();
    expect(() => selectWaitRecovery(sources, -100, 8, [10])).toThrow('wait_recovery_source_missing');
    expect(() => selectWaitRecovery(sources, -100, 7, [99])).toThrow('wait_recovery_source_missing');
    expect(selectWaitRecovery(sources, -200, 7, [10])).toBeUndefined();
    expect(() => selectWaitRecovery([...sources, { ...sources[0]!, messageId: 12, waitRecovery: { ...fence, generation: 'another' } }], -100, 7, [10, 12]))
      .toThrow('wait_recovery_source_mismatch');
  });
  it.each([{ state: 'STOP', waitGeneration: 'claimed' }, { state: 'WAIT', waitGeneration: 'claimed' },
    { state: 'RUNNING', waitGeneration: 'new' }, { state: 'RUNNING' }])('rejects a stale runtime state %j', async current => {
    f.state.mockResolvedValue(current); expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
  });
  it('fails closed on account/topic mismatch or unavailable Redis while ordinary tasks remain compatible', async () => {
    expect(await isTaskWaitRecoveryCurrent({ ...task, messageThreadId: 8 })).toBe(false);
    f.account = '456'; expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
    f.account = '123'; f.state.mockRejectedValue(new Error('offline'));
    expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
    expect(await isTaskWaitRecoveryCurrent({ chatId: -100 })).toBe(true);
  });
  it('rechecks after durable-send claim and releases a not-sent hold on cancellation', async () => {
    f.hold.mockImplementation(async () => { f.state.mockResolvedValue({ state: 'STOP' }); return 1; });
    const send = vi.fn(async () => 123);
    await expect(withCodeActDeliveryIntent('task', -100, send, task)).rejects.toMatchObject({ code: 'wait_recovery_stale', delivery: 'not_sent' });
    expect(send).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it('checks every logical send, permits the current one and cannot revoke an already completed HTTP request', async () => {
    const send = vi.fn(async () => { f.state.mockResolvedValue({ state: 'STOP' }); return 123; });
    await expect(withCodeActDeliveryIntent('task', -100, send, task)).resolves.toBe(123);
    await expect(withCodeActDeliveryIntent('task', -100, send, task)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(send).toHaveBeenCalledOnce();
  });
  it('wires the fence into the actual HostApi reaction path and closes the task without a replay callback', async () => {
    const onEnd = vi.fn();
    const host = createHostApi(-100, { onEnd, taskId: 'reaction', quoteIds: [10], messageThreadId: 7, waitRecovery: fence });
    await expect(host.telegram.react(10, '👍')).resolves.toBe(true);
    f.state.mockResolvedValue({ state: 'RUNNING', waitGeneration: 'replacement' });
    await expect(host.telegram.react(10, '👍')).rejects.toThrow('wait_recovery_stale');
    expect(onEnd).toHaveBeenCalledWith('failed_input_superseded'); expect(f.react).toHaveBeenCalledOnce();
    expect(() => host.runtime.waitForUser('later')).toThrow('wait_recovery_cannot_suspend');
  });
  it('does not turn an expired recovery into a new autonomous goal or Meta request', async () => {
    const host = createHostApi(-100, { onEnd: vi.fn(), taskId: 'expired', quoteIds: [10], messageThreadId: 7, waitRecovery: fence });
    f.state.mockResolvedValue({ state: 'STOP' });
    await expect(host.goals.add('old decision')).rejects.toThrow('wait_recovery_stale');
    await expect(host.meta.request({ action: 'journal.write' })).rejects.toThrow('wait_recovery_stale');
  });
  it('rechecks a WAIT token after attachment preparation before a Telegram sticker send', async () => {
    const onEnd = vi.fn();
    const host = createHostApi(-100, { onEnd, taskId: 'sticker', messageThreadId: 7, waitRecovery: fence });
    f.action.mockImplementation(async () => { f.state.mockResolvedValue({ state: 'STOP' }); });
    await host.telegram.sendSticker('synthetic-sticker-handle');
    expect(f.sticker).not.toHaveBeenCalled(); expect(onEnd).toHaveBeenCalledWith('failed_input_superseded');
  });
  it.each(['before', 'during-rate-check'])('blocks forwarding after WAIT cancellation %s', async when => {
    const onEnd=vi.fn();
    const host=createHostApi(-100,{onEnd,taskId:'forward',messageThreadId:7,waitRecovery:fence});
    if(when==='before') f.state.mockResolvedValue({state:'STOP'});
    else f.rate.mockImplementation(async()=>{f.state.mockResolvedValue({state:'STOP'});return 1;});
    await expect(host.telegram.forward(-200,10)).rejects.toThrow('wait_recovery_stale');
    expect(f.forward).not.toHaveBeenCalled(); expect(onEnd).toHaveBeenCalledWith('failed_input_superseded');
  });
});
