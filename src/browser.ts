import { chromium, Browser, Page } from "playwright";

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    if (this.browser) {
      return;
    }

    // 支持通过环境变量配置代理（可选）
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const launchOptions: any = {
      headless: true, // 使用headless模式，适合npx远程执行
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu", // 禁用GPU加速，提高服务器兼容性
        "--single-process", // 使用单进程模式，减少资源占用
        "--no-zygote" // 禁用zygote进程
      ],
    };

    // 如果配置了代理，则使用代理
    if (proxy) {
      launchOptions.proxy = {
        server: proxy
      };
    }

    this.browser = await chromium.launch(launchOptions);

    this.page = await this.browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    // 添加浏览器指纹隐藏
    await this.page.addInitScript(() => {
      // @ts-ignore
      delete navigator.__proto__.webdriver;
      // @ts-ignore
      navigator.__defineGetter__('languages', () => ['zh-CN', 'zh', 'en']);
      // @ts-ignore
      navigator.__defineGetter__('plugins', () => [1, 2, 3, 4, 5]);
    });

    // 设置超时
    this.page.setDefaultTimeout(45000); // 增加到45秒
    this.page.setDefaultNavigationTimeout(45000); // 增加到45秒
  }

  async getPage(): Promise<Page> {
    if (!this.page) {
      await this.initialize();
    }
    return this.page!;
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // 随机延迟，模拟人类行为
  async randomDelay(min: number = 500, max: number = 1500): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
