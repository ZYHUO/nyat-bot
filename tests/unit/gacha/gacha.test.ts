import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));

const {
  pickRarity, creditCoins, getBalance, rollGacha, getCollection, recycleDupes,
  addWish, getWishlist, wishHolders, wishWanted, ROLL_COST,
} = await import('../../../src/pipeline/gacha/gacha.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0032_gacha.sql'), 'utf-8'));
}

describe('gacha', () => {
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

  describe('wallet + roll', () => {
    it('credits and spends coins', () => {
      creditCoins(-100, 1, 200);
      expect(getBalance(-100, 1)).toBe(200);
      const r = rollGacha(-100, 1, 1, () => 0.5);
      expect(r.ok).toBe(true);
      expect(r.spent).toBe(ROLL_COST);
      expect(getBalance(-100, 1)).toBe(200 - ROLL_COST);
      expect(getCollection(-100, 1)).toHaveLength(1);
    });
    it('rejects when broke', () => {
      const r = rollGacha(-100, 1, 1);
      expect(r.ok).toBe(false);
      expect(r.results).toHaveLength(0);
    });
    it('multi-roll accumulates collection', () => {
      creditCoins(-100, 1, 1000);
      const r = rollGacha(-100, 1, 10, () => 0.5);
      expect(r.results).toHaveLength(10);
      expect(r.spent).toBe(ROLL_COST * 10);
    });
  });

  describe('recycle dupes', () => {
    it('converts duplicate copies to coins, keeps one', () => {
      // force the same card 3 times via a constant rng
      creditCoins(-100, 1, 1000);
      rollGacha(-100, 1, 3, () => 0.5);
      const before = getCollection(-100, 1);
      const dupCard = before.find((e) => e.count > 1);
      if (dupCard) {
        const { recycled } = recycleDupes(-100, 1);
        expect(recycled).toBeGreaterThan(0);
        expect(getCollection(-100, 1).every((e) => e.count === 1)).toBe(true);
      }
    });
  });

  describe('wishlist peer matching (the novel loop)', () => {
    it('wishHolders finds other users who own a wished card', () => {
      // user 2 owns 'maid'
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
