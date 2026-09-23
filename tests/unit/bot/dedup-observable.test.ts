import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 同群同文本去重的跳过必须**可读**（round 191）。
 *
 * `scripts/check-gate-evidence.sh` 一直报「同群同文本去重 跳过 0 次」。
 * 看着像"判据场景还没出现"——实测按闸自己的判据（同群 + 前 4 字 + 30s）
 * 回放全日志：**命中 391 次，其中 190 次是同一句的真重复**。
 *
 * 为什么读不到：`LOG_LEVEL=info`，而跳过点写的是 `logger.debug`。
 * 全日志 905 条 debug 的最后一条在 09-23 11:03 —— 之后一次都没写出来。
 *
 * AGENTS.md round 66 归档过这条坑（"a debug line is invisible at
 * LOG_LEVEL=info, which puts the hole straight back"），这是第二次踩。
 */
describe('dedup 跳过可读', () => {
  const SRC = 'src/bot/sender/telegram.ts';

  it('① 跳过点是 logger.info 不是 logger.debug', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const line = code.find((l) => l.includes('sendMessage: duplicate text within 30s, skipped'));
    expect(line, '跳过日志行不在').toBeDefined();
    expect(line!).toContain('logger.info');
    expect(line!).not.toContain('logger.debug');
  });

  it('② 计数器仍然在（两个量具都要有）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes("incrCounter('send_duplicate_skipped_total'"))).toBe(true);
    expect(code.some((l) => l.includes('_dedupSkipped += 1'))).toBe(true);
  });

  it('③ 注释写清"为什么提到 info"，否则下一个人嫌吵改回去', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 191');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 700);
    expect(block).toContain('LOG_LEVEL=info');
    expect(block).toContain('391');
    expect(block).toContain('190');
  });

  it('④ gate-evidence 脚本确实在读这条日志（两头对齐）', () => {
    const s = fs.readFileSync('scripts/check-gate-evidence.sh', 'utf8');
    // 脚本里的 awk 模式是 /duplicate text within 30s/（不带 ", skipped"）——
    // 第一版我按日志全文断言，不匹配（round 176「探错字等于没探」同款）。
    expect(s).toContain('duplicate text within 30s');
    expect(s).toContain('DEDUP=');
  });
});
