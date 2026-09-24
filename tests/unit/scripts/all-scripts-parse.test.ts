import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { transform } from 'esbuild';

/**
 * round 164: **每个 scripts/*.mts 都要能 parse**。
 *
 * Round 163 我用 python 往 session-report.mts 插一行，漏了 `if (rate < 0.15) {`，
 * esbuild 报 `Unexpected "}"`。**它是被 session-report 自己跑挂抓到的，不是被守卫。**
 *
 * 现有守卫都不管"脚本语法"：
 *   - `no-tamper-leftovers` 管 src//dist/ 的转义残留
 *   - `verify-deploy` 管 bundle 里的字符串
 *   - typecheck 的 tsconfig include **不含 scripts/**
 *
 * **判据用 esbuild.transform 而不是 import()**：第一版用 import()，
 * 结果 log-count.mts 退出码 2（它本来就会 process.exit(2) 打 usage），
 * 而 verify-deploy 之类会真去打 API。parse-only 才没有副作用。
 */

const scriptFiles = (): string[] =>
  execSync('ls scripts/*.mts', { encoding: 'utf8' }).split('\n').filter((l) => l.trim() !== '');

describe('所有 scripts/*.mts 都能 parse', () => {
  it('至少 30 个（少于这个说明 ls 失败或被误删）', () => {
    expect(scriptFiles().length).toBeGreaterThanOrEqual(30);
  });

  it('逐个 parse 不抛语法错', async () => {
    const bad: string[] = [];
    for (const f of scriptFiles()) {
      const code = await import('node:fs').then((fs) => fs.readFileSync(f, 'utf8'));
      try {
        await transform(code, { loader: 'ts', format: 'esm' });
      } catch (e) {
        const errs = (e as { errors?: Array<{ text: string; location?: { line: number } }> }).errors ?? [];
        bad.push(`${f}: ${errs.map((x) => `L${x.location?.line ?? '?'} ${x.text}`).join('; ')}`);
      }
    }
    expect(bad, '这些脚本 parse 不过：\\n  ' + bad.join('\\n  ')).toEqual([]);
  });
});
