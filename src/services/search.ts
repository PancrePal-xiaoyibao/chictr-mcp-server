import { BrowserManager } from "../browser.js";
import { HtmlParser, TrialListItem } from "../parsers/html-parser.js";
import NodeCache from "node-cache";
import { RequestOrchestrator } from "../runtime/orchestrator.js";
import { ChallengeDetector } from "../runtime/challenge-detector.js";
import { globalCacheManager } from "../runtime/cache-singleton.js";

const SEARCH_TTL_MS = 5 * 60 * 1000;
// 创建项目ID映射缓存（注册号 -> 项目ID）
const projectIdCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // 1小时缓存

export async function searchTrials(
  browserManager: BrowserManager,
  orchestrator: RequestOrchestrator,
  challengeDetector: ChallengeDetector,
  keyword?: string,         // 注册题目（可选）
  registrationNumber?: string, // 注册号（可选）
  year?: number,            // 年份（可选，默认当前年份）
  maxResults: number = 20
): Promise<TrialListItem[]> {
  // 生成缓存键
  const cacheKey = `search_${keyword || ''}_${registrationNumber || ''}_${year || ''}_${maxResults}`;
  
  // 检查缓存
  const cachedResult = await globalCacheManager.get<TrialListItem[]>(cacheKey);
  if (cachedResult) {
    // console.log(`[CACHE HIT] 搜索缓存命中: ${cacheKey}`);
    return cachedResult;
  }

  if (!challengeDetector.canProceed()) {
    const snapshot = challengeDetector.getSnapshot();
    throw new Error(
      `访问处于冷却期，请稍后重试。cooldown_remaining_ms=${snapshot.cooldown_remaining_ms}`
    );
  }
  
  // console.log(`[CACHE MISS] 搜索缓存未命中，执行新请求: ${cacheKey}`);

  return browserManager.withPage(async (page, sessionId) => {
    // 默认年份：普通关键词搜索用当前年；按注册号精确搜索时不强制年份过滤
    const searchYear =
      year !== undefined
        ? year
        : registrationNumber
          ? undefined
          : new Date().getFullYear();

    // 存储所有结果
    let allResults: TrialListItem[] = [];
    let currentPage = 1;
    let totalPages = 1;

    // 循环获取所有页面的结果
    do {
      // 构建URL
      const baseUrl = "https://www.chictr.org.cn/searchproj.html";
      const params: Record<string, string> = {
        page: currentPage.toString(),
        btngo: "btn"
      };

      // 添加可选参数
      if (keyword) {
        params.title = keyword;
      }
      if (registrationNumber) {
        params.regno = registrationNumber;
      }
      if (searchYear) {
        params.createyear = searchYear.toString();
      }

      const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
      // console.log(`[DEBUG] 搜索URL: ${url}`);

      try {
        // 设置请求头以模拟真实浏览器
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"'
        });

        await orchestrator.execute({
          requestId: `search-${sessionId}-${currentPage}-${Date.now()}`,
          endpoint: "search",
          handler: async () => {
            // 导航到页面，增加超时时间并添加错误处理
            try {
              await page.goto(url, {
                waitUntil: "networkidle",
                timeout: 45000 // 增加到45秒超时
              });
            } catch (navigationError) {
              // 如果networkidle超时，尝试使用load事件
              try {
                await page.goto(url, {
                  waitUntil: "load",
                  timeout: 30000
                });
              } catch (loadError) {
                // 如果load也失败，尝试domcontentloaded
                await page.goto(url, {
                  waitUntil: "domcontentloaded",
                  timeout: 20000
                });
                // 等待额外时间确保页面加载
                await browserManager.randomDelay(2000, 4000);
              }
            }
          },
        });

        // 检查是否需要验证码
        const pageTitle = await page.title();
        if (pageTitle.includes("验证") || pageTitle.includes("Verification") || pageTitle.includes("滑动")) {
          challengeDetector.reportChallenge([
            {
              type: "TITLE",
              confidence: 0.9,
              details: `title=${pageTitle}`,
            },
          ]);
          // 触发验证码，抛出错误提示用户
          throw new Error(
            "检测到滑动验证码，建议：\n" +
            "1. 减少请求频率（增加延迟时间）\n" +
            "2. 使用缓存避免重复请求\n" +
            "3. 考虑更换网络环境或IP\n" +
            "4. 降低搜索结果数量限制"
          );
        }

        await browserManager.randomDelay(5000, 10000); // 增加延迟到5-10秒，减少触发验证码概率

        // 解析HTML
        const html = await page.content();
        const parsed = HtmlParser.parseSearchResults(html);
        const pageResults = parsed.results;
        totalPages = parsed.pagination.totalPages;

        // 将每个结果的 project_id 缓存起来
        pageResults.forEach(result => {
          if (result.project_id) {
            projectIdCache.set(result.registration_number, result.project_id);
          }
        });

        // 添加到结果数组
        allResults = allResults.concat(pageResults);

        // 如果已达到最大结果数，停止循环
        if (allResults.length >= maxResults) {
          break;
        }

        // 移动到下一页
        currentPage++;

        // 在访问下一页之前，添加额外的随机延迟减少触发验证码
        if (currentPage <= totalPages && allResults.length < maxResults) {
          await browserManager.randomDelay(3000, 6000); // 页面间的额外延迟
        }

        // 限制最大页数以避免无限循环
        if (currentPage > Math.min(totalPages, 10)) { // 最多处理10页
          break;
        }

      } catch (error) {
        throw new Error(`搜索第${currentPage}页失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    } while (currentPage <= totalPages);

    // 限制结果数量
    const limitedResults = allResults.slice(0, maxResults);

    // 存储到缓存
    await globalCacheManager.set(cacheKey, limitedResults, SEARCH_TTL_MS);
    challengeDetector.recordSuccess();

    return limitedResults;
  });
}

// 添加清除搜索缓存的函数
export function clearSearchCache(): void {
  globalCacheManager.clearAll();
  projectIdCache.flushAll();
  // console.log("[CACHE] 搜索缓存已清除");
}

// 获取缓存统计信息
export function getSearchCacheStats(): { keys: number; hits: number; misses: number } {
  const stats = globalCacheManager.getStats();
  return {
    keys: stats.l1_keys + stats.l2_keys,
    hits: stats.l1_hits + stats.l2_hits,
    misses: stats.l1_misses + stats.l2_misses
  };
}

export function getSearchCacheStatsV2() {
  return globalCacheManager.getStats();
}

// 根据注册号获取项目ID
export function getProjectIdByRegistrationNumber(registrationNumber: string): string | undefined {
  return projectIdCache.get<string>(registrationNumber);
}
