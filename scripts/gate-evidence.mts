/**
 * round 184: **门禁证据**——把"我实际看到的那几行"落成文件。
 *
 * Round 38 立的规矩：「if a command times out or produces no readable output,
 * write "unverified" — do not carry forward.」**那条纯靠自觉**（round 176 归类：
 * action 类，没有守卫）。
 *
 * Round 176 的结论是：action 类要么做成工序、要么承认它会复发。
 * 这条做成工序——因为它的复发代价高（round 38 我报了一个从未观测的 101/107），
 * 而做成工序的成本只是一次 npm script。
 *
 * 做什么：跑 typecheck + lint + 指定的测试子集，把**每条的实际输出行**
 * 追加到 logs/gate-evidence.log。**只记真的跑出来、真的读到的行**；
 * 超时/退出码非零就记 `unverified` 并带上退出码，不记数字。
 *
 * 为什么不跑全量 test：全量 ~200s，超过 harness 60s 上限会被 SIGKILL，
 * 而 SIGKILL 下拿不到任何输出（round 38 就是这么丢掉数字的）。
 * 所以这个脚本只跑**能在时限内完成**的：typecheck / lint / 指定测试文件。
 * 全量由 round 170 那样单独起后台跑，跑完把结果行贴回来。
 *
 * 用法：npm run gate:evidence -- tests/unit/docs
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

const LOG = 'logs/gate-evidence.log';
const stamp = (): string => {
  const d = new Date();
  const cst = new Date(d.getTime() + 8 * 3600_000);
  return cst.toISOString().slice(0, 16).replace('T', ' ');
};

const run = (label: string, cmd: string): void => {
  let line: string;
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 55_000 });
    // 只留关键行：Tests / Test Files / 0 problems / (空)
    const key = out.split('\n').filter((l) => !/UNDICI|trace-warnings|vite\]/.test(l))
      .filter((l) => /Test Files|Tests\s+\d|problems|error|warning/.test(l)).slice(0, 3);
    // round 184: tsc/eslint 成功时空输出。“(no matching line)” 认不出“过”还是“未知”
    // ——而 round 38 就是这样把“没读到”当成“过”。所以空输出要区分：
    //   退出码 0 + 无输出 → "clean (no output, exit 0)"  ——这才是过
    //   退出码 0 + 有关键行 → 那些行
    // round 184 第二弹：tsc 和 eslint 成功时的“输出”只有 npm 的
    // `> nyat-bot@1.0.0 lint` / `> eslint src/` 回显——没有错误行。
    // 所以“没有关键行”对它们而言就是 clean，clean 要这样记：
    // round 184 第三弹：UNDICI 告喉在 stderr，execSync 默认只接 stdout，
    // 但这里看到它出现在 out 里——说明那些行混进了。
    // 所以判“能否算 clean”时要先把它们扣掉。
    const signal = out.split('\n')
      .filter((l) => !/UNDICI|trace-warnings|vite\]|ExperimentalWarning/.test(l))
      .filter((l) => l.trim() !== '' && !/^\s*>/.test(l))
      .join('\n').trim();
    line = key.length > 0
      ? key.join(' | ').replace(/\s+/g, ' ').trim()
      : (signal === '' ? 'clean (exit 0, no error lines)' : `no key line; first 60: ${signal.slice(0, 60)}`);
  } catch (e) {
    const err = e as { status?: number; stdout?: string; message?: string };
    const out = String(err.stdout ?? '');
    const key = out.split('\n').filter((l) => !/UNDICI|trace-warnings/.test(l))
      .filter((l) => /Test Files|Tests\s+\d|problems|×/.test(l)).slice(0, 3);
    line = `exit=${err.status ?? '?'} ${key.join(' | ').replace(/\s+/g, ' ').trim() || err.message?.slice(0, 80) || 'no output'}`;
  }
  // round 66 立的：别依赖本次进程正常退出。
  // round 184 第五弹：如果 gate:log 自己被抗杀（它的子进程要 55s），
  // 那三行就一行都不会出现——而“少三行”看起来就像“没跑”。
  // 所以先写占位、后填结果：被杀了也能看到"这一页开始了但没完成"。
  const started = `${stamp()}  ${label.padEnd(28)} running...\n`;
  fs.appendFileSync(LOG, started);
  console.log(`${label.padEnd(28)} running...`);
  const before = fs.readFileSync(LOG, 'utf8').length;
  fs.appendFileSync(LOG, `${stamp()}  ${label.padEnd(28)} ${line}\n`);
  // 用“覆盖占位行”的方式不可行（append 只能往后），所以记两行：
  //   running...  ← 开始时间戳
  //   <result>    ← 结束时间戳 + 结果
  // 读的人看到 running 后面没结果，就知道这一页未完成（而不是没跑）。
  void before;
  console.log(`${label.padEnd(28)} ${line}`);
};

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));

run('typecheck', 'npx tsc --noEmit 2>&1');
run('lint', 'npm run lint 2>&1');
if (targets.length > 0) {
  run('tests', `npx vitest run ${targets.join(' ')} 2>&1`);
} else {
  run('tests', 'echo "(no test files given — nothing run)"');
}
console.log(`\nappended to ${LOG}`);
