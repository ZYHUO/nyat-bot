// ────────────────────────────────────────
// Latency Model — 重尾人类延迟分布 + 作息调速(#1)
// ────────────────────────────────────────
//
// 旧延迟 = 线性字符计费 ± 20% 均匀抖动 → "均匀地快",凌晨和下午一个速度。
// 真人延迟是**重尾**的:大多数 1-3 秒,偶尔"刚在刷别的"15-40 秒;
// 且随作息波动(深夜慢、吃饭慢、犯懒慢)。
//
// sampleHumanDelay(base):
//   88% 快档:base × lognormal(σ≈0.35)(0.5×–2× 附近)
//   12% 慢档:base × 3–10×(走神/刷手机)
//   × life-state speedFactor(sleeping 2.4 / eating 1.6 / lazy 1.3 / 深夜 1.4)
//   夹在 [floor, cap] 内。
// direct 交互的"立即开火"路径不经过这里 —— @bot 仍然快。

import { getLifeState } from '../../tracking/life-state.js';

export interface DelayOptions {
  /** 慢档(走神)概率,默认 0.12 */
  tailProb?: number;
  /** 上限秒,默认 20 */
  capSec?: number;
  /** 下限秒,默认 0.3 */
  floorSec?: number;
  /** 是否乘 life-state 调速(默认 true) */
  circadian?: boolean;
  /** 注入随机源(测试用) */
  rng?: () => number;
}

/** 近似标准正态(3 个均匀和,够用) */
function approxNormal(rng: () => number): number {
  return (rng() + rng() + rng() - 1.5) * 1.46;
}

export function sampleHumanDelay(baseSec: number, opts: DelayOptions = {}): number {
  const rng = opts.rng ?? Math.random;
  const tailProb = opts.tailProb ?? 0.12;
  const cap = opts.capSec ?? 20;
  const floor = opts.floorSec ?? 0.3;

  let delay: number;
  if (rng() < tailProb) {
    // 慢档:走神 / 在看别的群 / 刷手机
    delay = baseSec * (3 + rng() * 7);
  } else {
    // 快档:lognormal 形状(中位 ≈ base,偶尔略快/略慢)
    delay = baseSec * Math.exp(0.35 * approxNormal(rng));
  }

  if (opts.circadian !== false) {
    delay *= getLifeState().speedFactor;
  }

  return Math.min(cap, Math.max(floor, delay));
}
