import { describe, expect, it } from 'vitest';

/**
 * 心流的 `why` 必须干净——它会被原样注入写手的 prompt 当"念头"。
 *
 * 2026-09-23（新 goal，用户："前言不搭后语"）。实测 10,807 条 Heart decision：
 *   why 含 `{`   926 条（9%）
 *   why 被截断    164 条（2%）
 *
 * 那些 why 长这样：
 *   {doro发的众筹澳门家宽，倍率还行，要参吗？
 *   {刚撩猫羽就发男铜贴纸，这反差绷不住
 *
 * 原样注入 reply.ts:623 后，写手拿到一个断裂的 JSON 片段当"念头"，
 * 还被要求"顺着这个念头说，别另起炉灶"——9% 的回复带着坏念头开笔。
 */

/** 与 src/pipeline/heart/decision.ts 的 cleanWhy 同形（改那边要同步这里）。 */
function cleanWhy(raw: string): string {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  t = t.replace(/^[\s{}[\]"'`]+/, '').replace(/[\s{}[\]"'`]+$/, '');
  const cut = t.search(/["']\s*,\s*["'][\w-]+["']\s*:/);
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/[,，:：、\s]+$/, '').trim();
  if ((t.match(/"/g)?.length ?? 0) % 2 === 1) t = t.replace(/["']?[^"']*$/, '').trim();
  return t.slice(0, 40);
}

describe('cleanWhy', () => {
  it('① 去掉首尾的 JSON 括号/引号（round 58 实测的 9%）', () => {
    expect(cleanWhy('{doro发的众筹澳门家宽，倍率还行，要参吗？')).toBe('doro发的众筹澳门家宽，倍率还行，要参吗？');
    expect(cleanWhy('{刚撩猫羽就发男铜贴纸，这反差绷不住')).toBe('刚撩猫羽就发男铜贴纸，这反差绷不住');
  });

  it('② 正常 why 一个字不动', () => {
    const s = '刚醒就被喊，烦都刻在脑门上了';
    expect(cleanWhy(s)).toBe(s);
    expect(cleanWhy('测速满血，赞一个喵')).toBe('测速满血，赞一个喵');
  });

  it('③ 全清空了就返回空串（调用方据此不注入）', () => {
    expect(cleanWhy('')).toBe('');
    expect(cleanWhy('{}')).toBe('');
    expect(cleanWhy('   ')).toBe('');
  });

  it('④ 仍然截到 40 字（不因为清洗就变长）', () => {
    const long = '啊'.repeat(80);
    expect(cleanWhy(long).length).toBe(40);
  });

  it('⑤ 去掉尾部截断的 JSON 残留', () => {
    const r = cleanWhy('这价格离谱到笑死","path":"cha');
    expect(r).not.toContain('path');
    expect(r.length).toBeGreaterThan(0);
  });
});
