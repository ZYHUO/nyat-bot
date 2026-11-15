import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { decayedSatiation } from '../../../../src/core/drives/store.js';

// The bug (2026-09-19): setDriveValue refreshed `updated_at` on every tick while
// leaving `satiation` at 1. `updated_at` exists solely as the decay clock, so the
// clock was reset forever and satiation never fell. Consequence, measured in
// production: connection + autonomy pinned at satiation 1.0 forever, the drive
// satiation suppressor vetoed 66 of 81 ticks, and the tick produced 0 proactive
// actions in four days.
//
// This test pins the invariant directly: refreshing a drive's VALUE must not move
// its satiation decay clock.

const migrationSql = readFileSync('migrations/0085_core_drives.sql', 'utf8');

describe('drive satiation decay clock', () => {
  it('decays exponentially with the age of the satiate() write', () => {
    // Half-life 6h: after 6h a satiation of 1 must be ~0.5.
    expect(decayedSatiation(1, 21600, 21600)).toBeCloseTo(0.5, 5);
    expect(decayedSatiation(1, 43200, 21600)).toBeCloseTo(0.25, 5);
    expect(decayedSatiation(0, 999999, 21600)).toBe(0);
  });

  it('a schema exists whose updated_at is the satiation clock', () => {
    const db = new Database(':memory:');
    db.exec(migrationSql);
    const cols = db.prepare('PRAGMA table_info(core_drives)').all().map((c) => c.name);
    expect(cols).toContain('satiation');
    expect(cols).toContain('updated_at');
    db.close();
  });

  it('simulates the production sequence: satiate -> many tick value refreshes', () => {
    const db = new Database(':memory:');
    db.exec(migrationSql);
    const now = 1_800_000_000;
    const half = 21600;

    const satiateAt = (name: string, at: number) =>
      db.prepare(
        `INSERT INTO core_drives (name, value, satiation, updated_at) VALUES (?, 0.5, 1, ?)
         ON CONFLICT(name) DO UPDATE SET satiation = 1, updated_at = excluded.updated_at`,
      ).run(name, at);

    // The BUGGY statement, i.e. the one that shipped for four days.
    const buggyRefresh = (name: string, v: number, at: number) =>
      db.prepare(
        `INSERT INTO core_drives (name, value, satiation, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(name, v, at);

    // The FIXED statement: value only, clock untouched.
    const fixedRefresh = (name: string, v: number, at: number) =>
      db.prepare(
        `INSERT INTO core_drives (name, value, satiation, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      ).run(name, v, at);

    const satiationAt = (name: string, at: number): number => {
      const row = db.prepare('SELECT satiation, updated_at FROM core_drives WHERE name = ?').get(name) as
        { satiation: number; updated_at: number };
      return decayedSatiation(row.satiation, Math.max(0, at - row.updated_at), half);
    };

    // ── buggy path: 6h of ticks, every one resetting the clock ──
    satiateAt('connection', now);
    for (let i = 1; i <= 12; i++) buggyRefresh('connection', 0.9, now + i * 1800); // every 30min for 6h
    const buggy = satiationAt('connection', now + 6 * 3600);
    // ── fixed path: same ticks, clock left alone ──
    satiateAt('autonomy', now);
    for (let i = 1; i <= 12; i++) fixedRefresh('autonomy', 0.9, now + i * 1800);
    const fixed = satiationAt('autonomy', now + 6 * 3600);

    expect(fixed).toBeCloseTo(0.5, 2); // one half-life really passed
    expect(buggy).toBeCloseTo(1, 5); // the clock was pinned, nothing decayed
    // The two must differ by at least a half-life of satiation.
    expect(buggy - fixed).toBeGreaterThan(0.4);
    db.close();
  });
});
