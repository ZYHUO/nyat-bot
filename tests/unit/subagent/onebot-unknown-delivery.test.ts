import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { CodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';
import { DeliveryError } from '../../../src/shared/delivery-result.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { observePendingIntent } from '../../../src/meta/pending-intent.js';

const f = vi.hoisted(() => ({
  db: null as Database.Database | null,
  sends: vi.fn(), detailed: vi.fn(), llm: vi.fn(), isolated: vi.fn(), persist: vi.fn(async () => {}), debug: vi.fn(),
  callbacks: vi.fn(async () => {}), putTask: vi.fn(), checkpoint: vi.fn(), resume: vi.fn(),
  answered: vi.fn(async () => {}), contextWrite: vi.fn(), memoryAck: vi.fn(), finalEvidence: vi.fn(), createDebt: vi.fn(),
  held: new Map<string, string>(), holdWrite: vi.fn(), compareDelete: vi.fn(), end: vi.fn(),
  cfg: {
    CODEACT_BANNED_WORDS: [], AGENT_TASK_SEND_BUDGET: 4, AGENT_LOOP_ENABLED: true,
    AGENT_MAX_SEGMENTS: 4, CODEACT_USAGE: 'test', MEMORY_SENSITIVE_CHAT_IDS: [], ONEBOT_MEDIA_ENABLED: false,
    CONTEXT_MAX_LENGTH: 100, BOT_TOKEN: '12345:synthetic', META_PENDING_INTENT_ENABLED: false,
    BACKGROUND_PUBLICATION_ENABLED: false, PROACTIVE_HOURLY_MAX_PER_CHAT: 2, MASTER_UID:20,
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: f.debug } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
  lrange: vi.fn(async () => []), zadd: vi.fn(async () => 1),
  hget: vi.fn(async (_key: string, id: string) => f.held.get(id) ?? null),
  hsetnx: f.holdWrite, eval: f.compareDelete,
}) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { if (f.db) return f.db; throw new Error('unexpected DB access'); } }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: () => false,
  filterRecalledOneBotMessages: (_chatId: number, messages: unknown[]) => messages }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.llm }));
vi.mock('../../../src/agent/background-evidence.js', () => ({ readPublicationEvidence: () => ({kind:'memory_source',sourceId:'synthetic-source',version:1,hash:'synthetic-hash',chatId:20,platform:'telegram',accountId:'12345',threadId:0,changedAt:Date.now(),text:'一条真实边界内的合成新来源'}),validatePublicationEvidence:()=>true }));
vi.mock('../../../src/cron/activation-policy.js', () => ({checkProactiveActivation:async()=>({allowed:true})}));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({tryAcquireProactiveSlot:async()=>true,markProactiveSent:async()=>{}}));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: f.isolated }));
// This fixture isolates uncertain delivery after admission. Real task/source
// admission is covered by input-scope and codeact-activation-policy suites.
vi.mock('../../../src/subagent/activation-policy.js', () => ({ checkCodeActActivation: () => ({ allowed: true }),
  checkCodeActTaskActivation: () => ({ allowed: true }), holdCodeActTask: vi.fn() }));
vi.mock('../../../src/subagent/task-store.js', () => ({ persistCodeActTask: f.persist }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueResumeCodeActJob: f.resume }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask: f.putTask, enqueueCallbackAsync: f.callbacks }) }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: vi.fn(), searchDigests: vi.fn(() => []) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered, answeredTimestamps: vi.fn(async () => []) }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ clearSpeakerBurst: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ loadCheckpoint: vi.fn(async () => null), saveCheckpoint: f.checkpoint,
  registerAgentChat: vi.fn(async () => {}), unregisterAgentChat: vi.fn(async () => {}), clearCheckpoint: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/interrupts.js', () => ({ drainInterrupts: vi.fn(async () => []), isHardStop: () => false }));
vi.mock('../../../src/agent/compaction.js', async (original) => ({
  ...await original<typeof import('../../../src/agent/compaction.js')>(),
  compactHistory: vi.fn(), restoreMessagesFromCompacted: vi.fn(),
}));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn(() => 'synthetic-event') }));
vi.mock('../../../src/agent/task-evidence-store.js', () => ({ saveTaskEvidence: f.finalEvidence }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ createDebt: f.createDebt, resolveOpenDebtsByTaskWithEvidence: vi.fn() }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendCognitiveEvent: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn(), getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/subagent/room-awareness.js', () => ({ renderRoomAwareness: async () => ({ text: '', signals: [] }) }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: vi.fn(async () => []), searchMemoryByUser: vi.fn(async () => []),
  memorizeAcknowledgedDelivery: f.memoryAck }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
// Keep the real context writer: confirmed-part assertions inspect its Redis
// append payload, not a spy that could pass without storing the actual body.
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({ checkNearDuplicate: async () => ({ isNearDuplicate: false }) }));
vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({ REPLY_SPLIT_CHAR_THRESHOLD: 1000, segmentReply: (text: string) => ({ segments: [text] }), calculateTypingDelay: () => 0 }));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({ buildCodeActIdentityPrompt: () => 'synthetic identity' }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => '/sandbox' }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 2 ** 52 + 1, getBotDisplayName: () => 'Bot' }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.sends, sendMessageDetailed:f.detailed, sendChatAction: vi.fn(async () => {}), sendSticker: vi.fn(), reactToMessage: vi.fn() }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: () => ({ assemble: async () => ({ prompt: 'synthetic prompt', manifest: { cacheHitRatio: 0 } }) }),
  staticText: vi.fn(), ephemeralText: vi.fn(), volatileText: vi.fn(), deltaText: vi.fn(),
}));
vi.mock('../../../src/subagent/prompt-inputs.js', () => ({ collectPromptInputs: async () => ({
  journal: '', journalChannelLink: null, scratchBlock: '', chatStyleLine: '', identity: '', masterBlock: '',
  recentCtx: '', permanent: '', roster: '', targetBlock: '', memoryBlock: '', selfStateLine: '', systemPrompt: '',
  injectedExperienceIds: [], injectedSkillIds: [], injectedPolicyIds: [], groundingBlock: '', relationshipBlock: '',
  workspaceBlock: '', learnedBlock: '',
}) }));

import { createHostApi } from '../../../src/subagent/host-api.js';
import { runCodeActTask } from '../../../src/subagent/executor.js';
import { DELIVERY_HOLD_KEY, DELIVERY_UNKNOWN_SUMMARY, holdUnknownCodeActDelivery, withCodeActDeliveryIntent } from '../../../src/subagent/delivery-hold.js';
import { prepareBackgroundTask, beginBackgroundTask, cancelBackgroundTask } from '../../../src/agent/background-publication.js';

const chatId = 2 ** 52 + 100;
const anchor = 2 ** 52 + 101;
function uncertainError() { return Object.assign(new Error('synthetic timeout'), { code: 'request_timeout', delivery: 'unknown' }); }
function task(): DispatchTask {
  return { id: 'synthetic-qq-unknown', chatId, createdAt: Date.now(), status: 'queued', contentDirection: 'synthetic delivery', quoteMessageIds: [anchor] };
}
beforeEach(() => {
  f.db?.close(); f.db = null; f.cfg.META_PENDING_INTENT_ENABLED = false; f.cfg.BACKGROUND_PUBLICATION_ENABLED=false;
  vi.clearAllMocks();
  f.held.clear();
  f.holdWrite.mockReset().mockImplementation(async (_key: string, id: string, record: string) => {
    if (f.held.has(id)) return 0;
    f.held.set(id, record); return 1;
  });
  f.compareDelete.mockReset().mockImplementation(async (_script: string, _keys: number, _key: string, id: string, expected: string) => {
    if (_key.startsWith('xxb:ctx:')) { f.contextWrite(_key, JSON.parse(id)); return 1; }
    if (f.held.get(id) !== expected) return 0;
    f.held.delete(id); return 1;
  });
  f.sends.mockReset().mockRejectedValue(uncertainError());
  f.llm.mockReset().mockResolvedValue({ content: '```js\nawait telegram.sendFinal("synthetic reply");\n```' });
  f.isolated.mockReset().mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
    await capabilities.get('telegram.sendFinal')!('synthetic reply', anchor);
    return { value: undefined, logs: [] };
  });
});

describe('real background executor separates checking from publishing',()=>{
  beforeEach(()=>{
    f.db=new Database(':memory:');f.db.exec(readFileSync('migrations/0131_background_publications.sql','utf8'));
    f.cfg.BACKGROUND_PUBLICATION_ENABLED=true;
    f.detailed.mockReset().mockImplementation(async(chatId,text,_reply,_thread,identity)=>{
      identity.beforeSend();return {status:'sent',chatId,intentId:identity.intentId,revision:identity.revision,
        parts:[{messageId:98,text,partIndex:0}],plannedPartCount:1};
    });
  });
  function backgroundTask(){return prepareBackgroundTask({...task(),id:'background-synthetic',chatId:20,quoteMessageIds:[]},
    {kind:'self_play',key:'self_play',sinceAt:Date.now()-1000});}
  it('no_update never offers direct effects or creates a callback/notification',async()=>{
    const current=backgroundTask();
    f.isolated.mockImplementation(async(_code:string,capabilities:CodeActCapabilities)=>{
      for(const name of ['telegram.sendText','telegram.react','telegram.sendVoice','telegram.sendSticker','meta.request','goals.add','runtime.scheduleSelfWake'])expect(capabilities.has(name)).toBe(false);
      await capabilities.get('runtime.endTask')!('no_update');return {value:undefined,logs:[]};
    });
    await runCodeActTask(current);
    expect(current).toMatchObject({status:'done',publicationOutcome:{state:'suppressed',reason:'no_change'}});
    expect(f.sends).not.toHaveBeenCalled();expect(f.detailed).not.toHaveBeenCalled();expect(f.callbacks).not.toHaveBeenCalled();expect(f.createDebt).not.toHaveBeenCalled();
  });
  it('defends the actual host against direct media/react/meta and future scheduling bypasses',async()=>{
    const current=backgroundTask();const run=beginBackgroundTask(current);
    const host=createHostApi(20,{onEnd:f.end,taskId:current.id,backgroundRun:run});
    for(const call of [()=>host.telegram.sendText('x'),()=>host.telegram.react(42,'❤'),()=>host.telegram.sendVoice('x'),
      ()=>host.telegram.sendSticker('x'),()=>host.meta.request({action:'journal.write'}),()=>host.goals.add('later'),()=>host.runtime.waitForUser('clarify')]){
      await expect(Promise.resolve().then(call)).rejects.toThrow('background_direct_effect_forbidden');
    }
    expect(f.sends).not.toHaveBeenCalled();expect(f.detailed).not.toHaveBeenCalled();
  });
  it('only a proposed verified-version result crosses the host terminal publisher and real ACK bookkeeping',async()=>{
    const current=backgroundTask();
    f.isolated.mockImplementation(async(_code:string,capabilities:CodeActCapabilities)=>{
      const evidence=await capabilities.get('runtime.readPublicationEvidence')!({kind:'message',messageId:42}) as {handle:string};
      const proposed=await capabilities.get('runtime.proposePublication')!('合成新版本结果',[evidence.handle]);
      expect(proposed).toMatchObject({state:'proposed'});expect(proposed).not.toHaveProperty('messageId');expect(f.detailed).not.toHaveBeenCalled();
      await capabilities.get('runtime.endTask')!('finding');return {value:undefined,logs:[]};
    });
    await runCodeActTask(current);
    expect(current).toMatchObject({status:'done',sendsUsed:1,publicationOutcome:{state:'sent'}});
    expect(f.detailed).toHaveBeenCalledOnce();expect(f.sends).not.toHaveBeenCalled();expect(f.callbacks).not.toHaveBeenCalled();
    expect(f.contextWrite).toHaveBeenCalledWith('xxb:ctx:20',expect.objectContaining({messageId:98,textContent:'合成新版本结果'}));
    await runCodeActTask(current);expect(f.detailed).toHaveBeenCalledOnce();
  });
  it('a failed model call never turns into the ordinary foreground fallback message',async()=>{
    const current=backgroundTask();f.llm.mockRejectedValue(new Error('synthetic model outage'));
    await runCodeActTask(current);expect(f.llm).toHaveBeenCalledOnce();expect(f.sends).not.toHaveBeenCalled();expect(f.detailed).not.toHaveBeenCalled();
  });
  it('cancellation during model work stops before guest execution and does not create more work',async()=>{
    const current=backgroundTask();f.llm.mockImplementation(async()=>{
      cancelBackgroundTask(current.id);return {content:'```js\nruntime.endTask("finding");\n```'};
    });
    await runCodeActTask(current);
    expect(f.llm).toHaveBeenCalledOnce();expect(f.isolated).not.toHaveBeenCalled();
    expect(f.detailed).not.toHaveBeenCalled();expect(f.callbacks).not.toHaveBeenCalled();expect(f.createDebt).not.toHaveBeenCalled();
    expect(current).toMatchObject({status:'failed',resultSummary:'failed_background_cancelled'});
  });
});

function pendingSource(id: number, text: string, edit = false) {
  return observePendingIntent(20, { role: 'user', uid: 20, username: '', fullName: 'synthetic', timestamp: Date.now() / 1000,
    messageId: id, textContent: text, isForwarded: false, eventIdentity: createMessageEventIdentity({
      ref: { conversation: { platform: 'telegram', accountId: '12345', idNamespace: 'telegram', conversationKind: 'private', id: '20' }, id: String(id) },
      occurredAt: Date.now(), edit, editedAt: edit ? Date.now() : null, updateId: edit ? id + 100 : id, content: text }) });
}
describe('actual CodeAct host closes stale generated drafts', () => {
  beforeEach(() => {
    f.db = new Database(':memory:'); f.db.exec(readFileSync('migrations/0129_pending_reply_intents.sql', 'utf8'));
    f.cfg.META_PENDING_INTENT_ENABLED = true;
  });
  it('a correction during the model call blocks the generated send and never retries it as a fallback', async () => {
    const pendingIntent = pendingSource(42, '两份18元');
    const current = { ...task(), chatId: 20, targetUserId: 20, quoteMessageIds: [42], pendingIntent };
    f.llm.mockImplementation(async () => {
      pendingSource(43, '更正：两份28元');
      return { content: '```js\nawait telegram.sendFinal("旧结果");\n```' };
    });
    await runCodeActTask(current);
    expect(f.sends).not.toHaveBeenCalled(); expect(f.llm).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_input_superseded' });
    expect(f.createDebt).not.toHaveBeenCalled();
  });
  it.each(['runtime.endTask', 'runtime.waitForUser'])('a stale model result containing only %s cannot finish or suspend the newer request', async method => {
    const pendingIntent = pendingSource(42, '原始问题');
    const current = { ...task(), chatId: 20, targetUserId: 20, quoteMessageIds: [42], pendingIntent };
    f.llm.mockImplementation(async () => { pendingSource(43, '修正问题'); return { content: '```js\n' + method + '("synthetic");\n```' }; });
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      await capabilities.get(method)!('synthetic'); return { value: undefined, logs: [] };
    });
    await runCodeActTask(current);
    expect(f.isolated).not.toHaveBeenCalled(); expect(f.sends).not.toHaveBeenCalled();
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_input_superseded', waitingForUser: false });
    expect(f.callbacks).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
  });
  it('a correction during guest work invalidates its already requested endTask before terminal bookkeeping', async () => {
    const pendingIntent = pendingSource(42, '原始问题');
    const current = { ...task(), chatId: 20, targetUserId: 20, quoteMessageIds: [42], pendingIntent };
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      await capabilities.get('runtime.endTask')!('done'); pendingSource(43, '生成中纠正');
      return { value: undefined, logs: [] };
    });
    await runCodeActTask(current);
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_input_superseded' });
    expect(f.callbacks).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.sends).not.toHaveBeenCalled();
  });
  it('a correction while saving waiting state cannot leave the old task waiting or resumable', async () => {
    const pendingIntent = pendingSource(42, '原始问题');
    const current = { ...task(), chatId: 20, targetUserId: 20, quoteMessageIds: [42], pendingIntent };
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      await capabilities.get('runtime.waitForUser')!('澄清'); return { value: undefined, logs: [] };
    });
    f.checkpoint.mockImplementationOnce(async () => { pendingSource(43, '不用了'); return 'old-checkpoint'; });
    await runCodeActTask(current);
    expect(f.checkpoint).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_input_superseded', waitingForUser: false });
    expect(f.callbacks).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.createDebt).not.toHaveBeenCalled();
  });
  it('a correction during segment checkpointing preserves an actual ACK but prevents continuation', async () => {
    const pendingIntent = pendingSource(42, '原始长任务');
    const current = { ...task(), chatId: 20, targetUserId: 20, quoteMessageIds: [42], pendingIntent };
    f.sends.mockResolvedValue(44); let turns = 0;
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      if (turns++ === 0) await capabilities.get('telegram.sendText')!('已确认的中间结果');
      return { value: undefined, logs: [] };
    });
    f.checkpoint.mockImplementationOnce(async () => { pendingSource(43, '更正后续要求'); return 'stale-segment'; });
    await runCodeActTask(current);
    expect(f.checkpoint).toHaveBeenCalledOnce(); expect(f.sends).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_input_superseded', sendsUsed: 1 });
    expect(f.contextWrite).toHaveBeenCalledWith('xxb:ctx:20',expect.objectContaining({messageId:44,textContent:'已确认的中间结果'}));
    expect(f.callbacks).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.createDebt).not.toHaveBeenCalled();
  });
  it('rechecks after asynchronous sending preparation, not only at host entry', async () => {
    const pendingIntent = pendingSource(42, '两份18元');
    const wire = vi.fn();
    f.sends.mockImplementation(async (_chat, _text, _reply, _thread, options) => {
      pendingSource(43, '不用了');
      // The real sender classifies a beforeSend rejection before wire entry.
      try { options.beforeSend(); } catch {
        throw new DeliveryError({ status: 'failed', chatId: 20, intentId: 'cancel-before-wire', revision: 1,
          parts: [], plannedPartCount: 1, reason: 'pending_intent_changed' });
      }
      wire(); return 44;
    });
    const host = createHostApi(20, { taskId: 'cancel-before-wire', onEnd: f.end, targetUserId: 20, defaultReplyTo: 42, pendingIntent });
    await expect(host.telegram.sendText('尚未发出的旧结果')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.sends).toHaveBeenCalledOnce(); expect(wire).not.toHaveBeenCalled(); expect(f.answered).not.toHaveBeenCalled();
    expect(f.held.has('cancel-before-wire')).toBe(false);
  });
  it('refuses another actor or thread borrowing a valid input fence', async () => {
    const pendingIntent = pendingSource(42, '合成问题');
    const wrong = createHostApi(20, { onEnd: f.end, targetUserId: 21, pendingIntent });
    await expect(wrong.telegram.sendText('不可发送')).rejects.toThrow('pending_intent_mismatch');
    expect(f.sends).not.toHaveBeenCalled();
  });
});

describe('QQ unknown delivery closes the actual host and executor', () => {
  it('TG uses the same durable intent, stops the real executor and refuses replay', async () => {
    const current = { ...task(), chatId: -100, quoteMessageIds: [42] };
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      await capabilities.get('telegram.sendFinal')!('synthetic TG reply', 42);
      return { value: undefined, logs: [] };
    });
    f.sends.mockRejectedValue(new DeliveryError({ status: 'unknown', chatId: -100,
      intentId: current.id, revision: 0, plannedPartCount: 1, parts: [] }));
    await runCodeActTask(current);
    expect(current).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY });
    expect(f.held.has(current.id)).toBe(true);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.answered).not.toHaveBeenCalled();
    expect(f.contextWrite).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    await runCodeActTask({ ...current, status: 'queued' });
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
  });

  it('TG intent storage failure prevents the external call', async () => {
    f.holdWrite.mockRejectedValueOnce(new Error('Redis unavailable'));
    const send = vi.fn(async () => 1);
    await expect(withCodeActDeliveryIntent('tg-no-store', -100, send)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('TG confirmed delivery clears only its matching intent', async () => {
    await expect(withCodeActDeliveryIntent('tg-ack', -100, async () => 123)).resolves.toBe(123);
    expect(f.held.has('tg-ack')).toBe(false);
    expect(f.compareDelete).toHaveBeenCalledTimes(1);
  });

  it('TG partial ACK is recorded as actual text, without final completion or planned tail', async () => {
    const partial = { status: 'unknown' as const, chatId: -100, intentId: 'tg-partial', revision: 0,
      plannedPartCount: 2, parts: [{ messageId: 401, text: '已经确认的片段', partIndex: 0 }] };
    f.sends.mockRejectedValue(new DeliveryError(partial));
    const host = createHostApi(-100, { taskId: 'tg-partial', onEnd: f.end, defaultReplyTo: 42 });
    await expect(host.telegram.sendFinal('完整计划还有未确认后半段')).rejects.toBeInstanceOf(DeliveryError);
    expect(f.sends).toHaveBeenCalledOnce();
    expect(host.runtime.didSendText()).toBe(true);
    const contextErrors = f.debug.mock.calls.filter(call => call[1] === 'host addAssistant failed').map(call => String(call[0].err));
    expect(contextErrors, contextErrors.join('\n')).toEqual([]);
    expect(f.contextWrite).toHaveBeenCalledWith('xxb:ctx:-100',
      expect.objectContaining({ textContent: '已经确认的片段', messageId: 401, role: 'assistant' }));
    expect(f.contextWrite).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.memoryAck).toHaveBeenCalledWith(-100,
      { messageId: 401, text: '已经确认的片段', partIndex: 0 }));
    expect(f.memoryAck).toHaveBeenCalledTimes(1);
    expect(host.runtime.didProduceFinal()).toBe(false);
    expect(host.runtime.didSendText()).toBe(true);
    expect(f.answered).not.toHaveBeenCalled();
    expect(f.held.has('tg-partial')).toBe(true);
  });

  it('TG suppression clears its intent without writing delivery history', async () => {
    f.sends.mockRejectedValue(new DeliveryError({ status: 'suppressed', chatId: -100,
      intentId: 'tg-suppressed', revision: 0, plannedPartCount: 1, parts: [] }));
    const host = createHostApi(-100, { taskId: 'tg-suppressed', onEnd: f.end, defaultReplyTo: 42 });
    await expect(host.telegram.sendFinal('重复计划')).rejects.toMatchObject({ result: { status: 'suppressed' } });
    expect(f.contextWrite).not.toHaveBeenCalled(); expect(f.answered).not.toHaveBeenCalled();
    expect(host.runtime.didProduceFinal()).toBe(false);
    expect(f.held.has('tg-suppressed')).toBe(false);
  });

  it('serializes concurrent calls, refuses later sends/endTask, and records no final/answered receipt', async () => {
    let rejectSend!: (error: unknown) => void;
    f.sends.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const hold = vi.fn(async () => {});
    const host = createHostApi(chatId, { taskId: 'parallel', onEnd: f.end, onDeliveryUnknown: hold, defaultReplyTo: anchor });
    const first = host.telegram.sendFinal('first synthetic reply');
    const second = host.telegram.sendText('a different reply queued concurrently');
    const all = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(f.sends).toHaveBeenCalledTimes(1));
    rejectSend(uncertainError());
    const results = await all;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledExactlyOnceWith('request_timeout');
    await expect(host.telegram.sendText('try again')).rejects.toThrow('delivery_unknown_task_closed');
    expect(() => host.runtime.endTask('done')).toThrow('delivery_unknown_task_closed');
    expect(host.runtime.hasUnknownDelivery?.()).toBe(true);
    expect(host.runtime.didProduceFinal()).toBe(false);
    expect(host.runtime.didSendText()).toBe(false);
    expect(f.answered).not.toHaveBeenCalled();
    expect(f.contextWrite).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it('stops after the real host failure without another model turn, fallback, resume or automatic callback', async () => {
    const current = task();
    await runCodeActTask(current);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.isolated).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY, waitingForUser: false,
      assessment: { status: 'unverified', reasons: ['delivery_unknown'] } });
    expect(current.sendsUsed ?? 0).toBe(0);
    for (const action of [f.answered, f.contextWrite, f.resume, f.checkpoint, f.callbacks, f.createDebt]) expect(action).not.toHaveBeenCalled();
    expect(f.finalEvidence).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'failed', assessment: 'unverified', reasons: ['delivery_unknown'] }));
    expect(f.holdWrite).toHaveBeenCalledWith(DELIVERY_HOLD_KEY, current.id, expect.any(String));
    const metadata = JSON.parse(f.held.get(current.id)!);
    expect(metadata).toEqual({ taskId: current.id, chatId, at: expect.any(Number), code: 'delivery_in_flight', attempt: expect.any(String) });
    expect(JSON.stringify(metadata)).not.toContain('synthetic reply');
  });

  it('blocks an old BullMQ payload and a resumed segment using the durable hold', async () => {
    const stale = task();
    await holdUnknownCodeActDelivery(stale.id, stale.chatId, 'request_timeout');
    await runCodeActTask(stale);
    await runCodeActTask({ ...task(), segment: 2 });
    expect(f.sends).not.toHaveBeenCalled();
    expect(f.llm).not.toHaveBeenCalled();
    expect(f.isolated).not.toHaveBeenCalled();
    expect(f.putTask).not.toHaveBeenCalled();
    expect(f.callbacks).not.toHaveBeenCalled();
    expect(stale).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY });
  });

  it('overrides an early guest endTask when its unawaited send later becomes unknown', async () => {
    f.isolated.mockImplementation(async (_code: string, capabilities: CodeActCapabilities) => {
      const pending = Promise.resolve(capabilities.get('telegram.sendText')!('unawaited synthetic reply', anchor));
      void pending.catch(() => undefined);
      await capabilities.get('runtime.endTask')!('claimed done before receipt');
      return { value: undefined, logs: [] };
    });
    const current = task();
    await runCodeActTask(current);
    expect(current).toMatchObject({ status: 'failed', resultSummary: DELIVERY_UNKNOWN_SUMMARY });
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.callbacks).not.toHaveBeenCalled();
    expect(f.answered).not.toHaveBeenCalled();
  });

  it.each(['not_sent', 'rejected'])('does not classify %s as unknown', async (delivery) => {
    const error = Object.assign(new Error('synthetic failure'), { delivery });
    f.sends.mockRejectedValue(error);
    const onUnknown = vi.fn();
    const host = createHostApi(chatId, { taskId: 'classified-error', onEnd: f.end, onDeliveryUnknown: onUnknown });
    await expect(host.telegram.sendText('ordinary unavailable test')).rejects.toBe(error);
    expect(host.runtime.hasUnknownDelivery?.()).toBe(false);
    expect(onUnknown).not.toHaveBeenCalled();
    expect(f.held.size).toBe(0);
  });

  it('does not infer unknown delivery from model/error text or change native Telegram behavior', async () => {
    const ordinary = Object.assign(new Error('delivery unknown: please retry'), { delivery: 'not_sent' });
    f.sends.mockRejectedValue(ordinary);
    const qqHost = createHostApi(chatId, { taskId: 'text-not-classification', onEnd: f.end });
    await expect(qqHost.telegram.sendText('plain error test')).rejects.toBe(ordinary);
    expect(qqHost.runtime.hasUnknownDelivery?.()).toBe(false);
    f.sends.mockRejectedValue(uncertainError());
    const tgHost = createHostApi(1234, { onEnd: f.end });
    await expect(tgHost.telegram.sendText('Telegram original path')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(tgHost.runtime.hasUnknownDelivery?.()).toBe(false);
    expect(f.held.size).toBe(0);
  });

  it('refuses an external send if Redis cannot durably claim the intent', async () => {
    f.holdWrite.mockRejectedValue(new Error('synthetic Redis outage'));
    const host = createHostApi(chatId, { taskId: 'write-unavailable', onEnd: f.end });
    await expect(host.telegram.sendText('must not leave process')).rejects.toMatchObject({
      code: 'delivery_intent_store_unavailable', delivery: 'not_sent',
    });
    expect(f.sends).not.toHaveBeenCalled();
    expect(f.answered).not.toHaveBeenCalled();
  });

  it('writes a unique intent before sending and deletes only that exact intent after confirmation', async () => {
    const operation = vi.fn(async () => {
      const record = JSON.parse(f.held.get('confirmed')!);
      expect(record).toMatchObject({ taskId: 'confirmed', chatId, code: 'delivery_in_flight', attempt: expect.any(String) });
      return 123;
    });
    expect(await withCodeActDeliveryIntent('confirmed', chatId, operation)).toBe(123);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.compareDelete).toHaveBeenCalledWith(expect.stringContaining("redis.call('HDEL'"), 1,
      DELIVERY_HOLD_KEY, 'confirmed', expect.stringContaining('"attempt"'));
    expect(f.held.has('confirmed')).toBe(false);
  });

  it('retains another attempt if the stored intent changes before confirmation', async () => {
    const otherIntent = JSON.stringify({ attempt: 'another-worker' });
    await expect(withCodeActDeliveryIntent('changed', chatId, async () => {
      f.held.set('changed', otherIntent);
      return 123;
    })).rejects.toMatchObject({ code: 'delivery_intent_changed', delivery: 'unknown' });
    expect(f.held.get('changed')).toBe(otherIntent);
  });

  it('keeps the prewritten intent through a post-send Redis outage and blocks restart replay', async () => {
    f.sends.mockImplementation(async () => {
      expect(f.held.has('synthetic-qq-unknown')).toBe(true);
      f.holdWrite.mockRejectedValue(new Error('Redis disconnected after external send'));
      throw uncertainError();
    });
    await runCodeActTask(task());
    expect(f.held.has('synthetic-qq-unknown')).toBe(true);
    await runCodeActTask(task());
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.llm).toHaveBeenCalledTimes(1);
    expect(f.callbacks).not.toHaveBeenCalled();
  });

  it('uses hsetnx to prevent concurrent workers from sending the same task', async () => {
    let finish!: () => void;
    const first = withCodeActDeliveryIntent('same-task', chatId, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(f.held.has('same-task')).toBe(true));
    const duplicate = vi.fn(async () => 1);
    await expect(withCodeActDeliveryIntent('same-task', chatId, duplicate)).rejects.toMatchObject({ code: 'delivery_already_held' });
    expect(duplicate).not.toHaveBeenCalled();
    finish();
    await first;
  });

  it('routes a QQ failsafe through the same unquoted two-bubble host and counts each confirmed receipt', async () => {
    f.llm.mockRejectedValueOnce(new Error('synthetic model failure'))
      .mockResolvedValueOnce({ content: '这一部分还没处理完。\n需要再检查原因。' });
    f.sends.mockResolvedValue(anchor + 1);
    const current = task();
    await runCodeActTask(current);
    expect(f.sends.mock.calls.map(call => call[2])).toEqual([undefined, undefined]);
    expect(current.sendsUsed).toBe(2);
    expect(current.resultSummary).toBe('failsafe_plain_reply');
    expect(f.answered).toHaveBeenCalledWith(chatId, anchor);
  });

  it.each([2, 3])('does not bypass the three-bubble lifetime budget in a failsafe when %i were already used', async (sendsUsed) => {
    f.llm.mockRejectedValueOnce(new Error('synthetic model failure'))
      .mockResolvedValueOnce({ content: '第一部分尚未完成。\n第二部分也要再看。' });
    f.sends.mockResolvedValue(anchor + 1);
    const current = { ...task(), sendsUsed };
    await runCodeActTask(current);
    expect(f.sends).not.toHaveBeenCalled();
    expect(current.sendsUsed).toBe(sendsUsed);
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_silent' });
  });

  it('does not use a direct fallback send to evade the QQ text length policy', async () => {
    f.llm.mockRejectedValueOnce(new Error('synthetic model failure'))
      .mockResolvedValueOnce({ content: '字'.repeat(280) });
    f.sends.mockResolvedValue(anchor + 1);
    const current = task();
    await runCodeActTask(current);
    expect(f.sends).not.toHaveBeenCalled();
    expect(current).toMatchObject({ status: 'failed', resultSummary: 'failed_silent' });
  });
});
