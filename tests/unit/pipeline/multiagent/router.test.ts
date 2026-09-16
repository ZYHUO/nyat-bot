import { describe, it, expect } from 'vitest';
import { routeReply, routeNeedsSpecialists } from '../../../../src/pipeline/multiagent/router.js';

describe('routeReply (零 LLM,复用 replyPath → chat/lookup)', () => {
  it("planned → lookup", () => {
    expect(routeReply('planned')).toBe('lookup');
  });
  it("direct → chat", () => {
    expect(routeReply('direct')).toBe('chat');
  });
  it("undefined → chat(保守,不浪费专家)", () => {
    expect(routeReply(undefined)).toBe('chat');
  });
});

describe('route 谓词', () => {
  it('routeNeedsSpecialists: chat=false, lookup=true', () => {
    expect(routeNeedsSpecialists('chat')).toBe(false);
    expect(routeNeedsSpecialists('lookup')).toBe(true);
  });
});
