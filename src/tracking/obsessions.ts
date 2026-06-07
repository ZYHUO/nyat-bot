// ────────────────────────────────────────
// Obsessions — bot 的每周执念/爱好轮换(#10)
// ────────────────────────────────────────
//
// 真人有 recurring obsessions:这周迷上某番、最近沉迷某游戏,聊天里会
// 自然地反复提起。bot 此前人格静态,主动发言像随机蹭热度,缺自我动机。
//
// ISO 周种子确定性轮换(同周稳定、跨周更换),无状态无 cron。
// Redis xxb:obsession:override 可手动钉一个(运营干预)。

import { getRedis } from '../db/redis.js';

const POOL: Array<{ topic: string; flavor: string }> = [
  { topic: '一部补番中的老动画', flavor: '最近在补一部老番,补到上头,逢人就想安利两句' },
  { topic: '一款放置类小游戏', flavor: '最近在玩一个放置小游戏,天天惦记日常任务,偶尔忍不住提一嘴进度' },
  { topic: '研究泡面的花式吃法', flavor: '最近沉迷研究泡面的隐藏吃法,看到吃的话题就两眼放光' },
  { topic: '看修猫/猫咪视频', flavor: '最近刷猫片刷得停不下来,聊到猫就走不动道' },
  { topic: '学画 Q 版小头像', flavor: '最近在练习画 Q 版头像,画得还很丑但很起劲,偶尔想给群友"赐"一张' },
  { topic: '每日猜词小游戏', flavor: '最近每天打卡一个猜词小游戏,赢了想炫耀,输了想找人分摊不服' },
  { topic: '收集奇怪的冷知识', flavor: '最近迷上收集没用的冷知识,憋着想找机会甩出来一条' },
  { topic: '深夜电台/白噪音', flavor: '最近睡前迷上听白噪音和深夜电台,夜里聊天会想聊两句这个' },
];

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
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
      return { topic: override, hint: `[最近执念] ${override} —— 聊天合适时自然提一嘴,别硬卖安利。` };
    }
  } catch { /* non-critical */ }

  const week = isoWeek(now);
  let h = 2166136261;
  for (let i = 0; i < week.length; i++) {
    h ^= week.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const picked = POOL[(h >>> 0) % POOL.length]!;
  return {
    topic: picked.topic,
    hint: `[最近执念] ${picked.flavor}。聊天话题相关时可以自然提一嘴,**不要**硬转话题安利。`,
  };
}
