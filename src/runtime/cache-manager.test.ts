import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { CacheManager } from "./cache-manager.js";

test("cache manager should persist value to l2 and read back", async () => {
  const dbPath = "/tmp/chictr_cache_test.db";
  rmSync(dbPath, { force: true });
  const cache = new CacheManager(dbPath);
  await cache.set("k1", { a: 1 }, 60_000);

  const read = await cache.get<{ a: number }>("k1");
  assert.deepEqual(read, { a: 1 });

  const stats = cache.getStats();
  assert.ok(stats.l1_hits + stats.l2_hits >= 1);
});

