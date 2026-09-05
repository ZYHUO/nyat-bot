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
import { peekDmPending, markDmPendingFlushed } from '../tracking/dm-pending.js';
import { getAggregatedUserTag, getBotTagForAddressing } from '../tracking/user-profile.js';
import { getAggregatedAffinity } from '../tracking/user-affinity.js';
import { isMaster } from '../admin/auth.js';

/**
 * 称呼注入:主人 → 「主人」(优先于学来的跨群外号)。persona 对主人亲近但不跪,
 * 学来的 sender_tag 可能是「妹妹」之类(被某群语境学歪),
 * 直注会把主人喊成妹妹 → 主人关系必须压过外号。其他人用跨群外号(无则空)。
 */
export function nicknameHint(uid: number): string {
  if (isMaster(uid, env().MASTER_UID)) {
    return `(对方是你的主人,你叫TA「主人」,对主人你亲近但不跪)`;
  }
  // bot 对他的称呼(bot_tag,可私聊"叫我X"纠正)优先于群里外号(sender_tag)。
  const tag = getBotTagForAddressing(uid, uid) ?? getAggregatedUserTag(uid);
  return tag ? `(对方你私下叫TA「${tag}」)` : '';
}

/** 称呼标签(用于兜底池前缀):主人 → 「主人」,否则 bot_tag 优先于群里外号。 */
function addressLabel(uid: number): string | null {
  if (isMaster(uid, env().MASTER_UID)) return '主人';
  return getBotTagForAddressing(uid, uid) ?? getAggregatedUserTag(uid);
}

// generatePersonaProactiveText 依赖 getRecent(uid) 上下文,DM ctx 仅 7 天 TTL,
// 而问候候选窗口 90 天 → 久未私聊的人会拿到 null。给一个固定兜底池保证能发出。
const GOODNIGHT_POOL = ['晚安喵~', '本喵要睡啦,你也早点睡哦', '困死了…晚安', '睡了睡了,梦里见喵'];
const MORNING_POOL = ['起床啦喵~', '早安!本喵醒咯', '早上好呀,睡得好吗', '喵…刚醒,早安'];
export function fallbackGreeting(kind: 'goodnight' | 'morning', uid: number): string {
  const label = addressLabel(uid);
  const pool = kind === 'goodnight' ? GOODNIGHT_POOL : MORNING_POOL;
  const line = pool[Math.abs(uid) % pool.length]!;
  return label ? `${label}, ${line}` : line;
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
  // 主动 DM 冷却:**按 kind 分桶** —— 晚安/起床本就一天各一次,共用一个键会让晚安
  // 占满冷却把起床压掉(review #1/#8)。
  const cd = await redis.set(`xxb:dm:proactive:${uid}:${kind}`, '1', 'EX', Math.round(e.DM_PROACTIVE_COOLDOWN_HOURS * 3600), 'NX');
  if (cd === null) return false;

  const nick = nicknameHint(uid);
  const intent = kind === 'goodnight'
    ? `[睡前悄悄话] 你困了,私聊跟这位你挺亲近的人道个晚安,带一点撒娇、一两句就好${nick}`
    : `[起床啦] 你刚醒,迷迷糊糊私聊跟TA说声起床了/早${nick}`;
  try {
    const { generatePersonaProactiveText } = await import('./turn/proactive-turn.js');
    // ctx 可能已过期(7天 TTL)→ persona 生成拿不到上下文返回 null,用固定池兜底(review #9/#10)
    const text = (await generatePersonaProactiveText(uid, getBotUid(), intent)) || fallbackGreeting(kind, uid);
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
  const flushKey = `xxb:dm:flush:${uid}`;
  // 一次 DM 会话只 flush 一次(冷却 2h)
  const cd = await redis.set(flushKey, '1', 'EX', 2 * 3600, 'NX');
  if (cd === null) return false;
  // peek(不标记)→ 发成功后才 markFlushed,避免生成/发送失败时攒话被吞(review #7)
  const lines = peekDmPending(uid, 2);
  if (lines.length === 0) {
    await redis.del(flushKey); // 没东西可 flush,不占冷却
    return false;
  }
  const nick = nicknameHint(uid);
  const aff = getAggregatedAffinity(uid);
  const body = lines.map((l) => (l.context ? `${l.intent}(缘起:${l.context})` : l.intent)).join('；');
  const intent = `[终于私聊上了] 你之前一直攒着想跟TA说的:${body}。现在TA私聊你了,自然地把这些说出来,像憋了好久终于逮着机会,别像念清单${nick}`;
  try {
    const { generatePersonaProactiveText } = await import('./turn/proactive-turn.js');
    const text = await generatePersonaProactiveText(uid, getBotUid(), intent);
    if (!text) {
      await redis.del(flushKey); // 没生成出来,放开冷却下次再试,攒话不丢
      return false;
    }
    await sender.sendDirect(uid, text);
    markDmPendingFlushed(lines.map((l) => l.id)); // 确实发出后才标记
    logger.info({ uid, lines: lines.length, affinity: Math.round(aff.affinity) }, 'Flushed pending DM lines');
    return true;
  } catch (err) {
    await redis.del(flushKey); // 发送失败(可能被 block):放开冷却,攒话保留
    logger.debug({ err, uid }, 'flushDmPendingOnInbound failed (likely blocked)');
    return false;
  }
}
