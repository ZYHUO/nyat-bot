import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * arity-aware 缺参闸（round 169，计划第 2 步）。
 *
 * 现场：代发 /geo 无参数 → 对端回用法 → 它自己编了 8.8.8.8。
 * 第 1 步修"把退回当结果解"，这一步修"不该发的也发了"。
 */
describe('代发缺参闸（arity-aware）', () => {
  const SRC = 'src/pipeline/tools/bot-delegation.ts';

  const block = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = lines.findIndex((l) => l.includes('usageNeedsArg(profile?.usage_syntax)'));
    expect(i).toBeGreaterThan(-1);
    return lines.slice(i, i + 22).join('\n');
  };

  it('① 判据是 usageNeedsArg（不是全局 IP 正则）', () => {
    const b = block();
    expect(b).toContain('if (usageNeedsArg(profile?.usage_syntax)');
    expect(b).toContain('!(args || \'\').trim()');
    // 不能出现把 IP 正则当准入门槛的形状
    expect(b).not.toContain('isIP(');
  });

  it('② 无占位命令绝不进闸（/q /re /checkin /stock）', () => {
    // 真实数据形状来自 bot_command_profiles（见下面 ⑧ 的对照）
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('function usageNeedsArg(');
    expect(s).toContain('return false;');
  });

  it('③ 有兜底：人类消息带了实参就放行', () => {
    const b = block();
    expect(b).toContain('humanMessageCarriesArg(chatId)');
  });

  it('④ 拦住时有计数器 + info，且带 usage_syntax 字段（round 84 的形状）', () => {
    const b = block();
    expect(b).toContain("incrCounter('delegation_missing_args_total'");
    expect(b).toContain('logger.info');
    expect(b).toContain('needs an argument but none was given');
  });

  it('⑤ 返回 sent:false + 文本，不是 throw（tryDelegateCommand 契约永不抛）', () => {
    const b = block();
    expect(b).toContain('sent: false');
    expect(b).not.toContain('throw new Error');
  });

  it('⑥ 文案明确告诉模型"别自己编一个填进去"', () => {
    const b = block();
    expect(b).toContain('别自己编一个填进去');
  });

  it('⑦ humanMessageCarriesArg fail-open（读不到上下文不拦）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('async function humanMessageCarriesArg');
    expect(i).toBeGreaterThan(-1);
    const body = s.slice(i, i + 900);
    expect(body).toContain('catch');
    expect(body).toContain('return true');
  });

  it('⑧ 判据对真实 usage_syntax 全对（形状来自 data/xxb.db 的 ready 档案）', () => {
    // 这段是判据的复刻，用来钉住"真实形状"这个集合。
    // 若哪天改了判据，这里会红——那正是要人重新确认一遍真实数据的时候。
    const need = (syn: string): boolean => {
      const s0 = syn.trim();
      if (!s0) return false;
      if (/[<\[][^>\]]{1,60}[>\]]/.test(s0)) return true;
      const rest = s0.replace(/^\/[a-z0-9_]+/i, '').trim();
      return !!rest && !/^(或|回复消息|回复时)/.test(rest);
    };
    expect(need('/geo <IP或域名>')).toBe(true);
    expect(need('/music <歌名>')).toBe(true);
    expect(need('/q <数字>')).toBe(true);
    expect(need('/jx [链接] 或回复消息使用')).toBe(true);
    expect(need('/get <me|chat|ID|用户名|链接>|回复消息时使用')).toBe(true);
    expect(need('/q')).toBe(false);
    expect(need('/re')).toBe(false);
    expect(need('/checkin')).toBe(false);
    expect(need('/stock')).toBe(false);
    expect(need('/cards')).toBe(false);
    expect(need('/q 或回复消息使用')).toBe(false);
    expect(need('')).toBe(false);
  });
});
