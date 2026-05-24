import { describe, expect, it } from 'vitest';
import {
  shouldRegisterBotCommands,
  shouldWarmMemory,
} from '../../../src/startup/side-effects.js';

describe('startup side-effect ownership', () => {
  it('registers bot commands only on the bot ingress owner', () => {
    expect(
      shouldRegisterBotCommands({ worker: false, botIngress: true, http: false, cron: false }),
    ).toBe(true);
    expect(
      shouldRegisterBotCommands({ worker: true, botIngress: false, http: true, cron: true }),
    ).toBe(false);
  });

  it('warms memory only on processes that actively use it', () => {
    expect(
      shouldWarmMemory({ worker: true, botIngress: false, http: false, cron: false }),
    ).toBe(true);
    expect(
      shouldWarmMemory({ worker: false, botIngress: true, http: false, cron: false }),
    ).toBe(true);
    expect(
      shouldWarmMemory({ worker: false, botIngress: false, http: false, cron: true }),
    ).toBe(true);
    expect(
      shouldWarmMemory({ worker: false, botIngress: false, http: true, cron: false }),
    ).toBe(false);
    expect(
      shouldWarmMemory({ worker: false, botIngress: false, http: false, cron: false }),
    ).toBe(false);
  });
});
