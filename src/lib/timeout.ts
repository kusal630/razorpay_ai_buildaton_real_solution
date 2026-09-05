/**
 * timeout.ts — bounded waits for dependency calls.
 *
 * A hung downstream (gateway socket that never answers, stalled LLM
 * relay) must NEVER wedge the scheduler: with single-flight ticks, one
 * unsettled await stops ALL future ticks. Race the call against a timer;
 * on expiry reject loudly (the caller's catch logs it) while the tick
 * moves on. The underlying promise is left to settle on its own — the
 * SDK gives us no abort handle, but a dangling socket is survivable
 * while a wedged loop is not.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    // A pending timeout must never hold the process open by itself.
    if (typeof (timer as any)?.unref === "function") (timer as any).unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Scheduler gateway budget: slow dependency, not a hung one. */
export const GATEWAY_TIMEOUT_MS = 15000;
