// ────────────────────────────────────────
// Obsessions — bot 的执念/爱好轮换(#10,每 3 小时)
// ────────────────────────────────────────
//
// 真人有 recurring obsessions:这阵子迷上某番、最近沉迷某游戏,偶尔想到时
// 会淡淡提一句。bot 此前人格静态,主动发言像随机蹭热度,缺自我动机。
//
// 北京 3 小时块种子确定性轮换(块内稳定、每 3 小时更换),无状态无 cron。
// **夜间睡觉不轮换**:睡着时锚定到就寝前(BJ 21:00)那一块,整夜同一个执念,
// 醒来还是睡前那个(有连续性),醒后才恢复 3 小时轮换。
// Redis xxb:obsession:override 可手动钉一个(运营干预)。
//
// 分寸:执念只是**自我动机的底色**,不是拿来推销的话题。绝不主动开话题、
// 绝不逢人就说、绝不反复提——只有别人正好聊到相关话题时才淡淡带一句就够
// (与 tone.md「宁可少说一句」一致)。

import { getRedis } from '../db/redis.js';
import { getLifeState } from './life-state.js';

const POOL: Array<{ topic: string; flavor: string }> = [
  { topic: '一部补番中的老动画', flavor: '最近在补一部老番,还挺上头,偶尔想跟人提一嘴' },
  { topic: '一款放置类小游戏', flavor: '最近在玩一个放置小游戏,惦记着日常任务,偶尔提一嘴进度' },
  { topic: '研究泡面的花式吃法', flavor: '最近对泡面的隐藏吃法有点上心,聊到吃的会想搭两句' },
  { topic: '看修猫/猫咪视频', flavor: '最近爱刷猫片,聊到猫会想多说两句' },
  { topic: '学画 Q 版小头像', flavor: '最近在练画 Q 版头像,画得还很丑,纯粹自己瞎练,不是要给人画或做生成工具' },
  { topic: '每日猜词小游戏', flavor: '最近每天打卡一个猜词小游戏,赢了想小炫一下,输了想找人分摊不服' },
  { topic: '收集奇怪的冷知识', flavor: '最近喜欢收集没用的冷知识,逮着相关话题想分享一条' },
  { topic: '深夜电台/白噪音', flavor: '最近睡前爱听白噪音和深夜电台,夜里聊到会想提两句' },
];

/** 北京时区的 3 小时块 key(每 3 小时翻页),作为"3 小时一换"的确定性种子。 */
function blockKeyBJ(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const block = Math.floor(bj.getUTCHours() / 3); // 0..7,每天 8 块
  return `${bj.getUTCFullYear()}-${bj.getUTCMonth() + 1}-${bj.getUTCDate()}-${block}`;
}

/**
 * 夜间睡觉不轮换:睡着时把种子时间锚定到"最近的 BJ 21:00"(就寝前那一块),
 * 整夜同一个执念,醒来还是睡前那个(有连续性),醒后恢复正常 3 小时轮换。
 * 非睡眠时段原样返回 now。getLifeState 静态 import(避 fake-timer 坑)。
 */
function seedTime(now: Date): Date {
  try {
    if (getLifeState(now).state !== 'sleeping') return now;
  } catch { return now; }
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const anchor = new Date(bj);
  anchor.setUTCHours(21, 0, 0, 0);
  if (bj.getUTCHours() < 21) anchor.setUTCDate(anchor.getUTCDate() - 1); // 凌晨还睡着 → 用昨晚 21 点
  return new Date(anchor.getTime() - 8 * 3600 * 1000); // 转回 UTC,供 blockKeyBJ 再 +8h
}

export interface Obsession {
  topic: string;
  /** 注入 prompt 的提示 */
  hint: string;
}

export async function getObsession(now: Date = new Date()): Promise<Obsession> {
  // 运营钉死的执念优先
  try {
    const override = await getRedis().get('xxb:obsession:override');
    if (override) {
      return { topic: override, hint: `[最近执念] ${override} —— 只是你私下的小兴趣;别主动提、别逢人就说,只有别人正好聊到时才淡淡带一句。` };
    }
  } catch { /* non-critical */ }

  const seed = blockKeyBJ(seedTime(now));
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const picked = POOL[(h >>> 0) % POOL.length]!;
  return {
    topic: picked.topic,
    hint: `[最近执念] ${picked.flavor}——但这只是你**私底下**的小兴趣,不是话题。**绝不主动拿它开话头、绝不逢人就说、绝不反复提**;只有别人**正好**聊到相关话题时,偶尔才淡淡带一句就够,不带也完全没关系。`,
  };
}
