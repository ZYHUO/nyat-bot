// ────────────────────────────────────────
// Member roster cache — reduce Redis queries
// ────────────────────────────────────────

interface CachedRoster {
  roster: string;
  timestamp: number;
}

const cache = new Map<number, CachedRoster>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachedRoster(chatId: number): string | null {
  const cached = cache.get(chatId);
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > CACHE_TTL_MS) {
    cache.delete(chatId);
    return null;
  }

  return cached.roster;
}

export function setCachedRoster(chatId: number, roster: string): void {
  cache.set(chatId, {
    roster,
    timestamp: Date.now(),
  });

  // Cleanup old entries (simple LRU-like behavior)
  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}
