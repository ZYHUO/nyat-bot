// ────────────────────────────────────────
// Turn Actor — G12 执行期 per-chat 互斥锁
// ────────────────────────────────────────
//
// 调度层的 meta.scheduledJobId 只是"排程期"指针,横跨多个 await 且被
// 多个生产者(ingress / defer_resume / wait_resume / sleep-cycle / 收尾
// forceNew)并发读写,挡不住两个 chat_turn job 同时被 concurrency=8 的
// worker 执行。执行期双回合的后果:registerGeneration 的 supersede 路径
// 互相掐死对方的生成(不计入打断 cap)→ replan 预算白烧 → 回复终局丢弃。
//
// 本模块在唯一 choke point(runChatTurn 入口、drainPending 之前)串行化:
// SET NX + token 比对释放/续期,持有期覆盖整个回合(含收尾 reschedule),
// TTL 兜底持锁进程崩溃。输锁方不 drain、排短延迟重试,唤醒不丢(所有
// 生产者都是"条目先进 pending 再排 job",持锁回合收尾必然接住)。

import { getRedis } from '../../db/redis.js';

const LOCK_KEY = (chatId: number) => `xxb:turn:execlock:${chatId}`;

// 只有 token 匹配才允许续期/释放 —— TTL 过期后接手的新回合不会被旧回合
// 的 finally 误删锁。
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function acquireTurnLock(chatId: number, token: string, ttlMs: number): Promise<boolean> {
  const result = await getRedis().set(LOCK_KEY(chatId), token, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

export async function renewTurnLock(chatId: number, token: string, ttlMs: number): Promise<boolean> {
  const result = (await getRedis().eval(RENEW_LUA, 1, LOCK_KEY(chatId), token, String(ttlMs))) as number;
  return result === 1;
}

export async function releaseTurnLock(chatId: number, token: string): Promise<void> {
  await getRedis().eval(RELEASE_LUA, 1, LOCK_KEY(chatId), token);
}
