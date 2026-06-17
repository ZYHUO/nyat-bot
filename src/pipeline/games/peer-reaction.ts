// ────────────────────────────────────────
// A 多 bot 共存 — 对群里其他 bot 的发言做反应(让位/捧哏/补刀)
// ────────────────────────────────────────
//
// 真实群里有别的 bot(千雪=另一只猫娘、聚合解析姬=下载…),本喵以前当噪音。
// 这里:看到会话型 bot(botClass=chat,如千雪)发言 → 接一句短的;看到下载/
// 解析类**带媒体的成功结果**(cmd_result+media)→ 给个尾刀吐槽。
//
// 三家 sign-off 强制约束(全部纳入):
//   - 整条路径占 **chat-lock**(否则和正常回复/proactive 在同群抢发)。
//   - **不走 judge/heart**(bot_message 规则本就 L0 IGNORE 非点名 bot,0ms;
//     这里是另起的 fire-and-forget 反应)。
//   - **@/回复我 → 让位**(交给正常回复路径,别双答)。
//   - 有未决代发(pending delegation)→ 不反应(回执优先)。
//   - per-(chat,peer) fatigue 防 A↔千雪 无限对喷 + 全局冷却 + 概率 + 作息门 + 抑制门。
//   - cmd_result 仅对"有媒体的成功结果"反应(不对进度/失败吐槽)。

import { getRedis } from '../../db/redis.js';
import { acquireChatLock } from '../../queue/chat-lock.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { addAssistant } from '../context/manager.js';
import { isAsleep } from '../../tracking/sleep.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';

const FATIGUE_KEY = (chatId: number, peer: string): string => `xxb:peerreact:fat:${chatId}:${peer}`;
const COOLDOWN_KEY = (chatId: number): string => `xxb:peerreact:cd:${chatId}`;
const FATIGUE_MAX = 3;              // 同一 peer 10 分钟内最多反应 3 次(qoder:别太紧)
const FATIGUE_WINDOW_SEC = 600;
const COOLDOWN_SEC = 90;           // 全局:同群两次 peer 反应最小间隔
const PROBABILITY = 0.55;

function mentionsOrRepliesSelf(m: FormattedMessage, botUid: number, botUsername: string, nicks: string[]): boolean {
  if (m.replyTo?.uid === botUid) return true;
  const t = (m.textContent || m.captionContent || '').toLowerCase();
  if (botUsername && t.includes(`@${botUsername.toLowerCase()}`)) return true;
  return nicks.some((n) => n && t.includes(n.toLowerCase()));
}

function hasMedia(m: FormattedMessage): boolean {
  return !!(m.audioFileId || m.voiceFileId || m.documentFileId || m.imageFileId || m.videoFileId || m.sticker);
}

/**
 * 入站其他 bot 消息触发(caller 已确认 botClass∈{chat,cmd_result})。
 * fire-and-forget,永不抛。
 */
export async function maybePeerReaction(chatId: number, peer: FormattedMessage, botUid: number): Promise<void> {
  try {
    const e = env();
    if (!e.PEER_REACTION_ENABLED || chatId >= 0 || !peer.isBot || !peer.username) return;
    const botClass = peer.botClass;
    if (botClass !== 'chat' && botClass !== 'cmd_result') return;
    // 下载/解析类:只对"有媒体的成功结果"尾刀,不对"解析中/失败"吐槽
    if (botClass === 'cmd_result' && !hasMedia(peer)) return;
    // @/回复我 → 让正常回复路径接(别双答)
    if (mentionsOrRepliesSelf(peer, botUid, e.BOT_USERNAME, e.BOT_NICKNAMES)) return;
    if (await isAsleep()) return;

    const redis = getRedis();
    // 有未决代发 → 回执优先,别插嘴
    if (await redis.get(`xxb:delegation:${chatId}`).catch(() => null)) return;
    if (await redis.get(COOLDOWN_KEY(chatId)).catch(() => null)) return;
    // per-peer fatigue:防和同一只 bot 无限对喷
    const peerKey = FATIGUE_KEY(chatId, peer.username.toLowerCase());
    const fat = await redis.incr(peerKey).catch(() => 1);
    if (fat === 1) await redis.expire(peerKey, FATIGUE_WINDOW_SEC).catch(() => {});
    if (fat > FATIGUE_MAX) return;
    if (Math.random() >= PROBABILITY) return;

    // 抑制门:chat 在 WAIT/STOP → 不插
    try {
      const { isChatSuppressed } = await import('../timing/chat-runtime.js');
      if (await isChatSuppressed(chatId)) return;
    } catch { /* non-critical */ }

    const peerText = (peer.textContent || peer.captionContent || (hasMedia(peer) ? '[发了个文件/媒体]' : '')).slice(0, 120);
    const peerName = peer.fullName || peer.username;
    const intent =
      botClass === 'chat'
        ? `[接另一个bot] 群里另一个 bot「${peerName}」刚说:「${peerText}」。你可以自然接一句——捧哏、调侃、补一刀都行,像群友之间互动。**别复述它的话**,别自我介绍。`
        : `[尾刀] 群里的工具 bot「${peerName}」刚把结果/文件发出来了(${peerText})。你可以顺势吐个槽或点评一句,轻松随意。别复述,别重发文件。`;

    const { generatePersonaProactiveText } = await import('../turn/proactive-turn.js');
    const text = await generatePersonaProactiveText(chatId, botUid, intent);
    if (!text) return; // 模型觉得没必要说 → silent

    // 持锁发送:和正常回复/proactive 串行,避免乱序/双发
    const release = await acquireChatLock(chatId);
    try {
      if (await redis.get(COOLDOWN_KEY(chatId)).catch(() => null)) return; // 锁后复检
      const mid = await sendMessage(chatId, text.slice(0, 200));
      if (mid) {
        await addAssistant(chatId, { textContent: text.slice(0, 200), messageId: mid });
        await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', COOLDOWN_SEC).catch(() => {});
        logger.info({ chatId, peer: peer.username, botClass }, 'Peer reaction sent');
      }
    } finally {
      await release().catch(() => {});
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'maybePeerReaction failed (non-critical)');
  }
}
