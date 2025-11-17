import { BrowserManager } from "./browser.js";
import { HtmlParser } from "./parsers/html-parser.js";

async function debugSearchContent() {
  const browserManager = new BrowserManager();
  try {
    await browserManager.initialize();
    const page = await browserManager.getPage();

    console.log("🔍 调试 ChiCTR 搜索功能");
    
    // 使用简单的搜索URL
    const searchUrl = "https://www.chictr.org.cn/searchproj.html?title=KRAS&btngo=btn";
    console.log(`正在访问: ${searchUrl}`);
    
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
    
    await page.goto(searchUrl, { waitUntil: "networkidle" });
    await browserManager.randomDelay(2000, 3000); // 增加延迟
    
    const html = await page.content();
    const title = await page.title();
    console.log("页面标题:", title);
    console.log("页面内容长度:", html.length);
    
    // 检查页面是否包含特定文本
    if (html.includes("共检索到")) {
      console.log("✅ 页面包含搜索结果信息");
    } else {
      console.log("❌ 页面可能没有正确加载搜索结果");
    }
    
    if (html.includes("table")) {
      console.log("✅ 页面包含表格");
    } else {
      console.log("❌ 页面不包含表格");
    }
    
    // 尝试解析搜索结果
    const parsed = HtmlParser.parseSearchResults(html);
    const results = parsed.results;
    const pagination = parsed.pagination;
    console.log(`解析到 ${results.length} 个结果:`);
    console.log(`分页信息: 总结果数=${pagination.totalResults}, 总页数=${pagination.totalPages}, 当前页=${pagination.currentPage}`);
    
    if (results.length > 0) {
      console.log("前3个结果:");
      console.log(JSON.stringify(results.slice(0, 3), null, 2));
    } else {
      console.log("没有解析到结果，显示部分HTML内容:");
      // 显示HTML的前2000个字符
      console.log(html.substring(0, 2000));
      
      // 尝试查找可能的表格结构
      console.log("\n尝试查找表格结构:");
      const tableRegex = /<table[^>]*class=["'][^"']*table\d+[^"']*["'][^>]*>/i;
      const tableMatch = html.match(tableRegex);
      if (tableMatch) {
        console.log("找到表格标签:", tableMatch[0]);
      } else {
        console.log("未找到预期的表格标签");
      }
    }
    
    await browserManager.close();
  } catch (error) {
    console.error("测试失败:", error);
    if (browserManager) {
      await browserManager.close();
    }
  }
}

debugSearchContent();