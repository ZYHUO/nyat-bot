import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));

const {
  pickRarity, unlockCard, getCollection,
  addWish, getWishlist, wishHolders, wishWanted, PITY_SR,
} = await import('../../../src/pipeline/gacha/gacha.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0032_gacha.sql'), 'utf-8'));
}

describe('collectible cards', () => {
  beforeEach(() => { testDb = new Database(':memory:'); initSchema(testDb); });
  afterEach(() => testDb.close());

  describe('pickRarity', () => {
    it('roll 0 → rarest first (UR)', () => {
      expect(pickRarity(0, false)).toBe('UR');
    });
    it('roll near 1 → commonest (N)', () => {
      expect(pickRarity(0.999, false)).toBe('N');
    });
    it('pity guarantees SR+ (never N/R)', () => {
      expect(['SR', 'SSR', 'UR']).toContain(pickRarity(0.999, true));
      expect(pickRarity(0, true)).toBe('UR');
    });
  });

  describe('unlockCard (free, no economy)', () => {
    it('adds an unlocked card to the collection and flags new', () => {
      const r = unlockCard(-100, 1, () => 0.5);
      expect(r.card).toBeTruthy();
      expect(r.isNew).toBe(true);
      expect(r.count).toBe(1);
      expect(getCollection(-100, 1)).toHaveLength(1);
    });
    it('second copy of the same card is not new and bumps count', () => {
      // constant rng → same rarity bucket + same card index
      const first = unlockCard(-100, 1, () => 0);  // 0 → UR, index 0 in UR pool
      const second = unlockCard(-100, 1, () => 0);
      expect(first.card.id).toBe(second.card.id);
      expect(second.isNew).toBe(false);
      expect(second.count).toBe(2);
    });
    it('soft pity guarantees a rare within PITY_SR unlocks', () => {
      // Always roll the commonest (N) — pity must force SR+ on the PITY_SR-th unlock
      let sawRare = false;
      for (let i = 0; i < PITY_SR; i++) {
        const r = unlockCard(-100, 2, () => 0.999);
        if (['SR', 'SSR', 'UR'].includes(r.card.rarity)) sawRare = true;
      }
      expect(sawRare).toBe(true);
    });
  });

  describe('wishlist peer matching (the social loop)', () => {
    it('wishHolders finds other users who own a wished card', () => {
      testDb.prepare("INSERT INTO gacha_collection (chat_id, uid, card_id, count, first_at) VALUES (-100, 2, 'maid', 1, 0)").run();
      addWish(-100, 1, 'maid');
      const m = wishHolders(-100, 1);
      expect(m).toHaveLength(1);
      expect(m[0]!.card.id).toBe('maid');
      expect(m[0]!.holders).toContain(2);
    });
    it('wishWanted finds who wants a card I own', () => {
      testDb.prepare("INSERT INTO gacha_collection (chat_id, uid, card_id, count, first_at) VALUES (-100, 1, 'kitsune', 2, 0)").run();
      addWish(-100, 3, 'kitsune');
      const m = wishWanted(-100, 1);
      expect(m.find((x) => x.card.id === 'kitsune')?.wanters).toContain(3);
    });
    it('getWishlist returns resolved cards', () => {
      addWish(-100, 1, 'empress');
      expect(getWishlist(-100, 1).map((c) => c.id)).toContain('empress');
    });
  });
});
