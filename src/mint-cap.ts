// ── Per-wallet mintable quantity ─────────────────────────────────────────────
//
// A drop's per-wallet limit is not a static fact. The owner can edit a stage in
// the last minutes before it opens, and the wallet's own minted count moves
// whenever it mints elsewhere. Either change alters how many tokens the wallet
// can actually mint, and broadcasting a quantity above the cap reverts on-chain
// — the gas is spent and nothing is minted.
//
// The cap reaches us two different ways depending on the path:
//
//   • the phase's own limit — max_total_mintable_by_wallet, readable on-chain
//     for public stages and from the inventory for OpenSea-managed ones;
//   • the running cap — the summed limits of every stage up to and including
//     this one, which is what SeaDrop actually enforces against the wallet's
//     lifetime minted count.
//
// What the wallet can mint in this phase is the tighter of the two, minus what
// it has already minted. When a bound is unknown it is not applied: an unknown
// limit must never be reported as 0, which would read as "you cannot mint at
// all" and talk the user out of a mint they were entitled to.

export interface MintCap {
  /** The phase's own per-wallet limit. null = unknown or unlimited. */
  phaseLimit: number | null;
  /** Running cap across every stage up to and including this one. null = unknown. */
  runningCap: number | null;
  /** What the wallet has already minted on this drop, lifetime. null = unknown. */
  minted: number | null;
}

/** A real limit, as opposed to the 0 this codebase uses to mean "unknown". */
function isLimit(v: number | null | undefined): v is number {
  return v != null && v > 0;
}

/**
 * How many tokens the wallet can mint in this phase, or null when nothing is
 * known. Unknown bounds are ignored rather than treated as zero.
 */
export function mintableFromCap(cap: MintCap): number | null {
  const bounds: number[] = [];
  if (isLimit(cap.phaseLimit)) bounds.push(cap.phaseLimit);
  if (isLimit(cap.runningCap)) {
    // An unknown minted count is NOT zero. `cap.minted ?? 0` quoted the wallet
    // an allowance it may already have spent. With minted unknown the running
    // cap is still a hard ceiling for this phase — it counts every stage up to
    // and including this one — so it bounds the answer without being reduced.
    bounds.push(cap.minted != null ? Math.max(0, cap.runningCap - cap.minted) : cap.runningCap);
  }
  if (bounds.length === 0) return null;
  return Math.min(...bounds);
}

export interface QuantityReconciliation {
  quantity: number;
  /** True when the requested quantity was above the cap and has been reduced. */
  clamped: boolean;
  /** True when the cap is known and the wallet has nothing left. */
  exhausted: boolean;
  mintable: number | null;
}

/**
 * Fit a requested quantity to a known cap.
 *
 * A mintable of 0 means the wallet has used its whole allocation. That is a
 * refusal, not a value to clamp upwards from — callers must not fire.
 */
export function reconcileQuantity(requested: number, mintable: number | null): QuantityReconciliation {
  if (mintable == null) return { quantity: requested, clamped: false, exhausted: false, mintable };
  if (mintable <= 0) return { quantity: 0, clamped: requested > 0, exhausted: true, mintable };
  if (requested > mintable) return { quantity: mintable, clamped: true, exhausted: false, mintable };
  return { quantity: requested, clamped: false, exhausted: false, mintable };
}

/** "3" / "unknown" — for report lines. */
export function describeMintable(mintable: number | null): string {
  return mintable == null ? "unknown" : String(mintable);
}
