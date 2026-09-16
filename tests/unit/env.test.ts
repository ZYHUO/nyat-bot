import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/env.js';

describe('parseEnv', () => {
  const validEnv = {
    BOT_TOKEN: 'test-token-123',
  };

  it('parses minimal valid env with defaults', () => {
    const env = parseEnv(validEnv);
    expect(env.BOT_TOKEN).toBe('test-token-123');
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CONTEXT_MAX_LENGTH).toBe(600);
    expect(env.JUDGE_WINDOW_SIZE).toBe(10);
    expect(env.MASTER_UID).toBe(0);
    expect(env.BOT_NICKNAMES).toEqual(['xxb', '啾咪囝', '啾咪']);
  });

  it('throws on missing BOT_TOKEN', () => {
    expect(() => parseEnv({})).toThrow();
  });

  it('coerces numeric values', () => {
    const env = parseEnv({
      ...validEnv,
      PORT: '8080',
      MASTER_UID: '12345',
      CONTEXT_MAX_LENGTH: '200',
    });
    expect(env.PORT).toBe(8080);
    expect(env.MASTER_UID).toBe(12345);
    expect(env.CONTEXT_MAX_LENGTH).toBe(200);
  });

  it('parses boolean env strings literally', () => {
    const env = parseEnv({
      ...validEnv,
      VERIFY_ENABLED: 'false',
      ALLOWLIST_ENABLED: '0',
      ALLOWLIST_AUTO_AI_REVIEW: 'true',
      JUDGE_KNOWLEDGE_GROUP: '1',
    });

    expect(env.VERIFY_ENABLED).toBe(false);
    expect(env.ALLOWLIST_ENABLED).toBe(false);
    expect(env.ALLOWLIST_AUTO_AI_REVIEW).toBe(true);
    expect(env.JUDGE_KNOWLEDGE_GROUP).toBe(true);
  });

  it('splits BOT_NICKNAMES by comma', () => {
    const env = parseEnv({ ...validEnv, BOT_NICKNAMES: 'a,b,c' });
    expect(env.BOT_NICKNAMES).toEqual(['a', 'b', 'c']);
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => parseEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => parseEnv({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('multi-agent 新开关默认值(T4):全开 + researcher 6 步 + best-of-N 1 + ASI 抽样', () => {
    const env = parseEnv(validEnv);
    expect(env.MULTI_AGENT_ENABLED).toBe(true);
    expect(env.MULTI_AGENT_CHAT_SPECIALISTS).toBe(true);
    expect(env.MULTI_AGENT_DIRECTOR_ENABLED).toBe(true);
    expect(env.MULTI_AGENT_CONTEXT_DIGEST_ENABLED).toBe(true);
    expect(env.MULTI_AGENT_PERSONA_CRITIC_ENABLED).toBe(true);
    expect(env.MULTI_AGENT_PERSONA_ENABLED).toBe(true);
    expect(env.MULTI_AGENT_CRITIC_MAX_ROUNDS).toBe(2);
    expect(env.MULTI_AGENT_CRITIC_ON_LOOKUP).toBe(false);
    expect(env.MULTI_AGENT_RESEARCHER_MAX_STEPS).toBe(6);
    // 默认 1：闲聊不常开 best-of-N（token ×写手）；需要时按 replyTier / env 提升
    expect(env.WRITER_BEST_OF_N).toBe(1);
    expect(env.WRITER_SELECTOR_ENABLED).toBe(true);
    expect(env.REALTIME_LEARN_ENABLED).toBe(true);
    // 默认 0.2：与 realtime-learn 重叠打分，全量浪费
    expect(env.ASI_SAMPLE_RATE).toBe(0.2);
  });

  it('multi-agent 开关可被 env 覆盖(T4)', () => {
    const env = parseEnv({
      ...validEnv,
      WRITER_BEST_OF_N: '1',
      MULTI_AGENT_PERSONA_CRITIC_ENABLED: 'false',
      MULTI_AGENT_CRITIC_MAX_ROUNDS: '3',
      ASI_SAMPLE_RATE: '0.5',
      MULTI_AGENT_CHAT_SPECIALISTS: 'false',
    });
    expect(env.WRITER_BEST_OF_N).toBe(1);
    expect(env.MULTI_AGENT_PERSONA_CRITIC_ENABLED).toBe(false);
    expect(env.MULTI_AGENT_CRITIC_MAX_ROUNDS).toBe(3);
    expect(env.ASI_SAMPLE_RATE).toBe(0.5);
    expect(env.MULTI_AGENT_CHAT_SPECIALISTS).toBe(false);
  });

  it('phase-2 evidence gates default OFF and accept override', () => {
    const env = parseEnv({ ...validEnv });
    expect(env.GOAL_EVIDENCE_GATE_ENABLED).toBe(false);
    expect(env.SKILL_VERIFIED_USE_ENABLED).toBe(false);
    expect(env.SELF_EDIT_GUARDRAILS_ENABLED).toBe(false);
    const on = parseEnv({
      ...validEnv,
      GOAL_EVIDENCE_GATE_ENABLED: '1',
      SKILL_VERIFIED_USE_ENABLED: 'true',
      SELF_EDIT_GUARDRAILS_ENABLED: '1',
    });
    expect(on.GOAL_EVIDENCE_GATE_ENABLED).toBe(true);
    expect(on.SKILL_VERIFIED_USE_ENABLED).toBe(true);
    expect(on.SELF_EDIT_GUARDRAILS_ENABLED).toBe(true);
  });

  it('H1.1 floor gate defaults OFF and accepts override', () => {
    const env = parseEnv({ ...validEnv });
    expect(env.FLOOR_ENABLED).toBe(false);
    const on = parseEnv({ ...validEnv, FLOOR_ENABLED: '1' });
    expect(on.FLOOR_ENABLED).toBe(true);
  });
});
