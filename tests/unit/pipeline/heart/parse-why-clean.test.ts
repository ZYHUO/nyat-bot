import { describe, expect, it } from 'vitest';
import { parseHeart } from '../../../../src/pipeline/heart/decision.js';

/**
 * parseHeart 出来的 why 必须是干净的中文（round 187）。
 *
 * 现场（2026-09-23 13:12-13:57，round 165 修部署**前**）：
 * `Heart decision` 的 why 是 `{QQ机器人权限形同虚设，啥功能都用不了`
 * ——**前导 `{` 没被剥掉**，而那个量在修复前是 8.9%（12280 条里 1095 条）。
 *
 * round 165 给 reflect 覆写路径补了 cleanWhy；这里钉住**解析路径**本身，
 * 因为那是我 round 59 就以为修好的地方（实际 8.9% 一直是那个数）。
 */
describe('parseHeart 的 why 清洗', () => {
  it('① 前导 { 被剥掉（现场那个形状）', () => {
    const r = parseHeart('{"act":"reply","path":"chat","why":"{QQ机器人权限形同虚设，啥功能都用不了"}');
    expect(r).not.toBeNull();
    expect(r!.why).toBe('QQ机器人权限形同虚设，啥功能都用不了');
    expect(r!.why.startsWith('{')).toBe(false);
  });

  it('② 前导多个括号/引号一起剥', () => {
    const r = parseHeart('{"act":"reply","path":"chat","why":"[{\'刚喊完大肥鱼"}');
    expect(r!.why).toBe('刚喊完大肥鱼');
  });

  it('③ 尾部截断的 JSON 残片被切掉', () => {
    const r = parseHeart('{"act":"reply","path":"chat","why":"这卡冻了","path":"cha"}');
    expect(r!.why).not.toContain('","');
  });

  it('④ 正常 why 不动（不能把内容洗掉）', () => {
    const r = parseHeart('{"act":"reply","path":"chat","why":"爪痕算固定资产改良支出，记你名下按月扣折旧喵"}');
    expect(r!.why).toBe('爪痕算固定资产改良支出，记你名下按月扣折旧喵');
  });

  it('⑤ 空/纯括号 → 空串（调用方据此不注入 [你的念头]）', () => {
    const r = parseHeart('{"act":"reply","path":"chat","why":"{}"}');
    expect(r!.why).toBe('');
  });

  it('⑥ 40 字上限仍生效', () => {
    const long = '啊'.repeat(80);
    const r = parseHeart(JSON.stringify({ act: 'reply', path: 'chat', why: long }));
    expect(r!.why.length).toBeLessThanOrEqual(40);
  });
});
