import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/env.js', () => ({ env: vi.fn() }));

import { isMultiAgentChat } from '../../../../src/pipeline/multiagent/flags.js';
import { env } from '../../../../src/env.js';

const setEnv = (
  MULTI_AGENT_ENABLED: boolean,
  MULTI_AGENT_CHAT_IDS: number[],
  TURN_ACTOR_ENABLED = true,
): void => {
  (env as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    MULTI_AGENT_ENABLED,
    MULTI_AGENT_CHAT_IDS,
    TURN_ACTOR_ENABLED,
  });
};

describe('isMultiAgentChat (灰度群判定 + L2 turn-actor 守卫)', () => {
  it('flag 关 → 恒 false', () => {
    setEnv(false, []);
    expect(isMultiAgentChat(-100)).toBe(false);
  });
  it('flag 开 + 空灰度 → true(全群生效)', () => {
    setEnv(true, []);
    expect(isMultiAgentChat(-100)).toBe(true);
  });
  it('flag 开 + 灰度不含本群 → false', () => {
    setEnv(true, [-200]);
    expect(isMultiAgentChat(-100)).toBe(false);
  });
  it('flag 开 + 灰度含本群 → true', () => {
    setEnv(true, [-100, -300]);
    expect(isMultiAgentChat(-100)).toBe(true);
  });
  it('L2:flag 开但 turn-actor 关 → false(多智能体需 turn 打断)', () => {
    setEnv(true, [], false);
    expect(isMultiAgentChat(-100)).toBe(false);
  });
});
