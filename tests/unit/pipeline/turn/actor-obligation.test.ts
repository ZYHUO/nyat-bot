import { describe, it, expect } from 'vitest';
import { selectActiveObligation } from '../../../../src/pipeline/turn/obligation-select.ts';

function candidate(id: string, strong: boolean, createdAt: number) {
  return {
    id,
    targetUid: strong ? 1 : 2,
    mustReplyStrong: strong,
    directInteraction: strong,
    priority: strong ? 100 : 50,
    state: 'pending' as const,
    chatId: -100,
    anchorMessageId: createdAt,
    anchorUid: strong ? 1 : 2,
    anchorFullName: '',
    targetFullName: '',
    kind: 'judge_reply' as const,
    createdAt,
    updatedAt: createdAt,
    relatedMessageIds: [createdAt],
    triggerUids: [strong ? 1 : 2],
  };
}

describe('actor obligation priority helper', () => {
  it('prefers strong obligation in mixed candidates', () => {
    const weak = candidate('weak', false, 10);
    const strong = candidate('strong', true, 20);
    const selected = selectActiveObligation([weak, strong]).active;
    expect(selected?.id).toBe('strong');
  });
});
