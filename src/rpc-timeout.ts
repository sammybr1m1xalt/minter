// ── RPC read timeout ────────────────────────────────────────────────────────
//
// ethers v6 has no provider timeout: a dead endpoint holds the promise (and
// whatever called it) open until the OS gives up on the socket — 5 s on a
// refused port, minutes on a blackholed route. Every read that is not already
// bounded by its caller goes through this.
//
// This lives in its own module because more than one module needs it. It used
// to be private to seadrop-public.ts, which made that file the only place a
// bounded read could happen — and a SeaDrop module is not where a generic
// reader should have to import its timeout from.

/**
 * Bound an RPC read.
 *
 * The timer is cleared in `finally` so a settled promise never leaves a live
 * timer keeping the process alive.
 */
export async function withRpcTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default ceiling for a single chain read. 15 s is long enough for a slow
 * public RPC under load and short enough that a blackholed endpoint cannot
 * stall a mint plan for minutes.
 *
 * Overridable with RPC_TIMEOUT_MS so a run can be tuned without editing code —
 * lower it on a fast private node, raise it on a congested public one. A
 * missing, zero, negative or non-numeric value falls back to the default rather
 * than disabling the timeout.
 */
function readTimeoutOverride(): number | null {
  const raw = process.env.RPC_TIMEOUT_MS;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export const DEFAULT_READ_TIMEOUT_MS = readTimeoutOverride() ?? 15000;
