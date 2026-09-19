import { describe, expect, it } from 'vitest';

import { buildHostCapabilitySnapshot } from '../../../src/agent/nyatos-contracts.js';
import { compileSocialActProposal } from '../../../src/agent/social-act-compiler.js';
import type { SocialActProposal } from '../../../src/agent/social-act.js';

const scope = { visibility: 'chat' as const, chatId: -100 };

function proposal(overrides: Partial<SocialActProposal> = {}): SocialActProposal {
  return {
    schema: 'social_act.v1',
    scope,
    correlationId: 'social-act:test',
    source: 'model',
    intent: 'answer',
    thoughtUnits: [],
    bubbles: [{ text: '第一段', pauseAfterMs: 100 }, { text: '第二段' }],
    media: [{ kind: 'photo', source: 'photo-1', purpose: 'explain' }],
    capability: buildHostCapabilitySnapshot({
      scope,
      chatKind: 'group',
      observedEffects: { canSendText: true, canSendMedia: null },
    }),
    ...overrides,
  };
}

describe('SocialAct compiler', () => {
  it('keeps text executable while deferring media with unknown capability', () => {
    const plan = compileSocialActProposal(proposal());
    expect(plan).toMatchObject({ executable: true, bubbles: [{ text: '第一段' }, { text: '第二段' }] });
    expect(plan?.deferredMedia).toEqual([{ kind: 'photo', purpose: 'explain', reason: 'capability_unknown' }]);
  });

  it('blocks text when host reports no send capability and enforces limits', () => {
    const capability = buildHostCapabilitySnapshot({
      scope,
      observedEffects: { canSendText: false },
    });
    const plan = compileSocialActProposal(proposal({ capability, bubbles: [{ text: 'x' }, { text: 'y' }] }));
    expect(plan?.executable).toBe(false);
    expect(plan?.blockedReasons).toContain('text_capability_unavailable');
  });

  it('rejects a proposal whose scope does not match the host capability', () => {
    const capability = buildHostCapabilitySnapshot({ scope: { visibility: 'chat', chatId: -200 } });
    expect(compileSocialActProposal(proposal({ capability }))).toBeNull();
  });
});

