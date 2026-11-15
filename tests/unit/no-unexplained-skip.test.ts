import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * round 128: **不讹出现无原因的硬 skip。**
 *
 * Round 127 查那 4 个 skip 时归立了三种：
 *   skipIf(环境不满足)  → 正确设计（bwrap 没装就不测 bwrap）
 *   it.skip(flaky)          → 记原因 + 复查条件，别当不存在
 *   it.todo(没写)        → 视为不存在，该删
 *
 * 而全仓现在唯一一个硬 skip 是 heart-infra-failure:353，
 * 它的原因在上一行注释里（"Flaky when co-run..."）。
 *
 * 这条守卫防的是**新的无原因 skip**：一个测试被跳过而没人知道为什么，
 * 那它守护的行为就处于无保障状态——而且比没有测试更坏（假安全感）。
 */

const listSkips = (): Array<{ file: string; line: number; text: string }> => {
  const out = execSync(
    "grep -rn '\\.skip(' tests/unit --include=*.ts | grep -v skipIf || true",
    { encoding: 'utf8' },
  );
  const rows: Array<{ file: string; line: number; text: string }> = [];
  for (const l of out.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    // round 128: 排除本文件——我的文档注释里写着 `.skip(` 这个词，
    // 不排就会把自己算成“无原因的 skip”（自指）。
    if (m[1]!.endsWith('no-unexplained-skip.test.ts')) continue;
    rows.push({ file: m[1]!, line: Number(m[2]), text: m[3]! });
  }
  return rows;
};

/** 读一个文件的前 N 行（用来查 it.skip 上方的注释）。 */
const linesBefore = (file: string, line: number, back = 4): string[] => {
  const fs = require('node:fs') as typeof import('node:fs');
  const all = fs.readFileSync(file, 'utf8').split('\n');
  return all.slice(Math.max(0, line - 1 - back), line - 1);
};

describe('没有无缘无故的 skip', () => {
  it('① 每个 .skip( 必须带原因（消息里或上方注释里）', () => {
    const rows = listSkips();
    const unexplained: string[] = [];
    for (const r of rows) {
      const before = linesBefore(r.file, r.line).join('\n');
      const hasWhy = /flaky|hang|CI|co-run|不支持|无法|延期|临时|slow|timeout|不自支/i
        .test(r.text + '\n' + before);
      if (!hasWhy) unexplained.push(`${r.file}:${r.line}`);
    }
    expect(unexplained, '这些 skip 没写为什么（下一个人不知道它守的行为日前处于无保障）：\n  '
      + unexplained.join('\n  ')).toEqual([]);
  });

  it('② it.todo 视为不存在——有就直接报（round 127 立的第三种）', () => {
    // round 128: 排除本文件自己——它的文档注释里写着 it.todo( 这个词，
    // 否则守卫会在自己身上抓到自己（自指、和 round 50 那个“断言对象被自己删掉”对称）。
    const out = execSync(
      "grep -rn 'it\\.todo(' tests/unit --include=*.ts | grep -v no-unexplained-skip || true",
      { encoding: 'utf8' },
    ).trim();
    expect(out, '有 it.todo：\n' + out).toBe('');
  });

  it('③ skipIf 是正当的，不该被这条守卫误伤', () => {
    const rows = listSkips();
    for (const r of rows) {
      expect(r.text, `${r.file}:${r.line} 是 skipIf，不该走到这里`).not.toContain('skipIf');
    }
  });
});
