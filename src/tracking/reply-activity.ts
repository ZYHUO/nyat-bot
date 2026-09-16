// ────────────────────────────────────────
// Reply Activity — bot 沉默检测的数据层
// ────────────────────────────────────────
// 两个埋点:
//   - recordHumanMessage(chatId): 人类消息入站时记(排除 bot 自己/服务消息)
//   - recordBotReply(chatId):     bot 发消息成功时记(与 recordSpeech 同点)
// 扫描: scanSilentChats() 找出「最近有人说话但 bot 超阈值没回复」的活跃 chat。
// 告警去重在 cron 层用 Redis NX key 实现(见 silence-alert.ts)。

import { getRedis } from '../db/redis.js';

const HUMAN_KEY = (chatId: number): string => `xxb:activity:lastHuman:${chatId}`;
// 「直接对 bot 说话」的独立时间戳(DM/@/昵称/回复 bot/命令)。
// 群聊普通消息不更新它 —— bot 决定不插话是正常行为,不该触发沉默告警。
const HUMAN_DIRECT_KEY = (chatId: number): string => `xxb:activity:lastHumanDirect:${chatId}`;
const REPLY_KEY = (chatId: number): string => `xxb:activity:lastReply:${chatId}`;
// 24h 无人类消息的 chat 自动过期,扫描时自然消失(不主动清)。
const TTL_SEC = 24 * 3600;

/** 记一条人类消息(fire-and-forget,永不抛)。direct=true 时同时更新 direct 时间戳。 */
export function recordHumanMessage(
  chatId: number,
  opts: { direct?: boolean } = {},
  now: Date = new Date(),
): void {
  try {
    const redis = getRedis();
    const ts = now.getTime();
    redis
      .set(HUMAN_KEY(chatId), ts, 'EX', TTL_SEC)
      .catch(() => {});
    if (opts.direct) {
      redis
        .set(HUMAN_DIRECT_KEY(chatId), ts, 'EX', TTL_SEC)
        .catch(() => {});
    }
  } catch {
    /* fail-soft */
  }
}

/** 记一次 bot 回复/发言(fire-and-forget,永不抛)。 */
export function recordBotReply(chatId: number, now: Date = new Date()): void {
  try {
    const redis = getRedis();
    const key = REPLY_KEY(chatId);
    redis
      .set(key, now.getTime(), 'EX', TTL_SEC)
      .catch(() => {});
  } catch {
    /* fail-soft */
  }
}

export interface ChatActivity {
  chatId: number;
  lastHumanAt: number;
  lastReplyAt: number | null;
  silentForMin: number;
}

export interface ScanOptions {
  /** 人类最后发言距今超过该分钟数 = 不算「活跃」(潜水群不告警)。 */
  humanStaleMin: number;
  /** 人类最后发言后,bot 超过该分钟数没接话 = 判定沉默。 */
  replyStaleMin: number;
  /** 最多返回多少个沉默 chat(防告警风暴)。 */
  max?: number;
}

/**
 * 扫描活跃但沉默的 chat。Redis 故障时返回空数组(告警静默,不误报)。
 *
 * 正确语义(两次修复后):
 *  1. 「人类最后一条消息 bot 有没有接」,不是「bot 最近多久没说话」。
 *  2. 只统计「直接对 bot 说话」的消息(DM/@/昵称/回复 bot/命令)——
 *     群聊普通消息 bot 决定不插话是正常行为(Heart gate/cooldown),不告警。
 *  3. direct 时间戳存在且 bot 没接,才判定沉默。
 */
export async function scanSilentChats(opts: ScanOptions): Promise<ChatActivity[]> {
  const { humanStaleMin, replyStaleMin, max = 20 } = opts;
  const now = Date.now();
  const humanCutoff = now - humanStaleMin * 60_000;

  let redis;
  try {
    redis = getRedis();
    // 探活:失败直接返回空(不误报)。
    await redis.ping();
  } catch {
    return [];
  }

  try {
    // 只扫 direct key:没有 direct 消息的 chat(DM 天然有,群聊仅 @/回复时)不参与判定。
    const stream = redis.scanStream({ match: 'xxb:activity:lastHumanDirect:*', count: 200 });
    const silent: ChatActivity[] = [];

    for await (const keys of stream) {
      if (!keys || keys.length === 0) continue;
      const chatIds = (keys as string[]).map((k) => Number(k.split(':').at(-1)));
      if (chatIds.length === 0) continue;

      const humanVals = await redis.mget(chatIds.map((c) => HUMAN_DIRECT_KEY(c)));
      const replyVals = await redis.mget(chatIds.map((c) => REPLY_KEY(c)));

      for (let i = 0; i < chatIds.length; i++) {
        const chatId = chatIds[i]!;
        const humanTs = Number(humanVals[i] ?? 0);
        // direct 消息过期/丢失 → 不活跃,跳过。
        if (!humanTs || humanTs < humanCutoff) continue;

        const replyTsRaw = replyVals[i];
        const replyTs = replyTsRaw ? Number(replyTsRaw) : null;
        // bot 在该 direct 消息之后回过话 → 不是沉默(已接)。
        if (replyTs && replyTs >= humanTs) continue;

        // direct 消息距今还没到阈值(给 bot 接话时间)→ 不判定。
        if (now - humanTs < replyStaleMin * 60_000) continue;

        silent.push({
          chatId,
          lastHumanAt: humanTs,
          lastReplyAt: replyTs,
          // 从人类 direct 发言算起(bot 一直没接的时间)。
          silentForMin: Math.round((now - humanTs) / 60_000),
        });
        if (silent.length >= max) return silent;
      }
    }
    return silent;
  } catch (err) {
    try {
      const { logger } = await import('../shared/logger.js');
      logger.warn({ err }, 'scanSilentChats failed');
    } catch {
      /* ignore */
    }
    return [];
  }
}
