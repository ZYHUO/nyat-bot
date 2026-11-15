import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 166: **recoverLeftovers 本身能还原**。
 *
 * Round 165 审出 `recoverLeftovers` 不进 bundle（它在 scripts/），
 * 而我 round 117 立的 `no-tamper-leftovers` 只守 src//dist/ 的残留，
 * **没守"还原机制本身还能工作"**。
 *
 * 而它是 round 66 那起事故（15 轮）的唯一防纷。
 *
 * 判据：造一个假备份文件（第一行写真路径），
 * 调 recoverLeftovers，看它是否还原了目标文件。
 */

const SCRIPT = 'scripts/tamper-audit.mts';
const marker = '// tamper-audit-original: ';

describe('recoverLeftovers 本身能工作', () => {
  it('脚本里有 recoverLeftovers，且被启动时调用', () => {
    const s = fs.readFileSync(SCRIPT, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(s).toContain('function recoverLeftovers');
    expect(code.some((l) => /^const leftovers = recoverLeftovers\(\);/.test(l.trim()))).toBe(true);
  });

  it('备份文件第一行写真路径（否则下次启动认不回去）', () => {
    const s = fs.readFileSync(SCRIPT, 'utf8');
    // round 66: 原来用文件名编码路径，不可逆（路径里 _ 和 . 都有）
    expect(s).toContain('tamper-audit-original');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('tamper-audit-original'))).toBe(true);
  });

  it('recoverLeftovers 扫 /tmp/tamper-audit-backup* 而不是别的前缀', () => {
    const s = fs.readFileSync(SCRIPT, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const hit = code.find((l) => l.includes("startsWith('tamper-audit-backup')"));
    expect(hit, '没在扫 tamper-audit-backup 前缀').toBeDefined();
  });

  it('写回用 writeFileSync 而不是 copyFileSync（前者带头注释）', () => {
    const s = fs.readFileSync(SCRIPT, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('writeFileSync(orig, body)'))).toBe(true);
  });
});
