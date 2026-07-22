import type { ContextProvider } from './types.js';

export function staticText(id: string, text: string): ContextProvider {
  return {
    id,
    tier: 'static',
    provide: () => ({ id, tier: 'static', text }),
  };
}

export function deltaText(id: string, text: string, fingerprint?: string): ContextProvider {
  return {
    id,
    tier: 'delta',
    provide: () => ({ id, tier: 'delta', text, fingerprint }),
  };
}

export function ephemeralText(id: string, text: string): ContextProvider {
  return {
    id,
    tier: 'ephemeral',
    provide: () => ({ id, tier: 'ephemeral', text }),
  };
}

export function volatileText(id: string, text: string): ContextProvider {
  return {
    id,
    tier: 'volatile',
    provide: () => ({ id, tier: 'volatile', text }),
  };
}
