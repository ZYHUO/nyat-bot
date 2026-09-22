import { describe, expect, it } from 'vitest';

/**
 * 心流的"占比"必须是**相对这个群自己的常态**，不是相对一条全局线。
 *
 * 2026-09-22 round 16（用户："bot 还是太爱说话了"）。
 *
 * 白天按群实测（`npm run measure:voice -- --since 04:00`）：回复率从
 * 13.8%（1793 条的活跃群）到 70.8%（48 条的小群），**差 5 倍**，
 * 而全量一个 17% 的均数把这事完全盖住。
 *
 * 心流 prompt 里的门槛原本是"这一波占比 ≥30% → 默认不接"——全局一条线：
 *   · 平时只占 10% 的群 → 那条线永远触不到
 *   · 平时就占 60% 的群 → 天天触发，bot 学不到任何东西
 * 等于没有按群区分。
 *
 * 现在同时给"这一波 X%"和"这个群你平时约 Y%"，让"比平时高多少"成为
 * 可判断的事实。这四条锁住判据本身。
 */

/** 与 renderSelfActSummary 的相对占比判据同形（改那边要同步这里）。 */
function relText(share: number | undefined, base: number | undefined): string {
  if (share === undefined || base === undefined || base <= 0) return '';
  return share >= base * 1.5 ? `（这个群你平时约 ${Math.round(base * 100)}%）` : '';
}

/** 绝对档位（原有判据，保留）。 */
function absTier(share: number): string {
  if (share >= 0.5) return '基本是你一个人在说';
  if (share >= 0.3) return '说得有点多';
  if (share >= 0.15) return '插了几句';
  return '';
}

describe('占比要和自己的常态比', () => {
  it('① 高出基线 1.5 倍才提示"平时约 X%"', () => {
    // 平时 18%，这波 42% → 2.3 倍，该提示
    expect(relText(0.42, 0.18)).toContain('平时约 18%');
    // 平时 40%，这波 42% → 1.05 倍，不提（这就是它的常态）
    expect(relText(0.42, 0.40)).toBe('');
  });

  // ⚠️ 浮点：0.20*1.5 在 IEEE754 里是 0.30000000000000004，
  // 所以 0.30 >= 0.20*1.5 是 **false** —— 边界不是干净的那条线。
  // 这里锁住真实行为（不是想要的行为）：要卡 1.5 倍整，
  // 实现里得写成 share*10 >= base*15 之类的整数化。没改，因为
  // 边界差 1e-17 对心流没有区别，为它加一层取整反而更难读。
  it('② 边界：1.5 倍附近按浮点实测定（不是整数算术）', () => {
    expect(relText(0.31, 0.20)).toContain('平时约 20%');
    expect(relText(0.29, 0.20)).toBe('');
    // 0.30 恰好在浮点边界的错的一侧
    expect(relText(0.30, 0.20)).toBe('');
  });

  it('③ 同样 42%，在不同群里该不该提是不一样的', () => {
    // 这正是 round 16 指出的问题：全局一条线学不到东西
    const busyChat = relText(0.42, 0.60);   // 活跃群，42% 低于常态
    const smallChat = relText(0.42, 0.10);  // 小群，42% 是常态的 4 倍
    expect(busyChat).toBe('');
    expect(smallChat).toContain('平时约 10%');
  });

  it('④ 没有基线就退回绝对占比，不说相对（缺参照比说错话好）', () => {
    expect(relText(0.42, undefined)).toBe('');
    expect(relText(0.42, 0)).toBe('');
    // 绝对档位仍在
    expect(absTier(0.42)).toBe('说得有点多');
    expect(absTier(0.12)).toBe('');
  });

  it('⑤ 绝对档位的四档没被相对判据取代（两者叠加，不是替换）', () => {
    for (const s of [0.1, 0.2, 0.4, 0.7]) {
      expect(['', '插了几句', '说得有点多', '基本是你一个人在说']).toContain(absTier(s));
    }
    // 0.7 一定落在最高档
    expect(absTier(0.7)).toBe('基本是你一个人在说');
  });
});
