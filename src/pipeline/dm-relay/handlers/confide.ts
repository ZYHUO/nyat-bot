// ────────────────────────────────────────
// 猫娘树洞 — DM handler
// 用户说"树洞"或"说个秘密" → 猫娘匿名转发到群组
// 猫娘用不同回复风格（安慰/调侃/共鸣）
// ────────────────────────────────────────

import { logger } from '../../../shared/logger.js';
import { StreamingSender } from '../../../bot/sender/streaming.js';
import { sendMessage } from '../../../bot/sender/telegram.js';
import { callWithFallback } from '../../../ai/fallback.js';
import { getRedis } from '../../../db/redis.js';
import { runSafetyChecks } from '../safety.js';
import { checkFeatureGate } from '../feature-gate.js';

const log = logger.child({ mod: 'dm:confide' });

const PENDING_CONFIDE_PREFIX = 'xxb:dm:pending_confide:';
const PENDING_CONFIDE_TTL = 300; // 5 minutes

const CONFIDE_RATE_PREFIX = 'xxb:dm:confide:rate:';
const CONFIDE_DAILY_LIMIT = 5;

/** Check & increment daily confide counter. Returns remaining count, or -1 if over limit. */
async function consumeConfideRate(uid: number): Promise<number> {
  const redis = getRedis();
  const key = CONFIDE_RATE_PREFIX + uid;
  const count = await redis.incr(key);
  // Always (re)set TTL to next Asia/Shanghai midnight. Idempotent, and avoids a stuck
  // counter if the process died between INCR and EXPIRE on the first call.
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  await redis.expire(key, ttl);
  if (count > CONFIDE_DAILY_LIMIT) return -1;
  return CONFIDE_DAILY_LIMIT - count;
}

export async function setPendingConfide(uid: number): Promise<void> {
  await getRedis().set(PENDING_CONFIDE_PREFIX + uid, '1', 'EX', PENDING_CONFIDE_TTL);
}

export async function hasPendingConfide(uid: number): Promise<boolean> {
  return (await getRedis().exists(PENDING_CONFIDE_PREFIX + uid)) === 1;
}

export async function clearPendingConfide(uid: number): Promise<void> {
  await getRedis().del(PENDING_CONFIDE_PREFIX + uid);
}

export interface ConfideResult {
  handled: boolean;
  pendingGroupSelection?: {
    groups: Array<{ chatId: number; title: string }>;
    content: string;
  };
}

const CONFIDE_STYLES = [
  '安慰型 — 温暖包容，让人心安',
  '调侃型 — 轻松幽默，化解沉重',
  '共鸣型 — 感同身受，表示理解',
  '鼓励型 — 积极正面，给人力量',
  '佛系型 — 淡定从容，看开一切',
];

/**
 * Handle "树洞" or "说个秘密" commands.
 */
export async function handleConfide(
  ctx: { uid: number; chatId: number; messageId: number },
  sender: StreamingSender,
  content?: string,
): Promise<ConfideResult> {
  if (content && content.trim()) {
    // Signal caller to resolve a target group and call doConfide()
    return { handled: true, pendingGroupSelection: { groups: [], content: content.trim() } };
  }

  await setPendingConfide(ctx.uid);
  await sender.sendDirect(ctx.chatId, '🐱 喵~ 把秘密告诉本喵吧，本喵会匿名分享到群里的~（5分钟内有效）', ctx.messageId);
  return { handled: true };
}

/**
 * Generate the confide response and post to group.
 */
export async function doConfide(
  ctx: { uid: number; chatId: number; messageId: number },
  sender: StreamingSender,
  content: string,
  groupId: number,
): Promise<void> {
  // Feature gate (group admin may disable 树洞)
  const gate = await checkFeatureGate(groupId, 'confide');
  if (gate) {
    await sender.sendDirect(ctx.chatId, gate, ctx.messageId);
    return;
  }

  // Rate limit (5/day)
  const remaining = await consumeConfideRate(ctx.uid);
  if (remaining < 0) {
    await sender.sendDirect(ctx.chatId, `😿 今天的树洞额度已用完喵（每天 ${CONFIDE_DAILY_LIMIT} 次），明天再来吧~`, ctx.messageId);
    return;
  }

  // Safety: ban / membership / spam / dedup
  const safety = await runSafetyChecks(ctx.uid, groupId, 0, content);
  if (!safety.ok) {
    await sender.sendDirect(ctx.chatId, safety.reply, ctx.messageId);
    return;
  }

  const style = CONFIDE_STYLES[Math.floor(Math.random() * CONFIDE_STYLES.length)]!;

  const prompt = `你是啾咪囝,群里的猫娘,有人悄悄找你倾诉了一桩心事。这次用"${style}"的路子接住 TA。

怎么回:
1. 像朋友深夜接到消息那样说话,有温度,不端着
2. 别复述 TA 的原话,但要让 TA 知道你听懂了哪一层
3. 安慰不带建议:不说"你应该""你可以",陪着就是陪着
4. 2-4 句,猫腔点到为止,不靠"喵"撑场面
5. 只输出回复本身,不带标签或说明

TA 的心事:${content}`;

  let response: string;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: '你是啾咪囝,一只嘴硬心软的猫娘。别人交出心事的时候,你接得住:先听懂,再说话,不灌鸡汤。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
    });
    response = result.content.trim();
  } catch (err) {
    log.warn({ err }, 'confide AI failed, using fallback');
    response = '喵~ 本喵听到了你的心声，虽然不知道说什么好，但本喵会一直陪着你的~';
  }

  // Post to group — completely anonymous, no attribution
  try {
    await sendMessage(groupId, response);
    await sender.sendDirect(ctx.chatId, '🐱 已经匿名分享到群里啦~ 本喵会替你保密的喵~', ctx.messageId);
    log.info({ uid: ctx.uid, groupId }, 'confide posted');
  } catch (err) {
    log.warn({ err, groupId }, 'confide send failed');
    await sender.sendDirect(ctx.chatId, '😿 发送失败了，可能群组不可用~', ctx.messageId);
  }
}
