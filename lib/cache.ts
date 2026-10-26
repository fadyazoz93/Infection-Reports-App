/**
 * In-Memory Cache-Aside Layer for Turso / Cloud Database Optimization
 * 
 * Objectives:
 * 1. Eliminate full scans and repetitive cloud reads (Row Reads Exhaustion).
 * 2. Serve hot data directly from memory with 0 cloud read cost.
 * 3. Support TTL (Time-To-Live) and prefix-based cache invalidation.
 * 4. Support optimistic mutations (update cache locally on write without follow-up SELECTs).
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private stats = {
    hits: 0,
    misses: 0,
    savedCloudReads: 0
  };

  /**
   * Get cached item if present and not expired
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    // Estimate saved row reads based on cache hit
    this.stats.savedCloudReads++;
    return entry.data as T;
  }

  /**
   * Set item in cache with TTL in milliseconds (default: 10 minutes)
   */
  set<T>(key: string, data: T, ttlMs: number = 10 * 60 * 1000): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs
    });
  }

  /**
   * Delete a specific cache key
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache performance metrics
   */
  getMetrics() {
    return {
      size: this.store.size,
      ...this.stats,
      hitRate: this.stats.hits + this.stats.misses > 0 
        ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1) + '%'
        : '0%'
    };
  }
}

export const memoryCache = new MemoryCache();
