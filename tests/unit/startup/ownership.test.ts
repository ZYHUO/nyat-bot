import { describe, expect, it } from 'vitest';
import { assertIngressHttpOwnership, getStartupOwnership, ownsMetaLoop } from '../../../src/startup/ownership.js';

describe('role startup and webhook receiver ownership', () => {
  it('rejects webhook ingress without its HTTP receiver before registering anything', () => {
    const ingress = getStartupOwnership({ XXB_ENABLE_BOT_INGRESS: 'true', XXB_ENABLE_HTTP: 'false' });
    expect(() => assertIngressHttpOwnership(ingress, { WEBHOOK_URL: 'https://example.invalid', WEBHOOK_SECRET: 'synthetic' })).toThrow('XXB_ENABLE_HTTP=true');
    expect(() => assertIngressHttpOwnership(ingress, {})).not.toThrow();
    expect(() => assertIngressHttpOwnership({ ...ingress, http: true }, { WEBHOOK_URL: 'https://example.invalid', WEBHOOK_SECRET: 'synthetic' })).not.toThrow();
  });
  it('allows HTTP-only roles without granting them ingress or Meta execution', () => {
    const receiver = getStartupOwnership({ XXB_ENABLE_BOT_INGRESS: 'false', XXB_ENABLE_HTTP: 'true', XXB_ENABLE_WORKER: 'false', XXB_ENABLE_CRON: 'false' });
    expect(() => assertIngressHttpOwnership(receiver, { WEBHOOK_URL: 'https://example.invalid', WEBHOOK_SECRET: 'synthetic' })).not.toThrow();
    expect(receiver.botIngress).toBe(false);
    expect(ownsMetaLoop(receiver)).toBe(false);
  });
});
