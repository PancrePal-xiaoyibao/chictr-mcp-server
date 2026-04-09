import { chromium, Browser, Page } from "playwright";
import { SessionManager, SessionStats } from "./runtime/session-manager.js";

export class BrowserManager {
  private browser: Browser | null = null;
  private sessionManager: SessionManager | null = null;

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
    this.sessionManager = new SessionManager(this.browser, {
      maxRequestsPerSession: Number(process.env.SESSION_MAX_REQUESTS || 40),
      sessionTTLMs: Number(process.env.SESSION_TTL_MS || 8 * 60 * 1000),
      maxIdleMs: Number(process.env.SESSION_IDLE_MS || 2 * 60 * 1000),
      recycleIntervalMs: Number(process.env.SESSION_RECYCLE_INTERVAL_MS || 30_000),
    });
  }

  async withPage<T>(handler: (page: Page, sessionId: string) => Promise<T>): Promise<T> {
    if (!this.sessionManager) {
      await this.initialize();
    }
    const manager = this.sessionManager!;
    const session = await manager.acquireSession();
    const page = await session.context.newPage();

    try {
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(45000);
      return await handler(page, session.sessionId);
    } finally {
      await page.close().catch(() => {});
      await manager.releaseSession(session.sessionId);
    }
  }

  getSessionStats(): SessionStats | null {
    return this.sessionManager?.getStats() || null;
  }

  async close(): Promise<void> {
    if (this.sessionManager) {
      await this.sessionManager.shutdown();
      this.sessionManager = null;
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
