/**
 * Simple in-memory TTL cache for expensive database queries and aggregations.
 * Prevents redundant database query storms from repeated dashboard polling.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryTtlCache {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds = 60): void {
    if (this.cache.size >= this.maxEntries) {
      // BUG-14 fix: The old condition `this.cache.size >= this.maxEntries` inside the
      // loop was always true when entering, nuking the entire cache on every overflow.
      // Now: first purge expired entries, then evict oldest if still full.
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now > v.expiresAt) {
          this.cache.delete(k);
        }
      }
      // If still at capacity after purging expired, evict the oldest entry
      if (this.cache.size >= this.maxEntries) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Helper to fetch or compute cached values.
   */
  async getOrSet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const fresh = await fetcher();
    this.set(key, fresh, ttlSeconds);
    return fresh;
  }
}

export const statsCache = new MemoryTtlCache(500);
