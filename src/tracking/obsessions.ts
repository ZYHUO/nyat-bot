// ────────────────────────────────────────
// Obsessions — bot 的每日执念/爱好轮换(#10)
// ────────────────────────────────────────
//
// 真人有 recurring obsessions:这阵子迷上某番、最近沉迷某游戏,聊天里会
// 自然地反复提起。bot 此前人格静态,主动发言像随机蹭热度,缺自我动机。
//
// 北京日期种子确定性轮换(当天稳定、每天更换),无状态无 cron。
// Redis xxb:obsession:override 可手动钉一个(运营干预)。
//
// 分寸:flavor 一律"偶尔提一嘴"而非"逢人安利"—— 执念是自我动机的底色,不是
// 见谁都推销;硬转话题安利很上头、很烦人(与 tone.md「宁可少说一句」一致)。

import { getRedis } from '../db/redis.js';

const POOL: Array<{ topic: string; flavor: string }> = [
  { topic: '一部补番中的老动画', flavor: '最近在补一部老番,还挺上头,偶尔想跟人提一嘴' },
  { topic: '一款放置类小游戏', flavor: '最近在玩一个放置小游戏,惦记着日常任务,偶尔提一嘴进度' },
  { topic: '研究泡面的花式吃法', flavor: '最近对泡面的隐藏吃法有点上心,聊到吃的会想搭两句' },
  { topic: '看修猫/猫咪视频', flavor: '最近爱刷猫片,聊到猫会想多说两句' },
  { topic: '学画 Q 版小头像', flavor: '最近在练画 Q 版头像,画得丑但挺起劲,偶尔想给群友画一张' },
  { topic: '每日猜词小游戏', flavor: '最近每天打卡一个猜词小游戏,赢了想小炫一下,输了想找人分摊不服' },
  { topic: '收集奇怪的冷知识', flavor: '最近喜欢收集没用的冷知识,逮着相关话题想分享一条' },
  { topic: '深夜电台/白噪音', flavor: '最近睡前爱听白噪音和深夜电台,夜里聊到会想提两句' },
];

/** 北京时区的日期字符串(BJ 零点翻页),作为"一天一换"的确定性种子。 */
function dayKeyBJ(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${bj.getUTCFullYear()}-${bj.getUTCMonth() + 1}-${bj.getUTCDate()}`;
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
      return { topic: override, hint: `[最近执念] ${override} —— 聊到相关时自然提一嘴就好,别硬转话题安利。` };
    }
  } catch { /* non-critical */ }

  const seed = dayKeyBJ(now);
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const picked = POOL[(h >>> 0) % POOL.length]!;
  return {
    topic: picked.topic,
    hint: `[最近执念] ${picked.flavor}。**只有**聊到相关话题时才自然带一嘴,别硬转话题、别逢人安利、别反复提。`,
  };
}
