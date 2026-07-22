import type {
  AssembleResult,
  ContextManifest,
  ContextManifestEntry,
  ContextPart,
  ContextProvider,
  ContextTier,
} from './types.js';

const TIER_ORDER: ContextTier[] = ['static', 'delta', 'ephemeral', 'volatile'];

export type ContextEngineLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
};

export type ContextEngineOptions = {
  /** When false, still assembles but does not update fingerprints (always cache miss). */
  enabled?: boolean;
  logger?: ContextEngineLogger;
};

const defaultOpts: Required<Pick<ContextEngineOptions, 'enabled'>> & {
  logger: ContextEngineLogger;
} = {
  enabled: true,
  logger: { warn: () => undefined },
};

let globalOpts = { ...defaultOpts };

/** Process-wide defaults (host injects env + pino). */
export function setContextEngineOptions(opts: ContextEngineOptions): void {
  globalOpts = {
    enabled: opts.enabled ?? globalOpts.enabled,
    logger: opts.logger ?? globalOpts.logger,
  };
}

/** In-memory last fingerprints per engine instance (process-local). */
export class ContextEngine {
  private readonly lastFingerprints = new Map<string, string>();
  private lastManifest: ContextManifest | null = null;

  constructor(
    private readonly name: string,
    private readonly opts: ContextEngineOptions = {},
  ) {}

  getLastManifest(): ContextManifest | null {
    return this.lastManifest;
  }

  async assemble(providers: ContextProvider[]): Promise<AssembleResult> {
    const enabled = this.opts.enabled ?? globalOpts.enabled;
    const log = this.opts.logger ?? globalOpts.logger;
    const collected: ContextPart[] = [];

    for (const provider of providers) {
      try {
        const raw = await provider.provide();
        const parts = Array.isArray(raw) ? raw : [raw];
        for (const part of parts) {
          if (!part?.text?.trim()) continue;
          collected.push({
            id: part.id || provider.id,
            tier: part.tier || provider.tier,
            text: part.text,
            fingerprint: part.fingerprint ?? part.text,
          });
        }
      } catch (err) {
        log.warn({ err, engine: this.name, provider: provider.id }, 'Context provider failed');
      }
    }

    // Stable order: tier then id
    collected.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      return ti !== 0 ? ti : a.id.localeCompare(b.id);
    });

    const entries: ContextManifestEntry[] = [];
    let staticChars = 0;
    let deltaChars = 0;
    let ephemeralChars = 0;
    let volatileChars = 0;
    let cacheHitChars = 0;
    const texts: string[] = [];

    for (const part of collected) {
      const fp = part.fingerprint ?? part.text;
      const prev = this.lastFingerprints.get(part.id);
      const cacheHit = prev !== undefined && prev === fp;
      if (enabled) this.lastFingerprints.set(part.id, fp);

      const chars = part.text.length;
      entries.push({ id: part.id, tier: part.tier, chars, cacheHit });
      if (part.tier === 'static') staticChars += chars;
      else if (part.tier === 'delta') deltaChars += chars;
      else if (part.tier === 'ephemeral') ephemeralChars += chars;
      else volatileChars += chars;
      if (cacheHit) cacheHitChars += chars;
      texts.push(part.text);
    }

    const totalChars = staticChars + deltaChars + ephemeralChars + volatileChars;
    const manifest: ContextManifest = {
      renderedAt: Date.now(),
      totalChars,
      staticChars,
      deltaChars,
      ephemeralChars,
      volatileChars,
      cacheHitChars,
      cacheHitRatio: totalChars > 0 ? cacheHitChars / totalChars : 0,
      parts: entries,
    };
    this.lastManifest = manifest;

    log.debug?.(
      {
        engine: this.name,
        totalChars,
        cacheHitRatio: Number(manifest.cacheHitRatio.toFixed(3)),
        parts: entries.length,
      },
      'Context assembled',
    );

    return {
      prompt: texts.join('\n\n'),
      manifest,
    };
  }
}

const engines = new Map<string, ContextEngine>();

export function getContextEngine(name: string, opts?: ContextEngineOptions): ContextEngine {
  let eng = engines.get(name);
  if (!eng) {
    eng = new ContextEngine(name, opts);
    engines.set(name, eng);
  }
  return eng;
}

/** Test helper. */
export function _resetContextEngines(): void {
  engines.clear();
}
