// ────────────────────────────────────────
// 功能 B:主动 DM — 睡前/起床悄悄话(B1)+ 攒话 flush(B2)
// ────────────────────────────────────────
//
// 两者共用:都给「曾私聊过 bot 的人」发(TG 不能冷启动 DM),都经 persona 管线
// 自然生成(不模板直发),都 block-safe(用户 block 了 bot → Forbidden,吞掉),
// 都带跨群外号画像。频控由调用方(cron 边沿/入站)+ Redis 冷却把关。

import { getRedis } from '../db/redis.js';
import { getBotUid } from '../bot/bot.js';
import { sender } from './shared.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';
import { hasDmEver } from '../tracking/dm-state.js';
import { takeDmPending } from '../tracking/dm-pending.js';
import { getAggregatedUserTag } from '../tracking/user-profile.js';
import { getAggregatedAffinity } from '../tracking/user-affinity.js';

/** 跨群外号 → 注入片段(无外号则空) */
function nicknameHint(uid: number): string {
  const tag = getAggregatedUserTag(uid);
  return tag ? `(对方你私下叫TA「${tag}」)` : '';
}

/**
 * 睡前/起床给一个已私聊用户发悄悄话。block-safe + 每用户每边沿去重 + 冷却。
 * 返回是否发了。
 */
export async function sendDmGreeting(uid: number, kind: 'goodnight' | 'morning'): Promise<boolean> {
  const e = env();
  if (!hasDmEver(uid)) return false; // TG 不能冷启动 DM
  const redis = getRedis();
  const dayKey = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  // 每用户每天每类一次
  const dedup = await redis.set(`xxb:dm:greeted:${uid}:${dayKey}:${kind}`, '1', 'EX', 36 * 3600, 'NX');
  if (dedup === null) return false;
  // 主动 DM 冷却(同人两次主动间隔)
  const cd = await redis.set(`xxb:dm:proactive:${uid}`, '1', 'EX', Math.round(e.DM_PROACTIVE_COOLDOWN_HOURS * 3600), 'NX');
  if (cd === null) return false;

  const nick = nicknameHint(uid);
  const intent = kind === 'goodnight'
    ? `[睡前悄悄话] 你困了,私聊跟这位你挺亲近的人道个晚安,带一点撒娇、一两句就好${nick}`
    : `[起床啦] 你刚醒,迷迷糊糊私聊跟TA说声起床了/早${nick}`;
  try {
    const { generatePersonaProactiveText } = await import('./turn/proactive-turn.js');
    const text = await generatePersonaProactiveText(uid, getBotUid(), intent);
    if (!text) return false;
    await sender.sendDirect(uid, text);
    logger.info({ uid, kind }, 'Proactive DM greeting sent');
    return true;
  } catch (err) {
    // Forbidden(用户 block 了 bot)等 → 吞掉,不刷 error
    logger.debug({ err, uid }, 'sendDmGreeting failed (likely blocked)');
    return false;
  }
}

/**
 * 睡前/起床边沿:给「已私聊 + 高好感」用户发悄悄话。挂在 sleep-cycle 边沿,
 * 全局每边沿最多 DM_GREET_MAX_USERS 人(防 spam/封号)。SLEEP_DM_ENABLED 关→no-op。
 */
export async function announceDmGreetings(kind: 'goodnight' | 'morning'): Promise<void> {
  const e = env();
  if (!e.SLEEP_DM_ENABLED) return;
  try {
    const { listDmEverUids } = await import('../tracking/dm-state.js');
    const uids = listDmEverUids(90 * 86400); // 近 90 天私聊过的
    const ranked = uids
      .map((uid) => ({ uid, aff: getAggregatedAffinity(uid).affinity }))
      .filter((x) => x.aff >= e.DM_GREET_AFFINITY_MIN)
      .sort((a, b) => b.aff - a.aff)
      .slice(0, e.DM_GREET_MAX_USERS);
    for (const { uid } of ranked) {
      await sendDmGreeting(uid, kind); // 串行,防 rate limit
    }
    if (ranked.length > 0) logger.info({ kind, count: ranked.length }, 'DM greetings round done');
  } catch (err) {
    logger.debug({ err, kind }, 'announceDmGreetings failed (non-critical)');
  }
}

/**
 * 用户私聊时:若有攒着的话,自然地说出来(取 1-2 条)。block-safe + 冷却避免
 * 每条 DM 都倒。返回是否发了。
 */
export async function flushDmPendingOnInbound(uid: number): Promise<boolean> {
  const redis = getRedis();
  // 一次 DM 会话只 flush 一次(冷却 2h)
  const cd = await redis.set(`xxb:dm:flush:${uid}`, '1', 'EX', 2 * 3600, 'NX');
  if (cd === null) return false;
  const lines = takeDmPending(uid, 2);
  if (lines.length === 0) {
    await redis.del(`xxb:dm:flush:${uid}`); // 没东西可 flush,不占冷却
    return false;
  }
  const nick = nicknameHint(uid);
  const aff = getAggregatedAffinity(uid);
  const body = lines.map((l) => (l.context ? `${l.intent}(缘起:${l.context})` : l.intent)).join('；');
  const intent = `[终于私聊上了] 你之前一直攒着想跟TA说的:${body}。现在TA私聊你了,自然地把这些说出来,像憋了好久终于逮着机会,别像念清单${nick}`;
  try {
    const { generatePersonaProactiveText } = await import('./turn/proactive-turn.js');
    const text = await generatePersonaProactiveText(uid, getBotUid(), intent);
    if (!text) return false;
    await sender.sendDirect(uid, text);
    logger.info({ uid, lines: lines.length, affinity: Math.round(aff.affinity) }, 'Flushed pending DM lines');
    return true;
  } catch (err) {
    logger.debug({ err, uid }, 'flushDmPendingOnInbound failed (likely blocked)');
    return false;
  }
}
