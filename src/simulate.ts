// ── Pre-broadcast simulation gate ───────────────────────────────────────────
//
// Simulates before EVERY broadcast:
//
//     // Simulate before broadcast.
//     try { await provider.call(txRequest); }
//     catch (e) { throw new Error(`simulation revert: ${parseRevert(e)}`); }
//
// The TS port had no simulation anywhere in the mint path — it signed and
// blasted unconditionally. That means a guaranteed revert (closed sale, wrong
// stage, insufficient allocation, a payload bound to another wallet) still
// costs gas to discover, and the failure surfaces as a reverted receipt rather
// than a refusal to send.
//
// This module is the shared gate. Both mint paths call it before signing.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY SIMULATE AT ALL WHEN WE BLAST TO MANY ENDPOINTS?
// ────────────────────────────────────────────────────────────────────────────
// Simulation is not a substitute for broadcasting — it is a filter. A tx that
// reverts in eth_call will revert on-chain, so sending it buys a guaranteed
// loss of gas plus a receipt poll. The blast is for redundancy against
// endpoint failure, not for hoping one node evaluates the call differently.

import { JsonRpcProvider } from "ethers";

export interface SimulateRequest {
  to: string;
  from: string;
  data: string;
  value: bigint;
  /** Optional — some mints check msg.sender-specific state. */
  gasLimit?: bigint;
}

export interface SimulateResult {
  ok: boolean;
  /** True when the call reverted. */
  reverted: boolean;
  /** Human-readable revert reason, when the node supplied one. */
  reason?: string;
  /** Raw revert data, for programmatic matching. */
  data?: string;
  /**
   * True when we could not determine an answer (network error, timeout, RPC
   * refusal). Distinct from `reverted`: a reverted call is a definitive NO,
   * while an indeterminate one is unknown — and treating unknown as NO would
   * block a perfectly good mint because a public RPC had a bad moment.
   */
  indeterminate?: boolean;
}

/**
 * Extract a revert reason from an ethers error across the shapes different
 * RPC providers return. Never throws.
 */
export function parseRevert(err: any): { reason?: string; data?: string } {
  if (!err) return {};

  // ethers v6 puts the revert data on err.data, and the reason on
  // err.reason / err.shortMessage. Some providers nest it under
  // err.info.error.data (the raw JSON-RPC error object).
  const data =
    err.data ??
    err.info?.error?.data ??
    err.error?.data ??
    (typeof err.message === "string" && err.message.startsWith("0x") ? err.message : undefined);

  let reason: string | undefined;
  if (typeof err.reason === "string") reason = err.reason;
  else if (typeof err.shortMessage === "string") reason = err.shortMessage;
  else if (typeof err.message === "string") {
    // ethers wraps revert data as "execution reverted: <reason>" or
    // "execution reverted (no data present; likely require(false))".
    const m = err.message.match(/execution reverted:?\s*(.*)$/);
    reason = m ? m[1].trim() : err.message;
  }

  // Omit keys that are undefined rather than emitting them explicitly — a
  // caller doing `Object.keys()` or a deep-equal should not see phantom fields.
  const out: { reason?: string; data?: string } = {};
  if (reason !== undefined) out.reason = reason;
  if (data !== undefined) out.data = data;
  return out;
}

/**
 * True when an error from a node means "we could not tell", not "the call
 * reverts". Shared by the simulation gate and the gas-estimate path so the two
 * can never disagree about what counts as a revert — a transport failure must
 * not be read as a verdict, or a public RPC having a bad moment blocks a good
 * mint.
 */
export function isIndeterminateRpcError(err: any): boolean {
  const msg = String(err?.reason ?? err?.shortMessage ?? err?.message ?? "").toLowerCase();
  return (
    err?.name === "AbortError" ||
    /timeout|timed out|network error|failed to fetch|socket|econnrefused|enotfound|eai_again/i.test(msg)
  );
}

/**
 * Simulate a transaction with eth_call.
 *
 * Returns { ok: true } when the call succeeds, { ok: false, reverted: true }
 * when it reverts. A NETWORK failure is reported as reverted: false with a
 * reason, so the caller can distinguish "the tx would revert" from "we could
 * not tell" — those need different handling.
 */
export async function simulateTx(
  provider: JsonRpcProvider,
  req: SimulateRequest,
  timeoutMs = 10_000
): Promise<SimulateResult> {
  // A hard timeout is mandatory. ethers retries a dead endpoint with exponential
  // backoff and no ceiling, so an unreachable RPC would otherwise hang the mint
  // path indefinitely. A simulation is a nice-to-have — it must never be able to
  // block a broadcast forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.call({
        to: req.to,
        from: req.from,
        data: req.data,
        value: req.value,
        ...(req.gasLimit ? { gasLimit: req.gasLimit } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`simulation timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return { ok: true, reverted: false };
  } catch (err: any) {
    const { reason, data } = parseRevert(err);

    // A missing/empty revert payload usually means the selector does not exist
    // rather than that the call reverted on state. Both are failures, but the
    // distinction matters for the message.
    const noData = !data || data === "0x";

    // Distinguish "the node said no" from "the node did not answer". A timeout
    // or a network error is NOT evidence the transaction reverts — treating it
    // as a revert would block a good mint because a public RPC had a bad moment.
    if (isIndeterminateRpcError(err)) {
      return {
        ok: false,
        reverted: false,
        indeterminate: true,
        reason: reason ?? "RPC did not answer (timeout/network error)",
      };
    }

    return {
      ok: false,
      reverted: true,
      reason: reason ?? (noData ? "call reverted (no data — selector may not exist)" : undefined),
      data,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Known revert patterns ───────────────────────────────────────────────────
// Matched against the reason string. Each entry is a failure the caller can
// act on rather than retry blindly.

export interface RevertPattern {
  pattern: RegExp;
  label: string;
  /** True when retrying later could succeed (sale not open yet, etc.). */
  retryable: boolean;
}

export const REVERT_PATTERNS: RevertPattern[] = [
  // Order matters: the more specific patterns must come FIRST, or a broader
  // pattern shadows them. "insufficient funds" would otherwise swallow
  // "insufficient funds for gas" and mislabel a gas problem as a balance one.
  { pattern: /insufficient funds for gas/i, label: "insufficient funds for gas", retryable: false },
  { pattern: /insufficient (funds|balance)/i, label: "insufficient funds", retryable: false },
  { pattern: /not active|notactive|not started|notstarted|notenabled|not enabled/i, label: "sale not active", retryable: true },
  { pattern: /before start|too early|not yet/i, label: "sale has not started", retryable: true },
  { pattern: /ended|expired|after end|sale over/i, label: "sale has ended", retryable: false },
  { pattern: /invalid merkle|invalidmerkleproof|not on (the )?allowlist|not eligible/i, label: "wallet not eligible", retryable: false },
  { pattern: /exceeds? (the )?(max|limit|cap)|mint.*too many|over the limit/i, label: "quantity exceeds the per-wallet cap", retryable: false },
  { pattern: /price.*(exceed|changed|mismatch)|incorrect.*(price|value)|wrong price/i, label: "price changed since the payload was built", retryable: false },
  { pattern: /signature.*(invalid|expired|mismatch)|invalid signature|bad signature/i, label: "signature invalid or expired", retryable: false },
  { pattern: /nonce/i, label: "nonce mismatch", retryable: true },
];

/** Classify a revert reason against the known patterns. */
export function classifyRevert(reason: string | undefined): RevertPattern | null {
  if (!reason) return null;
  for (const p of REVERT_PATTERNS) {
    if (p.pattern.test(reason)) return p;
  }
  return null;
}
