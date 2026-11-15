import { describe, expect, it, vi } from 'vitest';
import { CODEACT_CAPABILITY_METHODS, META_CAPABILITY_METHODS, selectCodeActCapabilities, validCapabilityName } from '../../../src/sandbox/codeact/capabilities.js';

describe('explicit RPC capabilities replace positional host-object injection', () => {
  it('rejects prototype traversal paths', () => {
    for (const name of ['constructor.constructor', 'runtime.__proto__', 'runtime.prototype', 'runtime.getPlan.call', 'process.exit']) {
      if (name === 'process.exit') expect(CODEACT_CAPABILITY_METHODS).not.toContain(name);
      else expect(validCapabilityName(name)).toBe(false);
    }
  });
  it('does not invoke getters or inherit methods during selection', () => {
    const getter = vi.fn(() => () => 'unsafe');
    const namespace = Object.create({ inherited: () => 'unsafe' });
    Object.defineProperty(namespace, 'read', { get: getter });
    expect(selectCodeActCapabilities({ test: namespace }, ['test.read', 'test.inherited']).size).toBe(0);
    expect(getter).not.toHaveBeenCalled();
  });
  it('separates Meta dispatch privileges from ordinary CodeAct', () => {
    expect(META_CAPABILITY_METHODS).toContain('dispatch.taskToGroup');
    expect(CODEACT_CAPABILITY_METHODS).not.toContain('dispatch.taskToGroup');
    expect(META_CAPABILITY_METHODS).not.toContain('telegram.sendText');
  });
  it('keeps arbitrary code, file access and bookkeeping outside the minimal profile', () => {
    for (const method of ['computer.run', 'computer.eval', 'computer.readFile', 'self.editPrompt', 'runtime.flushBookkeeping', 'runtime.drainUnviewedResults']) {
      expect(CODEACT_CAPABILITY_METHODS).not.toContain(method);
    }
  });
});
