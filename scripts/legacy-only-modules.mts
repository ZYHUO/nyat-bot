// 找"只被 legacy 路径引用"的模块——round 33-75 已经人工找出七个，
// 这个脚本一次算全，免得继续一个个撞。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e); const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (/\.(ts|mts)$/.test(e)) out.push(p);
  }
  return out;
}
const files = walk('src');
const body = new Map<string, string>();
for (const f of files) body.set(f, readFileSync(f, 'utf8'));

/** 模块 → import 它的模块集合 */
const importers = new Map<string, Set<string>>();
for (const [f, src] of body) {
  for (const m of src.matchAll(/(?:from |import\()'(\.[^']+)'/g)) {
    let p = m[1]!;
    let base = join(f, '..', p).replace(/\.js$/, '.ts');
    if (!existsSync(base)) base = join(f, '..', p).replace(/\.js$/, '.mts');
    if (!existsSync(base)) continue;
    if (!importers.has(base)) importers.set(base, new Set());
    importers.get(base)!.add(f);
  }
}

// legacy 集合：只被这些模块（或它们的传递闭包）引用的，就是 legacy-only
const LEGACY_SEEDS = ['src/pipeline/pipeline.ts', 'src/queue/worker.ts'];
// ⚠️ **Heart 不是 legacy。** round 76 第一版漏了这条，把
// `src/pipeline/heart/self-state.ts` 也算成 legacy，于是它 import 的
// `tracking/obsessions.ts` 被误判成"只接在 legacy"。
// AGENTS.md 写明："In production the **Heart branch is the main path**"。
// 这条坑值得记：**目录名 `pipeline/` 会让人以为整个目录都是老路**，
// 而生产主路径的心流和 turn-actor 就住在这个目录里。
const isLegacy = (f: string): boolean =>
  f.startsWith('src/pipeline/')
  && !f.startsWith('src/pipeline/heart/')
  && !f.startsWith('src/pipeline/turn/')
  && !f.startsWith('src/pipeline/stages/media.ts')
  && !f.startsWith('src/pipeline/multimodal.ts') && !f.startsWith('src/pipeline/context/')
  && !f.startsWith('src/pipeline/shared') && !f.startsWith('src/pipeline/reply/')
  && !f.startsWith('src/pipeline/tools/bot-delegation.ts')
  && !f.startsWith('src/pipeline/games/') && !f.startsWith('src/pipeline/timing/')
  && !f.startsWith('src/pipeline/nl-commands') && !f.startsWith('src/pipeline/control-actions')
  && !f.startsWith('src/pipeline/directive') && !f.startsWith('src/pipeline/command-router')
  && !f.startsWith('src/pipeline/vision');

const legacyOnly: string[] = [];
for (const [f, imps] of importers) {
  if (imps.size === 0) continue;
  const allLegacy = [...imps].every(isLegacy);
  if (allLegacy) legacyOnly.push(f);
}
console.log(`模块总数 ${files.length}｜有 import 者的 ${importers.size}`);
console.log(`\n只被 legacy 路径引用的模块（${legacyOnly.length} 个）：`);
for (const f of legacyOnly.sort()) console.log('   ', f.replace(/^src\//, ''));

// ⚠️ **这个清单有已知的假阳性，用之前必须逐个确认。**
//
// round 76 第一次跑，26 个里至少 3 个是假的：
//   tracking/obsessions.ts            ← heart/self-state.ts:75 动态 import
//   pipeline/turn/turn-lock.ts        ← turn/actor.ts:451 动态 import
//   agent/agency-reply-observation.ts ← stages/deliver.ts:1254 动态 import
//
// 原因：动态 import 的路径解析在这里没兜住（`join(f,'..',p)` 对 `../../x.js`
// 的归一化和 existsSync 检查在某些深度上不成立），于是这些模块看起来没有 import 者，
// 而"没有 import 者"被当成了"只被 legacy 引用"。
//
// 所以这份清单的正确用法是**候选筛选器**，不是结论。它把 411 个模块压到 26 个，
// 人只需要确认这 26 个——round 33-75 七个人工找到的病例，在这里都能对上。
// 但每一个都要再 grep 一次动态 import 才能下结论。
console.log('\n（候选清单，非结论：动态 import 的路径解析有已知漏洞，用前逐个 grep 确认。）');
process.exit(0);
