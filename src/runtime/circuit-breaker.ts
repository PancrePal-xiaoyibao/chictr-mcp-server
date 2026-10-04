export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number
  ) {}

  canExecute(now: number = Date.now()): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (now - this.openedAt < this.cooldownMs) return false;
      this.state = "HALF_OPEN";
    }

    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.halfOpenProbeInFlight = false;
    this.state = "CLOSED";
  }

  recordFailure(now: number = Date.now()): void {
    this.failures += 1;
    this.halfOpenProbeInFlight = false;
    if (this.state === "HALF_OPEN" || this.failures >= this.threshold) {
      this.state = "OPEN";
      this.openedAt = now;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

