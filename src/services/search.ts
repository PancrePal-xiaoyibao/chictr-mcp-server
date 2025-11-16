import { BrowserManager } from "../browser.js";
import { HtmlParser, TrialListItem } from "../parsers/html-parser.js";
import NodeCache from "node-cache";

// 创建缓存实例
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5分钟缓存

export async function searchTrials(
  browserManager: BrowserManager,
  keyword: string,
  months: number = 6,
  maxResults: number = 10
): Promise<TrialListItem[]> {
  // 生成缓存键
  const cacheKey = `search_${keyword}_${months}_${maxResults}`;
  
  // 检查缓存
  const cachedResult = searchCache.get<TrialListItem[]>(cacheKey);
  if (cachedResult) {
    // console.log(`[CACHE HIT] 搜索缓存命中: ${cacheKey}`);
    return cachedResult;
  }
  
  // console.log(`[CACHE MISS] 搜索缓存未命中，执行新请求: ${cacheKey}`);

  const page = await browserManager.getPage();

  // 计算时间范围
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  // 构建URL
  const baseUrl = "https://www.chictr.org.cn/searchproj.html";
  const params = new URLSearchParams({
    title: keyword,
    officialname: "",
    subjectid: "",
    regstatus: "",
    regno: "",
    secondaryid: "",
    applier: "",
    studyleader: "",
    createyear: "",
    sponsor: "",
    secsponsor: "",
    sourceofspends: "",
    studyailment: "",
    studyailmentcode: "",
    studytype: "",
    studystage: "",
    studydesign: "",
    recruitmentstatus: "",
    gender: "",
    agreetosign: "",
    measure: "",
    country: "",
    province: "",
    city: "",
    institution: "",
    institutionlevel: "",
    intercode: "",
    ethicalcommitteesanction: "",
    whetherpublic: "",
    minstudyexecutetime: "",
    maxstudyexecutetime: "",
    btngo: "btn"
  });

  const url = `${baseUrl}?${params.toString()}`;
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

    // 导航到页面
    await page.goto(url, { waitUntil: "networkidle" });
    await browserManager.randomDelay();

    // 解析HTML
    const html = await page.content();
    // console.log(`[DEBUG] 页面标题: ${await page.title()}`);
    // console.log(`[DEBUG] 页面内容长度: ${html.length}`);
    
    // 检查是否有搜索结果
    // if (html.includes("共检索到")) {
    //   console.log("[DEBUG] 页面包含搜索结果信息");
    // } else {
    //   console.log("[DEBUG] 页面可能没有搜索结果");
    // }
    
    const results = HtmlParser.parseSearchResults(html);
    // console.log(`[DEBUG] 解析到 ${results.length} 个结果`);

    // 限制结果数量
    const limitedResults = results.slice(0, maxResults);
    
    // 存储到缓存
    searchCache.set(cacheKey, limitedResults);
    
    return limitedResults;
  } catch (error) {
    throw new Error(`搜索失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 添加清除搜索缓存的函数
export function clearSearchCache(): void {
  searchCache.flushAll();
  // console.log("[CACHE] 搜索缓存已清除");
}

// 获取缓存统计信息
export function getSearchCacheStats(): { keys: number; hits: number; misses: number } {
  const stats = searchCache.getStats();
  return {
    keys: searchCache.keys().length,
    hits: stats.hits || 0,
    misses: stats.misses || 0
  };
}
