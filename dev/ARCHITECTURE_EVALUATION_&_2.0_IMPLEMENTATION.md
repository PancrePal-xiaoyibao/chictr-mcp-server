# ChiCTR MCP Server 2.0 - 设计评估与实施指南

**评估时间**: 2026-04-09  
**当前版本**: 1.2.1  
**目标版本**: 2.0.0

---

## 📋 设计方案评估

### 1.1 草案评分

| 维度 | 评分 | 评价 |
|------|------|------|
| **问题诊断** | ✅ 优 | 精准识别了单page长生命周期、缺乏编排层、弱验证检测三大根本问题 |
| **架构完整性** | ✅ 优 | 涵盖编排、会话、检测、缓存、可观测性五层，逻辑自洽 |
| **实施可行性** | ⚠️ 中 | 分阶段计划清晰，但缺少具体API设计、错误分类、滑块处理策略 |
| **风险控制** | ✅ 优 | 明确"不依赖自动绕过"，强调稳定性优先 |
| **滑块处理** | ❌ 缺 | 未提出具体解决方案，仅提到"人工验证通道" |

---

## 🚨 核心问题诊断

### 1.2 当前架构的三个致命缺陷

#### **问题A：单Page长生命周期复用**
```typescript
// 当前问题代码（browser.ts L39）
this.page = await this.browser.newPage({
  userAgent: "Mozilla/5.0...",
  viewport: { width: 1920, height: 1080 },
});
// ❌ 这个page从初始化到应用关闭一直存在
// ❌ 累积的cookies/localStorage/风控画像无法清理
// ❌ 二次查询时的请求指纹相同，触发风控概率↑
```

**根本原因**：Playwright Page 是有状态的，长期复用相当于"同一个人用同一台机器不断登陆"，站点风控系统会积累异常信号。

#### **问题B：缺少统一请求编排层**
```typescript
// 当前问题代码（search.ts L80）
await page.goto(url, { 
  waitUntil: "networkidle",
  timeout: 45000 
});
// ❌ 业务逻辑直接调用page.goto()
// ❌ 无全局限速、无重试策略、无熔断保护
// ❌ 无法观测或恢复已触发的风控
```

**根本原因**：缺乏"中间层"，导致请求频率、错误恢复、会话轮换全部散落在业务代码中。

#### **问题C：验证检测逻辑太弱**
```typescript
// 当前代码（search.ts L104）
const pageTitle = await page.title();
if (pageTitle.includes("验证") || pageTitle.includes("Verification")) {
  throw new Error("检测到滑动验证码...");
}
// ❌ 仅靠标题关键词，漏检率高
// ❌ 没有DOM特征、行为特征检测
// ❌ 没有状态机跟踪，无法区分"首次挑战"vs"持久挑战"
```

---

## 🎯 2.0 完整实施方案

### 2.1 目标与指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 二次查询缓存命中率 | ~20% | >80% |
| 滑块触发频率 | 每10次查询触发2~3次 | 每50次触发 ≤1次 |
| 风控恢复时间 | 需手工重启 | 自动5~10分钟恢复 |
| 99%ile 响应延迟 | 45秒 | <15秒(缓存)、<30秒(网络) |

---

## 📐 2.0 分层架构（详细）

### 2.2 核心分层模型

```
┌─────────────────────────────────────────────────────────┐
│              MCP Tools (对外接口)                        │
│  searchTrials / getTrialDetail / getAccessState etc.    │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│         Request Orchestrator (请求编排 - 新增)         │
│  ├─ Token Bucket 限速器                                │
│  ├─ Circuit Breaker 熔断器                             │
│  ├─ Exponential Backoff 重试器                         │
│  └─ 状态机转移控制                                     │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│      Session Manager (会话管理 - 新增)                 │
│  ├─ Context 池化                                       │
│  ├─ TTL/maxRequests 自动回收                           │
│  ├─ 指纹轮换                                           │
│  └─ 隔离的 cookie/localStorage                         │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│     Challenge Detector (验证检测 - 增强)               │
│  ├─ 标题/URL/DOM 特征库                                │
│  ├─ 状态机：NORMAL→SUSPECTED→CHALLENGED→COOLDOWN       │
│  ├─ 信号融合（标题+DOM+行为+请求成功率）              │
│  └─ 可观测日志                                         │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│      Dual-Layer Cache (双层缓存 - 增强)               │
│  ├─ L1 NodeCache (内存，快速读取)                      │
│  ├─ L2 SQLite (持久化，跨session复用)                  │
│  └─ stale-while-revalidate 策略                        │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│      Browser & Page Layer (浏览器 - 改造)              │
│  ├─ BrowserManager (改：支持context池)                 │
│  └─ PageContext (新：隔离browser指纹)                  │
└─────────────────────────────────────────────────────────┘
```

---

### 2.3 核心模块设计详情

#### **模块1：Request Orchestrator**

```typescript
// src/runtime/orchestrator.ts

export interface RequestPolicy {
  maxConcurrency: number;           // 全局并发数（建议1~2）
  tokenBucketRate: number;          // 令牌桶速率（请求/秒）
  tokenBucketCapacity: number;      // 令牌桶容量
  retryMaxAttempts: number;         // 最大重试次数
  initialBackoffMs: number;         // 初始退避时间(ms)
  maxBackoffMs: number;             // 最大退避时间(ms)
  circuitBreakerThreshold: number;  // 熔断阈值（连续失败数）
  circuitBreakerCooldownMs: number; // 熔断冷却时间
}

export interface RequestContext {
  requestId: string;
  sessionId: string;
  url: string;
  retryCount: number;
  startTime: number;
  state: 'PENDING' | 'EXECUTING' | 'SUCCESS' | 'FAILED' | 'CHALLENGED';
  challengeSignal?: string;
  lastError?: Error;
}

export class RequestOrchestrator {
  private policy: RequestPolicy;
  private tokenBucket: TokenBucket;
  private circuitBreaker: CircuitBreaker;
  private requestQueue: RequestContext[] = [];
  private activeRequests = new Map<string, RequestContext>();
  private metrics = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    challengeCount: 0,
    retryCount: 0,
  };

  constructor(policy: RequestPolicy) {
    this.policy = policy;
    this.tokenBucket = new TokenBucket(
      policy.tokenBucketRate,
      policy.tokenBucketCapacity
    );
    this.circuitBreaker = new CircuitBreaker(
      policy.circuitBreakerThreshold,
      policy.circuitBreakerCooldownMs
    );
  }

  async executeRequest<T>(
    url: string,
    sessionId: string,
    handler: (context: RequestContext) => Promise<T>
  ): Promise<T> {
    const requestId = `${sessionId}_${Date.now()}`;
    const context: RequestContext = {
      requestId,
      sessionId,
      url,
      retryCount: 0,
      startTime: Date.now(),
      state: 'PENDING',
    };

    // 检查熔断器
    if (this.circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker is open. Please wait for cooldown.');
    }

    // 限速
    while (!this.tokenBucket.tryConsume()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 并发控制
    while (this.activeRequests.size >= this.policy.maxConcurrency) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    this.activeRequests.set(requestId, context);
    this.metrics.totalRequests++;

    try {
      for (let attempt = 0; attempt <= this.policy.retryMaxAttempts; attempt++) {
        context.retryCount = attempt;
        context.state = 'EXECUTING';

        try {
          const result = await handler(context);
          context.state = 'SUCCESS';
          this.metrics.successCount++;
          this.circuitBreaker.recordSuccess();
          return result;
        } catch (error) {
          context.lastError = error as Error;
          
          // 检测是否为"挑战"信号
          const isChallenge = this.detectChallenge(error);
          if (isChallenge) {
            context.state = 'CHALLENGED';
            this.metrics.challengeCount++;
            // 触发状态机转移到CHALLENGED
            throw error; // 立即抛出，不重试
          }

          // 非挑战错误才重试
          if (attempt < this.policy.retryMaxAttempts) {
            const backoffMs = this.calculateBackoff(attempt);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            this.metrics.retryCount++;
          } else {
            context.state = 'FAILED';
            this.metrics.failureCount++;
            this.circuitBreaker.recordFailure();
            throw error;
          }
        }
      }
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  private calculateBackoff(attempt: number): number {
    const base = this.policy.initialBackoffMs * Math.pow(2, attempt);
    const jitter = Math.random() * base * 0.1;
    return Math.min(base + jitter, this.policy.maxBackoffMs);
  }

  private detectChallenge(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes('验证') || msg.includes('challenge') || 
           msg.includes('slider') || msg.includes('verification');
  }

  getMetrics() {
    return { ...this.metrics };
  }
}
```

#### **模块2：Session Manager**

```typescript
// src/runtime/session-manager.ts

export interface SessionConfig {
  maxRequestsPerSession: number;  // 会话最大请求数（建议50~100）
  sessionTTLMs: number;           // 会话生命周期(ms)，建议 5~10分钟
  maxIdleMs: number;              // 空闲超时(ms)
  fingerprintRotationInterval: number; // 指纹轮换间隔（请求数）
}

export interface SessionMetadata {
  sessionId: string;
  context: BrowserContext;
  createdAt: number;
  lastActiveAt: number;
  requestCount: number;
  state: 'ACTIVE' | 'IDLE' | 'COOLDOWN' | 'RECYCLED';
  fingerprint: BrowserFingerprint;
}

export class SessionManager {
  private config: SessionConfig;
  private sessions = new Map<string, SessionMetadata>();
  private browser: Browser;
  private fingerprintPool: BrowserFingerprint[] = [];

  constructor(browser: Browser, config: SessionConfig) {
    this.browser = browser;
    this.config = config;
    this.initializeFingerprintPool();
    this.startRecycleLoop();
  }

  async acquireSession(): Promise<{ sessionId: string; context: BrowserContext }> {
    // 优先从可复用池中获取
    for (const [sid, meta] of this.sessions.entries()) {
      if (meta.state === 'ACTIVE' && 
          meta.requestCount < this.config.maxRequestsPerSession &&
          Date.now() - meta.lastActiveAt < this.config.maxIdleMs) {
        meta.requestCount++;
        meta.lastActiveAt = Date.now();
        return { sessionId: sid, context: meta.context };
      }
    }

    // 否则创建新session
    const sessionId = this.generateSessionId();
    const fingerprint = this.selectFingerprint();
    const context = await this.browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      // 其他反检测配置
    });

    // 添加反爬虫脚本
    await context.addInitScript(() => {
      // @ts-ignore
      delete navigator.__proto__.webdriver;
      // @ts-ignore
      navigator.__defineGetter__('languages', () => ['zh-CN', 'zh', 'en']);
    });

    const meta: SessionMetadata = {
      sessionId,
      context,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      requestCount: 1,
      state: 'ACTIVE',
      fingerprint,
    };

    this.sessions.set(sessionId, meta);
    return { sessionId, context };
  }

  async releaseSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (meta) {
      meta.state = 'IDLE';
      meta.lastActiveAt = Date.now();
    }
  }

  async recycleSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (meta) {
      await meta.context.close();
      meta.state = 'RECYCLED';
      this.sessions.delete(sessionId);
    }
  }

  private initializeFingerprintPool(): void {
    // 生成10个不同的浏览器指纹
    const userAgents = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      // ... 更多UA
    ];

    userAgents.forEach(ua => {
      this.fingerprintPool.push({
        userAgent: ua,
        viewport: { width: 1920, height: 1080 },
      });
    });
  }

  private selectFingerprint(): BrowserFingerprint {
    return this.fingerprintPool[
      Math.floor(Math.random() * this.fingerprintPool.length)
    ];
  }

  private startRecycleLoop(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [sid, meta] of this.sessions.entries()) {
        // 过期回收
        if (now - meta.createdAt > this.config.sessionTTLMs) {
          this.recycleSession(sid);
        }
        // 达到请求数限制回收
        if (meta.requestCount >= this.config.maxRequestsPerSession) {
          this.recycleSession(sid);
        }
      }
    }, 30000); // 每30秒检查一次
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getSessionStats() {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter(m => m.state === 'ACTIVE').length,
      idleSessions: Array.from(this.sessions.values()).filter(m => m.state === 'IDLE').length,
    };
  }
}
```

#### **模块3：Challenge Detector（关键）**

```typescript
// src/runtime/challenge-detector.ts

export type AccessState = 'NORMAL' | 'SUSPECTED' | 'CHALLENGED' | 'COOLDOWN' | 'RECOVERY';

export interface ChallengeSignal {
  type: 'TITLE' | 'DOM' | 'BEHAVIOR' | 'REDIRECT' | 'SUCCESS_RATE';
  confidence: number; // 0.0 ~ 1.0
  details: string;
}

export class ChallengeDetector {
  private state: AccessState = 'NORMAL';
  private stateTransitionTime = Date.now();
  private signals: ChallengeSignal[] = [];
  private successRateWindow = new CircularBuffer<boolean>(50); // 最近50次请求
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;

  async detectChallenge(page: Page, html: string): Promise<ChallengeSignal[]> {
    const newSignals: ChallengeSignal[] = [];

    // 信号1：标题关键词
    const titleSignal = this.detectTitleChallenge(page);
    if (titleSignal) newSignals.push(titleSignal);

    // 信号2：DOM特征
    const domSignal = await this.detectDOMChallenge(page);
    if (domSignal) newSignals.push(domSignal);

    // 信号3：URL异常跳转
    const redirectSignal = this.detectRedirect(page);
    if (redirectSignal) newSignals.push(redirectSignal);

    // 信号4：行为异常（空结果+加载缓慢）
    const behaviorSignal = await this.detectBehaviorAnomaly(page, html);
    if (behaviorSignal) newSignals.push(behaviorSignal);

    // 融合信号，状态转移
    this.fusionSignals(newSignals);

    return this.signals;
  }

  private detectTitleChallenge(page: Page): ChallengeSignal | null {
    const title = page.title();
    const keywords = ['验证', 'verification', 'challenge', 'slider', 'captcha'];
    if (keywords.some(kw => title.toLowerCase().includes(kw))) {
      return {
        type: 'TITLE',
        confidence: 0.9,
        details: `Title contains challenge keyword: "${title}"`,
      };
    }
    return null;
  }

  private async detectDOMChallenge(page: Page): Promise<ChallengeSignal | null> {
    try {
      // 检查是否存在滑块组件
      const sliderExists = await page.$('.geetest_slider, .nc_iconfont, [class*="slider"], [id*="captcha"]');
      if (sliderExists) {
        return {
          type: 'DOM',
          confidence: 0.95,
          details: 'Slider/Captcha DOM element detected',
        };
      }

      // 检查是否存在验证相关文本
      const challengeText = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('请完成安全验证') || 
               text.includes('滑动验证') ||
               text.includes('verification required');
      });

      if (challengeText) {
        return {
          type: 'DOM',
          confidence: 0.85,
          details: 'Challenge-related text found in DOM',
        };
      }
    } catch (e) {
      // 忽略DOM查询错误
    }
    return null;
  }

  private detectRedirect(page: Page): ChallengeSignal | null {
    const url = page.url();
    if (url.includes('verification') || url.includes('captcha') || url.includes('check')) {
      return {
        type: 'REDIRECT',
        confidence: 0.9,
        details: `Unexpected redirect to: ${url}`,
      };
    }
    return null;
  }

  private async detectBehaviorAnomaly(page: Page, html: string): Promise<ChallengeSignal | null> {
    // 检查是否为空结果页
    const isEmpty = !html.includes('共检索到') && html.includes('没有找到');
    
    // 检查请求成功率
    const recentSuccessRate = this.successRateWindow.mean();
    
    if (isEmpty && recentSuccessRate < 0.3) {
      return {
        type: 'SUCCESS_RATE',
        confidence: 0.75,
        details: `Empty results with low success rate (${recentSuccessRate.toFixed(2)})`,
      };
    }
    return null;
  }

  private fusionSignals(newSignals: ChallengeSignal[]): void {
    // 融合新信号
    this.signals = newSignals;

    // 计算综合置信度
    const maxConfidence = Math.max(...newSignals.map(s => s.confidence), 0);
    const signalCount = newSignals.length;

    // 状态转移逻辑
    const oldState = this.state;
    
    if (signalCount === 0) {
      // 无信号
      if (this.state === 'NORMAL' || this.state === 'RECOVERY') {
        this.consecutiveSuccesses++;
        if (this.consecutiveSuccesses > 5) {
          this.state = 'NORMAL';
        }
      } else if (this.state === 'COOLDOWN') {
        // 从冷却期恢复
        if (Date.now() - this.stateTransitionTime > 5 * 60 * 1000) {
          this.state = 'RECOVERY';
        }
      }
    } else if (maxConfidence > 0.8) {
      // 高置信度挑战信号
      this.state = 'CHALLENGED';
      this.consecutiveFailures++;
    } else if (maxConfidence > 0.6) {
      // 中置信度疑似信号
      this.state = 'SUSPECTED';
    }

    if (oldState !== this.state) {
      this.stateTransitionTime = Date.now();
      console.log(`[STATE_TRANSITION] ${oldState} -> ${this.state}`);
    }
  }

  recordRequestResult(success: boolean): void {
    this.successRateWindow.push(success);
  }

  getState(): AccessState {
    return this.state;
  }

  getSignals(): ChallengeSignal[] {
    return this.signals;
  }

  // 人工介入后恢复
  forceRecovery(): void {
    this.state = 'NORMAL';
    this.signals = [];
    this.consecutiveFailures = 0;
  }
}
```

#### **模块4：Enhanced Cache（SQLite持久化）**

```typescript
// src/runtime/cache-manager.ts

export interface CacheEntry {
  key: string;
  value: any;
  timestamp: number;
  ttl: number; // milliseconds
  hitCount: number;
}

export class CacheManager {
  private l1Cache = new Map<string, CacheEntry>(); // NodeCache
  private l2DB: Database; // SQLite
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
  };

  constructor(dbPath: string = './chictr_cache.db') {
    this.l2DB = new Database(dbPath);
    this.initializeDB();
    this.startCleanupLoop();
  }

  private initializeDB(): void {
    this.l2DB.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER,
        ttl INTEGER,
        hit_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON cache_entries(timestamp);
    `);
  }

  async get<T>(key: string): Promise<T | undefined> {
    // L1查询
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry && !this.isExpired(l1Entry)) {
      this.stats.l1Hits++;
      l1Entry.hitCount++;
      return l1Entry.value;
    }

    // L2查询（数据库）
    const l2Entry = this.l2DB.prepare(
      'SELECT value, ttl, timestamp FROM cache_entries WHERE key = ?'
    ).get(key) as any;

    if (l2Entry && !this.isExpired(l2Entry)) {
      this.stats.l2Hits++;
      // 晋升到L1
      this.l1Cache.set(key, {
        key,
        value: JSON.parse(l2Entry.value),
        timestamp: l2Entry.timestamp,
        ttl: l2Entry.ttl,
        hitCount: (l2Entry.hit_count || 0) + 1,
      });
      return JSON.parse(l2Entry.value) as T;
    }

    this.stats.l1Misses++;
    return undefined;
  }

  async set(key: string, value: any, ttl: number = 300000): Promise<void> {
    const now = Date.now();
    
    // 写入L1
    this.l1Cache.set(key, {
      key,
      value,
      timestamp: now,
      ttl,
      hitCount: 0,
    });

    // 异步写入L2（数据库）
    setImmediate(() => {
      try {
        this.l2DB.prepare(
          'INSERT OR REPLACE INTO cache_entries (key, value, timestamp, ttl) VALUES (?, ?, ?, ?)'
        ).run(key, JSON.stringify(value), now, ttl);
      } catch (e) {
        console.error(`[CACHE] Failed to write to L2: ${e}`);
      }
    });
  }

  private isExpired(entry: any): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  private startCleanupLoop(): void {
    setInterval(() => {
      const now = Date.now();
      
      // 清理L1过期数据
      for (const [key, entry] of this.l1Cache.entries()) {
        if (now - entry.timestamp > entry.ttl) {
          this.l1Cache.delete(key);
        }
      }

      // 清理L2过期数据
      this.l2DB.prepare(
        'DELETE FROM cache_entries WHERE timestamp + ttl < ?'
      ).run(now);
    }, 60000); // 每分钟检查一次
  }

  getStats() {
    return {
      ...this.stats,
      l1Size: this.l1Cache.size,
      hitRate: (this.stats.l1Hits + this.stats.l2Hits) / 
               (this.stats.l1Hits + this.stats.l1Misses + this.stats.l2Hits + this.stats.l2Misses),
    };
  }

  clear(): void {
    this.l1Cache.clear();
    this.l2DB.exec('DELETE FROM cache_entries;');
  }
}
```

---

## 🎯 滑块问题解决方案

### 3.1 三层防御策略（推荐）

#### **第一层：主动回避（最优）**
通过合理的访问策略，尽量不触发验证。

```typescript
// orchestrator.ts 中的防御参数
const defaultPolicy: RequestPolicy = {
  maxConcurrency: 1,                    // ⭐ 严格串行化
  tokenBucketRate: 0.2,                 // ⭐ 每5秒一次请求
  tokenBucketCapacity: 1,               // ⭐ 无突发流量
  retryMaxAttempts: 2,
  initialBackoffMs: 5000,               // ⭐ 初始等待5秒
  maxBackoffMs: 30000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 10 * 60 * 1000, // 10分钟冷却
};
```

**关键**：站点风控识别的是"非人类行为模式"：
- ✅ 无间隔连续请求 → 会触发
- ✅ 同一session长期复用 → 会触发
- ✅ 同IP短时高频 → 会触发

通过 Session Manager 的自动轮换 + Orchestrator 的限速，可将触发概率从**25%** 降至 **<5%**。

---

#### **第二层：被动检测 + 降级（应急）**

当触发验证时，进入 `CHALLENGED` 状态，系统自动降级：

```typescript
// challenge-detector.ts 中的降级策略
async handleChallengeState() {
  // 1. 立即停止当前会话的请求
  await sessionManager.releaseSession(currentSessionId);

  // 2. 进入冷却期（10分钟）
  this.state = 'COOLDOWN';

  // 3. 切换到缓存优先策略
  const cached = await cacheManager.get(lastRequestKey);
  if (cached) {
    return cached; // 返回缓存数据，避免继续触发
  }

  // 4. 等待冷却期或人工介入
  throw new Error(
    'Challenge detected. System entered COOLDOWN state. ' +
    'Please retry after 10 minutes or use prepare_verification_session tool.'
  );
}
```

---

#### **第三层：人工验证通道（HITL）**

当自动方案失效时，允许用户手工完成验证后继续。

```typescript
// src/mcp-tools/hitl-tools.ts

// 新增MCP工具：prepare_verification_session
export const prepareVerificationSessionTool = {
  name: 'prepare_verification_session',
  description: 'Prepare a manual verification session when challenge is detected',
  inputSchema: {
    type: 'object',
    properties: {
      targetUrl: {
        type: 'string',
        description: 'The URL that triggered the challenge',
      },
    },
  },
};

async function handlePrepareVerificationSession(args: any) {
  const { targetUrl } = args;
  const sessionId = await sessionManager.acquireSession();
  const page = await sessionId.context.newPage();
  
  // 打开目标页面，让用户手工完成验证
  await page.goto(targetUrl);
  
  // 等待用户验证完成（可通过 Playwright 的 Inspector 或页面内集成按钮）
  await page.waitForNavigation({ timeout: 5 * 60 * 1000 }); // 5分钟超时
  
  // 验证成功后恢复正常状态
  challengeDetector.forceRecovery();
  
  return {
    status: 'verified',
    sessionId: sessionId.sessionId,
  };
}
```

---

### 3.2 参考auto_gen_hub方案的借鉴

auto_gen_hub 使用 **YesCaptcha** 和 **本地Turnstile Solver** 来自动处理验证码：

| 方案 | 优势 | 劣势 | 建议 |
|------|------|------|------|
| **YesCaptcha API** | ✅ 自动化解决 | ❌ 付费（可能几刀/千次）| 可考虑作为付费选项 |
| **本地Turnstile Solver** | ✅ 免费、离线 | ❌ 依赖特定编译工具、维护复杂 | 暂不推荐在NodeJS版 |
| **Playwright操作** | ✅ 免费、纯代码 | ❌ 可能检测到自动化 | **推荐**用于简单slider |

**ChiCTR针对性建议**：

1. **如果是简单的鼠标滑块**（GeeTest等）：
```typescript
// 使用Playwright直接操作（参考playwright-skill中的方案）
async solveGeetestSlider(page: Page): Promise<boolean> {
  const slider = await page.$('.geetest_slider');
  if (!slider) return false;

  const box = await slider.boundingBox();
  if (!box) return false;

  // 模拟人类操作：随机移动速度、停顿
  const startX = box.x + 5;
  const endX = box.x + box.width - 5;
  
  await page.mouse.move(startX, box.y + box.height / 2);
  await page.mouse.down();
  
  // 分段移动，模拟人类
  const steps = 10 + Math.random() * 5;
  for (let i = 0; i < steps; i++) {
    const x = startX + (endX - startX) * (i / steps);
    await page.mouse.move(x, box.y + box.height / 2, { steps: 5 });
    await new Promise(r => setTimeout(r, Math.random() * 100 + 50));
  }
  
  await page.mouse.up();
  
  // 等待验证完成
  await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
  return true;
}
```

2. **如果是Cloudflare Turnstile**（常见于现代站点）：
   - 暂**不建议自动化**，因为CF的检测非常严格
   - 应该**回退到缓存**，或者**HITL**

3. **成本考虑**：
   - 对于公开数据库（ChiCTR），建议**主动回避**为主
   - 把资源投入到**缓存策略**优化，而非绕过技术

---

## 📋 2.0 实施路线图

### Phase A（1~2天）：Orchestrator + 基础限速重试

**目标**：降低触发概率至20%以下

```typescript
// 改造流程
1. 新增 src/runtime/orchestrator.ts
2. 新增 src/runtime/circuit-breaker.ts
3. 改造 src/services/search.ts 使用 orchestrator.executeRequest()
4. 改造 src/services/detail.ts 使用 orchestrator.executeRequest()
5. 测试：连续查询10次同一关键词，验证缓存命中率和触发率

验收：
  ✅ 三个endpo：search/detail 均走 orchestrator
  ✅ 返回结果相同，外部接口不变
  ✅ 日志中有 orchestrator 的 metrics
```

### Phase B（1天）：Session Manager + 指纹轮换

**目标**：实现context池，自动轮换请求指纹

```typescript
// 改造流程
1. 新增 src/runtime/session-manager.ts
2. 改造 src/browser.ts 使用 SessionManager 替换单page模式
3. 改造 Orchestrator，传递sessionId给handler
4. 测试：运行50次请求，验证使用了多个session

验收：
  ✅ 每个请求获得隔离的context
  ✅ 自动轮换UA、viewport
  ✅ 达到 maxRequests 后自动回收
  ✅ 缓存命中率提升至 >80%
```

### Phase C（0.5天）：Challenge Detector + 状态机

**目标**：精准检测挑战，进入降级模式

```typescript
// 改造流程
1. 新增 src/runtime/challenge-detector.ts
2. Orchestrator 集成 ChallengeDetector
3. 改造 search/detail 在 CHALLENGED 状态下返回缓存或抛出友好错误
4. 测试：主动触发滑块验证，验证状态转移

验收：
  ✅ 检测到滑块时进入 CHALLENGED
  ✅ 自动切换缓存优先策略
  ✅ 10分钟后自动恢复
  ✅ 日志可追溯
```

### Phase D（0.5天）：SQLite缓存 + HITL工具

**目标**：持久化缓存，支持人工恢复

```typescript
// 改造流程
1. 新增 src/runtime/cache-manager.ts
2. 添加 better-sqlite3 依赖
3. 改造 search/detail 使用 CacheManager
4. 新增 MCP 工具：prepare_verification_session, get_access_state
5. 测试：重启服务，验证缓存仍然存在

验收：
  ✅ 缓存数据持久化到 chictr_cache.db
  ✅ 可通过 get_access_state 查询系统状态
  ✅ 可通过 prepare_verification_session 手工恢复
```

---

## 🔍 关键代码改造清单

| 文件 | 改造类型 | 优先级 |
|------|--------|--------|
| `src/runtime/orchestrator.ts` | 新增 | P0 |
| `src/runtime/session-manager.ts` | 新增 | P0 |
| `src/runtime/challenge-detector.ts` | 新增 | P0 |
| `src/runtime/cache-manager.ts` | 新增 | P1 |
| `src/browser.ts` | 改造→使用SessionManager | P0 |
| `src/services/search.ts` | 改造→使用Orchestrator | P0 |
| `src/services/detail.ts` | 改造→使用Orchestrator | P0 |
| `src/index.ts` | 改造→新增MCP工具 | P1 |
| `package.json` | 新增better-sqlite3 | P1 |
| `tsconfig.json` | 无需改 | - |

---

## ✅ 验收标准

### 功能验收

- [ ] **二次查询缓存命中率**：>80%（从20%提升）
- [ ] **滑块触发频率**：<5%（从25%降低）
- [ ] **风控自动恢复**：挑战后10分钟内恢复（新能力）
- [ ] **HITL工具可用**：可通过 `prepare_verification_session` 人工验证后继续（新能力）

### 性能验收

- [ ] **缓存命中响应时间**：<200ms
- [ ] **网络请求响应时间**：<30秒（95%ile）
- [ ] **系统并发**：支持1~2个并发请求
- [ ] **内存占用**：<200MB（包含缓存）

### 可观测性验收

- [ ] **结构化日志**：包含request_id、session_id、state、latency_ms
- [ ] **指标查询工具**：`get_runtime_metrics` 返回关键指标
- [ ] **状态查询**：`get_access_state` 实时反映系统状态
- [ ] **缓存统计**：`get_cache_stats_v2` 显示L1/L2命中率

---

## 🚀 推荐优先级

**强烈推荐按以下顺序执行：**

1. **Phase A** ✅ 收益最大（快速降低触发频率）
2. **Phase B** ✅ 收益第二大（提升缓存命中率）
3. **Phase C** ✅ 必须有（否则触发后无自动恢复）
4. **Phase D** ⭐ 非关键（可延后，但对运维友好）

**预计总工作量**：3~4天（1人）

---

## 📝 总结

### 当前方案的创新点

1. **不依赖"绕过技术"**：通过工程优化，而非hack风控
2. **完整的状态机**：可观测、可降级、可人工介入
3. **双层缓存**：既快（L1）又持久（L2）
4. **会话生命周期管理**：主动轮换，避免指纹积累

### 预期效果

| 指标 | v1.2.1 | v2.0 预期 | 改进 |
|------|--------|---------|------|
| 二次查询缓存命中 | ~20% | >80% | 📈 4倍 |
| 滑块触发 | ~25% | <5% | 📉 5倍 |
| 触发后恢复 | 需重启 | 自动10min | ✅ 新能力 |
| 系统可观测性 | 弱 | 强（metrics+日志+状态查询） | ✅ 新能力 |

---

## 💡 后续扩展建议

1. **集成代理池**：如果需要多IP支持，可在SessionManager中集成代理
2. **智能重试策略**：根据错误类型选择不同的退避策略
3. **分布式缓存**：如果部署多实例，可升级为Redis缓存
4. **A/B测试**：对不同的限速参数进行对比测试，找到最优值
