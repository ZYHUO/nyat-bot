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
const REPLY_KEY = (chatId: number): string => `xxb:activity:lastReply:${chatId}`;
// 24h 无人类消息的 chat 自动过期,扫描时自然消失(不主动清)。
const TTL_SEC = 24 * 3600;

/** 记一条人类消息(fire-and-forget,永不抛)。 */
export function recordHumanMessage(chatId: number, now: Date = new Date()): void {
  try {
    const redis = getRedis();
    const key = HUMAN_KEY(chatId);
    redis
      .set(key, now.getTime(), 'EX', TTL_SEC)
      .catch(() => {});
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
 * 正确语义(修复 2026-08-15 误报):「人类最后一条消息 bot 有没有接」,
 * 不是「bot 最近多久没说话」。人类发言后 bot 回过话 → 之后群安静潜水是
 * 正常行为,不告警。只有人类最后发言后 bot 一直没接才判定沉默,
 * silentForMin 从人类最后发言算起。
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
    const stream = redis.scanStream({ match: 'xxb:activity:lastHuman:*', count: 200 });
    const silent: ChatActivity[] = [];

    for await (const keys of stream) {
      if (!keys || keys.length === 0) continue;
      const chatIds = (keys as string[]).map((k) => Number(k.split(':').at(-1)));
      if (chatIds.length === 0) continue;

      const humanVals = await redis.mget(chatIds.map((c) => HUMAN_KEY(c)));
      const replyVals = await redis.mget(chatIds.map((c) => REPLY_KEY(c)));

      for (let i = 0; i < chatIds.length; i++) {
        const chatId = chatIds[i]!;
        const humanTs = Number(humanVals[i] ?? 0);
        // 人类消息过期/丢失 → 不活跃,跳过。
        if (!humanTs || humanTs < humanCutoff) continue;

        const replyTsRaw = replyVals[i];
        const replyTs = replyTsRaw ? Number(replyTsRaw) : null;
        // 人类最后发言后 bot 回过话 → 不是沉默(之后潜水是正常)。
        if (replyTs && replyTs >= humanTs) continue;
        // bot 回过话但比人类最后发言晚,且距今 < replyStaleMin → 正常(给 bot 接话时间)。
        // 注:上面已覆盖;这里只保留人类发言后 bot 完全没接的情形。

        // 人类最后发言距今还没到阈值(给 bot 缓冲时间)→ 不判定。
        if (now - humanTs < replyStaleMin * 60_000) continue;

        silent.push({
          chatId,
          lastHumanAt: humanTs,
          lastReplyAt: replyTs,
          // 从人类最后发言算起(bot 一直没接的时间)。
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
