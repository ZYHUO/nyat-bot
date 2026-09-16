// ────────────────────────────────────────
// Silence Alert — bot 沉默检测(端到端回复健康)
// ────────────────────────────────────────
// 每 SILENCE_ALERT_INTERVAL_MIN 分钟跑一次:
//   1. scanSilentChats() 找「最近活跃但 bot 超阈值没回复」的 chat
//   2. 每 chat 用 Redis NX key(冷却期 SILENCE_ALERT_COOLDOWN_MIN)去重,
//      冷却期内同一 chat 不重复告警
//   3. 告警发到 SILENCE_ALERT_CHAT_ID(owner DM);未配置时只打日志
//
// 设计取舍:监控 bot 是否「该回没回」,而不是「完全没说过话」——
// 潜水群本来就不该回,所以只扫最近有人类消息的 chat。

import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { scanSilentChats } from '../tracking/reply-activity.js';
import { sendMessage } from '../bot/sender/telegram.js';
import { logger } from '../shared/logger.js';

const ALERT_KEY = (chatId: number): string => `xxb:activity:alertCooldown:${chatId}`;

export async function runSilenceAlert(): Promise<void> {
  const cfg = env();
  if (!cfg.SILENCE_ALERT_ENABLED) return;

  const humanStaleMin = cfg.SILENCE_ALERT_HUMAN_STALE_MIN;
  const replyStaleMin = cfg.SILENCE_ALERT_THRESHOLD_MIN;
  const cooldownMin = cfg.SILENCE_ALERT_COOLDOWN_MIN;
  const targetChatId = cfg.SILENCE_ALERT_CHAT_ID;

  const silent = await scanSilentChats({
    humanStaleMin,
    replyStaleMin,
    max: cfg.SILENCE_ALERT_MAX_PER_RUN,
  });

  if (silent.length === 0) return;

  let redis;
  try {
    redis = getRedis();
  } catch {
    redis = null;
  }

  let alerted = 0;
  for (const s of silent) {
    // NX 去重:冷却期内不重复告警。
    if (redis) {
      const key = ALERT_KEY(s.chatId);
      const ok = await redis
        .set(key, '1', 'EX', cooldownMin * 60, 'NX')
        .catch(() => null);
      if (!ok) continue; // 冷却期内,跳过
    }

    const lastHuman = new Date(s.lastHumanAt).toLocaleString('zh-CN', { hour12: false });
    const lastReply = s.lastReplyAt
      ? new Date(s.lastReplyAt).toLocaleString('zh-CN', { hour12: false })
      : '无(bot 从未回复过该 chat)';

    const text =
      `⚠️ *沉默告警* — bot 疑似未回复\n` +
      `chat: \`${s.chatId}\`\n` +
      `人类最后发言: ${lastHuman}\n` +
      `bot 最后回复: ${lastReply}\n` +
      `已沉默: ~${s.silentForMin} 分钟(阈值 ${replyStaleMin}min)`;

    if (targetChatId > 0) {
      try {
        await sendMessage(targetChatId, text);
        alerted++;
      } catch (err) {
        logger.warn({ err, chatId: s.chatId }, 'Silence alert send failed');
      }
    } else {
      // 未配置目标:只打日志,不发送。
      logger.warn({ chatId: s.chatId, silentForMin: s.silentForMin }, 'SILENCE_ALERT: bot silent in active chat (no target chat configured)');
    }
  }

  if (alerted > 0) {
    logger.info({ alerted, thresholdMin: replyStaleMin }, 'Silence alert sent');
  }
}
