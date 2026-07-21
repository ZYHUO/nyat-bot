import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type {
  AssembleResult,
  ContextManifest,
  ContextManifestEntry,
  ContextPart,
  ContextProvider,
  ContextTier,
} from './types.js';

const TIER_ORDER: ContextTier[] = ['static', 'delta', 'ephemeral', 'volatile'];

/** In-memory last fingerprints per engine instance (process-local). */
export class ContextEngine {
  private readonly lastFingerprints = new Map<string, string>();
  private lastManifest: ContextManifest | null = null;

  constructor(private readonly name: string) {}

  getLastManifest(): ContextManifest | null {
    return this.lastManifest;
  }

  async assemble(providers: ContextProvider[]): Promise<AssembleResult> {
    const enabled = env().CONTEXT_ENGINE_ENABLED;
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
        logger.warn({ err, engine: this.name, provider: provider.id }, 'Context provider failed');
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

    logger.debug(
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

export function getContextEngine(name: string): ContextEngine {
  let eng = engines.get(name);
  if (!eng) {
    eng = new ContextEngine(name);
    engines.set(name, eng);
  }
  return eng;
}

/** Test helper. */
export function _resetContextEngines(): void {
  engines.clear();
}
