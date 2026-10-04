import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CacheManager } from "./cache-manager.js";

function createTestCache(): { cache: CacheManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chictr-cache-test-"));
  return { cache: new CacheManager(join(dir, "cache.db")), dir };
}

test("cache manager should persist value to l2 and read back", async () => {
  const { cache, dir } = createTestCache();
  try {
    await cache.set("k1", { a: 1 }, 60_000);
    const read = await cache.get<{ a: number }>("k1");
    assert.deepEqual(read, { a: 1 });

    const stats = cache.getStats();
    assert.ok(stats.l1_hits + stats.l2_hits >= 1);
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cache manager should use remaining L2 TTL when restoring L1", async () => {
  const { cache, dir } = createTestCache();
  try {
    await cache.set("k1", { a: 1 }, 60_000);
    const db = (cache as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("UPDATE cache_entries SET created_at = ? WHERE key = ?").run(Date.now() - 59_500, "k1");
    const l1 = (cache as unknown as { l1: { del: (key: string) => void } }).l1;
    l1.del("k1");

    assert.deepEqual(await cache.get<{ a: number }>("k1"), { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await cache.get("k1"), undefined);
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cache manager should discard malformed L2 JSON", async () => {
  const { cache, dir } = createTestCache();
  try {
    const db = (cache as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("INSERT INTO cache_entries (key, value, created_at, ttl_ms) VALUES (?, ?, ?, ?)").run("bad", "{", Date.now(), 60_000);
    assert.equal(await cache.get("bad"), undefined);
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

