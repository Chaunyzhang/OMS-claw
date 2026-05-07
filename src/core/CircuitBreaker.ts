export interface CircuitBreakerState {
  feature: string;
  status: "closed" | "open";
  failureCount: number;
  reopenAt?: number;
  lastError?: string;
}

export class CircuitBreaker {
  private readonly states = new Map<string, CircuitBreakerState>();

  canCall(feature: string, now = Date.now()): boolean {
    const state = this.states.get(feature);
    if (!state || state.status === "closed") {
      return true;
    }
    if (state.reopenAt !== undefined && state.reopenAt <= now) {
      this.states.set(feature, { feature, status: "closed", failureCount: 0 });
      return true;
    }
    return false;
  }

  recordSuccess(feature: string): void {
    this.states.set(feature, { feature, status: "closed", failureCount: 0 });
  }

  recordFailure(feature: string, error: unknown, now = Date.now()): CircuitBreakerState {
    const previous = this.states.get(feature);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    const open = failureCount >= 3;
    const state: CircuitBreakerState = {
      feature,
      status: open ? "open" : "closed",
      failureCount,
      reopenAt: open ? now + 5 * 60 * 1000 : undefined,
      lastError: error instanceof Error ? error.message : String(error)
    };
    this.states.set(feature, state);
    return state;
  }
}
