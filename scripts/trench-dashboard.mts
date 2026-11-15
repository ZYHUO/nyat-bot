/**
 * Nyat Trench · 判定面板（一个入口跑完所有对照仪器）
 *
 * 为什么需要：Phase 1 灰度实验的判据分散在四个脚本里（金丝雀 / 判定点对等度 /
 * 醒来行为 / 包络回测）。醒来之后、或者往灰名单放了群之后，需要一次看完——
 * 分四次跑会漏，而漏掉的那一项往往正是异常所在。
 *
 * 用法：
 *   npx tsx scripts/trench-dashboard.mts          # 全部
 *   npx tsx scripts/trench-dashboard.mts canary   # 只跑金丝雀
 *   npx tsx scripts/trench-dashboard.mts equiv wakeup
 */

import { execSync } from 'node:child_process';

const ALL = ['canary', 'equiv', 'wakeup', 'envelope'];
const want = process.argv.slice(2).filter((a) => ALL.includes(a));
const run = want.length > 0 ? want : ALL;

const SCRIPTS: Record<string, { path: string; label: string; args?: string[] }> = {
  canary: { path: 'scripts/trench-canary.mts', label: '行为金丝雀（安全面/活性/决策面/真人感/分群对照/Phase 2）' },
  equiv: { path: 'scripts/decision-equivalence.mts', label: '判定点对等度（Phase 2 准入线）' },
  wakeup: { path: 'scripts/wakeup-check.mts', label: '醒来行为判定（定向债是活人还是痉挛）' },
  // **固定带 --project 3.9**：不回测投影的话，面板只会显示"现状拦 0.1%"，
  // 而那个数回答的是"碍不碍事"——正是我修正过三次的"分母选错"。
  // 这个包络的职责是接住判定点扶正后的放大，所以投影口径才是判读依据。
  // 位置参数必须在 --project 之前：回测脚本按 argv[2..5] 取 天数/上限/窗口，
  // 只传 --project 会把 argv[2] 顶成 '--project' → Number() = NaN → SQL 报 no such column。
  envelope: { path: 'scripts/envelope-backtest.mts', label: '包络回测（现状 + 投影两个分母）', args: ['3', '150', '100', '3600', '--project', '3.9'] },
};

console.log(`\n═══ Nyat Trench 判定面板 · ${run.join(' + ')} ═══\n`);

for (const key of run) {
  const { path, label, args = [] } = SCRIPTS[key]!;
  console.log(`\n──── ${key}：${label} ────\n`);
  try {
    execSync(`npx tsx ${path} ${args.join(' ')}`, { stdio: 'inherit', timeout: 240_000 });
  } catch (err) {
    // 这些脚本自己会在数据不足时 exit 0 并说明；非零退出才是真问题。
    const code = (err as { status?: number }).status;
    if (code !== 0 && code !== undefined) {
      console.log(`  ⚠️ ${key} 以退出码 ${code} 结束（见上方输出）`);
    }
  }
}

console.log('\n──── 面板结束 ────');
console.log('判据速查（论文 §九·补三，跑之前就已写死）：');
console.log('  · 发送率 26% → 60%+ = 判定点真的接了权');
console.log('  · 包络拦截 > 0 且持续 = 上限太紧，调参而不是回滚');
console.log('  · 该群关系分/投诉下降 = 行为退化，回滚');
console.log('  · 其余群曲线不动 = 灰度生效');
console.log('  · 醒来桶零锚点率 ≥ 白天主动桶 3 倍 = 痉挛；三桶差异 < 1.5 倍 = 活人\n');
