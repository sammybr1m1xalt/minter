// ── Per-transaction gas estimation ───────────────────────────────────────────
//
// The TS port never estimated gas: it used a static 250_000 everywhere. That
// fails in both directions and both failures are silent:
//
//   • A mint whose real cost exceeds 250k reverts on-chain with out-of-gas,
//     AFTER the tx was already broadcast — the user pays for a reverted tx.
//   • A mint whose real cost is far below 250k locks maxFeePerGas × 250k as the
//     fee cap. Unused gas is refunded, but the cap is what the wallet must be
//     able to cover: a base-fee spike between signing and inclusion can make
//     the tx unaffordable, and it never mines.
//
// Estimates per transaction and adds a 20% buffer.

import { JsonRpcProvider } from "ethers";
import { isIndeterminateRpcError } from "./simulate";

export interface AutoGasRequest {
  to: string;
  from?: string;
  data?: string;
  value?: bigint;
}

export interface AutoGasResult {
  gasLimit: bigint;
  /** Present only on chains without EIP-1559 (no maxFeePerGas). */
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Estimate gas for a transaction and derive a competitive fee.
 *
 * The 20% buffer matters: a mint that sits exactly
 * at the block gas limit, or one whose cost depends on storage slots that are
 * warm in eth_call but cold on-chain, reverts without it.
 *
 * Throws when the estimate fails — an estimate failure is almost always a
 * revert, and the caller should treat it as "do not send".
 */
export async function autoGas(
  provider: JsonRpcProvider,
  txRequest: AutoGasRequest
): Promise<AutoGasResult> {
  // Fee data and the gas estimate are independent reads, so they run together.
  // They used to be sequential — two round trips inside the T-0 critical path,
  // which is exactly what a snipe cannot afford.
  const [feeData, rawGasLimit] = await Promise.all([
    provider.getFeeData(),
    provider.estimateGas(txRequest).catch((e: any) => {
      // A network or timeout failure says nothing about the transaction — it is
      // "could not tell", not "revert". Wrapping it as "likely revert" made the
      // caller treat a dead RPC as do-not-send evidence and drop every wallet.
      if (isIndeterminateRpcError(e)) throw e;
      // Wrapped here so the rejection Promise.all reports is the estimate
      // failure, not whatever getFeeData happened to reject with.
      throw new Error(
        `gas estimate failed (likely revert): ${e?.shortMessage ?? e?.message ?? "unknown"}`
      );
    }),
  ]);
  const gasLimit = rawGasLimit * 120n / 100n;

  // Legacy-fee chains (no maxFeePerGas): use gasPrice.
  if (feeData.maxFeePerGas == null) {
    const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
    return { gasLimit, gasPrice };
  }

  const priorityFee = feeData.maxPriorityFeePerGas
    ? (feeData.maxPriorityFeePerGas * 110n) / 100n
    : 1_500_000_000n;
  // `feeData.maxFeePerGas` is already the node's EIP-1559 suggestion — ethers
  // derives it as roughly 2× the base fee plus the tip. Doubling it again asked
  // the wallet to cover ~4× the base fee, which is the "unaffordable, never
  // mines" failure this module's own header describes. One more tip on top of
  // the node's suggestion is a snipe premium without the balance blow-up.
  const maxFee = feeData.maxFeePerGas + priorityFee;
  return { gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee };
}

/**
 * Estimate gas with a bounded timeout.
 *
 * Same reasoning as simulateTx: a client library retries a dead endpoint with
 * exponential backoff and no ceiling, so an unreachable RPC would otherwise
 * turn this into an unbounded hang. Returns null ONLY when the estimate could
 * not be obtained in time; a failed estimate (almost always a revert) is
 * rethrown so the caller refuses to send.
 */
export async function autoGasBounded(
  provider: JsonRpcProvider,
  txRequest: AutoGasRequest,
  timeoutMs = 8_000
): Promise<AutoGasResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      autoGas(provider, txRequest),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`gas estimation timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (e: any) {
    // A timeout or a network failure means "could not tell" — the caller may
    // fall back to a default. Anything else is a failed estimate, which is
    // almost always a revert; the caller must treat that as "do not send", not
    // as an inconclusive result. Swallowing both let a guaranteed revert
    // through to the broadcast path, so the two are told apart here.
    if (isIndeterminateRpcError(e)) return null;
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
