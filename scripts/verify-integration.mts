/**
 * 合龙验证（integration smoke）—— 测**组合**，不是单测。
 *
 * 为什么单独有它：2026-09-20 这次会话里，几乎全部静默失败都是"各自单测绿、
 * 组合失效"——
 *   · owedTo 里两个未定义引用（clamp / hashKey），单测验得过，组合恒返 0
 *   · 内容指纹按第一个冒号切，count 对而 repeat 恒 0
 *   · echo 惩罚不看量级，反广告变成反安静
 *   · Meta 主路径从不调用 bot 分类器（分类器在主路径上从未运行）
 * 414 个单测文件全绿，从来不意味着这几件事可用。
 *
 * 用法：npx tsx scripts/verify-integration.mts
 * 退出码 0 = 合龙通过。每次改 nyatos/ 或 subagent/host-api.ts 后跑一遍。
 */

const out: string[] = [];
const ok = (name: string, cond: boolean): void => { out.push(`${cond ? '✓' : '✗'} ${name}`); };

// 1) StepFun 全网搜索（主路由）——走生产代码路径，不打 mock
{
  const { executeSearch } = await import('../src/pipeline/tools/search.js');
  const r = await executeSearch('TypeScript 5 新特性');
  ok('stepfun 搜索返回带来源的结果', r.includes('源:') && r.length > 200);
}

// 2) 反广告：授权 → 测量 → 呈现 → 关授权后零成本
{
  const { setAntiAd, antiAdEnabled, noteInbound, readAdSignals, renderAdPressure }
    = await import('../src/nyatos/ad-pressure.js');
  // **每次跑用唯一的 chat**：第一版用固定 -1007770001，而上一次探针刚写过同一个
  // 键——5 分钟窗口里旧条目还在，count 就不是 8，于是这个检查恒定失败（而 adP 其实
  // 是对的，下一个检查能过就是证据）。这是"测试污染"类，本会话已经踩过一次。
  const C = -1 * Math.floor(Date.now() / 1000) - 1000000000;
  const U = 999888777;
  await setAntiAd(C, true, 30);
  ok('群主授权可开可查', await antiAdEnabled(C));
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 8; i++) await noteInbound(C, U, `刷屏${i}`, now);
  const s = await readAdSignals(C, U, now);
  ok('刷屏行为推高 adP', s.adP > 0 && s.count === 8);
  const line = await renderAdPressure(C, [{ uid: U, name: '测试号' }]);
  ok('Frame 呈现事实且含"你定"（非裁决）', line.includes('[噪声]') && line.includes('你定'));
  await setAntiAd(C, false);
  ok('关授权后零呈现', (await renderAdPressure(C, [{ uid: U }])) === '');
}

// 3) 身体信号注册表 + 三个信号的自注册
{
  await import('../src/nyatos/trench.js');
  await import('../src/nyatos/debt.js');
  await import('../src/nyatos/ad-pressure.js');
  const { listBodySignals, collectBodyFacts } = await import('../src/nyatos/body-signal.js');
  const ids = listBodySignals().map((s) => s.id);
  ok('trench/debt/adPressure 三个信号已自注册',
    ['trench', 'debt', 'adPressure'].every((i) => ids.includes(i)));
  ok('未授权群 collectBodyFacts 不炸', Array.isArray(await collectBodyFacts(-1007770001)));
}

// 4) 踢人门（admin 面是闭包，测不了行为，改测闸门齐全 + 与反广告共用授权）
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/subagent/host-api.ts', 'utf8');
  ok('kick 与反广告共用一把授权钥匙', src.includes('antiAdEnabled(chatId)'));
  ok('kick 四道闸齐全',
    ['admin_kick_disabled', 'admin_no_master', 'admin_no_self', 'can_restrict_members']
      .every((k) => src.includes(k)));
}

console.log(`\n═══ 合龙验证 · ${out.length} 项 ═══\n`);
for (const l of out) console.log(`  ${l}`);
const bad = out.filter((l) => l.startsWith('✗')).length;
console.log(bad === 0 ? `\n✅ ${out.length}/${out.length} 合龙通过\n` : `\n❌ ${bad} 项失败\n`);
process.exit(bad === 0 ? 0 : 1);
