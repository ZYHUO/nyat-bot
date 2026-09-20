// ────────────────────────────────────────
// 反广告 · 行为气压（Ad Pressure）
// ────────────────────────────────────────
//
// 为什么不是规则引擎
// ────────────────────
// 仓库里已经有一个 bot-classifier.ts，靠确定性正则判 ad/verify/echo
// （VERIFY_RE / AD_PROMO_RE / AD_OFFER_RE）。对它做过语料分析（近 24h 3000 条
// bot_interactions + 近 7 天 25501 条入站）之后，结论是它在该抓的东西上近乎无效：
//
//   经典人类广告信号   手机号 0 · 加密货币 0 · 色情 0 · QQ群号 0
//   真实噪声来源       其他 bot：TikTok/抖音解析错误、网络测试进度条、游戏 bot
//
// 也就是说"广告"在这个生态里主要不是**内容特征**问题，是**行为特征**问题。
// 再加关键词正则只会提高误伤、抓不到真目标。
//
// 架构立场（Nyat Trench §三）
// ────────────────────────────────
// 宿主只负责"你的嗓子现在什么状态"，模型负责"想说什么、说不说"。
// 反广告同理：**宿主只测量"谁在以机器的方式刷屏"，模型决定忽略/删/禁言/上报群主。**
// 所以这里输出的是有界标量 + 事实清单，不是 verdict。
//
// 四个信号，全部行为化，无一内容关键词
// ─────────────────────────────────────
//   burst   单位时间发自同一发送者的条数（滑动窗口）
//   echo    有没有人接他的话（回复/提及率）—— 刷屏的典型特征是零互动
//   repeat  内容近重复（归一化哈希，不是关键词）
//   spread  同内容跨群散发（一个真人在一个群说话；广告号在多个群说同一句）
//
// 群主开关
// ─────────
// 反广告是重活（删消息/禁言），必须群主明确要。用 Redis 的 per-chat 键，
// 由 bot 的管理工具或主人指令设置，可带 TTL。没有这个键时本模块零开销。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

/** 反广告总闸：没有群主授权就不测量、不呈现。 */
const ENABLE_KEY = (chatId: number): string => `xxb:trench:antiad:${chatId}`;

/** 单发送者的行为样本窗口（秒）。 */
const WINDOW_SEC = 300;
/** 窗口内超过这个条数才开始计 burst（低于它视为正常话多）。 */
const BURST_ONSET = 4;
/** burst 记分上限。 */
const BURST_MAX = 4;
/** echo 低于这个比例视为"没人接"。 */
const ECHO_FLOOR = 0.15;
/** repeat/spread 各贡献的上限。 */
const SIGNAL_MAX = 2;
/** adP 的上界（与 P 同思路：有界、可钳制）。 */
export const AD_P_MAX = 8;

export interface AdSignals {
  /** 窗口内发自该发送者的条数。 */
  count: number;
  /** 窗口内被别人回复/提及的次数。 */
  engaged: number;
  /** 互动率 engaged/count。 */
  echoRate: number;
  /** 与本人近期消息的近重复条数。 */
  repeats: number;
  /** 同内容在多少个别的群出现过。 */
  spread: number;
  /** 合成的有界标量 [0, AD_P_MAX]。 */
  adP: number;
}

let _seq = 0;
/** 单调序号：保证 zset member 逐条唯一（同秒同内容不去重）。 */
function seq(): number {
  _seq = (_seq + 1) % 1_000_000;
  return _seq;
}

const EMPTY: AdSignals = {
  count: 0, engaged: 0, echoRate: 1, repeats: 0, spread: 0, adP: 0,
};

/** 内容指纹：归一化后取稳定哈希。近重复检测用，不存原文。 */
function fingerprint(text: string): string {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120);
  if (!norm) return '';
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 群主是否授权了反广告。没有授权 → 本模块整体不工作。 */
export async function antiAdEnabled(chatId: number): Promise<boolean> {
  try {
    const r = getRedis();
    return (await r.get(ENABLE_KEY(chatId))) !== null;
  } catch {
    return false; // 读失败按未开启处理——宁可不动，不误伤
  }
}

/** 群主开启/关闭反广告。minutes 省略 = 长期。 */
export async function setAntiAd(chatId: number, on: boolean, minutes?: number): Promise<void> {
  const r = getRedis();
  const k = ENABLE_KEY(chatId);
  if (!on) {
    await r.del(k);
    return;
  }
  const ttl = minutes ? Math.max(60, Math.round(minutes * 60)) : undefined;
  if (ttl) await r.set(k, String(Math.floor(Date.now() / 1000)), 'EX', ttl);
  else await r.set(k, String(Math.floor(Date.now() / 1000)));
}

/**
 * 记录一条入站（只在该群已授权时才有意义；未授权时调用方不该调）。
 * 只存行为计数与内容指纹，不存原文。
 */
export async function noteInbound(
  chatId: number,
  uid: number,
  text: string,
  at: number,
): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0) return;
  const r = getRedis();
  const w = `${chatId}:${uid}`;
  const fp = fingerprint(text);
  const pipe = r.multi();
  // member 必须**逐条唯一**：`${at}:${fp}` 会让同一秒发同一内容的多条塌缩成一条
  // （zset 按 member 去重），burst 和 repeat 于是全部少算。加一个单调序号。
  pipe.zadd(`xxb:trench:antiad:win:${w}`, String(at), `${at}:${fp || '-'}:${seq()}`);
  pipe.zremrangebyscore(`xxb:trench:antiad:win:${w}`, '-inf', `(${at - WINDOW_SEC}`);
  pipe.expire(`xxb:trench:antiad:win:${w}`, WINDOW_SEC * 4);
  // 跨群索引：同指纹出现在哪些群（spread 的判据）
  if (fp) {
    pipe.sadd(`xxb:trench:antiad:fp:${fp}`, String(chatId));
    pipe.expire(`xxb:trench:antiad:fp:${fp}`, 6 * 3600);
  }
  await pipe.exec();
}

/** 记录一次"有人接了他的话"（回复/提及都算）。 */
export async function noteEngaged(chatId: number, uid: number, at: number): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0) return;
  const r = getRedis();
  const w = `${chatId}:${uid}`;
  const pipe = r.multi();
  // 同上：member 用 `String(at)` 会让同一秒的多次互动塌缩成一条，互动率被低估。
  pipe.zadd(`xxb:trench:antiad:eng:${w}`, String(at), `${at}:${seq()}`);
  pipe.zremrangebyscore(`xxb:trench:antiad:eng:${w}`, '-inf', `(${at - WINDOW_SEC}`);
  pipe.expire(`xxb:trench:antiad:eng:${w}`, WINDOW_SEC * 4);
  await pipe.exec();
}

/** 读出该发送者当前的行为信号与合成标量。 */
export async function readAdSignals(
  chatId: number,
  uid: number,
  now = Math.floor(Date.now() / 1000),
): Promise<AdSignals> {
  if (!Number.isSafeInteger(uid) || uid <= 0) return EMPTY;
  try {
    const r = getRedis();
    const w = `${chatId}:${uid}`;
    const winKey = `xxb:trench:antiad:win:${w}`;
    const engKey = `xxb:trench:antiad:eng:${w}`;

    const [winRaw, engRaw] = await Promise.all([
      r.zrangebyscore(winKey, now - WINDOW_SEC, now),
      r.zrangebyscore(engKey, now - WINDOW_SEC, now),
    ]);
    const count = winRaw.length;
    const engaged = engRaw.length;
    if (count === 0) return { ...EMPTY, engaged };

    // repeat：窗口内同一指纹出现 ≥2 次
    const seen = new Map<string, number>();
    for (const m of winRaw) {
      // member 形如 `${at}:${fp}:${seq}`，指纹是**第二段**。
      // 第一版按第一个冒号切，切出来是 `${fp}:${seq}`——每条都唯一，
      // 于是 repeat 永远是 0（而 count 是对的，属于"一半对一半错"的那种静默失败）。
      const parts = m.split(':');
      const fp = parts[1];
      if (!fp || fp === '-') continue;
      seen.set(fp, (seen.get(fp) ?? 0) + 1);
    }
    const repeats = [...seen.values()].filter((n) => n >= 2).reduce((s, n) => s + (n - 1), 0);

    // spread：同一指纹在别的群也出现过
    let spread = 0;
    for (const [fp, n] of seen) {
      if (n < 2) continue;
      // ioredis 的 smembers 返回 string[]（不是 Set），用 .length
      const chats = await r.smembers(`xxb:trench:antiad:fp:${fp}`);
      if (chats.length > 1) spread += 1;
    }

    const echoRate = count > 0 ? engaged / count : 1;

    // 合成：burst 是主项，echo/repeat/spread 是加权项，各自有界。
    const burst = count <= BURST_ONSET ? 0 : Math.min(BURST_MAX, count - BURST_ONSET + 1);
    // **echo 惩罚必须有量级门槛**：第一版不看 count 就罚"没人接"，
    // 结果任何只发一条、恰好没人回的人（群里绝大多数的正常发言）adP 直接 1.5，
    // 反广告变成反安静。只有已经形成刷屏量级时，零互动才是佐证而不是罪证。
    const echoPenalty = count >= BURST_ONSET && echoRate < ECHO_FLOOR ? 1.5 : 0;
    const repeatPenalty = Math.min(SIGNAL_MAX, repeats);
    const spreadPenalty = Math.min(SIGNAL_MAX, spread);
    const raw = burst + echoPenalty + repeatPenalty + spreadPenalty;
    const adP = Math.max(0, Math.min(AD_P_MAX, raw));

    return { count, engaged, echoRate, repeats, spread, adP };
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'readAdSignals failed (non-critical)');
    return EMPTY;
  }
}

/**
 * Frame 呈现：**只给事实，不给裁决**。
 * 例：「[噪声] 8560347478 在刷屏：5 条/5分钟，0 人接，4 条重复」
 * 删不删、禁不禁言，模型自己定；群主没开反广告时这里什么都不返回。
 */
export async function renderAdPressure(
  chatId: number,
  candidates: Array<{ uid: number; name?: string }>,
): Promise<string> {
  if (!(await antiAdEnabled(chatId))) return '';
  const lines: string[] = [];
  for (const c of candidates.slice(0, 3)) {
    const s = await readAdSignals(chatId, c.uid);
    if (s.adP < 1) continue;
    const who = c.name ? `${c.name}（${c.uid}）` : String(c.uid);
    const bits = [
      `${s.count} 条/5分钟`,
      `${s.engaged} 人接`,
      s.repeats > 0 ? `${s.repeats} 条重复` : '',
      s.spread > 0 ? `跨 ${s.spread} 个群同内容` : '',
    ].filter(Boolean);
    lines.push(`[噪声] ${who} 在刷屏：${bits.join('，')}。管不管、怎么管，你定。`);
  }
  return lines.join('\n');
}
