import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./circuit-breaker.js";

test("circuit breaker should open after threshold failures", () => {
  const cb = new CircuitBreaker(2, 1000);
  cb.recordFailure(0);
  assert.equal(cb.getState(), "CLOSED");
  cb.recordFailure(10);
  assert.equal(cb.getState(), "OPEN");
});

test("circuit breaker should allow execute in half-open after cooldown", () => {
  const cb = new CircuitBreaker(1, 1000);
  cb.recordFailure(0);
  assert.equal(cb.canExecute(500), false);
  assert.equal(cb.canExecute(1200), true);
  assert.equal(cb.getState(), "HALF_OPEN");
  cb.recordSuccess();
  assert.equal(cb.getState(), "CLOSED");
});

