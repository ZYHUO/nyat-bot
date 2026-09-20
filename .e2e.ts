// 端到端冒烟：四项新功能一起跑，验证组合（各自的单测都绿，错的是组合）
const out: string[] = [];
const ok = (n: string, c: boolean) => out.push(`${c ? '✓' : '✗'} ${n}`);

// 1) stepfun 搜索（主路由）
{
  const { executeSearch } = await import('./src/pipeline/tools/search.js');
  const r = await executeSearch('TypeScript 5 新特性');
  ok('stepfun 搜索返回带来源的结果', r.includes('源:') && r.length > 200);
}
// 2) 反广告行为测量 + 群主授权
{
  const { setAntiAd, antiAdEnabled, noteInbound, readAdSignals, renderAdPressure } = await import('./src/nyatos/ad-pressure.js');
  const C = -1007770001;
  await setAntiAd(C, true, 30);
  ok('群主授权可开可查', await antiAdEnabled(C));
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 8; i++) await noteInbound(C, 999888777, `刷屏${i}`, now);
  const s = await readAdSignals(C, 999888777, now);
  ok('刷屏行为推高 adP', s.adP > 0 && s.count === 8);
  const line = await renderAdPressure(C, [{ uid: 999888777, name: '测试号' }]);
  ok('Frame 呈现事实且含"你定"', line.includes('[噪声]') && line.includes('你定'));
  await setAntiAd(C, false);
  ok('关授权后零呈现', (await renderAdPressure(C, [{ uid: 999888777 }])) === '');
}
// 3) 身体信号注册表（含自注册的三个）
{
  await import('./src/nyatos/trench.js');
  await import('./src/nyatos/debt.js');
  await import('./src/nyatos/ad-pressure.js');
  const { listBodySignals, collectBodyFacts } = await import('./src/nyatos/body-signal.js');
  const ids = listBodySignals().map((s) => s.id);
  ok('三个信号已自注册', ['trench', 'debt', 'adPressure'].every((i) => ids.includes(i)));
  const facts = await collectBodyFacts(-1007770001);
  ok('未授权群 collectBodyFacts 不炸且可空', Array.isArray(facts));
}
// 4) 踢人授权与反广告共用钥匙（源码级断言，因 admin 面是闭包）
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/subagent/host-api.ts', 'utf8');
  ok('kick 门含 antiAdEnabled 共用授权', src.includes('antiAdEnabled(chatId)'));
  ok('kick 四道闸齐全', ['admin_kick_disabled', 'admin_no_master', 'admin_no_self', "can_restrict_members"].every((k) => src.includes(k)));
}
console.log('E2E\n' + out.join('\n'));
process.exit(out.some((l) => l.startsWith('✗')) ? 1 : 0);
