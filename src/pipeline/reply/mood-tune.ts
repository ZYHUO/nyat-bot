// ────────────────────────────────────────
// Mood-Tune — 情绪/精力 → Humanizer 参数调制 (Opus 评审 #1)
//
// Opus 建议:随机性不该是 IID——心情差的时候回复更短、更少贴纸、
// 更容易敷衍;心情好的时候更活泼。让 humanizer 参数成为
// life-state energy + chat mood 的慢变量函数,而不是静态配置。
//
// 纯函数,无 IO;输入 mood/energy,输出对 HumanizerConfig 的覆盖。
// 合并顺序(deliver.ts):群风格 < mood-tune < 运营 override < ASI self-tune。
// ────────────────────────────────────────

import type { HumanizerConfig } from "./humanizer.js";

/** 心情价 (-1..1): 正=好心情, 负=坏心情。0 = 中性。 */
export interface MoodTuneInput {
  /** life-state energy 0..1 (疲惫/精力) */
  energy: number;
  /** 群 mood valence -1..1 (正=热闹友好, 负=冷淡/被怼) */
  valence: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 把 energy + valence 映射为 HumanizerConfig 的部分覆盖。
 * 输出值都是绝对覆盖(非增量),因此必须从 DEFAULT 派生再调。
 * fail-soft:任何输入越界都钳制,不抛错。
 */
export function moodTuneHumanizer(input: MoodTuneInput): Partial<HumanizerConfig> {
  const energy = clamp(Number.isFinite(input.energy) ? input.energy : 0.8, 0, 1);
  const valence = clamp(Number.isFinite(input.valence) ? input.valence : 0, -1, 1);

  const tune: Partial<HumanizerConfig> = {};

  // ── 精力维度:累 → 打字更马虎、反应更慢、更爱用 emoji 敷衍 ──
  if (energy < 0.4) {
    tune.typoRate = 0.25;        // 懒得打对
    tune.readDelayBase = 4.0;    // 反应迟钝
    tune.emojiReplyRate = 0.35;  // 更爱用 emoji 打发
    tune.emojiReplyMaxLength = 12;
    tune.ackPrefixRate = 0.1;    // 没劲多打前缀
    tune.jitterFactor = 0.5;     // 打字节奏飘
  } else if (energy < 0.65) {
    tune.typoRate = 0.15;
    tune.readDelayBase = 2.5;
    tune.emojiReplyRate = 0.2;
    tune.ackPrefixRate = 0.15;
  } else if (energy > 0.85) {
    tune.typoRate = 0.08;        // 精神好,打错少
    tune.readDelayBase = 1.2;    // 反应快
    tune.ackPrefixRate = 0.3;    // 愿意多说
    tune.jitterFactor = 0.35;    // 打字利落
  }

  // ── 心情维度:被怼/冷淡 → 更短、更敷衍、反应更慢 ──
  if (valence < -0.25) {
    tune.emojiReplyRate = Math.max(tune.emojiReplyRate ?? 0.15, 0.4); // 敷衍优先
    tune.emojiReplyMaxLength = 10;
    tune.readDelayBase = Math.max(tune.readDelayBase ?? 2.0, 3.5);    // 爱答不理
    tune.typoRate = Math.max(tune.typoRate ?? 0.1, 0.2);              // 不耐烦
    tune.ackPrefixRate = Math.min(tune.ackPrefixRate ?? 0.2, 0.05);   // 懒得客套
  } else if (valence > 0.3) {
    tune.ackPrefixRate = Math.max(tune.ackPrefixRate ?? 0.2, 0.35);   // 热情
    tune.jitterFactor = Math.max(tune.jitterFactor ?? 0.4, 0.55);     // 活泼蹦跳
    tune.typoRate = Math.min(tune.typoRate ?? 0.1, 0.06);             // 开心打得认真
    tune.deleteResendRate = 0.1;                                      // 话多嘴快撤回也多
  }

  return tune;
}
