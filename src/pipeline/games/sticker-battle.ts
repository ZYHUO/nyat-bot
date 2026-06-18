// ────────────────────────────────────────
// 贴纸对战(E)— 群里连发贴纸时,本喵也甩一张凑个热闹(斗图)
// ────────────────────────────────────────
//
// 真实群文化:贴纸刷屏是高频非文字场景,本喵以前只会随机跟发一张、没参与感。
// 这里做轻量"斗图":检测到连发贴纸 → 本喵也来一张,大多数时候纯甩图,偶尔配一句短话。
//
// ⚠ 反面教训(用户反馈"很怪"):原版给贴纸编了个"战力 N 分"(从 gacha rarity
//    映射的数字),但群里根本不存在"战力"这套系统 —— 凭空报个"战力才 44,本喵划水"
//    像非要套个游戏壳,很出戏。已移除:斗图就是甩图,不报任何编造的数值。
//
// 设计(三家 sign-off 约束):
//   - **reactive、不走 proactive cron**(qoder:免得和 burst/proactive-scan 纠缠)
//     —— 由入站贴纸消息触发,fire-and-forget。
//   - 贴纸直发、不过 reply 管线 → 天然不碰全局 anti-repeat(cursor:别动 anti-repeat)。
//   - 复用 sticker store(选图)+ chat-lock(防与回复乱序)。
//   - 过作息门 + 抑制门 + 每群冷却 + 概率,默认 flag 关。

import { getRedis } from '../../db/redis.js';
import { getRecent, addAssistant } from '../context/manager.js';
import { sendMessage, sendSticker } from '../../bot/sender/telegram.js';
import { getReadyStickersByIntent, recordStickerSent } from '../../knowledge/sticker/store.js';
import { acquireChatLock } from '../../queue/chat-lock.js';
import { isAsleep } from '../../tracking/sleep.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';

const COOLDOWN_KEY = (chatId: number): string => `xxb:stickerbattle:${chatId}`;
const COOLDOWN_SEC = 1800;          // 每群最少隔 30 分钟来一次,别变贴纸刷屏帮凶
const WAR_WINDOW = 6;               // 看最近 6 条
const WAR_MIN_STICKERS = 3;         // ≥3 张贴纸
const WAR_MIN_SENDERS = 2;          // 来自 ≥2 个人
const BATTLE_PROBABILITY = 0.5;     // 命中战况也只一半概率入场
const BATTLE_INTENTS = ['playful', 'mischievous', 'smug', 'laughing', 'dramatic', 'tease'];

/** 最近窗口里是不是一场"贴纸战":≥3 张贴纸、来自 ≥2 个真人 */
export function detectStickerWar(recent: FormattedMessage[]): boolean {
  const tail = recent.slice(-WAR_WINDOW);
  const stickerMsgs = tail.filter((m) => m.sticker && !m.isBot && m.role !== 'assistant');
  if (stickerMsgs.length < WAR_MIN_STICKERS) return false;
  return new Set(stickerMsgs.map((m) => m.uid)).size >= WAR_MIN_SENDERS;
}

// 斗图入场白:真人斗图大多数时候只甩图、不配字,所以这里多数返回 null(纯甩图),
// 偶尔来一句短话凑趣。不编造任何"战力/分数"这类群里不存在的数值(用户反馈"很怪")。
const BATTLE_QUIPS = [
  '斗图呢喵?本喵也来一张',
  '这张拿得出手吧喵',
  '来都来了,本喵也斗一张',
  '你们斗挺欢喵,本喵插一脚',
  '本喵这张如何喵',
  '本喵也有好图喵',
];

/** 返回入场短话;多数时候返回 null = 纯甩贴纸(最自然的斗图)。 */
function battleQuip(): string | null {
  if (Math.random() < 0.6) return null; // 60% 纯甩图
  return BATTLE_QUIPS[Math.floor(Math.random() * BATTLE_QUIPS.length)]!;
}

/**
 * 入站贴纸触发:检测到贴纸战就带战力入场。fire-and-forget,永不抛。
 */
export async function maybeStickerBattle(chatId: number): Promise<void> {
  try {
    if (!env().STICKER_BATTLE_ENABLED || chatId >= 0) return;
    if (await isAsleep()) return; // 睡觉不凑热闹

    const redis = getRedis();
    if (await redis.get(COOLDOWN_KEY(chatId)).catch(() => null)) return;
    if (Math.random() >= BATTLE_PROBABILITY) return;

    // 抑制门:chat 正处于 WAIT/STOP(节奏克制)→ 不插入
    try {
      const { isChatSuppressed } = await import('../timing/chat-runtime.js');
      if (await isChatSuppressed(chatId)) return;
    } catch { /* non-critical */ }

    const recent = await getRecent(chatId, WAR_WINDOW + 2);
    if (!detectStickerWar(recent)) return;

    const candidates = getReadyStickersByIntent(BATTLE_INTENTS);
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.score - a.score);
    const picked = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))]!;
    const quip = battleQuip(); // 多数时候 null = 纯甩图

    // 持锁发送:避免和正常回复在 TG 侧乱序;锁后复检冷却(TOCTOU)
    const release = await acquireChatLock(chatId);
    try {
      if (await redis.get(COOLDOWN_KEY(chatId)).catch(() => null)) return;
      if (quip) {
        const textMid = await sendMessage(chatId, quip);
        if (textMid) await addAssistant(chatId, { textContent: quip, messageId: textMid });
      }
      const stickerMid = await sendSticker(chatId, picked.fileId);
      if (stickerMid) {
        recordStickerSent(chatId, stickerMid, picked.fileUniqueId, picked.fileId, 'playful');
        await addAssistant(chatId, { textContent: '[sticker]', messageId: stickerMid });
      }
      await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', COOLDOWN_SEC).catch(() => {});
      logger.info({ chatId, quip: quip ?? '(sticker-only)' }, 'Sticker battle: joined');
    } finally {
      await release().catch(() => {});
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'maybeStickerBattle failed (non-critical)');
  }
}
