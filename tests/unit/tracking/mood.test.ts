import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory mock SQLite
interface MoodRow {
  chat_id: number;
  valence: number;
  last_event_at: number;
  last_decay_at: number;
  last_event_summary: string;
}
const store = new Map<number, MoodRow>();

const mockDb = {
  prepare: (sql: string) => {
    if (sql.startsWith('SELECT valence, last_decay_at, last_event_summary')) {
      return {
        get: (chatId: number) => {
          const row = store.get(chatId);
          if (!row) return undefined;
          return {
            valence: row.valence,
            last_decay_at: row.last_decay_at,
            last_event_summary: row.last_event_summary,
          };
        },
      };
    }
    if (sql.startsWith('SELECT valence, last_decay_at FROM chat_mood')) {
      return {
        get: (chatId: number) => {
          const row = store.get(chatId);
          if (!row) return undefined;
          return { valence: row.valence, last_decay_at: row.last_decay_at };
        },
      };
    }
    if (sql.startsWith('INSERT INTO chat_mood')) {
      return {
        run: (
          chatId: number,
          valence: number,
          lastEventAt: number,
          lastDecayAt: number,
          summary: string,
        ) => {
          store.set(chatId, {
            chat_id: chatId,
            valence,
            last_event_at: lastEventAt,
            last_decay_at: lastDecayAt,
            last_event_summary: summary,
          });
          return { changes: 1 };
        },
      };
    }
    throw new Error('unexpected sql: ' + sql);
  },
};

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => mockDb,
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  MOOD_ENABLED: true,
  MOOD_DECAY_RATE_PER_HOUR: 0.3,
  MOOD_INJECT_ENABLED: true,
  MOOD_INJECT_THRESHOLD: 20,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

describe('mood — pure functions', () => {
  let mod: typeof import('../../../src/tracking/mood.js');

  beforeEach(async () => {
    store.clear();
    vi.resetModules();
    envValues['MOOD_ENABLED'] = true;
    envValues['MOOD_DECAY_RATE_PER_HOUR'] = 0.3;
    envValues['MOOD_INJECT_ENABLED'] = true;
    envValues['MOOD_INJECT_THRESHOLD'] = 20;
    mod = await import('../../../src/tracking/mood.js');
  });

  it('valenceBucket boundaries', () => {
    expect(mod.valenceBucket(80)).toBe('cheerful');
    expect(mod.valenceBucket(60)).toBe('cheerful');
    expect(mod.valenceBucket(59)).toBe('good');
    expect(mod.valenceBucket(20)).toBe('good');
    expect(mod.valenceBucket(0)).toBe('calm');
    expect(mod.valenceBucket(-20)).toBe('calm');
    expect(mod.valenceBucket(-21)).toBe('down');
    expect(mod.valenceBucket(-60)).toBe('down');
    expect(mod.valenceBucket(-61)).toBe('grumpy');
    expect(mod.valenceBucket(-100)).toBe('grumpy');
  });

  it('decayValence after 1h with rate 0.3 keeps 70%', () => {
    expect(mod.decayValence(50, 1, 0.3)).toBeCloseTo(35, 1);
  });

  it('decayValence after 2h compounds (0.7^2 = 0.49)', () => {
    expect(mod.decayValence(50, 2, 0.3)).toBeCloseTo(24.5, 1);
  });

  it('decayValence with 0 hours unchanged', () => {
    expect(mod.decayValence(50, 0, 0.3)).toBe(50);
  });

  it('decayValence with rate 0 unchanged', () => {
    expect(mod.decayValence(50, 5, 0)).toBe(50);
  });

  it('moodPromptHint empty when |valence| < threshold', () => {
    expect(mod.moodPromptHint({ valence: 10, bucket: 'calm', lastEventSummary: '' })).toBe('');
    expect(mod.moodPromptHint({ valence: -10, bucket: 'calm', lastEventSummary: '' })).toBe('');
  });

  it('moodPromptHint non-empty when |valence| >= threshold', () => {
    expect(mod.moodPromptHint({ valence: 30, bucket: 'good', lastEventSummary: '' })).toContain('心情');
    expect(mod.moodPromptHint({ valence: -30, bucket: 'down', lastEventSummary: '' })).toContain('心情');
  });

  it('moodPromptHint empty when MOOD_INJECT_ENABLED=false', () => {
    envValues['MOOD_INJECT_ENABLED'] = false;
    expect(mod.moodPromptHint({ valence: 60, bucket: 'cheerful', lastEventSummary: '' })).toBe('');
  });
});

describe('mood — get / apply with DB', () => {
  let mod: typeof import('../../../src/tracking/mood.js');

  beforeEach(async () => {
    store.clear();
    vi.resetModules();
    envValues['MOOD_ENABLED'] = true;
    envValues['MOOD_DECAY_RATE_PER_HOUR'] = 0.3;
    envValues['MOOD_INJECT_ENABLED'] = true;
    envValues['MOOD_INJECT_THRESHOLD'] = 20;
    mod = await import('../../../src/tracking/mood.js');
  });

  it('feature off: getChatMood returns calm/0 without DB read', () => {
    envValues['MOOD_ENABLED'] = false;
    const s = mod.getChatMood(-100);
    expect(s.valence).toBe(0);
    expect(s.bucket).toBe('calm');
    expect(store.size).toBe(0);
  });

  it('feature off: applyMoodEvent is no-op', () => {
    envValues['MOOD_ENABLED'] = false;
    mod.applyMoodEvent(-100, 50, 'test');
    expect(store.size).toBe(0);
  });

  it('default state for unknown chat is calm/0', () => {
    const s = mod.getChatMood(-200);
    expect(s.valence).toBe(0);
    expect(s.bucket).toBe('calm');
  });

  it('applyMoodEvent persists and clamps to [-100, 100]', () => {
    mod.applyMoodEvent(-300, 150, 'huge_positive');
    let s = mod.getChatMood(-300);
    expect(s.valence).toBe(100);

    mod.applyMoodEvent(-300, -300, 'huge_negative');
    s = mod.getChatMood(-300);
    // 100 + (-300) → -200 → clamped to -100; but applied AFTER decay (~0 elapsed) ≈ -100
    expect(s.valence).toBe(-100);
    expect(s.bucket).toBe('grumpy');
  });

  it('successive events accumulate then clamp', () => {
    mod.applyMoodEvent(-400, 30, 'a');
    mod.applyMoodEvent(-400, 40, 'b');
    const s = mod.getChatMood(-400);
    // ~70 minus tiny decay between calls
    expect(s.valence).toBeGreaterThan(60);
    expect(s.bucket).toBe('cheerful');
  });

  it('zero or non-finite delta is skipped', () => {
    mod.applyMoodEvent(-500, 0, 'zero');
    expect(store.has(-500)).toBe(false);
    mod.applyMoodEvent(-500, NaN, 'nan');
    expect(store.has(-500)).toBe(false);
  });

  it('decay applied on read across simulated time', () => {
    // Manually seed a row 2 hours in the past
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    store.set(-600, {
      chat_id: -600,
      valence: 50,
      last_event_at: twoHoursAgo,
      last_decay_at: twoHoursAgo,
      last_event_summary: 'seeded',
    });
    const s = mod.getChatMood(-600);
    // 50 * 0.7^2 = 24.5
    expect(s.valence).toBeCloseTo(24.5, 1);
    expect(s.bucket).toBe('good');
  });
});
