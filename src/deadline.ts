/**
 * Deadline helper for RPC work.
 *
 * ethers 6.17 has no timeout option on JsonRpcProvider (verified: the options
 * interface at provider-jsonrpc.d.ts exposes only staticNetwork, batchStallTime,
 * batchMaxCount, cacheTimeout and pollingInterval), and its FetchRequest
 * defaults to a 300000 ms timeout with 429 backoff (utils/fetch.js). A single
 * stalled endpoint can therefore hold a caller for ~5 minutes — fatal inside a
 * T-0 fire window.
 *
 * Every ethers call on a time-critical path should be wrapped in this.
 */

/**
 * Run a promise under a deadline.
 *
 * Returns null when the deadline expires; rethrows any other rejection.
 *
 * The losing promise is NOT cancelled — JS cannot cancel an in-flight fetch —
 * but a late rejection is swallowed so it cannot surface as an unhandled
 * rejection. Callers must treat null as "could not tell in time" and decide
 * accordingly (skip the wallet, fail open, or fall back), never as a value.
 */
export async function withDeadline<T>(
  p: Promise<T>,
  timeoutMs: number,
  label = "call"
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach a no-op catch so a rejection arriving after the deadline is
  // consumed here rather than becoming an unhandled rejection.
  p.catch(() => {});
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Error thrown when a bounded call times out, for call sites that must not fail open. */
export class DeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "DeadlineError";
  }
}

/**
 * Like withDeadline, but throws DeadlineError instead of returning null.
 * Use where proceeding without the value would be worse than skipping.
 */
export async function withDeadlineOrThrow<T>(
  p: Promise<T>,
  timeoutMs: number,
  label = "call"
): Promise<T> {
  const result = await withDeadline(p, timeoutMs, label);
  if (result === null) throw new DeadlineError(label, timeoutMs);
  return result;
}
