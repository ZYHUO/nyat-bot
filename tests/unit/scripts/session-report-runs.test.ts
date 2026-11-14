import { afterAll, describe, expect, it } from 'vitest';
import { reportFixture } from '../../helpers/log-script.js';

/**
 * round 196: **session-report 能跑，不是只能 parse。**
 *
 * Round 192 发现 scripts/ 只有一个 parse 守卫（all-scripts-parse）——
 * 它 esbuild.transform 一遍，语法对就通过。而我 round 163/192
 * 在这个文件里出过两次语法错（漏 `if (` 和漏 `);`），
 * **两次都是被脚本自己跑挂抓住的，不是被守卫**。
 *
 * Round 193 量到它只要 4.7 秒（我之前猜"要几十秒"），
 * 所以行为守卫完全做得起。
 *
 * 判据：跑 1 天窗口，断言
 *   ① 退出码 0
 *   ② 输出含 "Interrupt 打断" 且含四个数（round 191/192 立的）
 *   ③ 输出含 "心流裁决"、"act 分布" 和 "编辑重放"（我改过的段）
 *
 * 1 天而不是默认全窗口：默认要读所有历史，慢且不稳定。
 *
 * round 202: 三个 it 都带 25s 超时。加 act 分布后它们超过 vitest 默认 5s——
 * 不是报告变慢（仍 4.7s），而是子进程启动开销让总时长过了 5s。
 */

const fixture = reportFixture();
afterAll(() => fixture.cleanup());
const run = () => fixture.run('scripts/session-report.mts', ['1', '--offline', '--metrics-file', fixture.metricsFile]);

describe('session-report 能跑（行为守卫，round 196）', () => {
  it('退出码 0（round 163/192 的语法错都是这里该抓到的）', () => {
    const r = run();
    expect(r.code, `exit=${r.code}\n${r.out.slice(0, 400)}`).toBe(0);
    expect(r.out).toContain('离线输入');
    expect(r.out).toContain('总调用 4｜成功 3｜失败 1');
    expect(r.out).toContain('离线模式未提供 SQLite 快照');
  }, 25_000);

  it('含 Interrupt 段且四个数都在一行（round 191/192）', () => {
    const r = run();
    const line = r.out.split('\n').find((l) => l.includes('Interrupt 打断'));
    expect(line, '输出里没有 Interrupt 段').toBeDefined();
    for (const frag of ['共', '条', '每百条入站', 'background', '入站 ', 'addressed']) {
      expect(line!, `Interrupt 行缺「${frag}」\n  ${line}`).toContain(frag);
    }
    expect(line).toContain('addressed 2');
    expect(line).toContain('background 1');
    expect(line).toContain('入站 5');
  }, 25_000);

  it('含心流 / act 分布 / 编辑重放（我改过的三段都还得在）', () => {
    const r = run();
    expect(r.out).toContain('心流裁决');
    // round 202 新加：四个 act 都得出现
    const actLine = r.out.split('\n').find((l) => l.includes('act: reply'));
    expect(actLine, '输出里没有 act 分布行').toBeDefined();
    for (const a of ['reply', 'wait', 'pass', 'react']) {
      expect(actLine!, `act 行缺 ${a}\n  ${actLine}`).toContain(a);
    }
    expect(r.out).toContain('编辑重放');
    expect(r.out).toContain('每任务开口次数:  1次×2');
    expect(r.out).toContain('任务 2 个｜超过 2 次开口的 0 个');
  }, 25_000);
});
