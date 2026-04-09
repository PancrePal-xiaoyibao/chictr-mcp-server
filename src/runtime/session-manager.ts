import { Browser, BrowserContext } from "playwright";

export interface SessionConfig {
  maxRequestsPerSession: number;
  sessionTTLMs: number;
  maxIdleMs: number;
  recycleIntervalMs: number;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  idleSessions: number;
}

interface Fingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
}

interface SessionMetadata {
  sessionId: string;
  context: BrowserContext;
  createdAt: number;
  lastActiveAt: number;
  requestCount: number;
  inUse: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly fingerprints: Fingerprint[] = this.createFingerprints();
  private recycleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly config: SessionConfig
  ) {
    this.recycleTimer = setInterval(() => {
      void this.recycleExpired();
    }, this.config.recycleIntervalMs);
  }

  async acquireSession(): Promise<{ sessionId: string; context: BrowserContext }> {
    const now = Date.now();
    for (const [sessionId, meta] of this.sessions.entries()) {
      if (
        !meta.inUse &&
        meta.requestCount < this.config.maxRequestsPerSession &&
        now - meta.createdAt < this.config.sessionTTLMs &&
        now - meta.lastActiveAt < this.config.maxIdleMs
      ) {
        meta.inUse = true;
        meta.requestCount += 1;
        meta.lastActiveAt = now;
        return { sessionId, context: meta.context };
      }
    }

    const session = await this.createSession();
    this.sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, context: session.context };
  }

  async releaseSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.inUse = false;
    meta.lastActiveAt = Date.now();
  }

  async shutdown(): Promise<void> {
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
      this.recycleTimer = null;
    }
    const values = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(values.map((s) => s.context.close().catch(() => {})));
  }

  getStats(): SessionStats {
    let active = 0;
    let idle = 0;
    for (const meta of this.sessions.values()) {
      if (meta.inUse) active += 1;
      else idle += 1;
    }
    return {
      totalSessions: this.sessions.size,
      activeSessions: active,
      idleSessions: idle,
    };
  }

  private async createSession(): Promise<SessionMetadata> {
    const fingerprint = this.pickFingerprint();
    const context = await this.browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });

    await context.addInitScript(() => {
      // @ts-ignore
      delete navigator.__proto__.webdriver;
      // @ts-ignore
      navigator.__defineGetter__("languages", () => ["zh-CN", "zh", "en"]);
      // @ts-ignore
      navigator.__defineGetter__("plugins", () => [1, 2, 3, 4, 5]);
    });

    const now = Date.now();
    return {
      sessionId: `sess_${now}_${Math.random().toString(36).slice(2, 8)}`,
      context,
      createdAt: now,
      lastActiveAt: now,
      requestCount: 1,
      inUse: true,
    };
  }

  private async recycleExpired(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, meta] of this.sessions.entries()) {
      if (meta.inUse) continue;
      const ttlExpired = now - meta.createdAt >= this.config.sessionTTLMs;
      const idleExpired = now - meta.lastActiveAt >= this.config.maxIdleMs;
      const countExceeded = meta.requestCount >= this.config.maxRequestsPerSession;

      if (ttlExpired || idleExpired || countExceeded) {
        await meta.context.close().catch(() => {});
        this.sessions.delete(sessionId);
      }
    }
  }

  private pickFingerprint(): Fingerprint {
    const index = Math.floor(Math.random() * this.fingerprints.length);
    return this.fingerprints[index]!;
  }

  private createFingerprints(): Fingerprint[] {
    const uas = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ];
    return uas.map((userAgent) => ({
      userAgent,
      viewport: { width: 1920, height: 1080 },
    }));
  }
}

