import { describe, expect, it } from 'vitest';

/**
 * 撞名命令必须**显式指定**才代发。
 *
 * 2026-09-22 round 5（用户："不会用其他 bot 的指令 完全乱来"）。
 * 生产实测两次误代发：
 *   09-21 15:27  用户说「等下又要签到水句开盲盒了」→ bot 向 nmnmfunbot 发了 /checkin
 *   09-22 14:31  用户说「争取以后能有一周的全勤吧」 → bot 又向 nmnmfunbot 发了 /checkin
 *
 * 两条都只是在闲聊里提到"签到"，不是在要求签到。
 * 而 `nmnmfunbot /checkin` 恰好是 ready 的已学命令，语义一近就代发了。
 *
 * 用户要的是"帮我用别的 bot 的 X 命令"，不是"你听到 X 这个词就去按一次"。
 * 撞名的那些更不能含糊——本 bot 自己就有 /checkin、/cards、/stats、/game。
 */

/** 与 src/pipeline/command-router.ts 同形（改那边要同步这里）。 */
const OWN_COMMANDS = new Set([
  '/checkin', '/help', '/status', '/stats', '/muteme', '/unmuteme',
  '/watch', '/game', '/feature', '/setdefault', '/cards', '/wish', '/skill',
]);

function namesBot(text: string, bot: string): boolean {
  const b = bot.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes('@' + b)) return true;
  const stem = b.replace(/_bot$/, '');
  if (stem.length >= 3 && t.includes(stem)) return true;
  return false;
}

/** Jev 判"命中"之后的那道守卫。true = 放行代发。 */
function allowsDelegation(text: string, command: string, bot: string): boolean {
  if (OWN_COMMANDS.has(command.toLowerCase())) return namesBot(text, bot);
  return true;   // 不撞名的命令不需要这道守卫
}

describe('撞名命令的代发守卫', () => {
  it('① 生产踩过的两次：闲聊提到"签到" → 不代发', () => {
    expect(allowsDelegation('等下又要签到水句开盲盒了', '/checkin', 'nmnmfunbot')).toBe(false);
    expect(allowsDelegation('争取以后能有一周的全勤吧', '/checkin', 'nmnmfunbot')).toBe(false);
  });

  it('② 显式 @bot → 放行', () => {
    expect(allowsDelegation('用 nmnmfunbot 的 checkin 帮我签一下', '/checkin', 'nmnmfunbot')).toBe(true);
    expect(allowsDelegation('/checkin@nmnmfunbot', '/checkin', 'nmnmfunbot')).toBe(true);
  });

  it('③ 不撞名的命令不需要这道守卫（照常放行）', () => {
    expect(allowsDelegation('查一下 8.8.8.8 是哪里的', '/geo', 'uzumaru_geoip_bot')).toBe(true);
    expect(allowsDelegation('随便一句提到 stock 的话', '/stock', 'uzumaru_bot')).toBe(true);
  });

  it('④ 短 stem 不会误命中（名字本体 <3 字符时不认）', () => {
    // 假设有个叫 "ab" 的 bot，文本里有 "about" 不该算点到它
    expect(namesBot('tell me about it', 'ab')).toBe(false);
    expect(namesBot('tell me ab something', 'ab')).toBe(false);
  });

  it('⑤ _bot 后缀变形也认（uzumaru_bot → 文本写 uzumaru）', () => {
    expect(namesBot('uzumaru 那个 bot 能查股票吗', 'uzumaru_bot')).toBe(true);
  });
});
