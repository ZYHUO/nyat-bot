import { describe, expect, it } from "vitest";
import { moodTuneHumanizer } from "../../../../src/pipeline/reply/mood-tune.js";

describe("moodTuneHumanizer", () => {
  it("neutral input returns neutral/empty tuning", () => {
    const t = moodTuneHumanizer({ energy: 0.8, valence: 0 });
    expect(t).toEqual({});
  });

  it("low energy → more typos, slower read, more emoji, fewer ack prefixes", () => {
    const t = moodTuneHumanizer({ energy: 0.2, valence: 0 });
    expect(t.typoRate).toBeGreaterThan(0.2);
    expect(t.readDelayBase).toBeGreaterThanOrEqual(4.0);
    expect(t.emojiReplyRate).toBeGreaterThan(0.3);
    expect(t.ackPrefixRate).toBeLessThan(0.15);
  });

  it("negative valence → evasive short replies (high emoji rate, slow, curt)", () => {
    const t = moodTuneHumanizer({ energy: 0.8, valence: -0.8 });
    expect(t.emojiReplyRate).toBeGreaterThan(0.35);
    expect(t.readDelayBase).toBeGreaterThanOrEqual(3.5);
    expect(t.typoRate).toBeGreaterThan(0.15);
    expect(t.ackPrefixRate).toBeLessThanOrEqual(0.05);
  });

  it("positive valence → warm and lively", () => {
    const t = moodTuneHumanizer({ energy: 0.7, valence: 0.8 });
    expect(t.ackPrefixRate).toBeGreaterThan(0.3);
    expect(t.typoRate).toBeLessThanOrEqual(0.06);
    expect(t.deleteResendRate).toBe(0.1);
  });

  it("clamps out-of-range inputs instead of throwing", () => {
    const t = moodTuneHumanizer({ energy: 5, valence: -50 });
    expect(t).toBeDefined();
    expect(Number.isFinite(t.typoRate ?? 0)).toBe(true);
    const t2 = moodTuneHumanizer({ energy: Number.NaN, valence: Number.NaN });
    expect(t2).toEqual({});
  });
});
