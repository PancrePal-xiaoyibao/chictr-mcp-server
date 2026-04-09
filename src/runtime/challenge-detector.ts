export type AccessState = "NORMAL" | "SUSPECTED" | "CHALLENGED" | "COOLDOWN" | "RECOVERY";
export type ChallengeSignalType = "TITLE" | "URL" | "DOM" | "BEHAVIOR";

export interface ChallengeSignal {
  type: ChallengeSignalType;
  confidence: number;
  details: string;
  at: number;
}

export interface AccessStateSnapshot {
  state: AccessState;
  cooldown_remaining_ms: number;
  last_transition_at: string;
  recent_signals: ChallengeSignal[];
  consecutive_failures: number;
}

export class ChallengeDetector {
  private state: AccessState = "NORMAL";
  private lastTransitionAt = Date.now();
  private cooldownUntil = 0;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private recentSignals: ChallengeSignal[] = [];

  constructor(private readonly cooldownMs: number = 10 * 60 * 1000) {}

  canProceed(now: number = Date.now()): boolean {
    if (this.state !== "COOLDOWN") return true;
    if (now >= this.cooldownUntil) {
      this.transition("RECOVERY");
      return true;
    }
    return false;
  }

  getSnapshot(now: number = Date.now()): AccessStateSnapshot {
    const remaining =
      this.state === "COOLDOWN" ? Math.max(0, this.cooldownUntil - now) : 0;
    return {
      state: this.state,
      cooldown_remaining_ms: remaining,
      last_transition_at: new Date(this.lastTransitionAt).toISOString(),
      recent_signals: [...this.recentSignals],
      consecutive_failures: this.consecutiveFailures,
    };
  }

  reportChallenge(signals: Omit<ChallengeSignal, "at">[], now: number = Date.now()): void {
    const normalized: ChallengeSignal[] = signals.map((s) => ({ ...s, at: now }));
    this.recentSignals = [...normalized].slice(-5);
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.transition("CHALLENGED", now);
    this.enterCooldown(now);
  }

  recordSuccess(): void {
    this.consecutiveSuccesses += 1;
    this.consecutiveFailures = 0;
    this.recentSignals = [];
    if (this.state === "RECOVERY" && this.consecutiveSuccesses >= 2) {
      this.transition("NORMAL");
    } else if (this.state === "SUSPECTED" || this.state === "CHALLENGED") {
      this.transition("RECOVERY");
    }
  }

  forceRecovery(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.recentSignals = [];
    this.cooldownUntil = 0;
    this.transition("RECOVERY");
  }

  markSuspected(signal: Omit<ChallengeSignal, "at">): void {
    const now = Date.now();
    this.recentSignals = [{ ...signal, at: now }].slice(-5);
    if (this.state === "NORMAL") {
      this.transition("SUSPECTED", now);
    }
  }

  private enterCooldown(now: number): void {
    this.cooldownUntil = now + this.cooldownMs;
    this.transition("COOLDOWN", now);
  }

  private transition(next: AccessState, at: number = Date.now()): void {
    if (this.state === next) return;
    this.state = next;
    this.lastTransitionAt = at;
  }
}

