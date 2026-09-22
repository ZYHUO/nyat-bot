import { describe, expect, it } from 'vitest';

/**
 * 心流必须知道"★ 这条我自己回过没有、回过几次"。
 *
 * 2026-09-22 round 4（用户："重复回复的概率太高了"）。
 * 全量日志实测（40,083 条入站 / 4,808 个首气泡）：
 *   同一个锚点被回复 >1 次   153 个（唯一锚点的 7.9%）
 *   多出来的回复             206 个 → 真实重复率 4.3%
 *   最严重的 8 个锚点各被回 5-6 次
 *     "有完没完喵" / "你是不是只会说这一句啊喵"    ← 同一个人被反复接
 *     "本喵看不到图细节" ×3 个近似变体              ← 同一句换个说法
 *
 * 病因：`markMessageAnswered` 有 6 处调用（发出去就记），
 * **读它的人里没有心流**。attention.ts 只用它跳过"入队"，
 * 没有一处在"要不要回"之前问一句"我回过没有"。
 * 于是 bot 可以对同一条反复开口，每次都以为自己是第一次接。
 *
 * 这三条锁住新接线的两端 + 兼容旧数据。
 */

/** 与 src/meta/answered.ts 同形（改那边要同步这里）。 */
function parseTimes(raw: string | null): number[] {
  if (!raw) return [];
  if (raw === '1') return [];                        // 旧格式：回过了但没时间
  return raw.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
}

function isAnswered(raw: string | null): boolean {
  return raw !== null && raw !== '' && raw !== '0';
}

/** 与 heart/decision.ts 的 answeredLine 同形。 */
function answeredLine(times: number[], nowSec: number): string {
  if (!times.length) return '';
  const ago = Math.max(1, Math.round((nowSec - times[0]!) / 60));
  return times.length >= 2
    ? `[这条你已经回过 ${times.length} 次] 最近一次 ${ago} 分钟前。**连着接同一条,群里看着像复读机**`
    : `[这条你已经回过 1 次] 最近一次 ${ago} 分钟前。除非人家追加了新内容`;
}

describe('心流的"已经回过"召回', () => {
  const now = 1_800_000_000;

  it('① 没回过 → 不注入任何行（不无中生有）', () => {
    expect(answeredLine(parseTimes(null), now)).toBe('');
  });

  it('② 回过一次 → 注入一行，提醒"除非追加新内容"', () => {
    const line = answeredLine(parseTimes(String(now - 300)), now);
    expect(line).toContain('回过 1 次');
    expect(line).toContain('5 分钟前');
    expect(line).toContain('追加了新内容');
    // 一次还不算复读，不能说得太重
    expect(line).not.toContain('复读机');
  });

  it('③ 回过两次以上 → 明确说"像复读机"', () => {
    const line = answeredLine(parseTimes([now - 60, now - 600].join(',')), now);
    expect(line).toContain('回过 2 次');
    expect(line).toContain('复读机');
  });

  it('④ 时间戳列表新的在前（"最近一次"要用最新的）', () => {
    expect(parseTimes([now - 60, now - 600, now - 1200].join(','))[0]).toBe(now - 60);
  });

  it('⑤ 旧格式的单值兼容：算回过了，但拿不到时间（不误导）', () => {
    expect(isAnswered('1')).toBe(true);
    expect(parseTimes('1')).toEqual([]);
  });

  it('⑥ 空值和零值不算回过了', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('0')).toBe(false);
  });
});
