import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * round 196: **session-report 能跑，不是只能 parse。**
 *
 * Round 192 发现 scripts/ 只有一个 parse 守卫（all-scripts-parse）——
 * 它 esbuild.transform 一遍，语法对就纠结。而我 round 163/192
 * 在这个文件里出过两次语法错（漏 `if (` 和漏 `);`），
 * **两次都是被脚本自己跑挂抓住的，不是被守卫**。
 *
 * Round 193 量到它只要 4.7 秒（我之前代代"要几十秒"），
 * 所以行为守卫完全做得起。
 *
 * 判据：跑 1 天窗口，断言
 *   ① 退出码 0
 *   ② 输出含 "Interrupt 打断" 且含四个数（round 191/192 立的）
 *   ③ 输出含 "心流裁决" 和 "编辑重放"（另两个我改过的段）
 *
 * 1 天而不是默认全窗口：默认要读所有历史，慢且不稳定。
 */

const run = (): { code: number; out: string } => {
  try {
    const out = execSync('npx tsx scripts/session-report.mts 1', { encoding: 'utf8', stdio: 'pipe', timeout: 50_000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, out: String(err.stdout ?? '') };
  }
};

describe('session-report 能跑（行为守卫，round 196）', () => {
  it('退出码 0（round 163/192 的语法错都是这里该抓到的）', () => {
    const r = run();
    expect(r.code, `exit=${r.code}\n${r.out.slice(0, 400)}`).toBe(0);
  });

  it('含 Interrupt 段且四个数都在一行（round 191/192）', () => {
    const r = run();
    const line = r.out.split('\n').find((l) => l.includes('Interrupt 打断'));
    expect(line, '输出里没有 Interrupt 段').toBeDefined();
    for (const frag of ['共', '条', '每百条入站', 'background', '入站 ', 'addressed']) {
      expect(line!, `Interrupt 行缺「${frag}」\n  ${line}`).toContain(frag);
    }
  });

  it('含心流与编辑重放两段（我改过它们，都得还在）', () => {
    const r = run();
    expect(r.out).toContain('心流裁决');
    expect(r.out).toContain('编辑重放');
  });
});
