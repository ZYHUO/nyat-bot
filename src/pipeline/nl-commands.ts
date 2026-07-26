// ────────────────────────────────────────
// Natural-language command router.
// Maps free-form phrases ("帮我签到"、"看看我的图鉴"、"追踪比特币") to the
// canonical command the user would otherwise have to type as a slash command.
// Deterministic (regex only, 0 LLM, ~0ms). Conservative by design — group
// messages only reach here when the bot is addressed (mention / reply-to-bot);
// DMs are 1:1 so any clear intent counts.
//
// kind:
//   'intercept' — dispatched directly by the pipeline command handler (returns a string)
//   'llm'       — /checkin & /stats, which are rendered by the reply LLM with
//                 injected data; the caller rewrites the message to the canonical
//                 slash so the existing reply-side injection picks it up.
// ────────────────────────────────────────

import { resolveCard } from './gacha/cards.js';

export interface CommandIntent {
  cmd: string;
  arg: string;
  kind: 'intercept' | 'llm';
}

/** Detect a command intent in a natural-language message, or null. */
export function detectCommandIntent(raw: string): CommandIntent | null {
  const text = (raw || '').trim();
  if (!text || text.startsWith('/')) return null; // slash commands handled elsewhere
  // drop a leading @mention token so "@nyat 签到" → "签到"
  const t = text.replace(/^@\S+\s*/, '').trim();
  if (!t) return null;

  // ── help / 功能 ──
  if (/(?:你(?:都|又)?(?:会|能做|可以做)(?:啥|什么|哪些)|有(?:什么|哪些)功能|功能(?:列表|菜单|介绍)|怎么(?:用|玩)你|^help$)/i.test(t)) {
    return { cmd: '/help', arg: '', kind: 'intercept' };
  }

  // ── party games ──
  const game = /真心话/.test(t) ? 'tod'
    : /大冒险/.test(t) ? 'dare'
    : /二选一/.test(t) ? 'wyr'
    : /我从未/.test(t) ? 'nhie'
    : /猜数字/.test(t) ? 'guess'
    : null;
  if (game && (/(?:玩|来|开|出|搞|整|想玩|想来)/.test(t) || t.length <= 6)) {
    return { cmd: '/game', arg: game, kind: 'intercept' };
  }

  // ── watch / unwatch / watches ──
  let m: RegExpMatchArray | null;
  // 「关注」加负向先行 (?!点|度):「关注点」(焦点)、「关注度」是名词,不是追踪动作。
  if ((m = t.match(/(?:取消|别再?|不(?:要|想))(?:追踪|关注(?!点|度)|盯)\s*(?:话题|关键词)?\s*[「"]?([^"」\s]{1,30})/))) {
    return { cmd: '/unwatch', arg: m[1]!, kind: 'intercept' };
  }
  if (/(?:追踪|关注)(?:列表|了(?:啥|什么|哪些))|我(?:追踪|关注)了(?:啥|什么|哪些)|我的(?:追踪|关注(?!点|度))/.test(t)) {
    return { cmd: '/watches', arg: '', kind: 'intercept' };
  }
  if ((m = t.match(/(?:帮我)?(?:追踪|关注(?!点|度)|盯着?|留意)\s*(?:一下)?\s*(?:话题|关键词)?\s*[「"]?([^"」\s]{1,30})/))) {
    const kw = m[1]!.replace(/[「"」]/g, '').trim();
    // ignore "关注我"/"关注一下" with no real keyword;并排除整句片段(含语气/比较词
    // 的多半是「怎么关注点都一样」这类疑问句,不是「关注比特币」这种命令)。
    const isSentenceFragment = /[都也吗呢吧嘛]|一样|怎么|什么|为什么|如何|一直|大家|你们/.test(kw);
    if (kw && kw !== '我' && kw !== '你' && kw !== '一下' && !isSentenceFragment) {
      return { cmd: '/watch', arg: kw, kind: 'intercept' };
    }
  }

  // ── wishlist (validated against the real catalog to avoid false positives) ──
  if (/谁(?:有|拥有).{0,4}我(?:想要|要|心愿)|心愿单?\s*(?:里)?\s*谁有|谁有我(?:想要|心愿)/.test(t)) {
    return { cmd: '/wish', arg: 'holders', kind: 'intercept' };
  }
  if (/谁(?:想|要|想要).{0,3}我的(?:卡|猫娘)/.test(t)) {
    return { cmd: '/wish', arg: 'wanted', kind: 'intercept' };
  }
  if ((m = t.match(/(?:心愿单?\s*(?:加|添加)|想要|想集齐?|求(?:一?张)?|想抽到?|想换)\s*[「"]?([^"」]{1,24})/))) {
    const name = m[1]!.trim();
    const cleaned = name.replace(/(?:这|那)?(?:张|只|个)?卡?[喵猫]?[~。!?,，.、\s]*$/u, '').trim();
    const card = resolveCard(name) || resolveCard(cleaned);
    if (card) return { cmd: '/wish', arg: `add ${card.name}`, kind: 'intercept' };
  }
  if (/(?:我的)?心愿单/.test(t)) {
    return { cmd: '/wish', arg: '', kind: 'intercept' };
  }

  // ── cards / 图鉴 ──
  if (/(?:猫娘)?(?:卡册|图鉴|卡组)|(?:看看?|查看?|给我看|我的)(?:猫娘)?卡|我(?:有哪些|收集的?)卡|集卡(?:进度)?/.test(t)) {
    return { cmd: '/cards', arg: '', kind: 'intercept' };
  }

  // ── stats (LLM-rendered) — check before checkin so "签到排行榜" → stats ──
  if (/排行榜?|排名榜?|签到统计|谁签到(?:最多|第一)/.test(t)) {
    return { cmd: '/stats', arg: '', kind: 'llm' };
  }

  // ── checkin (LLM-rendered) ──
  // 必须是"整句就是签到指令",不能是子串匹配。原先 /签到|打卡|签个到|check\s?in/i 会让
  // 「今天忘了打卡」「签到活动结束了吗」「这家店我打卡过」「let me check in on that later」
  // 全部命中 —— 而 reply.ts 里那次 detectCommandIntent 是**无寻址门**的,命中即真的
  // doCheckin() 写库发卡,把用户当天的签到消耗掉(之后真敲 /checkin 只会得到"已经签过了",
  // 连签播报/里程碑/奖励永久丢失)。对称参考:同文件的派对分支就要求动词或 t.length<=6。
  if (/^(?:帮我|替我|我要|我想|来|想)?(?:签到|签个到|打卡)[。.!!~\s]*$/.test(t) || /\bcheckin\b/i.test(t)) {
    return { cmd: '/checkin', arg: '', kind: 'llm' };
  }

  return null;
}
