/**
 * Nyat Trench · 部署核验（Deploy Verification）
 *
 * 为什么需要它：2026-09-19 我发现用相对路径改 scripts/ 下的文件可以**报告成功但
 * 什么都没写**（shell 的 cwd 是 /root，不是仓库根）。而我这个会话里的失败，
 * 绝大多数都是"某一步报告成功但并未发生"——未接线的导出、静默 catch、陈旧日志、
 * 静默失败的读数器。代码和账本都能测，**"改动落在产物里"这件事没有守卫**。
 *
 * 所以这个脚本在 build 之后核验：这次会话新增的每一项机制都在 dist/index.js 里。
 * 匹配要同时处理三种形态，否则会误报（我一次核验里连错三次）：
 *   ① 单引号 —— esbuild 把 ' 规范成 "
 *   ② CJK   —— esbuild 把非 ASCII 转义成 \\uXXXX
 *   ③ 压缩后的变量改名（init_xxx / _exports 后缀）
 *
 * 用法：npx tsx scripts/verify-deploy.mts        （build 之后跑）
 */

import { readFileSync } from 'node:fs';

const BUNDLE = 'dist/index.js';

/** 一次匹配要试的四种形态：原样 / 双引号 / CJK 转义 / 两者兼有。 */
function variants(pattern: string): string[] {
  const dq = pattern.replace(/'/g, '"');
  // **必须大写 hex**：esbuild 发 \\u503C 而不是 \\u503c。第一版用小写，
  // 于是三项中文串全部误报缺失——而它们确实在产物里。
  const esc = (s: string): string =>
    [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('');
  return [pattern, dq, esc(pattern), esc(dq)];
}

const CHECKS: Array<[string, string]> = [
  // L0 海床
  ['L0 有界积分器渲染', 'renderTrench'],
  ['L0 时间泵', 'xxb:trench:lastpump:'],
  ['L0 睡眠积压', 'TRENCH_SLEEP_PULSE_ENABLED'],
  ['L0 定向债记账', 'oweFor'],
  ['L0 定向债渲染', '[欠话]'],
  ['L0 卡死自恢复', 'recoverIfStuck'],
  ['L0 发言抽气 85%', 'releasePressure'],
  // L1 沟壁
  ['L1 包络开关', 'TRENCH_ENVELOPE_MODE'],
  ['L1 包络拦截文案', '回得太密'],
  ['L1 发送前硬闸', 'BLOCKED by trench gate'],
  // L2 反射
  ['L2 Echo 回填', 'backfillEcho'],
  ['L2 回声渲染', '[回声]'],
  ['L2 放行入账 spoke', 'noteLiveOutcome'],
  ['L2 睡眠独立 asleep', 'asleep'],
  ['L2 绕过入账 intercepted', 'intercepted'],
  // Phase 1 与开关
  ['heart 三态路由', 'heartRoute'],
  ['heart 灰度名单', 'META_HEART_BYPASS_CHAT_IDS'],
  ['时限旁路', 'hasTimedBypass'],
  ['gate LLM 开关', 'TIMING_GATE_LLM_ENABLED'],
  // 仪器
  ['醒来检测', 'detectWakeTransition'],
  ['压力轨迹日志', 'trench pump tick'],
  ['cron 心跳', 'wake-detect ran'],
];

let bundle = '';
try {
  bundle = readFileSync(BUNDLE, 'utf8');
} catch {
  console.error(`✗ 读不到 ${BUNDLE} —— 先跑 npm run build`);
  process.exit(2);
}

const missing: string[] = [];
for (const [name, pattern] of CHECKS) {
  if (!variants(pattern).some((v) => bundle.includes(v))) missing.push(`${name} (${pattern})`);
}

console.log(`\n═══ 部署核验 · ${CHECKS.length} 项 ═══\n`);
for (const [name] of CHECKS) {
  const hit = !missing.some((m) => m.startsWith(`${name} (`));
  console.log(`  ${hit ? '✓' : '✗'} ${name}`);
}
if (missing.length === 0) {
  console.log(`\n✅ ${CHECKS.length}/${CHECKS.length} 项都在构建产物里。\n`);
  process.exit(0);
}
console.log(`\n❌ 缺失 ${missing.length} 项：`);
for (const m of missing) console.log(`   - ${m}`);
console.log('\n先确认是不是漏 build，再确认是不是编辑没落盘（相对路径！）。\n');
process.exit(1);
