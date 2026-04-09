import Database from "better-sqlite3";
import NodeCache from "node-cache";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CacheStatsV2 {
  l1_hits: number;
  l1_misses: number;
  l2_hits: number;
  l2_misses: number;
  l1_keys: number;
  l2_keys: number;
  hit_rate: number;
}

export class CacheManager {
  private readonly l1 = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  private readonly db: Database.Database;
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
  };

  constructor(dbPath: string = process.env.CACHE_DB_PATH || "./cache/chictr_cache.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_created_at ON cache_entries(created_at);
    `);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const l1v = this.l1.get<T>(key);
    if (l1v !== undefined) {
      this.stats.l1Hits += 1;
      return l1v;
    }
    this.stats.l1Misses += 1;

    const row = this.db
      .prepare("SELECT value, created_at, ttl_ms FROM cache_entries WHERE key = ?")
      .get(key) as { value: string; created_at: number; ttl_ms: number } | undefined;

    if (!row) {
      this.stats.l2Misses += 1;
      return undefined;
    }

    const expired = Date.now() - row.created_at > row.ttl_ms;
    if (expired) {
      this.db.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
      this.stats.l2Misses += 1;
      return undefined;
    }

    const parsed = JSON.parse(row.value) as T;
    this.l1.set(key, parsed, Math.ceil(row.ttl_ms / 1000));
    this.stats.l2Hits += 1;
    return parsed;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.l1.set(key, value, Math.ceil(ttlMs / 1000));
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cache_entries (key, value, created_at, ttl_ms) VALUES (?, ?, ?, ?)"
      )
      .run(key, JSON.stringify(value), Date.now(), ttlMs);
  }

  clearAll(): void {
    this.l1.flushAll();
    this.db.exec("DELETE FROM cache_entries");
  }

  cleanupExpired(): void {
    this.db.prepare("DELETE FROM cache_entries WHERE created_at + ttl_ms < ?").run(Date.now());
  }

  getStats(): CacheStatsV2 {
    const totalHits = this.stats.l1Hits + this.stats.l2Hits;
    const totalReq = totalHits + this.stats.l1Misses + this.stats.l2Misses;
    const l2KeysRow = this.db.prepare("SELECT COUNT(*) as c FROM cache_entries").get() as {
      c: number;
    };
    return {
      l1_hits: this.stats.l1Hits,
      l1_misses: this.stats.l1Misses,
      l2_hits: this.stats.l2Hits,
      l2_misses: this.stats.l2Misses,
      l1_keys: this.l1.keys().length,
      l2_keys: l2KeysRow.c || 0,
      hit_rate: totalReq === 0 ? 0 : totalHits / totalReq,
    };
  }
}
