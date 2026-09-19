// ────────────────────────────────────────
// Nyat Trench · 定向债（Debt）——把"无方向的免费势能"变成"欠谁一句话"
// ────────────────────────────────────────
//
// 来源：多模型评审第 22 轮，评审 3 的反对意见。
//
// 问题：睡眠期的 `pulseForUnheard(chatId, 0.5)` 是**无方向**的。醒来后 P 饱和到
// θ·g(12)=4.0 条/小时，而压平它的只有 60 分钟半衰期——也就是说衰减由 `Date.now()`
// 驱动，不是由"我说的有没有人接"驱动。评审的原话：由 clamp 顶住的包络天生是痉挛签名。
//
// 活人醒来的密话有两个特征它没有：
//   ① 每条锚在夜里堆积的**具体的人**身上（"你昨晚问我那个事"）
//   ② 没人接就自己停——衰减由闭环驱动，不由时钟驱动
//
// 实现上**不需要把 P 改成向量**。积分器保持标量（它管速率，本身没问题），
// 另外记一本定向的账：夜里谁的消息带来的气压，醒来就欠谁一句话。
// 于是：
//   - 速率上界仍由 P 决定（标量不变，r=clamp(θ·g(P)) 不变）
//   - 但 Frame 里多一行"你欠 A 两句话"，模型知道**该对谁说**
//   - 真的回给 A 的时候销账（discharge），同时 releasePressure 照旧
//   → 衰减改由"还债"驱动，时钟只是兜底
//
// 我自己提过的担忧（"指向性会不会让醒来行为变窄"）在这里得到解答：
// 会变窄，而那是**对的**——人醒来是回昨晚跟自己说话的人，不是对全群随机发言。
//
// 全程零 LLM、零 prompt 规则：宿主只提供"你欠谁"这个事实，说不说、怎么说仍是模型的。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

/** 单笔债的硬上界：一条消息最多欠 1 句，不许一夜之间攒成巨债。 */
const MAX_OWED = 6;

interface Debt {
  uid: number;
  owed: number;
}

function key(chatId: number): string {
  return `xxb:trench:owed:${chatId}`;
}

function enabled(): boolean {
  try {
    return env().TRENCH_DEBT_ENABLED === true;
  } catch {
    return false;
  }
}

/**
 * 记一笔定向债。
 *
 * @param chatId 会话
 * @param uid    这条消息的发送者——债的**方向**
 * @param delta  欠多少句（通常 0.5/1.0，被 clamp 到 [0, MAX_OWED]）
 */
export async function oweFor(chatId: number, uid: number, delta: number): Promise<void> {
  if (!enabled()) return;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  if (!Number.isSafeInteger(uid) || uid <= 0) return;      // 没有发送者就没有方向
  const d = Math.min(MAX_OWED, Math.max(0, Number(delta)));
  if (d <= 0) return;
  try {
    const redis = getRedis();
    const cur = Number(await redis.hget(key(chatId), String(uid)));
    const next = Math.min(MAX_OWED, (Number.isFinite(cur) ? cur : 0) + d);
    await redis.hset(key(chatId), String(uid), String(next));
    await redis.expire(key(chatId), 24 * 3600);            // 债不过夜两次
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'oweFor failed (non-critical)');
  }
}

/** 还债：bot 真的回给了这个人。 */
export async function discharge(chatId: number, uid: number, amount: number): Promise<void> {
  if (!enabled()) return;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  if (!Number.isSafeInteger(uid) || uid <= 0) return;
  try {
    const redis = getRedis();
    const cur = Number(await redis.hget(key(chatId), String(uid)));
    if (!Number.isFinite(cur)) return;
    const next = Math.max(0, cur - Math.max(0, Number(amount)));
    if (next <= 0.01) await redis.hdel(key(chatId), String(uid));
    else await redis.hset(key(chatId), String(uid), String(next));
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'discharge failed (non-critical)');
  }
}

/** 读前 N 个债主（ owed 高的在前）。读不到返回空数组，不编。 */
export async function readDebt(chatId: number, topN = 5): Promise<Debt[]> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return [];
  try {
    const all = await getRedis().hgetall(key(chatId));
    return Object.entries(all)
      .map(([uid, owed]) => ({ uid: Number(uid), owed: Number(owed) }))
      .filter((d) => Number.isSafeInteger(d.uid) && d.uid > 0 && Number.isFinite(d.owed) && d.owed > 0.01)
      .sort((a, b) => b.owed - a.owed)
      .slice(0, Math.max(1, topN));
  } catch {
    return [];
  }
}

/**
 * 渲染成 Frame 事实行。
 *
 * 刻意用"欠"这个语义而不是"待回复队列"——后者是工单系统，前者是人的债。
 * 名字只在有 uid→昵称映射时给出；拿不到昵称就说"那个人"，不编名字。
 */
export async function renderDebt(chatId: number, nameOf?: (uid: number) => string | null): Promise<string> {
  if (!enabled()) return '';
  const debts = await readDebt(chatId, 3);
  if (debts.length === 0) return '';
  const total = debts.reduce((s, d) => s + d.owed, 0);
  const names = debts.map((d) => {
    const n = nameOf?.(d.uid);
    return n ? `${n}（欠 ${Math.round(d.owed)} 句）` : `那个人（欠 ${Math.round(d.owed)} 句）`;
  });
  return `[欠话] 你睡着的时候 ${names.join('、')}——总共欠 ${Math.round(total)} 句。还不还、什么时候还，你定。`;
}
