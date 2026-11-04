// In-memory cache for data that is expensive to fetch and rarely changes.
// Entries expire after a short window so opening the same table again is
// instant, while the explicit Refresh action still requests fresh data.
export const CACHE_TTL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 50

type CacheEntry<T> = { value: T; expiresAt: number }

type CacheOptions = {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export type TtlCache<T> = {
  get: (key: string) => T | undefined
  set: (key: string, value: T) => void
  delete: (key: string) => void
  clear: () => void
  readonly size: number
}

export function createTtlCache<T>(options: CacheOptions = {}): TtlCache<T> {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry<T>>()

  const prune = () => {
    const time = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= time) entries.delete(key)
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      // Re-insert so Map order tracks recency for eviction.
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + ttlMs })
      prune()
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}
