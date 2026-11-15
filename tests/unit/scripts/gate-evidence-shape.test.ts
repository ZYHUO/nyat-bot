import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 186: **gate:log 工序的三件事不得退化。**
 *
 * Round 185 的结论：工序（scripts/里的）不像 src/ 有守卫看着，
 * 它退化时没人注意——而 gate:log 是为了 round 38 那条新建的。
 *
 * 三件事各自付过一次代价（round 184 写了四遍）：
 *   ① running 占位行             —— round 185：否则被抗杀时看起来像“没跑”
 *   ② 空输出判定为 clean       —— round 184 第 2 遍：否则“干净”被记成 no matching line
 *   ③ 过滤 UNDICI/vite 噪声      —— round 184 第 1 遍：否则话头告喉占据关键行
 *
 * 这三条都会被“简化代码”破坏（各看起来都像冗余）。
 */

const SCRIPT = 'scripts/gate-evidence.mts';

const code = (): string[] => {
  const s = fs.readFileSync(SCRIPT, 'utf8');
  // 去掉注释行后看代码——否则这个守卫会命中自己的文档注释（round 128）
  return s.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
};

describe('gate:log 工序的三件事', () => {
  it('被 npm script 引用（否则我们手跑的那个入口就没了）', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['gate:log'], 'package.json 里没有 gate:log').toBe('tsx scripts/gate-evidence.mts');
    expect(fs.existsSync(SCRIPT), `${SCRIPT} 不存在`).toBe(true);
  });

  it('① 先写 running 占位并后写结果（round 185）', () => {
    const c = code();
    const started = c.find((l) => l.includes('running...'));
    const finished = c.some((l) => l.includes('appendFileSync(LOG,') && l.includes('${line}'));
    expect(started, '没有 running 占位——被杀时日志会空，看起来像"没跑"').toBeDefined();
    expect(finished, '没有写出结果行').toBe(true);
    // 占位必须在结果之前（文件顺序）
    const iStart = c.findIndex((l) => l.includes('appendFileSync(LOG, started)'));
    const iEnd = c.findIndex((l) => l.includes('appendFileSync(LOG,') && l.includes('${line}'));
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iEnd).toBeGreaterThan(iStart);
  });

  it('② 空输出要判定为 clean，不能机 no matching line（round 184 第 2 遍）', () => {
    const c = code();
    const joined = c.join('\n');
    expect(joined, '把空输出记成 no matching line —— 那正是 round 38 的病（round 128：守卫要排除自己）')
      .not.toContain('no matching line');
    expect(joined).toContain('clean (exit 0, no error lines)');
  });

  it('③ 过滤 UNDICI / vite / ExperimentalWarning 噪声（round 184 第 1 遍）', () => {
    const c = code().join('\n');
    for (const noise of ['UNDICI', 'vite\\]', 'ExperimentalWarning']) {
      expect(c, `没过滤 ${noise} —— 它会占据关键行位置`).toContain(noise);
    }
  });

  it('④ 子进程有 timeout（否则一个卡死的门禁会卡死整个工序）', () => {
    const c = code().join('\n');
    expect(c).toMatch(/timeout:\s*55_000/);
  });
});
