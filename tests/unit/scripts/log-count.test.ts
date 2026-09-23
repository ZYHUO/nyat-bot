import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * round 74: **从日志 grep 出的数必须带口径**。
 *
 * Round 73 “审我自己的输入”的续篇。它处理了 /metrics（平铺的计数器），
 * 但 logs/app.log 才是重灾区——我每轮都在那里 grep 出一个数当事实用。
 *
 * 那个数四种可能：真值 / 进程内 / 睡期不触发 / 字段就不对。
 * 包装强制输出三句＊1件事堆到一起。
 *
 * 这里验两件事：口径三句在（否则就回退成敬 grep）；
 * 以及它不自作主张判断"可以上结论否"（那需要模式语义，这里没有）。
 */

const run = (args: string): string =>
  execSync(`npx tsx scripts/log-count.mts ${args}`, { encoding: 'utf8', stdio: 'pipe' });

describe('log-count 强制带口径', () => {
  it('① 三句口径都在（重启 / 睡期不触发 / 子串无语义）', () => {
    const out = run("'rejected semantic repeat' 3");
    expect(out).toContain('重启');
    expect(out).toContain('睡期');
    expect(out).toContain('子串匹配');
  });

  it('② 报出窗口内的重启次数（进程内状态的清零依据）', () => {
    const out = run("'rejected semantic repeat' 3");
    expect(out).toContain('窗口内重启');
  });

  it('③ 按天分布打出来（单日突增看不出来）', () => {
    const out = run("'rejected semantic repeat' 3");
    expect(out).toContain('按天:');
  });

  it('④ 首末命中时间也打（round 130 的教训：时间戳有时比数字重要）', () => {
    const out = run("'rejected semantic repeat' 3");
    expect(out).toContain('首末命中');
  });

  it('⑤ 0 命中时也照出口径（不能因为没数据就闭嘴）', () => {
    const out = run("'zzz-no-such-line-zzz' 3");
    expect(out).toContain('0 次');
    expect(out).toContain('睡期');
  });

  it('⑥ 没有参数时报 usage 并以 2 退出（不是静默 0）', () => {
    let code = 0;
    try { execSync('npx tsx scripts/log-count.mts', { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { code = (e as { status?: number }).status ?? 1; }
    expect(code).toBe(2);
  });

  it('⑦ npm script 指向真实文件（round 62 的同类守卫）', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    // round 74 实测：这个仓库的 vitest 配置下 `pkg['log:count']` 稳定读出
    // undefined，而 `(pkg.scripts as ...)['log:count']` 正常——疑似 tsx 的
    // ESM/CJS 互操作对含冒号 key 的下标访问做了转换。不深究（非本仓代码），
    // 绕开即可；记在这里免得下个人再查半小时。
    const cmd = (pkg.scripts as unknown as Record<string, string>)['log:count'];
    expect(cmd).toBeDefined();
    expect(cmd).toContain('scripts/log-count.mts');
    expect(fs.existsSync('scripts/log-count.mts')).toBe(true);
  });
});
