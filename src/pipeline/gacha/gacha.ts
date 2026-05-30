// ────────────────────────────────────────
// Gacha core — wallet, rolls, collection, wishlist matching, dupe recycling.
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { CARDS, RARITY_META, cardsByRarity, getCard, type Card, type Rarity } from './cards.js';

export const ROLL_COST = 50;          // tunable — coins per roll
export const PITY_SR = 10;            // tunable — guaranteed SR+ within this many rolls
const RARITY_ORDER: Rarity[] = ['UR', 'SSR', 'SR', 'R', 'N'];

function now(): number { return Math.floor(Date.now() / 1000); }

// ── Wallet ────────────────────────────────
function ensureWallet(chatId: number, uid: number): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO gacha_wallets (chat_id, uid, coins, rolls_since_sr, updated_at) VALUES (?, ?, 0, 0, ?)',
  ).run(chatId, uid, now());
}

export function getBalance(chatId: number, uid: number): number {
  const row = getDb().prepare('SELECT coins FROM gacha_wallets WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { coins: number } | undefined;
  return row?.coins ?? 0;
}

/** Credit coins (e.g. from checkin). Returns new balance. */
export function creditCoins(chatId: number, uid: number, amount: number): number {
  if (amount <= 0) return getBalance(chatId, uid);
  ensureWallet(chatId, uid);
  getDb().prepare('UPDATE gacha_wallets SET coins = coins + ?, updated_at = ? WHERE chat_id = ? AND uid = ?').run(amount, now(), chatId, uid);
  return getBalance(chatId, uid);
}

// ── Rarity selection (pure, testable) ─────
/**
 * Pick a rarity from a [0,1) roll. When `pityHit`, never returns N/R (guarantees SR+).
 */
export function pickRarity(roll: number, pityHit: boolean): Rarity {
  const pool: Rarity[] = pityHit ? ['UR', 'SSR', 'SR'] : RARITY_ORDER;
  const total = pool.reduce((s, r) => s + RARITY_META[r].weight, 0);
  let x = roll * total;
  for (const r of pool) {
    x -= RARITY_META[r].weight;
    if (x < 0) return r;
  }
  return pool[pool.length - 1]!;
}

function addToCollection(chatId: number, uid: number, cardId: string): boolean {
  const existing = getDb().prepare('SELECT count FROM gacha_collection WHERE chat_id = ? AND uid = ? AND card_id = ?').get(chatId, uid, cardId) as { count: number } | undefined;
  if (existing) {
    getDb().prepare('UPDATE gacha_collection SET count = count + 1 WHERE chat_id = ? AND uid = ? AND card_id = ?').run(chatId, uid, cardId);
    return false; // not new
  }
  getDb().prepare('INSERT INTO gacha_collection (chat_id, uid, card_id, count, first_at) VALUES (?, ?, ?, 1, ?)').run(chatId, uid, cardId, now());
  return true; // new card
}

export interface RollOutcome { card: Card; isNew: boolean }
export interface RollResult { ok: boolean; reason?: string; results: RollOutcome[]; spent: number; balance: number }

/** Roll the gacha `count` times. Spends coins, applies soft pity, updates collection. */
export function rollGacha(chatId: number, uid: number, count = 1, rng: () => number = Math.random): RollResult {
  ensureWallet(chatId, uid);
  const n = Math.max(1, Math.min(10, Math.floor(count)));
  const cost = ROLL_COST * n;
  const balance = getBalance(chatId, uid);
  if (balance < cost) {
    return { ok: false, reason: `喵币不够喵~ 需要 ${cost}（你有 ${balance}）。签到能领喵币哦`, results: [], spent: 0, balance };
  }

  const w = getDb().prepare('SELECT rolls_since_sr FROM gacha_wallets WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { rolls_since_sr: number };
  let pity = w.rolls_since_sr;
  const results: RollOutcome[] = [];

  const tx = getDb().transaction(() => {
    getDb().prepare('UPDATE gacha_wallets SET coins = coins - ?, updated_at = ? WHERE chat_id = ? AND uid = ?').run(cost, now(), chatId, uid);
    for (let i = 0; i < n; i++) {
      const pityHit = pity + 1 >= PITY_SR;
      const rarity = pickRarity(rng(), pityHit);
      const pool = cardsByRarity(rarity);
      const card = pool[Math.floor(rng() * pool.length)] ?? CARDS[0]!;
      const isNew = addToCollection(chatId, uid, card.id);
      results.push({ card, isNew });
      pity = (rarity === 'SR' || rarity === 'SSR' || rarity === 'UR') ? 0 : pity + 1;
    }
    getDb().prepare('UPDATE gacha_wallets SET rolls_since_sr = ? WHERE chat_id = ? AND uid = ?').run(pity, chatId, uid);
  });
  tx();
  return { ok: true, results, spent: cost, balance: getBalance(chatId, uid) };
}

// ── Collection ────────────────────────────
export interface CollectionEntry { card: Card; count: number }
export function getCollection(chatId: number, uid: number): CollectionEntry[] {
  const rows = getDb().prepare('SELECT card_id, count FROM gacha_collection WHERE chat_id = ? AND uid = ?').all(chatId, uid) as Array<{ card_id: string; count: number }>;
  return rows
    .map((r) => ({ card: getCard(r.card_id), count: r.count }))
    .filter((e): e is CollectionEntry => !!e.card)
    .sort((a, b) => RARITY_ORDER.indexOf(a.card.rarity) - RARITY_ORDER.indexOf(b.card.rarity));
}

/** Recycle duplicate copies (count>1) into coins (dust). Returns {gained, recycled}. */
export function recycleDupes(chatId: number, uid: number): { gained: number; recycled: number } {
  const rows = getDb().prepare('SELECT card_id, count FROM gacha_collection WHERE chat_id = ? AND uid = ? AND count > 1').all(chatId, uid) as Array<{ card_id: string; count: number }>;
  let gained = 0, recycled = 0;
  const tx = getDb().transaction(() => {
    for (const r of rows) {
      const card = getCard(r.card_id);
      if (!card) continue;
      const dupes = r.count - 1;
      gained += dupes * RARITY_META[card.rarity].dustValue;
      recycled += dupes;
      getDb().prepare('UPDATE gacha_collection SET count = 1 WHERE chat_id = ? AND uid = ? AND card_id = ?').run(chatId, uid, r.card_id);
    }
    if (gained > 0) getDb().prepare('UPDATE gacha_wallets SET coins = coins + ? WHERE chat_id = ? AND uid = ?').run(gained, chatId, uid);
  });
  tx();
  return { gained, recycled };
}

// ── Wishlist + peer matching (the novel cross-user loop) ──
export function addWish(chatId: number, uid: number, cardId: string): void {
  getDb().prepare('INSERT OR IGNORE INTO gacha_wishlist (chat_id, uid, card_id, created_at) VALUES (?, ?, ?, ?)').run(chatId, uid, cardId, now());
}
export function removeWish(chatId: number, uid: number, cardId: string): boolean {
  return getDb().prepare('DELETE FROM gacha_wishlist WHERE chat_id = ? AND uid = ? AND card_id = ?').run(chatId, uid, cardId).changes > 0;
}
export function getWishlist(chatId: number, uid: number): Card[] {
  const rows = getDb().prepare('SELECT card_id FROM gacha_wishlist WHERE chat_id = ? AND uid = ?').all(chatId, uid) as Array<{ card_id: string }>;
  return rows.map((r) => getCard(r.card_id)).filter((c): c is Card => !!c);
}

/** For each card I want, which OTHER users hold a spare (count≥2 ideally, else ≥1)? */
export function wishHolders(chatId: number, uid: number): Array<{ card: Card; holders: number[] }> {
  const wishes = getDb().prepare('SELECT card_id FROM gacha_wishlist WHERE chat_id = ? AND uid = ?').all(chatId, uid) as Array<{ card_id: string }>;
  const out: Array<{ card: Card; holders: number[] }> = [];
  for (const w of wishes) {
    const card = getCard(w.card_id);
    if (!card) continue;
    const rows = getDb().prepare('SELECT uid, count FROM gacha_collection WHERE chat_id = ? AND card_id = ? AND uid != ? ORDER BY count DESC').all(chatId, w.card_id, uid) as Array<{ uid: number; count: number }>;
    if (rows.length > 0) out.push({ card, holders: rows.map((r) => r.uid) });
  }
  return out;
}

/** For each spare card I hold, which OTHER users have it on their wishlist? */
export function wishWanted(chatId: number, uid: number): Array<{ card: Card; wanters: number[] }> {
  const owned = getDb().prepare('SELECT card_id, count FROM gacha_collection WHERE chat_id = ? AND uid = ?').all(chatId, uid) as Array<{ card_id: string; count: number }>;
  const out: Array<{ card: Card; wanters: number[] }> = [];
  for (const o of owned) {
    const card = getCard(o.card_id);
    if (!card) continue;
    const rows = getDb().prepare('SELECT uid FROM gacha_wishlist WHERE chat_id = ? AND card_id = ? AND uid != ?').all(chatId, o.card_id, uid) as Array<{ uid: number }>;
    if (rows.length > 0) out.push({ card, wanters: rows.map((r) => r.uid) });
  }
  return out;
}
