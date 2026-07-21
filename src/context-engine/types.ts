// ────────────────────────────────────────
// Context Engine — typed prompt assembly for cache + observability
// Inspired by CyberGroupmate Context Engine (static/delta/ephemeral/volatile).
// ────────────────────────────────────────

export type ContextTier = 'static' | 'delta' | 'ephemeral' | 'volatile';

export interface ContextPart {
  /** Stable id for delta tracking / manifest. */
  id: string;
  tier: ContextTier;
  /** Rendered text. Empty string = omit from final prompt. */
  text: string;
  /** Optional fingerprint for delta equality (defaults to text). */
  fingerprint?: string;
}

export interface ContextManifestEntry {
  id: string;
  tier: ContextTier;
  chars: number;
  /** true if identical to previous render of same id. */
  cacheHit: boolean;
}

export interface ContextManifest {
  renderedAt: number;
  totalChars: number;
  staticChars: number;
  deltaChars: number;
  ephemeralChars: number;
  volatileChars: number;
  cacheHitChars: number;
  cacheHitRatio: number;
  parts: ContextManifestEntry[];
}

export interface ContextProvider {
  id: string;
  tier: ContextTier;
  provide(): ContextPart | ContextPart[] | Promise<ContextPart | ContextPart[]>;
}

export interface AssembleResult {
  prompt: string;
  manifest: ContextManifest;
}
