import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/env.js';
import { validateOneBotConfig } from '../../../src/platform/onebot-runtime.js';
import { codeActMethodsForChat, buildCodeActSystemPrompt } from '../../../src/subagent/capability-prompt.js';

const configured = (overrides: Record<string, string> = {}) => parseEnv({
  BOT_TOKEN: 'synthetic-test-token', ONEBOT_ENABLED: 'true',
  ONEBOT_WS_URL: 'ws://127.0.0.1:3001/', ONEBOT_ACCESS_TOKEN: 'synthetic-token',
  ONEBOT_ACCOUNT_ID: '80001', ONEBOT_OWNER_ID: '80002', ...overrides,
});

describe('OneBot deployment configuration and capability scope', () => {
  it('stays off without any QQ credentials in a normal installation', () => {
    const config = parseEnv({ BOT_TOKEN: 'synthetic-test-token' });
    expect(config.ONEBOT_ENABLED).toBe(false);
    expect(() => validateOneBotConfig(config)).not.toThrow();
  });
  it('accepts loopback plus token and remote WSS, including empty all-chat filters', () => {
    expect(() => validateOneBotConfig(configured())).not.toThrow();
    expect(() => validateOneBotConfig(configured({ ONEBOT_WS_URL: 'wss://onebot.example/' }))).not.toThrow();
  });
  it.each(['http://127.0.0.1:3001/', 'ws://192.0.2.1:3001/', 'ws://127.0.0.1:3001/api', 'ws://127.0.0.1:3001/?access_token=secret'])('rejects incompatible or unprotected endpoint %s', url => {
    expect(() => validateOneBotConfig(configured({ ONEBOT_WS_URL: url }))).toThrow();
  });
  it.each([
    { ONEBOT_ACCESS_TOKEN: '' }, { ONEBOT_ACCOUNT_ID: '' }, { ONEBOT_OWNER_ID: '80001' },
    { ONEBOT_OWNER_ID: '-123' }, { ONEBOT_ALLOWED_GROUP_IDS: '123,not-a-QQ-number' },
  ])('requires explicit independent identities and valid filters', fields => {
    expect(() => validateOneBotConfig(configured(fields))).toThrow();
  });
  it('uses the QQ subset for both prompt generation and guest capabilities', () => {
    const methods = codeActMethodsForChat(-(2 ** 52 + 1));
    expect(methods).toContain('telegram.sendText');
    expect(methods).toContain('telegram.sendFinal');
    for (const absent of ['telegram.sendVoice', 'telegram.sendSticker', 'telegram.react', 'telegram.sendPoll', 'allowlist.approve']) {
      expect(methods).not.toContain(absent);
      expect(buildCodeActSystemPrompt(`Use ${absent} now.`, methods)).not.toContain(absent);
    }
    expect(codeActMethodsForChat(-100123)).toContain('telegram.sendVoice');
  });
});
