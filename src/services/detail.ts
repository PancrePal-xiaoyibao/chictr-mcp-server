import { BrowserManager } from "../browser.js";
import { HtmlParser, TrialDetail } from "../parsers/html-parser.js";
import NodeCache from "node-cache";
import { getProjectIdByRegistrationNumber } from "./search.js";

// 创建缓存实例
const detailCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10分钟缓存

export async function getTrialDetail(
  browserManager: BrowserManager,
  registrationNumber: string
): Promise<TrialDetail> {
  // 生成缓存键
  const cacheKey = `detail_${registrationNumber}`;
  
  // 检查缓存
  const cachedResult = detailCache.get<TrialDetail>(cacheKey);
  if (cachedResult) {
    // console.log(`[CACHE HIT] 详情缓存命中: ${cacheKey}`);
    return cachedResult;
  }
  
  // console.log(`[CACHE MISS] 详情缓存未命中，执行新请求: ${cacheKey}`);

  const page = await browserManager.getPage();

  // 先尝试从缓存获取项目ID
  let projectId = getProjectIdByRegistrationNumber(registrationNumber);
  
  // 如果缓存中没有，则从注册号推导（兼容旧逻辑）
  if (!projectId) {
    projectId = registrationNumber.replace("ChiCTR", "");
  }

  // 构建URL
  const url = `https://www.chictr.org.cn/showproj.html?proj=${projectId}`;

  try {
    // 导航到页面
    await page.goto(url, { waitUntil: "networkidle" });
    
    // 检查是否需要验证码
    const pageTitle = await page.title();
    if (pageTitle.includes("验证") || pageTitle.includes("Verification") || pageTitle.includes("滑动")) {
      // 触发验证码，抛出错误提示用户
      throw new Error(
        "检测到滑动验证码，建议：\n" +
        "1. 减少请求频率（增加延迟时间）\n" +
        "2. 使用缓存避免重复请求\n" +
        "3. 考虑更换网络环境或IP"
      );
    }
    
    await browserManager.randomDelay(3000, 8000); // 增加延迟时间

    // 检查是否页面加载成功
    const title = await page.title();
    if (title.includes("页面未找到") || title.includes("404")) {
      throw new Error(`未找到注册号为 ${registrationNumber} 的试验`);
    }

    // 解析HTML
    const html = await page.content();
    const detail = HtmlParser.parseTrialDetail(html);
    
    // 存储到缓存
    detailCache.set(cacheKey, detail);

    return detail;
  } catch (error) {
    throw new Error(`获取试验详情失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 添加清除详情缓存的函数
export function clearDetailCache(): void {
  detailCache.flushAll();
  // console.log("[CACHE] 详情缓存已清除");
}

// 获取缓存统计信息
export function getDetailCacheStats(): { keys: number; hits: number; misses: number } {
  const stats = detailCache.getStats();
  return {
    keys: detailCache.keys().length,
    hits: stats.hits || 0,
    misses: stats.misses || 0
  };
}
