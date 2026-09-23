/**
 * round 54\uff1a**\u80cc\u666f tamper \u5ba1\u6838**\u2014\u2014\u628a round 49-53 \u5b66\u5230\u7684\u90a3\u4e09\u6765\u6761\u56fa\u5316\u6210\u811a\u672c\u3002
 *
 * \u80cc\u666f\uff08round 53 \u7edf\u8ba1\uff09\uff1a
 *   \u00b7 \u5168\u5e93 34 \u4e2a\u65b0\u5b88\u536b\u91cc 20 \u4e2a\u771f\u7ea2\uff0c3 \u4e2a"\u6ca1\u7ea2"\u5168\u662f tamper \u9009\u70b9\u9519\uff08\u6495\u6ce8\u91ca/\u5224\u636e\u5f62\u72b6\u4e0d\u5bf9\uff09
 *   \u00b7 round 50 \u5f52\u6863\u4e86\u5047\u7eff\u4e09\u79cd\u5f62\u6001\uff1bround 51 \u7ed9\u51fa\u54e8\u5175/\u88c5\u9970\u5224\u636e
 *
 * \u8fd9\u4e2a\u811a\u672c\u505a\u4e00\u4ef6\u4e8b\uff1a\u5bf9\u7ed9\u5b9a\u7684\u6d4b\u8bd5\u6587\u4ef6\uff0c**\u6309 round 53 \u7684\u4e09\u6761\u89c4\u5219**\u9009 tamper \u70b9\uff0c
 * \u6539\u574f\u4e00\u6761\u672a\u6ce8\u91ca\u7684\u4ee3\u7801\u884c\uff0c\u8dd1\u6d4b\u8bd5\uff0c\u770b\u662f\u5426\u7ea2\u3002
 *
 * \u7528\u6cd5\uff1a
 *   npx tsx scripts/tamper-audit.mts tests/unit/foo.test.ts [more.test.ts ...]
 *   npx tsx scripts/tamper-audit.mts --changed     # \u53ea\u5ba1\u672c\u6b21\u672a\u63d0\u4ea4\u91cc\u65b0\u589e/\u6539\u52a8\u7684\u6d4b\u8bd5
 *
 * \u8f93\u51fa\uff1a\u6bcf\u4e2a\u6d4b\u8bd5\u4e00\u884c RED/GREEN + tamper \u7684\u90a3\u4e00\u884c\uff08\u4fbf\u4e8e\u4eba\u5de5\u590d\u6838\uff09\u3002
 * \u5b89\u5168\uff1a\u6bcf\u6b21 tamper \u524d\u5907\u4efd\u5230 /tmp\uff0c\u8dd1\u5b8c\u539f\u683c\u8fd8\u539f\uff1b\u5373\u4f7f\u811a\u672c\u88ab\u6740\u4e5f\u4e0d\u4f1a\u7559\u4e0b\u7834\u574f\u3002
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface Result { test: string; verdict: 'RED' | 'GREEN' | 'SKIP'; line: string; detail: string }

const BACKUP = '/tmp/tamper-audit-backup';

/** \u4ece\u6d4b\u8bd5\u6587\u4ef6\u91cc\u627e\u5b83\u65ad\u8a00\u7684\u300c\u672c\u5730\u6a21\u5f0f\u300d\uff1aSRC \u6587\u4ef6\u91cc\u7684\u4e00\u4e2a\u5177\u4f53\u5b57\u7b26\u4e32\u3002 */
function pickTarget(testFile: string): { src: string; needle: string } | null {
  const s = fs.readFileSync(testFile, 'utf8');
  const srcs = [...s.matchAll(/const SRC = '([^']+)'/g)].map((m) => m[1]!).filter((p) => fs.existsSync(p));
  if (srcs.length === 0) return null;
  const src = srcs[0]!;
  // \u5728\u6d4b\u8bd5\u91cc\u627e toContain\uff08'\u2026'\uff09 / not.toContain\uff08'\u2026'\uff09\uff0c\u9009\u6700\u957f\u7684\u90a3\u4e2a
  const lits = [...s.matchAll(/to(?:Not)?Contain\(\s*'([^']{6,})'/g)].map((m) => m[1]!);
  const code = fs.readFileSync(src, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//'));
  // \u4f18\u5148\u9009\u4e00\u4e2a**\u51fa\u73b0\u5728\u672a\u6ce8\u91ca\u4ee3\u7801\u884c\u91cc**\u7684\u5b57\u7b26\u4e32\uff08round 53 \u89c4\u5219 1\uff09
  const hit = lits.map((lit) => ({ lit, line: code.find((l) => l.includes(lit)) }))
    .find((x) => x.line !== undefined);
  if (hit) return { src, needle: hit.lit };
  return { src, needle: '' };
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
    const lines = fs.readFileSync(t.src, 'utf8').split('\n');
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trimStart().startsWith('//')) continue;
      if (lines[i]!.includes(t.needle)) { idx = i; break; }
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
      // vitest exits non-zero on failure \u2014 that IS red
      const out = String((e as { stdout?: string }).stdout ?? '');
      red = /\u00d7|FAIL|failed/.test(out) ? 1 : 0;
      if (red === 0) red = 2;  // crashed \u2014 also not green
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
console.log(`\n  RED ${red}  GREEN ${green}  SKIP ${skip}   (GREEN here means: the test passed with its own target broken \u2014 suspect)\n`);
