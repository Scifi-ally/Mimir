/**
 * Simple in-memory cache with TTL support for API responses
 * Used to minimize redundant API calls during a trading session
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<K, V> {
  private store: Map<K, CacheEntry<V>> = new Map();

  /**
   * Get a value from cache if it exists and hasn't expired
   */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value with TTL in milliseconds
   */
  set(key: K, value: V, ttlMs: number = 5 * 60 * 1000): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clear all expired entries
   */
  cleanup(): number {
    let cleared = 0;
    for (const [key, entry] of this.store.entries()) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.store.size;
  }
}

/**
 * Request deduplication to prevent duplicate concurrent requests
 */
export class RequestDeduplicator<K, V> {
  private pending: Map<K, Promise<V>> = new Map();

  /**
   * Execute a function, but only once per key at a time.
   * Concurrent requests with the same key will await the same promise.
   */
  async execute(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = fn()
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise);
    return promise;
  }
}
