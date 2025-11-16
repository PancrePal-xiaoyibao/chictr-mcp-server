import { BrowserManager } from "./browser.js";
import { HtmlParser } from "./parsers/html-parser.js";

async function debugSearch() {
  const browserManager = new BrowserManager();
  try {
    await browserManager.initialize();
    const page = await browserManager.getPage();

    console.log("🔍 调试 ChiCTR 搜索功能");
    
    // 使用简单的搜索URL
    const searchUrl = "https://www.chictr.org.cn/searchproj.html?title=KRAS&btngo=btn";
    console.log(`正在访问: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: "networkidle" });
    await browserManager.randomDelay(2000, 3000); // 增加延迟
    
    const html = await page.content();
    console.log("页面标题:", await page.title());
    console.log("页面内容长度:", html.length);
    
    // 保存页面内容用于分析
    // await Bun.write("debug-page.html", html);
    console.log("页面内容已获取");
    
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
    const results = HtmlParser.parseSearchResults(html);
    console.log(`解析到 ${results.length} 个结果:`);
    
    if (results.length > 0) {
      console.log("前3个结果:");
      console.log(JSON.stringify(results.slice(0, 3), null, 2));
    } else {
      console.log("没有解析到结果，显示部分HTML内容:");
      // 显示HTML的前1000个字符
      console.log(html.substring(0, 1000));
    }
    
    await browserManager.close();
  } catch (error) {
    console.error("测试失败:", error);
    if (browserManager) {
      await browserManager.close();
    }
  }
}

debugSearch();