// ────────────────────────────────────────
// Gacha card catalog — 猫娘-themed collectible cards.
// Static, curated. Rarity drives roll weights + duplicate-conversion value.
// ────────────────────────────────────────

export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR';

export interface Card {
  id: string;
  name: string;
  rarity: Rarity;
  emoji: string;
  flavor: string;
}

export const RARITY_META: Record<Rarity, { weight: number; star: string; dustValue: number; label: string }> = {
  N:   { weight: 600, star: '⭐',        dustValue: 5,   label: '普通' },
  R:   { weight: 280, star: '⭐⭐',      dustValue: 15,  label: '稀有' },
  SR:  { weight: 90,  star: '⭐⭐⭐',    dustValue: 50,  label: '超稀有' },
  SSR: { weight: 27,  star: '⭐⭐⭐⭐',  dustValue: 180, label: '极稀有' },
  UR:  { weight: 3,   star: '✨⭐⭐⭐⭐⭐', dustValue: 600, label: '传说' },
};

export const CARDS: Card[] = [
  // N
  { id: 'mike',     name: '三花喵', rarity: 'N', emoji: '🐱', flavor: '街角晒太阳的常客' },
  { id: 'kuro',     name: '小黑喵', rarity: 'N', emoji: '🐈‍⬛', flavor: '半夜偷吃零食的影子' },
  { id: 'shiro',    name: '小白喵', rarity: 'N', emoji: '🐈', flavor: '雪一样软乎乎' },
  { id: 'tora',     name: '虎斑喵', rarity: 'N', emoji: '🐅', flavor: '气势汹汹其实很怂' },
  { id: 'chibi',    name: '奶喵', rarity: 'N', emoji: '🍼', flavor: '走两步摔一跤' },
  { id: 'lazy',     name: '懒喵', rarity: 'N', emoji: '😴', flavor: '一天睡二十小时' },
  { id: 'fatcat',   name: '胖橘', rarity: 'N', emoji: '🟠', flavor: '十只橘九只胖' },
  { id: 'street',   name: '流浪喵', rarity: 'N', emoji: '🌧️', flavor: '雨天找屋檐的旅人' },
  // R
  { id: 'tsundere', name: '傲娇喵', rarity: 'R', emoji: '💢', flavor: '才、才不是为你撒娇呢' },
  { id: 'gamer',    name: '电竞喵', rarity: 'R', emoji: '🎮', flavor: '上分路上的猫爪' },
  { id: 'chef',     name: '厨娘喵', rarity: 'R', emoji: '🍳', flavor: '小鱼干料理大师' },
  { id: 'idol',     name: '偶像喵', rarity: 'R', emoji: '🎤', flavor: '舞台中央的小太阳' },
  { id: 'scholar',  name: '学霸喵', rarity: 'R', emoji: '📚', flavor: '图书馆的守护者' },
  { id: 'ninja',    name: '忍者喵', rarity: 'R', emoji: '🥷', flavor: '无声无息绕到背后' },
  { id: 'painter',  name: '画师喵', rarity: 'R', emoji: '🎨', flavor: '尾巴一甩就是一幅画' },
  // SR
  { id: 'maid',     name: '女仆喵', rarity: 'SR', emoji: '🎀', flavor: '欢迎回家喵~' },
  { id: 'magic',    name: '魔法喵', rarity: 'SR', emoji: '🔮', flavor: '喵法一闪万物皆甜' },
  { id: 'knight',   name: '骑士喵', rarity: 'SR', emoji: '🛡️', flavor: '以肉垫之名守护你' },
  { id: 'dj',       name: 'DJ喵', rarity: 'SR', emoji: '🎧', flavor: '把心跳调成节拍' },
  { id: 'astro',    name: '星象喵', rarity: 'SR', emoji: '🌙', flavor: '今晚的运势我说了算' },
  // SSR
  { id: 'kitsune',  name: '九尾喵', rarity: 'SSR', emoji: '🦊', flavor: '九条尾巴九种心情' },
  { id: 'empress',  name: '女王喵', rarity: 'SSR', emoji: '👑', flavor: '臣服于本喵的可爱' },
  { id: 'sakura',   name: '樱花喵', rarity: 'SSR', emoji: '🌸', flavor: '花瓣落处皆是温柔' },
  { id: 'galaxy',   name: '星河喵', rarity: 'SSR', emoji: '🌌', flavor: '把整片银河揣进口袋' },
  // UR
  { id: 'nyalpha',  name: '元初喵·Ω', rarity: 'UR', emoji: '🌟', flavor: '万喵之始，传说中的那一只' },
  { id: 'eclipse',  name: '蚀月喵', rarity: 'UR', emoji: '🌑', flavor: '日月失色，只为它驻足' },
];

const BY_ID = new Map(CARDS.map((c) => [c.id, c]));
const BY_RARITY = (() => {
  const m = new Map<Rarity, Card[]>();
  for (const c of CARDS) { const a = m.get(c.rarity) ?? []; a.push(c); m.set(c.rarity, a); }
  return m;
})();

export function getCard(id: string): Card | undefined { return BY_ID.get(id); }
export function cardsByRarity(r: Rarity): Card[] { return BY_RARITY.get(r) ?? []; }

/** Resolve a card by id, exact name, or fuzzy name substring. */
export function resolveCard(query: string): Card | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const byId = BY_ID.get(q.toLowerCase());
  if (byId) return byId;
  const exact = CARDS.find((c) => c.name === q);
  if (exact) return exact;
  return CARDS.find((c) => c.name.includes(q) || q.includes(c.name));
}

export function renderCard(c: Card): string {
  return `${c.emoji} ${RARITY_META[c.rarity].star} ${c.name}（${RARITY_META[c.rarity].label}）— ${c.flavor}`;
}
