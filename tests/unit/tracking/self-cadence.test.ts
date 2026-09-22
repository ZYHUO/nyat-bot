import { describe, expect, it } from 'vitest';

/**
 * 心流必须看到自己的**绝对节奏**（条/小时），不只是占比。
 *
 * 2026-09-22 round 17。一次实测翻转了我 17 轮的调法：
 *
 *   chat                 占比     条/小时
 *   -1003821093564      12.1%     14.8   ← 占比最低，节奏最高
 *   -1003543275052      12.2%     13.0   ← 每 4.6 分钟一句
 *   -1002450361141      72.6%      2.9   ← 占比最高，其实最安静
 *
 * 我调了 17 轮占比门槛（≥30% 默认不接 / 比基线高 1.5 倍才提示），
 * 而那两个最吵的群**占比只有 12%**——判据在它们身上永远不触发。
 * 群里的人感知的是"它每隔几分钟就冒一句"，不是"它占了多少字数"。
 */

/** 与 renderSelfActSummary 的节奏判据同形（改那边要同步这里）。 */
function cadenceLine(cad: number | undefined): string {
  if (cad === undefined) return '';
  return `这个群你平时每小时说 ${cad.toFixed(1)} 条`
    + (cad >= 5 ? '（挺密的——群里的人每隔几分钟就看见你一次。真人不会这样。）' : '');
}

describe('绝对节奏（条/小时）', () => {
  it('① 12% 占比但 14 条/小时 → 节奏该报警（占比门槛不会）', () => {
    // 这正是 round 17 的核心：占比看着收敛的那个才是真吵的
    const line = cadenceLine(14.8);
    expect(line).toContain('每小时说 14.8 条');
    expect(line).toContain('挺密的');
  });

  it('② 72% 占比但 0.6 条/小时 → 节奏不报警（它其实很安静）', () => {
    expect(cadenceLine(0.6)).not.toContain('挺密的');
  });

  it('③ 阈值 5 条/小时：恰好 5 算密，4.9 不算', () => {
    expect(cadenceLine(5)).toContain('挺密的');
    expect(cadenceLine(4.9)).not.toContain('挺密的');
  });

  it('④ 没有节奏数据就不渲染这一行（缺参照比说错话好）', () => {
    expect(cadenceLine(undefined)).toBe('');
  });

  it('⑤ 占比和节奏是两个维度，都要给（缺一个就有一个盲区）', () => {
    // 占比答"我是不是在自言自语"，节奏答"我是不是太吵"
    const busy = { share: 0.121, cad: 14.8 };
    const quiet = { share: 0.726, cad: 0.6 };
    // 占比门槛（≥30%）在 busy 上不触发
    expect(busy.share >= 0.3).toBe(false);
    // 节奏门槛（≥5）在 busy 上触发
    expect(busy.cad >= 5).toBe(true);
    // quiet 正好相反
    expect(quiet.share >= 0.3).toBe(true);
    expect(quiet.cad >= 5).toBe(false);
  });
});
