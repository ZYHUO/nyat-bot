import { describe, it, expect } from 'vitest';
import { routeReply, routeNeedsSpecialists, routeIsDeep } from '../../../../src/pipeline/multiagent/router.js';

describe('routeReply (零 LLM,复用 replyPath + replyTier → chat/lookup/deep)', () => {
  it("planned → lookup", () => {
    expect(routeReply('planned', 'normal')).toBe('lookup');
  });
  it("direct → chat", () => {
    expect(routeReply('direct', 'normal')).toBe('chat');
  });
  it("undefined → chat(保守,不浪费专家)", () => {
    expect(routeReply(undefined, 'normal')).toBe('chat');
  });
  it("max 档即使 direct 也 → deep(深度:研究员+记忆员+核查+Critic)", () => {
    expect(routeReply('direct', 'max')).toBe('deep');
  });
  it("max 档 planned 也 → deep", () => {
    expect(routeReply('planned', 'max')).toBe('deep');
  });
  it("pro direct → chat(pro 不强制研究)", () => {
    expect(routeReply('direct', 'pro')).toBe('chat');
  });
});

describe('route 谓词', () => {
  it('routeNeedsSpecialists: chat=false, lookup/deep=true', () => {
    expect(routeNeedsSpecialists('chat')).toBe(false);
    expect(routeNeedsSpecialists('lookup')).toBe(true);
    expect(routeNeedsSpecialists('deep')).toBe(true);
  });
  it('routeIsDeep: 仅 deep=true', () => {
    expect(routeIsDeep('deep')).toBe(true);
    expect(routeIsDeep('lookup')).toBe(false);
    expect(routeIsDeep('chat')).toBe(false);
  });
});
