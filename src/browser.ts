import { chromium, Browser, LaunchOptions, Page } from "playwright";
import { SessionManager, SessionStats } from "./runtime/session-manager.js";

export class BrowserManager {
  private browser: Browser | null = null;
  private sessionManager: SessionManager | null = null;

  async initialize(): Promise<void> {
    if (this.browser) {
      return;
    }

    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const launchOptions: LaunchOptions = {
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
      ],
    };

    if (proxy) {
      let proxyUrl: URL;
      try {
        proxyUrl = new URL(proxy);
      } catch {
        throw new Error("HTTP_PROXY/HTTPS_PROXY 必须是有效的 http 或 https URL");
      }
      if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
        throw new Error("HTTP_PROXY/HTTPS_PROXY 仅支持 http 或 https 协议");
      }
      launchOptions.proxy = { server: proxyUrl.origin };
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
