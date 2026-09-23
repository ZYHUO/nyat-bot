/**
 * round 54\u2015>55\uff1a**\u540e\u53f0 tamper \u5ba1\u6838**\u2014\u2014\u628a round 49-53 \u5b66\u5230\u7684\u90a3\u4e09\u6765\u89c4\u5219\u56fa\u5316\u6210\u811a\u672c\u3002
 *
 * \u80cc\u666f\uff08round 53 \u7edf\u8ba1\uff09\uff1a\u5168\u5e93 34 \u4e2a\u65b0\u5b88\u536b\u91cc 20 \u4e2a\u771f\u7ea2\uff0c
 * "6 \u4e2a\u6ca1\u7ea2" \u5168\u662f tamper \u9009\u70b9\u9519\uff08\u6495\u6ce8\u91ca / \u5224\u636e\u5f62\u72b6\u4e0d\u5bf9\uff09\u3002
 * round 50 \u5f52\u6863\u4e86\u5047\u7eff\u4e09\u79cd\u5f62\u6001\uff1bround 51 \u7ed9\u51fa\u54e8\u5175/\u88c5\u9970\u5224\u636e\u3002
 *
 * \u8fd9\u4e2a\u811a\u672c\u505a\u4e00\u4ef6\u4e8b\uff1a\u5bf9\u7ed9\u5b9a\u7684\u6d4b\u8bd5\u6587\u4ef6\uff0c**\u6309 round 53 \u7684\u4e09\u6761\u89c4\u5219**\u9009 tamper \u70b9\uff0c
 * \u6539\u574f\u4e00\u6761\u672a\u6ce8\u91ca\u7684\u4ee3\u7801\u884c\uff0c\u8dd1\u6d4b\u8bd5\uff0c\u770b\u662f\u5426\u7ea2\u3002
 *
 * \u7528\u6cd5\uff1a
 *   npx tsx scripts/tamper-audit.mts tests/unit/foo.test.ts [more.test.ts ...]
 *   npx tsx scripts/tamper-audit.mts --changed     # \u53ea\u5ba1\u672c\u6b21\u672a\u63d0\u4ea4\u91cc\u65c0\u65b0\u589e/\u6539\u52a8\u7684\u6d4b\u8bd5
 *
 * \u8f93\u51fa\uff1a\u6bcf\u4e2a\u6d4b\u8bd5\u4e00\u884c RED/GREEN + tamper \u7684\u90a3\u4e00\u884c\uff08\u4fbf\u4e8e\u4eba\u5de5\u590d\u6838\uff09\u3002
 * \u5b89\u5168\uff1a\u6bcf\u6b21 tamper \u524d\u5907\u4efd\u5230 /tmp\uff0c\u8dd1\u5b8c\u539f\u683c\u8fd8\u539f\uff1b\u5373\u4f7f\u811a\u672c\u88ab\u6740\u4e5f\u4e0d\u4f1a\u7559\u4e0b\u7834\u574f\u3002
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface Result { test: string; verdict: 'RED' | 'GREEN' | 'SKIP'; line: string; detail: string }

const BACKUP = '/tmp/tamper-audit-backup';

/**
 * round 55\u5f0f\u7684 needle \u9009\u70b9\uff1a**\u6309\u6d4b\u8bd5\u81ea\u5df1\u7684 slice \u90bb\u57df**\u9009\uff0c\u4e0d\u518d\u9009"\u6700\u957f\u7684\u5b57\u7b26\u4e32"\u3002
 *
 * round 54 \u7684\u7248\u672c\u9009\u6700\u957f\u7684\uff0c\u7ed3\u679c 34 \u4e2a\u91cc 6 \u4e2a GREEN \u5168\u662f\u9009\u70b9\u9519\u8bef\uff1a
 * \u6539\u4e86\u540c\u540d\u5b57\u7b26\u4e32\u7684**\u53e6\u4e00\u5904**\uff08\u5982 `taskId: opts.taskId` \u5728 host-api \u91cc 12 \u5904\uff09\u3002
 *
 * \u7b56\u7565\uff1a
 *   1. \u4ece\u6d4b\u8bd5\u91cc\u627e\u5b9a\u4f4d\u65b9\u5f0f\uff1a`s.indexOf('X')` \u6216 `lines.findIndex(l => l.includes('X'))`
 *   2. \u5728\u6e90\u7801\u91cc\u5b9a\u4f4d\u90a3\u4e2a X\uff0c\u53d6\u5468\u56f4 900 \u5b57\u7b26\u5f53\u5019\u9009\u7a97\u53e3
 *   3. \u53ea\u5728\u7a97\u53e3\u91cc\u627e\u51fa\u73b0\u5728**\u672a\u6ce8\u91ca\u884c**\u7684 toContain \u5b57\u7b26\u4e32
 *   \u6ca1\u6709\u7a97\u53e3\u65f6\u9000\u5316\u6210\u5168\u6587\uff08\u90a3\u662f\u6ca1\u529e\u6cd5\u7684\u4e8b\uff0c\u8bb0 SKIP \u539f\u56e0\uff09\u3002
 */
function pickTarget(testFile: string): { src: string; needle: string; from: number; to: number } | null {
  const s = fs.readFileSync(testFile, 'utf8');
  const srcs = [...s.matchAll(/const SRC = '([^']+)'/g)].map((m) => m[1]!).filter((p) => fs.existsSync(p));
  if (srcs.length === 0) return null;
  const src = srcs[0]!;
  const lits = [...s.matchAll(/to(?:Not)?Contain\(\s*'([^']{6,})'/g)].map((m) => m[1]!);
  if (lits.length === 0) return { src, needle: '', from: 0, to: full.length };
  const full = fs.readFileSync(src, 'utf8');
  const code = full.split('\n').filter((l) => !l.trimStart().startsWith('//'));
  const anchors = [
    ...[...s.matchAll(/\.(?:indexOf|lastIndexOf)\(\s*'([^']{4,})'/g)].map((m) => m[1]!),
    // round 55: 原来的正则要求 `findIndex(` 和 `includes(` 在同一个 `[^)]*` 里，
    // 而 `findIndex((l) => l.includes("X"))` 中间有另一个 `)`，匹配不上。
    // 改成先找 findIndex 行、再在行内找 includes的参数。
    ...s.split('\n')
      .map((l) => {
        // `includes("'host sendText'")` 形状：双引号包单引号。
        // `[^'"]{4,}` 遇到内部单引号就断，所以改取行内所有引号字符串。
        const sq = [...l.matchAll(/'([^']{4,})'/g)].map((m) => m[1]!);
        const dq = [...l.matchAll(/"([^\"]{4,})"/g)].map((m) => m[1]!);
        return [...sq, ...dq];
      })
      .flat()
  ].filter((a) => code.some((l) => l.includes(a)));
  const windows: Array<[number, number]> = [];
  for (const a of anchors) {
    const i = full.indexOf(a);
    if (i > 0) windows.push([i, i + 900]);
  }
  const inWindow = (lit: string): boolean => {
    if (windows.length === 0) return true;
    return windows.some(([lo, hi]) => {
      const w = full.slice(lo, hi);
      return w.includes(lit) && !w.split('\n').every((l) => l.trimStart().startsWith('//'));
    });
  };
  const scored = lits.map((lit) => {
    const line = code.find((l) => l.includes(lit));
    return { lit, line, win: inWindow(lit), pos: line ? full.indexOf(lit) : -1 };
  }).filter((x) => x.line !== undefined && x.pos > 0);
  const best = scored.find((x) => x.win) ?? scored[0];
  if (!best) return { src, needle: '', from: 0, to: full.length };
  // round 55: **返回窗口边界**，让 runOne 只在窗口里找要改的那一处。
  // 不然选对了字符串也没用：`taskId: opts.taskId` 在 host-api 里 12 处，
  // 窗口内的那处是日志点，窗口外的是别处——改后者测试仍然绿。
  const win = windows.find(([lo, hi]) => full.slice(lo, hi).includes(best.lit));
  return {
    src, needle: best.lit,
    from: win ? win[0] : 0,
    to: win ? win[1] : full.length,
  };
}

function runOne(testFile: string): Result {
  const t = pickTarget(testFile);
  if (!t || !t.needle) {
    return { test: testFile, verdict: 'SKIP', line: '', detail: 'no code-line target found' };
  }
  const backup = BACKUP + ':' + t.src.replace(/[^\w]/g, '_');
  fs.copyFileSync(t.src, backup);
  try {
    // round 53 rule 1: only non-comment lines
    // round 55 rule 2: only inside the test's own slice window
    const lines = fs.readFileSync(t.src, 'utf8').split('\n');
    let idx = -1;
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineStart = acc;
      acc += line.length + 1;
      if (lineStart < t.from || lineStart >= t.to) continue;
      if (line.trimStart().startsWith('//')) continue;
      if (line.includes(t.needle)) { idx = i; break; }
    }
    if (idx < 0) return { test: testFile, verdict: 'SKIP', line: '', detail: 'needle only in comments' };
    const original = lines[idx]!;
    lines[idx] = original.replace(t.needle, 'ZZ_TAMPERED');
    fs.writeFileSync(t.src, lines.join('\n'));
    let red = 0;
    try {
      const out = execSync(`npx vitest run ${testFile}`, { encoding: 'utf8', stdio: 'pipe', timeout: 200_000 });
      red = /\u00d7|FAIL/.test(out) ? 1 : 0;
    } catch (e) {
      // vitest exits non-zero on failure — that IS red
      const out = String((e as { stdout?: string }).stdout ?? '');
      red = /\u00d7|FAIL|failed/.test(out) ? 1 : 0;
      if (red === 0) red = 2;  // crashed — also not green
    }
    return {
      test: testFile,
      verdict: red > 0 ? 'RED' : 'GREEN',
      line: original.trim().slice(0, 70),
      detail: `tampered ${t.needle.slice(0, 30)} in ${t.src}`,
    };
  } finally {
    fs.copyFileSync(backup, t.src);
    fs.unlinkSync(backup);
  }
}

const args = process.argv.slice(2);
let files: string[] = [];
if (args[0] === '--changed') {
  const out = execSync('git status --porcelain', { encoding: 'utf8' });
  files = out.split('\n').map((l) => l.slice(3).trim())
    .filter((p) => p.endsWith('.test.ts') && fs.existsSync(p));
} else {
  files = args.filter((f) => f.endsWith('.test.ts') && fs.existsSync(f));
}

if (files.length === 0) {
  console.log('nothing to audit (pass test files, or --changed)');
  process.exit(0);
}

const rows: Result[] = files.map(runOne);
const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
console.log('\n=== tamper audit ===\n');
for (const r of rows) {
  console.log(`  ${pad(r.test.replace('tests/', ''), 62)} ${r.verdict}${r.line ? '  <- ' + r.line : ''}`);
}
const red = rows.filter((r) => r.verdict === 'RED').length;
const green = rows.filter((r) => r.verdict === 'GREEN').length;
const skip = rows.filter((r) => r.verdict === 'SKIP').length;
console.log(`\n  RED ${red}  GREEN ${green}  SKIP ${skip}   (GREEN here means: the test passed with its own target broken — suspect)\n`);
