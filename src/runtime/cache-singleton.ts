import { CacheManager } from "./cache-manager.js";

export const globalCacheManager = new CacheManager();

export function closeGlobalCacheManager(): void {
  globalCacheManager.close();
}

