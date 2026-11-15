import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-19：releasePressure 写好了、单测绿着，而全仓库唯一引用是注释——
// 积分器因此少了主要排水路径。这是我这个会话第四次"写了没调用"。
// 前三次（renderEcho / resetTrench / recentImpulses）是死代码扫描抓到的；
// 这次靠主动核对"每个导出的消费方"抓到。这个测试把该核对固定下来。

const REPO = process.cwd();
function read(rel: string): string {
  return readFileSync(`${REPO}/${rel}`, 'utf8');
}

describe('L0 排水路径的消费方存在', () => {
  it('host-api 的发送成功分支调 releasePressure', () => {
    const src = read('src/subagent/host-api.ts');
    expect(src).toContain('releasePressure(chatId)');
    // 且必须在 sendMessage 成功之后（messageId > 0 的那个分支里）
    const idx = src.indexOf('const messageId = await sendMessage(');
    const drain = src.indexOf('releasePressure(chatId)');
    expect(idx).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(idx);
  });

  it('tick 的主动发言路径也抽气（两条发送路都不能漏）', () => {
    const src = read('src/cron/unified-tick.ts');
    expect(src).toContain('releasePressure(a.chatId)');
  });

  it('releasePressure 不是只被注释引用（真正的调用点）', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rn "releasePressure(" ${REPO}/src --include='*.ts' | grep -v "export async function" | grep -v "^\\s*//" || true`,
      { encoding: 'utf8' },
    );
    const calls = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
    expect(calls.length).toBeGreaterThanOrEqual(2);   // host-api + unified-tick
  });
});
