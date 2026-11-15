import { describe, expect, it, vi } from 'vitest';
import { GlobalState } from '../../../src/meta/global-state.js';
import { singleDigestSourceChatId } from '../../../src/meta/digest-scope.js';

vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn() } }));

describe('digest provenance', () => {
  it('does not assign a single source to mixed or unknown inputs', () => {
    expect(singleDigestSourceChatId([-100, -100])).toBe(-100);
    expect(singleDigestSourceChatId([42])).toBe(42);
    for (const sources of [[], [42, -100], [-100, undefined], [0], [NaN], [1.5]]) {
      expect(singleDigestSourceChatId(sources)).toBeUndefined();
    }
  });

  it('filters in-memory digests before limiting and quarantines legacy records', () => {
    const state = new GlobalState();
    state.addDigest('group-only', -100);
    state.addDigest('dm-private', 42);
    state.addDigest('other-group', -200);
    state.addDigest('legacy-unknown');
    state.addDigest('invalid-source', 0);
    expect(state.recentDigests(1, { sourceChatId: -100 }).map((d) => d.text)).toEqual(['group-only']);
    expect(state.recentDigests(5, { sourceChatId: 42 }).map((d) => d.text)).toEqual(['dm-private']);
    expect(state.recentDigests()).toEqual([]);
    expect(state.recentDigests(5, { sourceChatId: 0 })).toEqual([]);
    expect(state.digests).toHaveLength(5);
  });
});
