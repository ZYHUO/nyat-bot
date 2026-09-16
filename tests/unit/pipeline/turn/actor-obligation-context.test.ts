import { describe, expect, it } from 'vitest';

import type { TurnJobPayload } from '../../../../src/pipeline/turn/types.js';

function mergeObligationContext(
  base: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean },
  fallback?: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean },
) {
  return {
    obligationId: base.obligationId ?? fallback?.obligationId,
    obligationTargetUid: base.obligationTargetUid ?? fallback?.obligationTargetUid,
    obligationStrong: base.obligationStrong ?? fallback?.obligationStrong,
  };
}

describe('actor obligation context fallback', () => {
  it('preserves turn payload obligation when drained entries have no obligation metadata', () => {
    const turnPayload: TurnJobPayload = {
      trigger: 'wait_timeout',
      scheduledAt: Date.now(),
      obligationId: 'obl-1',
      obligationTargetUid: 7,
      obligationStrong: true,
    };
    const merged = mergeObligationContext({}, {
      obligationId: turnPayload.obligationId,
      obligationTargetUid: turnPayload.obligationTargetUid,
      obligationStrong: turnPayload.obligationStrong,
    });
    expect(merged).toEqual({
      obligationId: 'obl-1',
      obligationTargetUid: 7,
      obligationStrong: true,
    });
  });
});
