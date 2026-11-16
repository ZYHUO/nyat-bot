import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ send: vi.fn(), onSend: vi.fn(), answered: vi.fn(), context: vi.fn(),
  held: new Map<string, string>(), chat: 2 ** 52 + 700, recall: vi.fn(),
  assertAssignment: vi.fn(), reserveAssignment: vi.fn(), assertReservation: vi.fn(), ackAssignment: vi.fn(), failAssignment: vi.fn(),
  cooling: vi.fn(), localCooling: vi.fn(), preview: vi.fn(), status: vi.fn(), postTask: vi.fn(), sleep: vi.fn(), mute: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_BANNED_WORDS: [], ONEBOT_MEDIA_ENABLED: false }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.send, sendSticker: vi.fn(), reactToMessage: vi.fn(), sendChatAction: vi.fn(async () => {}) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 2 ** 52 + 1, getBotDisplayName: () => 'Bot' }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected DB access'); } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: async () => null, set: async () => 'OK',
  hsetnx: async (_key: string, id: string, value: string) => { if (f.held.has(id)) return 0; f.held.set(id, value); return 1; },
  eval: async (_script: string, _count: number, _key: string, id: string, expected: string) => {
    if (f.held.get(id) !== expected) return 0; f.held.delete(id); return 1;
  },
}) }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recall }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered, answeredTimestamps: async () => [] }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ clearSpeakerBurst: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/session-digest.js', () => ({ searchDigests: () => [] }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => [], addAssistant: f.context }));
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({ checkNearDuplicate: async () => ({ isNearDuplicate: false }) }));
vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({ REPLY_SPLIT_CHAR_THRESHOLD: 1000,
  segmentReply: (text: string) => ({ segments: [text] }), calculateTypingDelay: () => 0 }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: async () => [], searchMemoryByUser: async () => [], memorizeMessage: async () => {} }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn(), getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendCognitiveEvent: vi.fn() }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ resolveOpenDebtsByTaskWithEvidence: vi.fn() }));
vi.mock('../../../src/agent/task-evidence-store.js', () => ({ saveTaskEvidence: vi.fn() }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/nyatos/envelope.js', () => ({ checkEnvelope: async () => ({ ok: true, mode: 'off' }), spendEnvelope: vi.fn() }));
vi.mock('../../../src/nyatos/trench.js', () => ({ releasePressure: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: f.postTask }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => '/synthetic-sandbox' }));

vi.mock('../../../src/platform/onebot-assignment-store.js', () => ({
  assertOneBotAssignmentTask: f.assertAssignment, reserveOneBotAssignmentSend: f.reserveAssignment,
  assertOneBotAssignmentReservation: f.assertReservation, acknowledgeOneBotAssignmentSend: f.ackAssignment, failOneBotAssignmentSend: f.failAssignment,
}));
vi.mock('../../../src/pipeline/correction-cooldown.js', () => ({ isCorrectionCooling: f.cooling, isLocallyCorrectionCooling: f.localCooling }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleepStrict: f.sleep }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ getMuteState: f.mute }));
vi.mock('../../../src/platform/onebot-assignments.js', () => ({ previewOneBotAssignment: f.preview, getOneBotAssignmentStatus: f.status }));

import { createHostApi } from '../../../src/subagent/host-api.js';
const anchor = 2 ** 52 + 50;
function setup(maxTextSends = 3, chatId = f.chat) {
  return createHostApi(chatId, { taskId: `synthetic-text-${chatId}`, defaultReplyTo: Math.abs(chatId) < 2 ** 52 ? 12345 : anchor,
    maxTextSends, onSend: f.onSend, onEnd: vi.fn() });
}
beforeEach(() => {
  vi.clearAllMocks(); f.held.clear(); f.chat++;
  f.recall.mockReturnValue(false); f.answered.mockResolvedValue(undefined); f.context.mockResolvedValue(undefined);
  f.send.mockReset().mockResolvedValue(2 ** 52 + 80);
  f.assertAssignment.mockReset().mockReturnValue(null);
  f.reserveAssignment.mockReset().mockReturnValue({ id: 'reservation' });
  f.assertReservation.mockReset().mockReturnValue({ controllerChatId: 2 ** 52 + 999 });
  f.sleep.mockReset().mockResolvedValue(false); f.mute.mockReset().mockReturnValue({ level: 0, temporary: false }); f.ackAssignment.mockReset(); f.failAssignment.mockReset();
  f.cooling.mockReset().mockResolvedValue(false); f.localCooling.mockReset().mockReturnValue(false);
});

describe('QQ host text bubbles, optional quote and confirmed budget', () => {
  it('omits visible quotes while retaining answered bookkeeping and two real bubble receipts', async () => {
    const api = setup();
    await api.telegram.sendText('先保留原来的思路。\n接下来只补测试。');
    expect(f.send.mock.calls.map(call => call.slice(0, 3))).toEqual([
      [f.chat, '先保留原来的思路。', undefined], [f.chat, '接下来只补测试。', undefined],
    ]);
    expect(f.onSend).toHaveBeenCalledTimes(2);
    expect(f.answered).toHaveBeenCalledWith(f.chat, anchor);
    expect(api.runtime.didSendText()).toBe(true);
    expect(f.postTask).toHaveBeenCalledOnce();
  });
  it('uses an explicit permitted quote on the first bubble only; rejects foreign quotes before send', async () => {
    const api = setup();
    await expect(api.telegram.sendText('这个引用不属于当前任务', anchor + 1)).rejects.toThrow('引用只能选择本任务');
    expect(f.send).not.toHaveBeenCalled();
    await api.telegram.sendText('这边已经确认了。\n下一步可以继续。', anchor);
    expect(f.send.mock.calls.map(call => call[2])).toEqual([anchor, undefined]);
  });
  it('preserves Telegram fallback quotation and its existing per-call budget', async () => {
    const api = setup(2, -1001234567890);
    await api.telegram.sendText('Telegram继续使用原来的触发消息引用');
    expect(f.send).toHaveBeenCalledWith(-1001234567890, expect.any(String), 12345, undefined,
      expect.objectContaining({ markAnswered: false, onReceipt: expect.any(Function) }));
    expect(f.onSend).toHaveBeenCalledOnce();
  });
  it('rejects oversized content and insufficient whole-reply budget before the first bubble', async () => {
    const api = setup(1);
    await expect(api.telegram.sendText('字'.repeat(241))).rejects.toThrow('压缩完整回答');
    await expect(api.telegram.sendText('第一部分已经确认。\n第二部分还要检查。')).rejects.toThrow('sendText_limit:1');
    expect(f.send).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
  });
  it('does not let parallel calls overbook a two-bubble task', async () => {
    const api = setup(2);
    let finish!: (id: number) => void;
    f.send.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = api.telegram.sendText('先说明当前状况。\n然后补充下一步。');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await expect(api.telegram.sendText('另一个并发调用不能抢占剩余额度')).rejects.toThrow('sendText_limit:2');
    finish(2 ** 52 + 81); await first;
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.onSend).toHaveBeenCalledTimes(2);
  });
  it('keeps the first acknowledged bubble charged when a later receipt is unknown and never retries', async () => {
    const api = setup(3);
    f.send.mockResolvedValueOnce(2 ** 52 + 82).mockRejectedValueOnce(Object.assign(new Error('timeout'), { delivery: 'unknown', code: 'request_timeout' }));
    await expect(api.telegram.sendFinal('第一部分可以交付。\n下一部分还没确认。')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.onSend).toHaveBeenCalledOnce(); expect(api.runtime.didSendText()).toBe(true);
    expect(api.runtime.didProduceFinal()).toBe(false); expect(api.runtime.hasUnknownDelivery?.()).toBe(true);
    await expect(api.telegram.sendText('不能再补发')).rejects.toThrow('delivery_unknown_task_closed');
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('releases an unsent reservation after a known transport rejection', async () => {
    const api = setup(2);
    f.send.mockRejectedValueOnce(Object.assign(new Error('not ready'), { delivery: 'not_sent' }));
    await expect(api.telegram.sendText('这一次尚未发送')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.onSend).not.toHaveBeenCalled();
    await api.telegram.sendText('恢复后先检查。\n然后确认结果。');
    expect(f.onSend).toHaveBeenCalledTimes(2);
  });
});


describe('QQ assignment delivery fences', () => {
  function assignment(maxTextSends = 3) {
    return createHostApi(f.chat, { taskId: 'assigned-task', qqAssignmentId: 'assignment',
      maxTextSends, onSend: f.onSend, onEnd: vi.fn() });
  }
  it('reserves the entire plan, rechecks each transport and records real bubble receipts', async () => {
    const api = assignment();
    f.send.mockImplementation(async (_chat, _text, _reply, _thread, options) => {
      expect(f.reserveAssignment).toHaveBeenCalledWith('assigned-task', f.chat, 2);
      options.beforeSend();
      return 2 ** 52 + 80 + f.send.mock.calls.length;
    });
    await api.telegram.sendFinal('这部分已经核实。\n下一步继续检查。');
    expect(f.reserveAssignment).toHaveBeenCalledOnce();
    expect(f.assertReservation).toHaveBeenCalledTimes(4);
    expect(f.ackAssignment.mock.calls).toEqual([['reservation', 0, 2 ** 52 + 81], ['reservation', 1, 2 ** 52 + 82]]);
    expect(api.runtime.didProduceFinal()).toBe(true);
    expect(f.postTask).not.toHaveBeenCalled();
    expect(f.failAssignment).not.toHaveBeenCalled();
  });
  it('does not open a follow-up window after an assignment exhausts its single-bubble budget', async () => {
    const api = assignment(1);
    await api.telegram.sendFinal('只发这一句。');
    expect(f.ackAssignment).toHaveBeenCalledOnce();
    expect(f.postTask).not.toHaveBeenCalled();
  });
  it.each(['expired', 'stopped', 'target_mismatch', 'feature_disabled', 'task_binding_mismatch'])('blocks %s grants before any transport', async code => {
    f.assertAssignment.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    await expect(assignment().telegram.sendText('不会投递')).rejects.toThrow(code);
    expect(f.send).not.toHaveBeenCalled(); expect(f.reserveAssignment).not.toHaveBeenCalled();
  });
  it('checks durable binding even when the caller removes the assignment field', async () => {
    f.assertAssignment.mockImplementation(({ qqAssignmentId }) => {
      if (!qqAssignmentId) throw new Error('task_binding_mismatch');
    });
    await expect(setup().telegram.sendText('不能去掉授权字段绕过')).rejects.toThrow('task_binding_mismatch');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not send a second bubble after revocation races the first acknowledgment', async () => {
    const api = assignment();
    f.ackAssignment.mockImplementationOnce(() => {
      f.assertReservation.mockImplementation(() => { throw new Error('stopped'); });
    });
    await expect(api.telegram.sendFinal('第一段可以发出。\n这段会被停止。')).rejects.toThrow('delivery_fence_changed');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.ackAssignment).toHaveBeenCalledOnce();
    expect(f.failAssignment).toHaveBeenCalledWith('reservation', false);
    expect(api.runtime.didProduceFinal()).toBe(false);
  });
  it('retains unknown reservation and closes the task without another transport call', async () => {
    const api = assignment();
    f.send.mockRejectedValueOnce(Object.assign(new Error('timeout'), { delivery: 'unknown' }));
    await expect(api.telegram.sendText('结果无法确认')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.failAssignment).toHaveBeenCalledWith('reservation', true);
    expect(api.runtime.hasUnknownDelivery?.()).toBe(true);
    await expect(api.telegram.sendText('不可以自动重发')).rejects.toThrow('delivery_unknown_task_closed');
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ackAssignment).not.toHaveBeenCalled();
  });
  it('does not retry a previously persisted send plan', async () => {
    f.reserveAssignment.mockImplementation(() => { throw new Error('send_already_reserved'); });
    await expect(assignment().telegram.sendText('已尝试过的任务')).rejects.toThrow('send_already_reserved');
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.NaN, 1.5])('holds an invalid numeric transport receipt %s', async messageId => {
    const api = assignment(); f.send.mockResolvedValueOnce(messageId);
    await expect(api.telegram.sendText('必须有有效回执')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.ackAssignment).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
    expect(api.runtime.hasUnknownDelivery?.()).toBe(true);
  });
  it('holds an acknowledgment-store failure after transport without retry', async () => {
    const api = assignment(); f.ackAssignment.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    await expect(api.telegram.sendText('落盘状态不确定')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.failAssignment).toHaveBeenCalledWith('reservation', true);
    await expect(api.telegram.sendText('不可重新发送')).rejects.toThrow('delivery_unknown_task_closed');
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('denies assignment media, reactions, future work and foreign-context reads', async () => {
    const api = assignment();
    await expect(api.telegram.react(anchor, '❤')).rejects.toThrow('qq_assignment_capability_forbidden');
    await expect(api.telegram.sendVoice('绕过文字预算')).rejects.toThrow('qq_assignment_capability_forbidden');
    expect(() => api.runtime.scheduleSelfWake('长期接管', 60)).toThrow('qq_assignment_capability_forbidden');
    await expect(api.goals.add('未来发言')).rejects.toThrow('qq_assignment_capability_forbidden');
    await expect(api.chats.recentMessages(f.chat + 10)).rejects.toThrow('qq_assignment_context_mismatch');
    await expect(api.meta.request({ action: 'journal.write' })).rejects.toThrow('qq_assignment_capability_forbidden');
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['sleeping', 'sleep_unavailable', 'muted', 'mute_unavailable'])('fails closed for %s preferences before assignment delivery', async reason => {
    if (reason === 'sleeping') f.sleep.mockResolvedValue(true);
    if (reason === 'sleep_unavailable') f.sleep.mockRejectedValue(new Error('unavailable'));
    if (reason === 'muted') f.mute.mockReturnValue({ level: 1, temporary: false });
    if (reason === 'mute_unavailable') f.mute.mockImplementation(() => { throw new Error('unavailable'); });
    await expect(assignment().telegram.sendText('尊重目标群的静默偏好')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.send).not.toHaveBeenCalled(); expect(f.ackAssignment).not.toHaveBeenCalled();
    expect(f.failAssignment).toHaveBeenCalledWith('reservation', false);
  });
  it('rechecks the target mute preference in the last synchronous sender callback', async () => {
    const api = assignment();
    const wire = vi.fn();
    f.send.mockImplementation(async (_chat, _text, _reply, _thread, options) => {
      f.mute.mockReturnValue({ level: 2, temporary: false });
      try { options.beforeSend(); } catch (cause) { throw Object.assign(new Error('cancelled', { cause }), { delivery: 'not_sent' }); }
      wire(); return 2 ** 52 + 80;
    });
    await expect(api.telegram.sendText('发送准备期间已经静默')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(wire).not.toHaveBeenCalled(); expect(f.ackAssignment).not.toHaveBeenCalled();
  });
  it.each([true, false])('respects correction cooldown for assignment=%s including ordinary in-flight tasks', async assigned => {
    f.cooling.mockResolvedValue(true);
    await expect((assigned ? assignment() : setup()).telegram.sendText('停止后不能再插话')).rejects.toThrow('delivery_fence_changed');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('uses read-only preview/status services and never suggests the unavailable cross-chat sender', async () => {
    const api = setup(); f.preview.mockResolvedValue({ status: 'ready', command: '/qqassign once 123 public text' });
    f.status.mockResolvedValue({ status: 'not_found' });
    await expect(api.chats.previewAssignment({ target: '123', mode: 'once', text: 'hello' })).resolves.toMatchObject({ status: 'ready' });
    expect(f.preview).toHaveBeenCalledWith(f.chat, { target: '123', mode: 'once', text: 'hello' });
    await expect(api.chats.assignmentStatus('assignment')).resolves.toMatchObject({ status: 'not_found' });
    expect(f.status).toHaveBeenCalledWith(f.chat, 'assignment');
    await expect(api.meta.request({ action: 'send_to_chat' })).rejects.toThrow('chats.previewAssignment');
    await expect(api.meta.request({ action: 'send_to_chat' })).rejects.not.toThrow('telegram.sendToChat');
    expect(f.send).not.toHaveBeenCalled(); expect(f.reserveAssignment).not.toHaveBeenCalled();
  });
});
