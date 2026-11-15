import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
/**
 * L0 must autoDispatch before Meta LLM — regression for Meta scripting
 * 「简单说没事或本喵在看着」 on 「千雪怎么了」.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ db: null as unknown as Database.Database, redis: null as unknown as MetaRedisFixture, active: null as import('../../../src/meta/types.js').DispatchTask | null, resume: vi.fn(), interrupt: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => runtime.db }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ getAgentTaskIdForChat: async () => runtime.active?.id,
  clearCheckpoint: vi.fn(async () => {}), unregisterAgentChat: vi.fn(async () => {}) }));
vi.mock('../../../src/agent/interrupts.js', async original => ({ ...await original<typeof import('../../../src/agent/interrupts.js')>(), pushInterrupt: runtime.interrupt }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: () => false }));
const callWithFallback = vi.fn();
const enqueueCodeActJob = vi.fn(async () => undefined);
const isCodeActBusy = vi.fn(async () => false);
const tryClaimQuote = vi.fn(async () => true);
const tryMarkCodeActActive = vi.fn(async () => true);
const allQuotesAnswered = vi.fn(async () => false);
const isMetaSubagentChat = vi.fn(() => true);
const suppressHeartDispatch = vi.fn(async (chatId: number) => { void chatId; return false; });
const markMessageAnswered = vi.fn(async (chatId: number, messageId: number) => { void chatId; void messageId; });
// Deliberately synthetic identity constants test scheduling, not SQLite routing.
// Real mapping rejection and acceptance are exercised by input-scope.test.
vi.mock('../../../src/meta/input-scope.js', () => ({ inspectMetaAttention: (value: unknown) => ({ status: 'valid', value }),
  inspectMetaChatScope: (value: number) => ({ status: 'valid', value }), holdMetaScopeInput: async () => true,
  inspectMetaTaskScope: (value: unknown) => ({ status: 'valid', value }) }));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallback(...args),
}));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueCodeActJob(...args),
  enqueueResumeCodeActJob: runtime.resume,
}));
vi.mock('../../../src/subagent/task-store.js', () => ({
  isCodeActBusy: (...args: unknown[]) => isCodeActBusy(...args),
  loadCodeActTask: async () => runtime.active,
  tryClaimQuote: (...args: unknown[]) => tryClaimQuote(...args),
  tryMarkCodeActActive: (...args: unknown[]) => tryMarkCodeActActive(...args),
  clearCodeActActive: vi.fn(async () => undefined),
  persistCodeActTask: vi.fn(async () => undefined),
}));
vi.mock('../../../src/meta/answered.js', () => ({
  allQuotesAnswered: (...args: unknown[]) => allQuotesAnswered(...args),
  isMessageAnswered: vi.fn(async () => false),
  markMessageAnswered: (chatId: number, messageId: number) => markMessageAnswered(chatId, messageId),
}));
vi.mock('../../../src/meta/flags.js', () => ({
  isMetaSubagentChat: (...args: unknown[]) => isMetaSubagentChat(...args),
}));
vi.mock('../../../src/meta/heart-refractory.js', () => ({
  shouldSuppressMetaHeartDispatch: (chatId: number) => suppressHeartDispatch(chatId),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: (chatId?: number) => chatId === -(2 ** 52 + 10) ? 2 ** 52 + 11 : 999001,
}));
vi.mock('../../../src/platform/owner-context.js', () => ({
  isConversationOwner: (chatId: number, uid: number) => chatId === -(2 ** 52 + 10)
    ? uid === 2 ** 52 + 12 : uid === 6251541967,
}));
vi.mock('../../../src/shared/master-identity.js', () => ({
  buildMasterIdentityBlock: () => 'synthetic owner identity', masterShortHint: () => 'synthetic owner',
}));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: () => ({ assemble: async () => ({ prompt: 'synthetic scoped context', manifest: { cacheHitRatio: 0 } }) }),
  staticText: vi.fn(), ephemeralText: vi.fn(), volatileText: vi.fn(), deltaText: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    MASTER_UID: 6251541967, BOT_TOKEN: "12345:synthetic", META_PENDING_INTENT_ENABLED: true,
    META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000, META_L0_COALESCE_MS: 0, META_ATTENTION_TOP_N: 30,
    META_USAGE: 'judge',
    CODEACT_TIMEOUT_MS: 5000,
    CODEACT_BANNED_WORDS: [],
    META_SUBAGENT_ENABLED: true,
    CODEACT_ISOLATION_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [],
    META_ACTIVATED_AT_SEC: 1,
  }),
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => runtime.redis }));

import { _resetGlobalState } from '../../../src/meta/global-state.js';
import { runMetaSession } from '../../../src/meta/session.js';
import type { AttentionItem } from '../../../src/meta/types.js';


import { observePendingIntent, settlePendingIntent } from '../../../src/meta/pending-intent.js';
import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
function input(id: number, uid = 20, thread = 0, edit = false, text?: string): AttentionItem {
 const identity = createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', accountId: '12345', idNamespace: 'telegram', conversationKind: 'group', id: '-100', ...(thread ? { threadId: String(thread) } : {}) }, id: String(id) }, occurredAt: Date.now(), edit, editedAt: edit ? Date.now() : null, updateId: edit ? id + 100 : id, content: edit ? 'corrected' : 'synthetic' });
 const pendingIntent = observePendingIntent(-100, { role: 'user', uid, username: '', fullName: 'synthetic', timestamp: Date.now()/1000, messageId: id, messageThreadId: thread || undefined, textContent: text ?? (edit ? '修正约束' : '帮我看下'), isForwarded: false, eventIdentity: identity });
 return { id: 'input-'+id+'-'+edit, chatId: -100, userId: uid, messageId: id, messageThreadId: thread || undefined, createdAt: Date.now(), layer: 'L0', pressure:100, reason:'direct', textPreview: edit ? '修正约束' : '帮我看下', pendingIntent };
}
beforeEach(() => {
 vi.clearAllMocks(); _resetGlobalState(); _resetAttentionAccumulator(); runtime.active=null;
 runtime.db = new Database(':memory:'); runtime.db.exec(readFileSync('migrations/0129_pending_reply_intents.sql','utf8'));
 runtime.redis=new MetaRedisFixture(); callWithFallback.mockResolvedValue({content:'chat'}); isCodeActBusy.mockResolvedValue(false);
 tryClaimQuote.mockResolvedValue(true); tryMarkCodeActActive.mockResolvedValue(true); allQuotesAnswered.mockResolvedValue(false); suppressHeartDispatch.mockResolvedValue(false);
});
afterEach(() => { _resetAttentionAccumulator(); runtime.db.close(); });
describe('real Meta session preserves the pending input owner', () => {
 it('separates interleaved authors and retains the second lane instead of swallowing it', async () => {
  const a=input(1),b=input(2,21),c=input(3);
  await runMetaSession([a,b,c],[]);
  expect(enqueueCodeActJob).toHaveBeenCalledOnce();
  expect(enqueueCodeActJob.mock.calls[0]![0]).toMatchObject({targetUserId:20,quoteMessageIds:[3],relatedQuoteIds:[1],pendingIntent:c.pendingIntent});
  expect((await getAttentionAccumulator().peek()).map(x=>x.messageId)).toEqual([2]);
 });
 it('a different user cannot resume someone else clarification', async () => {
  const original=input(1); runtime.active={id:'waiting',chatId:-100,targetUserId:20,createdAt:Date.now(),status:'waiting_user',waitingForUser:true,contentDirection:'synthetic',quoteMessageIds:[1],pendingIntent:original.pendingIntent};
  const b=input(2,21); await runMetaSession([b],[]);
  expect(runtime.resume).not.toHaveBeenCalled(); expect(runtime.interrupt).not.toHaveBeenCalled();
  expect(runtime.active.status).toBe('waiting_user'); expect((await getAttentionAccumulator().peek()).map(x=>x.messageId)).toEqual([2]);
 });
 it('the original author resumes with only their own same-topic input and exact new revision', async () => {
  const original=input(1); runtime.active={id:'waiting',chatId:-100,targetUserId:20,createdAt:Date.now(),status:'waiting_user',waitingForUser:true,contentDirection:'synthetic',quoteMessageIds:[1],pendingIntent:original.pendingIntent};
  const a=input(2),b=input(3,21); await runMetaSession([a,b],[]);
  expect(runtime.resume).toHaveBeenCalledOnce();
  expect(runtime.active.pendingUserInput).toEqual([expect.objectContaining({messageId:2,userId:20})]);
  expect(runtime.active.pendingIntent).toEqual(a.pendingIntent);
  expect((await getAttentionAccumulator().peek()).map(x=>x.messageId)).toEqual([3]);
 });
 it('an edited source is dispatchable despite the original message-ID answered stamp', async () => {
  input(1); const edit=input(1,20,0,true); allQuotesAnswered.mockResolvedValue(true);
  await runMetaSession([edit],[]);
  expect(enqueueCodeActJob).toHaveBeenCalledOnce();
  expect(enqueueCodeActJob.mock.calls[0]![0]).toMatchObject({pendingIntent:edit.pendingIntent});
  expect(tryClaimQuote).toHaveBeenCalledWith(-100,1,expect.any(String),edit.pendingIntent);
 });
 it.each([false, true])('late old attention cannot replace the current edit fence (retired generation=%s)', async retired => {
  const old=input(1); if(retired) settlePendingIntent(old.pendingIntent);
  const edit=input(1,20,0,true); old.createdAt=edit.createdAt+1000;
  await runMetaSession([edit,old],[]);
  expect(enqueueCodeActJob).toHaveBeenCalledOnce();
  expect(enqueueCodeActJob.mock.calls[0]![0]).toMatchObject({pendingIntent:edit.pendingIntent});
 });
 it('cancelled waiting task cannot adopt a new request and revive its checkpoint', async () => {
  const original=input(1);
  runtime.active={id:'cancelled-waiting',chatId:-100,targetUserId:20,createdAt:Date.now(),status:'waiting_user',waitingForUser:true,contentDirection:'old request',quoteMessageIds:[1],pendingIntent:original.pendingIntent,checkpointKey:'old-checkpoint'};
  input(2,20,0,false,'不用了'); const fresh=input(3);
  await runMetaSession([fresh],[]);
  expect(runtime.resume).not.toHaveBeenCalled(); expect(runtime.interrupt).not.toHaveBeenCalled();
  expect(runtime.active).toMatchObject({status:'failed',resultSummary:'failed_input_superseded',waitingForUser:false});
  expect(enqueueCodeActJob).toHaveBeenCalledOnce();
  expect(enqueueCodeActJob.mock.calls[0]![0]).toMatchObject({pendingIntent:fresh.pendingIntent});
 });
});
