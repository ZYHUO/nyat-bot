// ────────────────────────────────────────
// Collectible-card command handler — /cards (图鉴) + /wish (心愿单换卡).
// No rolling, no currency: cards are unlocked freely by签到/活跃. The loop is
// collect + trade dupes with群友. Returns a reply string. Group chats only.
// ────────────────────────────────────────

import { getGroupMembers } from '../context/manager.js';
import { RARITY_META, resolveCard } from './cards.js';
import {
  getCollection, addWish, removeWish, getWishlist, wishHolders, wishWanted,
} from './gacha.js';

async function nameMap(chatId: number, uids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  try {
    const members = await getGroupMembers(chatId);
    for (const mem of members) m.set(mem.uid, mem.username ? `@${mem.username}` : mem.fullName);
  } catch { /* fall back to uid */ }
  for (const u of uids) if (!m.has(u)) m.set(u, `用户${u}`);
  return m;
}

export async function handleGachaCommand(chatId: number, uid: number, cmd: string, arg: string): Promise<string> {
  const a = arg.trim();

  switch (cmd) {
    case '/cards':
    case '/卡册':
    case '/图鉴': {
      const coll = getCollection(chatId, uid);
      if (coll.length === 0) return '你还没有遇到过猫娘卡喵~ 每天签到、多冒泡就会慢慢遇到不同的猫猫！';
      const total = coll.reduce((s, e) => s + e.count, 0);
      const lines = coll.map((e) => `${e.card.emoji} ${RARITY_META[e.card.rarity].star} ${e.card.name}${e.count > 1 ? ` ×${e.count}` : ''}`);
      return `🗂️ 你的猫娘图鉴（${coll.length} 种 / ${total} 张）：\n${lines.join('\n')}\n\n重复的可以 /wish 跟群友换你缺的~`;
    }

    case '/wish':
    case '/心愿': {
      const [sub, ...rest] = a.split(/\s+/);
      const target = rest.join(' ');
      if (sub === 'add' || sub === '加') {
        const card = resolveCard(target);
        if (!card) return `没找到这张卡喵~ 用 /cards 看看卡名`;
        addWish(chatId, uid, card.id);
        return `⭐ 已把「${card.name}」加进心愿单~ 用 /wish holders 看群里谁有`;
      }
      if (sub === 'rm' || sub === 'del' || sub === '删') {
        const card = resolveCard(target);
        if (card && removeWish(chatId, uid, card.id)) return `已从心愿单移除「${card.name}」`;
        return `心愿单里没有这张喵~`;
      }
      if (sub === 'holders' || sub === '谁有') {
        const matches = wishHolders(chatId, uid);
        if (matches.length === 0) return '你的心愿单暂时没人持有，或心愿单是空的喵~';
        const names = await nameMap(chatId, matches.flatMap((m) => m.holders));
        const lines = matches.map((m) => `${m.card.emoji} ${m.card.name} ← ${m.holders.slice(0, 5).map((u) => names.get(u)).join('、')}`);
        return `🔍 想要的卡，群里谁手上有：\n${lines.join('\n')}\n\n去找他们换吧~`;
      }
      if (sub === 'wanted' || sub === '谁要') {
        const matches = wishWanted(chatId, uid);
        if (matches.length === 0) return '你的卡暂时没人想要，或你还没有卡喵~';
        const names = await nameMap(chatId, matches.flatMap((m) => m.wanters));
        const lines = matches.map((m) => `${m.card.emoji} ${m.card.name} → ${m.wanters.slice(0, 5).map((u) => names.get(u)).join('、')} 想要`);
        return `💌 你的卡，谁想要：\n${lines.join('\n')}\n\n可以拿去换你想要的~`;
      }
      // bare /wish → list
      const wl = getWishlist(chatId, uid);
      if (wl.length === 0) return '心愿单是空的喵~ 用 `/wish add 卡名` 添加，再 `/wish holders` 找持有人';
      return `⭐ 你的心愿单：\n${wl.map((c) => `${c.emoji} ${c.name}`).join('\n')}\n\n/wish holders 看谁有 · /wish wanted 看谁想要你的`;
    }

    default:
      return '';
  }
}
