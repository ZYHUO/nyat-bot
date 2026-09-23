import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { incrCounter } from '../metrics/registry.js';

/** 7 天 — 重启后 Attention 残留 / busy requeue 不能再回同一条 */
const TTL_SEC = 7 * 24 * 3600;

function key(chatId: number, messageId: number): string {
  return `xxb:meta:answered:${chatId}:${messageId}`;
}

/** Mark a user message as already replied-to (anti double-reply). */
export async function markMessageAnswered(chatId: number, messageId: number): Promise<void> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return;
  try {
    // round 4：累加成时间戳列表（留最近 5 次），心流要拿它说"你已经回过 N 次"。
    // 旧的 '1' 会被覆盖成当前时间——语义等价（回到过去了），不丢信息。
    const prev = await getRedis().get(key(chatId, mid));
    const times = prev && prev !== '1'
      ? prev.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    // round 38：**给账本加打点。**
    //
    // round 37 回放各闸时发现：重复锚点闸（round 89）全日志只拦 3 次，而我按它判据
    // 从 `host sendText` 日志回放得 3854 候选——差 1285 倍。
    //
    // 两个数来源不同：我的回放读发送日志，闸自己读 `answeredTimestamps(chat, anchor)`，
    // 而那个的源就是这里的 `markMessageAnswered`——**这个函数此前零打点**。
    // 于是"闸拦得少"这件事无法定论：上一份日志看得到"发了"，看不到"记了账吗"。
    //
    // 三个数分开记（都是 chat label，和 delegation_target_absent_total 同形）：
    //   写入 —— 新戳真的进了账本
    //   旧格式 —— prev === '1'（历史遗留，正常但要知道有多少）
    //   同秒去重 —— round 132 修的那个双签还能看到（应为 0，非 0 = 有人在绕过这里）
    // 这两个"非写入"分支其实比写入更值得看：它们正是"账本和发送日志对不上"的位置。
    incrCounter('answered_stamp_read_total', { chat: chatId });
    if (prev === '1') incrCounter('answered_legacy_format_total', { chat: chatId });
    const now = Math.floor(Date.now() / 1000);
    if (times.length > 0 && times[times.length - 1] === now) {
      incrCounter('answered_same_second_skipped_total', { chat: chatId });
    }
    // round 132：**同一次回答不能记两个戳。**
    //
    // 生产实测 `xxb:meta:answered:-1003350411234:68491` =
    //   1790169018,1790169058,1790169058,1790169094
    //                     ^^^^^^^^^ 同一秒两个戳，而那个锚点只成功发过一条。
    //
    // 根因是调用点重复，不是这里：
    //   - `src/bot/sender/telegram.ts:410` sendMessage 是公共出口，发完就标
    //   - `src/subagent/host-api.ts:1511` 同一个 firstReplyTo，Meta 路径再标一遍
    // 全仓 10 处调用，逐处去重容易漏；在这里挡一次覆盖全部。
    //
    // 判据用同一秒：两次真正分开的回答至少差几秒（要等心流/模型），
    // 而同一次发送的两个 mark 只差几毫秒。隔一秒的回答仍然各记一次。
    // 直接 return，不续 TTL：上一次写就是同一秒前的事，
    // 它已经把 TTL 设成 TTL_SEC 了，再续没有意义（也少一个依赖的方法）。
    if (times.length > 0 && times[times.length - 1] === now) return;
    times.push(now);
    await getRedis().set(key(chatId, mid), times.slice(-5).join(','), 'EX', TTL_SEC);
    incrCounter('answered_stamp_written_total', { chat: chatId, stamps: times.length });
  } catch (err) {
    logger.debug({ err, chatId, messageId: mid }, 'markMessageAnswered failed');
  }
}

/**
 * 这条消息被本喵回过几次、都是什么时候（新的在前）。
 *
 * round 4（新 goal，用户："重复回复的概率太高了"）加的。
 *
 * `markMessageAnswered` 原来只写一个 `'1'`——够 attention 的"入没入过队"用,
 * 但心流需要知道的是"**我回过几次、上次是什么时候、上次说了什么**"。
 * 一个布尔值回答不了"你已经回过三次了",而后者才是能拦住复读的那个事实。
 *
 * 存的还是同一个 key,值从 '1' 改成逗号分隔的 unix 秒（最多留 5 条,再老的就
 * 只在 `isMessageAnswered` 里当"回过了"用）。读的时候兼容旧的 '1'——
 * 老 key 会被解释成"回过了但不知道什么时候",比读失败好。
 */
export async function answeredTimestamps(chatId: number, messageId: number): Promise<number[]> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return [];
  try {
    const raw = await getRedis().get(key(chatId, mid));
    if (!raw) return [];
    if (raw === '1') return [];                      // 旧格式：只回过了，没时间
    const parsed = raw.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.sort((a, b) => b - a);
  } catch {
    return [];
  }
}

export async function isMessageAnswered(chatId: number, messageId: number): Promise<boolean> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return false;
  try {
    // round 4：值的形状从 '1' 变成了逗号分隔的时间戳列表（见 markMessageAnswered）。
    // 这里必须跟着改——第一版改完了 writer 和新 reader、漏了这个老 reader,
    // 于是 `marks and detects answered quotes` 立刻红。
    // 判据放宽成"有值就算回过了"：'1'（旧格式）和时间戳列表都算。
    const raw = await getRedis().get(key(chatId, mid));
    return raw !== null && raw !== '' && raw !== '0';
  } catch {
    return false;
  }
}

/** True if every positive quote id was already answered. */
export async function allQuotesAnswered(chatId: number, quotes: number[]): Promise<boolean> {
  const ids = quotes.filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return false;
  for (const id of ids) {
    if (!(await isMessageAnswered(chatId, id))) return false;
  }
  return true;
}

/**
 * Batch check which messages are already answered — single MGET round-trip
 * instead of N serial GETs. Returns a Set of `"chatId:messageId"` strings
 * for messages that were already replied-to.
 */
export async function batchMessagesAnswered(
  entries: ReadonlyArray<{ chatId: number; messageId: number }>,
): Promise<Set<string>> {
  const valid = entries
    .map((e) => ({ chatId: e.chatId, mid: Math.floor(Number(e.messageId)) }))
    .filter((e) => Number.isFinite(e.chatId) && Number.isFinite(e.mid) && e.mid > 0);
  if (!valid.length) return new Set();
  const keys = valid.map((e) => key(e.chatId, e.mid));
  try {
    const vals = (await getRedis().mget(...keys)) as (string | null)[];
    const answered = new Set<string>();
    for (let i = 0; i < valid.length; i++) {
      const entry = valid[i];
      if (entry && vals[i] === '1') answered.add(`${entry.chatId}:${entry.mid}`);
    }
    return answered;
  } catch {
    return new Set();
  }
}
