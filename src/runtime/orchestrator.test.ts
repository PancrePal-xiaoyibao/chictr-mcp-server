import test from "node:test";
import assert from "node:assert/strict";
import { RequestOrchestrator } from "./orchestrator.js";

test("orchestrator should retry retryable errors and finally succeed", async () => {
  const orchestrator = new RequestOrchestrator({
    maxConcurrency: 1,
    tokenBucketRate: 100,
    tokenBucketCapacity: 10,
    retryMaxAttempts: 2,
    initialBackoffMs: 1,
    maxBackoffMs: 5,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 1000,
  });

  let attempts = 0;
  const result = await orchestrator.execute({
    requestId: "r1",
    endpoint: "search",
    handler: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("network timeout");
      }
      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(orchestrator.getMetrics().retryCount, 2);
});

test("orchestrator should not retry challenge errors", async () => {
  const orchestrator = new RequestOrchestrator({
    maxConcurrency: 1,
    tokenBucketRate: 100,
    tokenBucketCapacity: 10,
    retryMaxAttempts: 3,
    initialBackoffMs: 1,
    maxBackoffMs: 5,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 1000,
  });

  let attempts = 0;
  await assert.rejects(async () => {
    await orchestrator.execute({
      requestId: "r2",
      endpoint: "detail",
      handler: async () => {
        attempts += 1;
        throw new Error("检测到滑动验证码");
      },
    });
  });

  assert.equal(attempts, 1);
  assert.equal(orchestrator.getMetrics().challengeCount, 1);
});

