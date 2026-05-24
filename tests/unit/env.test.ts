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
    expect(env.BOT_NICKNAMES).toEqual(['xxb', '啾咪囝']);
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
});
