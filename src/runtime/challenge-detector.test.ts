import test from "node:test";
import assert from "node:assert/strict";
import { ChallengeDetector } from "./challenge-detector.js";

test("challenge detector should enter cooldown after challenge", () => {
  const d = new ChallengeDetector(1000);
  d.reportChallenge([{ type: "TITLE", confidence: 0.9, details: "verification title" }], 100);
  const snap = d.getSnapshot(200);
  assert.equal(snap.state, "COOLDOWN");
  assert.equal(snap.cooldown_remaining_ms, 900);
});

test("challenge detector should recover after cooldown and successes", () => {
  const d = new ChallengeDetector(1000);
  d.reportChallenge([{ type: "URL", confidence: 0.8, details: "redirected" }], 100);
  assert.equal(d.canProceed(500), false);
  assert.equal(d.canProceed(1200), true);
  d.recordSuccess();
  d.recordSuccess();
  const snap = d.getSnapshot(1300);
  assert.equal(snap.state, "NORMAL");
});

