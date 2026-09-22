import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `npm run demo` 必须在**没有任何凭据**的机器上跑得起来，而且必须真的演出
 * "它决定不说话"这件事。
 *
 * 2026-09-22 round 2（提高知名度 goal）。这个 demo 是给陌生人看的：
 * 他克隆仓库，不想先申请 bot token、不想配 AI key。所以它依赖的那几句必须
 * 是零副作用的纯函数——这条测试就是验收。
 *
 * 为什么值得一条测试：demo 是门面。它挂了比 README 有错字严重得多，
 * 因为来看的人第一眼看到的就是它。
 */
describe('npm run demo', () => {
  const run = (args: string[] = []): string =>
    execFileSync('npx', ['tsx', 'scripts/demo.mts', ...args], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PATH: '/opt/node22/bin:' + (process.env.PATH ?? '') },
    });

  it('不带参数能跑完并输出剧本', () => {
    const out = run();
    expect(out).toContain('NyatBot');
    expect(out).toContain('有人会用 golang 写爬虫吗');
  }, 120_000);

  it('跑的是真代码：分层判定把 @nyatbot 判成 L0、普通消息判成 L2', () => {
    const out = run();
    expect(out).toContain('● L0');
    expect(out).toContain('○ L2');
  }, 120_000);

  it('必须真的演出一次"不发送"——否则这个 demo 没有卖点', () => {
    const out = run();
    expect(out).toContain('未发送');
    expect(out).toContain('这会儿没人叫你');
  }, 120_000);

  it('必须给出分句 + 打字节奏（这是"像真人"的证据）', () => {
    const out = run();
    expect(out).toMatch(/回复分 \d+ 句发送/);
    expect(out).toContain('打字间隔');
  }, 120_000);

  it('--html 生成一个文件', () => {
    const out = run(['--html']);
    expect(out).toContain('demo.html');
    expect(existsSync('demo.html')).toBe(true);
    rmSync('demo.html', { force: true });
  }, 120_000);
});
