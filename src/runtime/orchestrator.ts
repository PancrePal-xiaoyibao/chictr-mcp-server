import { CircuitBreaker } from "./circuit-breaker.js";
import { AppErrorCode, classifyError } from "./errors.js";

export interface RequestPolicy {
  maxConcurrency: number;
  tokenBucketRate: number;
  tokenBucketCapacity: number;
  retryMaxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

export interface RuntimeMetrics {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  challengeCount: number;
  retryCount: number;
  activeRequests: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const refillTokens = elapsedSeconds * this.ratePerSecond;
    if (refillTokens > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refillTokens);
      this.lastRefill = now;
    }
  }
}

export class RequestOrchestrator {
  private readonly tokenBucket: TokenBucket;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly activeRequests = new Set<string>();
  private readonly metrics: RuntimeMetrics = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    challengeCount: 0,
    retryCount: 0,
    activeRequests: 0,
  };

  constructor(private readonly policy: RequestPolicy) {
    this.tokenBucket = new TokenBucket(policy.tokenBucketRate, policy.tokenBucketCapacity);
    this.circuitBreaker = new CircuitBreaker(
      policy.circuitBreakerThreshold,
      policy.circuitBreakerCooldownMs
    );
  }

  static createDefault(): RequestOrchestrator {
    return new RequestOrchestrator({
      maxConcurrency: 1,
      tokenBucketRate: 0.2,
      tokenBucketCapacity: 1,
      retryMaxAttempts: 2,
      initialBackoffMs: 1200,
      maxBackoffMs: 10_000,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 10 * 60 * 1000,
    });
  }

  async execute<T>(params: {
    requestId: string;
    endpoint: "search" | "detail";
    handler: () => Promise<T>;
  }): Promise<T> {
    const { requestId, handler } = params;
    this.metrics.totalRequests += 1;

    if (!this.circuitBreaker.canExecute()) {
      throw new Error("Circuit breaker is open. Please retry after cooldown.");
    }

    while (!this.tokenBucket.tryConsume()) {
      await this.sleep(100);
    }

    while (this.activeRequests.size >= this.policy.maxConcurrency) {
      await this.sleep(100);
    }

    this.activeRequests.add(requestId);
    this.metrics.activeRequests = this.activeRequests.size;

    try {
      for (let attempt = 0; attempt <= this.policy.retryMaxAttempts; attempt++) {
        try {
          const result = await handler();
          this.metrics.successCount += 1;
          this.circuitBreaker.recordSuccess();
          return result;
        } catch (error) {
          const classified = classifyError(error);
          if (classified.code === AppErrorCode.CHALLENGE_ERROR) {
            this.metrics.challengeCount += 1;
            this.metrics.failureCount += 1;
            this.circuitBreaker.recordFailure();
            throw error;
          }

          if (!classified.retryable || attempt >= this.policy.retryMaxAttempts) {
            this.metrics.failureCount += 1;
            this.circuitBreaker.recordFailure();
            throw error;
          }

          this.metrics.retryCount += 1;
          const delayMs = this.calculateBackoff(attempt);
          await this.sleep(delayMs);
        }
      }
    } finally {
      this.activeRequests.delete(requestId);
      this.metrics.activeRequests = this.activeRequests.size;
    }

    throw new Error("Unexpected orchestration exit");
  }

  getMetrics(): RuntimeMetrics {
    return { ...this.metrics };
  }

  private calculateBackoff(attempt: number): number {
    const base = this.policy.initialBackoffMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.max(1, base * 0.1));
    return Math.min(base + jitter, this.policy.maxBackoffMs);
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

