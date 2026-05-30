// ────────────────────────────────────────
// Collectible 猫娘 cards — NOT a gacha/economy. Cards are unlocked *freely* by
// being active (daily checkin), never bought or rolled. The social loop is
// collection + wishlist matching, so群友 trade dupes with each other.
// `gacha_wallets.rolls_since_sr` is reused purely as a fairness/pity counter so
// everyone eventually meets a rare cat; the `coins` column is unused (legacy).
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { CARDS, RARITY_META, cardsByRarity, getCard, type Card, type Rarity } from './cards.js';

export const PITY_SR = 10;            // tunable — guaranteed SR+ within this many unlocks
const RARITY_ORDER: Rarity[] = ['UR', 'SSR', 'SR', 'R', 'N'];

function now(): number { return Math.floor(Date.now() / 1000); }

function ensureWallet(chatId: number, uid: number): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO gacha_wallets (chat_id, uid, coins, rolls_since_sr, updated_at) VALUES (?, ?, 0, 0, ?)',
  ).run(chatId, uid, now());
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

function addToCollection(chatId: number, uid: number, cardId: string): { isNew: boolean; count: number } {
  const existing = getDb().prepare('SELECT count FROM gacha_collection WHERE chat_id = ? AND uid = ? AND card_id = ?').get(chatId, uid, cardId) as { count: number } | undefined;
  if (existing) {
    getDb().prepare('UPDATE gacha_collection SET count = count + 1 WHERE chat_id = ? AND uid = ? AND card_id = ?').run(chatId, uid, cardId);
    return { isNew: false, count: existing.count + 1 };
  }
  getDb().prepare('INSERT INTO gacha_collection (chat_id, uid, card_id, count, first_at) VALUES (?, ?, ?, 1, ?)').run(chatId, uid, cardId, now());
  return { isNew: true, count: 1 };
}

export interface UnlockResult { card: Card; isNew: boolean; count: number }

/**
 * Freely unlock ONE card (e.g. on daily checkin). No cost. Soft pity via
 * rolls_since_sr so a rare cat is guaranteed within PITY_SR unlocks.
 */
export function unlockCard(chatId: number, uid: number, rng: () => number = Math.random): UnlockResult {
  ensureWallet(chatId, uid);
  const w = getDb().prepare('SELECT rolls_since_sr FROM gacha_wallets WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { rolls_since_sr: number };
  const pity = w.rolls_since_sr;
  const pityHit = pity + 1 >= PITY_SR;
  const rarity = pickRarity(rng(), pityHit);
  const pool = cardsByRarity(rarity);
  const card = pool[Math.floor(rng() * pool.length)] ?? CARDS[0]!;
  const { isNew, count } = addToCollection(chatId, uid, card.id);
  const newPity = (rarity === 'SR' || rarity === 'SSR' || rarity === 'UR') ? 0 : pity + 1;
  getDb().prepare('UPDATE gacha_wallets SET rolls_since_sr = ?, updated_at = ? WHERE chat_id = ? AND uid = ?').run(newPity, now(), chatId, uid);
  return { card, isNew, count };
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
