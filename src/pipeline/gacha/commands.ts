// ────────────────────────────────────────
// Gacha command handler — /roll /cards /wish /recycle /coins
// Returns a reply string. Group chats only (per-chat collections).
// ────────────────────────────────────────

import { getGroupMembers } from '../context/manager.js';
import { RARITY_META, resolveCard, renderCard } from './cards.js';
import {
  ROLL_COST, getBalance, rollGacha, getCollection, recycleDupes,
  addWish, removeWish, getWishlist, wishHolders, wishWanted,
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
    case '/coins':
    case '/喵币':
      return `💰 你有 ${getBalance(chatId, uid)} 喵币（每次签到能领，抽一次 ${ROLL_COST}）`;

    case '/roll':
    case '/抽卡': {
      const n = Math.max(1, Math.min(10, parseInt(a, 10) || 1));
      const r = rollGacha(chatId, uid, n);
      if (!r.ok) return `😿 ${r.reason}`;
      const lines = r.results.map((o) => `${o.isNew ? '🆕 ' : ''}${renderCard(o.card)}`);
      return `🎴 抽卡 ×${n}（花费 ${r.spent} 喵币）：\n${lines.join('\n')}\n\n余额：${r.balance} 喵币`;
    }

    case '/cards':
    case '/卡册': {
      const coll = getCollection(chatId, uid);
      if (coll.length === 0) return '你还没有任何卡喵~ 发 /roll 抽一张试试！';
      const total = coll.reduce((s, e) => s + e.count, 0);
      const lines = coll.map((e) => `${e.card.emoji} ${RARITY_META[e.card.rarity].star} ${e.card.name}${e.count > 1 ? ` ×${e.count}` : ''}`);
      return `🗂️ 你的卡册（${coll.length}/${total}）：\n${lines.join('\n')}\n\n重复卡可以 /recycle 回收成喵币`;
    }

    case '/recycle':
    case '/回收': {
      const { gained, recycled } = recycleDupes(chatId, uid);
      if (recycled === 0) return '没有重复的卡可以回收喵~';
      return `♻️ 回收了 ${recycled} 张重复卡，换得 ${gained} 喵币！余额：${getBalance(chatId, uid)}`;
    }

    case '/wish':
    case '/心愿': {
      const [sub, ...rest] = a.split(/\s+/);
      const target = rest.join(' ');
      if (sub === 'add' || sub === '加') {
        const card = resolveCard(target);
        if (!card) return `没找到这张卡喵~ 用 /cards 看看卡名`;
        addWish(chatId, uid, card.id);
        return `⭐ 已把「${card.name}」加进心愿单~ 用 /wish holders 看谁有`;
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
        return `🔍 想要的卡，谁手上有：\n${lines.join('\n')}\n\n去找他们换吧~`;
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
