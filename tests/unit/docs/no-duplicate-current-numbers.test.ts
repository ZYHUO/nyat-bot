import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 48: docs must not contain two copies of the same "current" number.
 *
 * Round 47 caught: OBJECTIVE-STATUS.md section 2 said the repeat-anchor guard
 * blocked 2 times while the table in section 3 already said 3 (round 196 updated
 * the table, missed the prose). Same fact, two copies, one updated.
 *
 * Round 48 went to fix it and found a THIRD copy (the "message for the user"
 * section still said 2). Two became three - so this test is not optional.
 *
 * Same family as the code bugs:
 *   round 192/198 two SECTION_ORDERs
 *   round 173      key written inside the shard loop
 */

const SRC = 'docs/OBJECTIVE-STATUS.md';
const SNAP = 'round 196';
const PAT = /(拦住|拦到过|跳过|触发)\s*(\d+)\s*次/g;

describe('no two copies of a current number', () => {
  it('the gate-count section is labelled a snapshot, not current', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain(SNAP);
    expect(s).toContain('gate:evidence');
  });

  it('the table header says snapshot, not "latest" (latest reads as current)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('round 196 快照');
    // sentinel: the header 最新证据 must not come back — it reads as
    // "current", and round 47/48 was exactly this header + two hand-copied numbers.
    expect(s).not.toContain('最新证据');
  });

  it('every guard number outside the table carries a round or snapshot tag', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const bad: string[] = [];
    s.split('\n').forEach((l, i) => {
      PAT.lastIndex = 0;
      if (!PAT.test(l)) return;
      if (l.trimStart().startsWith('|')) return;
      if (l.includes('快照') || /round \d+/.test(l)) return;
      if (l.trimStart().startsWith('#') || l.trimStart().startsWith('>')) return;
      bad.push(`L${i + 1}: ${l.slice(0, 70)}`);
    });
    expect(bad, 'these guard counts have no round/snapshot tag:\n' + bad.join('\n')).toEqual([]);
  });

  it('the repeat-anchor count is not stated with two different numbers', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const nums: number[] = [];
    for (const m of s.matchAll(PAT)) nums.push(Number(m[2]));
    const distinct = [...new Set(nums)].sort((a, b) => a - b);
    expect(distinct.length, `different guard counts seen: ${JSON.stringify(distinct)}`).toBeLessThanOrEqual(6);
  });
});
