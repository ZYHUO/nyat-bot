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

/**
 * round 66：**启动时清理上次被杀则的留残**。
 *
 * 事故：round 66 发现 `incrCounter('ZZ_BROKEN_ZZ', ...)` 在生产里待了 15 轮——
 * 因为本脚本的 `try/finally` 还原在 **SIGKILL 下不执行**（harness 的 60s 超时）。
 *
 * 所以上面那个事故的根因不是"忘记还原"，而是"**还原依赖进程正常退出**"。
 * 修法：把还原改成**下次启动时做**——那不受这一次怎么死影响。
 */
function recoverLeftovers(): string[] {
  const restored: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/tmp').filter((f) => f.startsWith('tamper-audit-backup'));
  } catch {
    return restored;
  }
  for (const f of entries) {
    const bak = `/tmp/${f}`;
    try {
      const content = fs.readFileSync(bak, 'utf8');
      // 备份文件的名字编码了原路径：tamper-audit-backup:_src_xxx_ts
      const m = f.replace(/^tamper-audit-backup:/, '').replace(/_/g, '/');
      // 上面的 replace 会把 . 也当分隔符，所以改用反向构造：从 CHECKS 里的原路径反推太芝。
      // 简单起见：备份的同时把真路径写进内容第一行注释。
      const firstLine = content.split('\n')[0] ?? '';
      const pm = firstLine.match(/tamper-audit-original: (\S+)/);
      if (!pm) continue;
      const orig = pm[1]!;
      const body = content.split('\n').slice(1).join('\n');
      fs.writeFileSync(orig, body);
      fs.unlinkSync(bak);
      restored.push(orig);
    } catch {
      /* 单个备份失败不阻止其余 */
    }
  }
  return restored;
}

const leftovers = recoverLeftovers();
if (leftovers.length > 0) {
  console.log(`\n⚠️  还原了 ${leftovers.length} 个上次被杀则留下的 tamper：${leftovers.map((f) => '\n    ' + f).join('')}\n`);
}

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
  const full = fs.readFileSync(src, 'utf8');
  // round 58: SRC 是文档/脚本（.md/.sh/.py）时，needle 就是测试断言的那个字符串本躈。
  // round 56/57 那个 GREEN 就是这类：脚本选了正文里一段，而断言的另有其字符串。
  const isDoc = /\.(md|sh|py|json)$/.test(src);
  // round 58 round 2: isDoc 时要选**断言它在的那个 it 块里的字符串**，
  // 不是全文第一个匹配的。否则 no-duplicate-current-numbers 会选中
  // 正文里的 `gate:evidence`（那个 it 根本没断言它）。
  let docLit = '';
  if (isDoc) {
    // 拆成 it 块，找有 toContain 的那个，取它里的字符串
    const blocks = s.split(/\n  it\(/).slice(1);
    for (const b of blocks) {
      const has = b.match(/to(?:Not)?Contain\(\s*'([^']{6,})'/);
      if (has && full.includes(has[1]!)) { docLit = has[1]!; break; }
    }
  }
  const lits = docLit ? [docLit] : [...s.matchAll(/to(?:Not)?Contain\(\s*'([^']{6,})'/g)].map((m) => m[1]!)
    .filter((lit) => (isDoc ? full.includes(lit) : true));
  const code = full.split('\n').filter((l) => !l.trimStart().startsWith('//'));
  // round 59: **findIndex 类的锚点要向后开窗口**。
  // 测试往往是 `lines.findIndex(...)` 拿到一个行号，再
  // `for (i = logIdx - 1; i >= 0; i--)` 往上找。所以断言的区域在
  // anchor 的**前面**，不是后面。
  // 现象：send-log-has-taskid 的 anchor `'host sendText'` 在 L1227（msg 行），
  // 而要改的 taskId 在 L1224（它上面 3 行）——向后开 900 字符的窗口覆盖不到。
  interface Anchor { text: string; backward: boolean }
  const anchorList: Anchor[] = [
    ...[...s.matchAll(/\.(?:indexOf|lastIndexOf)\(\s*'([^']{4,})'/g)].map((m) => ({ text: m[1]!, backward: false })),
    ...s.split('\n')
      .filter((l) => l.includes('findIndex('))
      .flatMap((l) => {
        const sq = [...l.matchAll(/'([^']{4,})'/g)].map((m) => m[1]!);
        const dq = [...l.matchAll(/"([^\"]{4,})"/g)].map((m) => m[1]!);
        return [...sq, ...dq].map((t) => ({ text: t, backward: true }));
      }),
  ].filter((a) => code.some((l) => l.includes(a.text)));
  const windows: Array<[number, number]> = [];
  for (const a of anchorList) {
    const i = full.indexOf(a.text);
    if (i <= 0) continue;
    // 向后开窗口（indexOf 形状）还是先向后看再往前（findIndex 形状）
    windows.push(a.backward ? [Math.max(0, i - 1200), i + 200] : [i, i + 900]);
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
    // round 56: SKIP 分两类，否则每次都要人重新判断这 15 个 SKIP 里哪些该管。
    //   behavioural   — the test imports and CALLS the real module, so its tamper
    //                   guarantee comes from the module itself being exercised.
    //   script/string — the test runs a script and compares strings; this tool
    //                   cannot help, a human must decide (round 50's constant-true
    //                   assertion was in exactly this class).
    const src0 = fs.readFileSync(testFile, 'utf8');
    const kind = /await import\(|from '[^']*src\//.test(src0)
      ? 'behavioural (calls real module — SKIP is correct)'
      : /execSync\(/.test(src0)
        ? 'script/string compare — needs human audit'
        : 'no code-line target';
    return { test: testFile, verdict: 'SKIP', line: '', detail: kind };
  }
  const backup = BACKUP + ':' + t.src.replace(/[^\w]/g, '_');
  // round 66: 备份的第一行写真路径，让下次启动的 recoverLeftovers 能还原。
  // 只靠文件名编码不行：`_` 和 `.` 都会出现在路径里，不可逆。
  fs.writeFileSync(backup, `// tamper-audit-original: ${t.src}\n` + fs.readFileSync(t.src, 'utf8'));
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
    if (idx < 0) {
      // round 57: 第三类 SKIP —— 测试故意断言**注释**（验证"道理写下来了"）。
      // 这不是缺陷：`cooldown-armed-log` 的 ③ 断言 `check-then-launch`
      // 在注释里，而那就是它要查的东西（round 66 容许这种：
      // "写下为什么，否则下一个人当冗余删掉"）。
      return { test: testFile, verdict: 'SKIP', line: '', detail: 'asserts on comments (rationale check)' };
    }
    const original = lines[idx]!;
    const isDoc = /\.(md|sh|py|json)$/.test(t.src);
    if (isDoc) {
      // round 58: 文档里同一个声明往往出现多处（gate:evidence 出现 3 次）。
      // 只改第一处断言依然绿——这就是 round 55 那个同形多处缺陷的文档版。
      // 对文档，声明被所有处同时反诉才算被验证。
      let n = 0;
      for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.split(t.needle).join('ZZ_TAMPERED'), n += lines[i]!.split('ZZ_TAMPERED').length - 1;
      void n;
    } else {
      lines[idx] = original.replace(t.needle, 'ZZ_TAMPERED');
    }
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
    // round 180: 不能用 copyFileSync——备份的第一行是
    // `// tamper-audit-original: <path>`（round 66 加的，为了让下次
    // 启动的 recoverLeftovers 能识别）。copy 回去会把那行注释
    // **一并留在源文件里**，lint 不报、typecheck 不报（它在文件头），
    // 所以每跑一次就多一行——round 180 这轮就这样白白多了一行。
    // recoverLeftovers 用的是 writeFileSync(slice(1))，那才对。
    const restored = fs.readFileSync(backup, 'utf8').split('\n').slice(1).join('\n');
    fs.writeFileSync(t.src, restored);
    fs.unlinkSync(backup);
  }
}

const args = process.argv.slice(2);
let files: string[] = [];

// round 180: **--src <file>** —— 反向入口。
//
// Round 178 我以为它选点错了（要 tumper src 而它收 test），round 179 读 pickTarget
// 发现它 tumper 的正是 SRC 指向的 src/——**方向是对的，缺的是入口**：
// 我手上有的是"我刚改的 src/X.ts"，而它要的是"tests/.../X.test.ts"。
// 中间那步（哪个测试覆盖它）得我脑子记。
//
// 这一步补上：grep 出所有指向该 src 的测试（两种引用形状都要认）：
//   const SRC = 'src/...'         （形状守卫型测试，43 个）
//   vi.mock('../../src/...')     （行为测试型，无 SRC 常量）
// 两种都要——round 167 那个行为测试就是后一种，而它恰是最需要 tumper 的。
if (args[0] === '--src') {
  const target = args[1]!;
  if (!fs.existsSync(target)) { console.error(`no such file: ${target}`); process.exit(2); }
  // 取得模块路径（去掉 .ts），那是测试通过 .js 寻址它的方式
  const mod = target.replace(/\.ts$/, '');
  const hits = execSync(
    `grep -rl "'[^']*${mod.replace(/^src\//, '')}" tests/ --include='*.test.ts' || true`,
    { encoding: 'utf8' }).split('\n').filter((l) => l.trim() !== '');
  files = [...new Set(hits)].filter((f) => fs.existsSync(f) && f.endsWith('.test.ts'));
  console.log(`=== --src ${target}: ${files.length} test(s) reference it ===`);
  if (files.length === 0) {
    console.log('  (none — this src has no test that names it; nothing to audit)');
    process.exit(0);
  }
  for (const f of files) console.log(`  ${f}`);
  console.log('');
} else if (args[0] === '--changed') {
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
  if (r.verdict === 'SKIP' || r.verdict === 'GREEN') console.log(`      (${r.detail})`);
}
const red = rows.filter((r) => r.verdict === 'RED').length;
const green = rows.filter((r) => r.verdict === 'GREEN').length;
const skip = rows.filter((r) => r.verdict === 'SKIP').length;
console.log(`\n  RED ${red}  GREEN ${green}  SKIP ${skip}   (GREEN here means: the test passed with its own target broken — suspect)\n`);
