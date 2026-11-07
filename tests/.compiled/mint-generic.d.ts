import { JsonRpcProvider } from "ethers";
export interface MintSelector {
    sig: string;
    /** Verified 4-byte selector. */
    selector: string;
    /** Argument roles, in ABI order. */
    args: ("to" | "amount" | "id" | "data" | "proof" | "signature" | "recipient")[];
    /**
     * What the selector needs beyond a scalar (to, amount) before it can be
     * encoded safely:
     *   undefined      — fully synthesizable
     *   "proof"        — needs a bytes32[] merkle proof
     *   "signature"    — needs an off-chain signature
     *   "structured"   — needs arguments we cannot derive from a scalar quantity
     *                    (array-batch forms, referral addresses, tokenURI strings,
     *                    per-wallet max values). The ABI-driven path in
     *                    abi-mint.ts handles these by reading real param names.
     */
    needs?: "proof" | "signature" | "structured";
    /** Higher = tried earlier when two selectors both match. */
    weight: number;
}
/** Compute a selector from a signature. Throws on an invalid signature. */
export declare function selectorFor(sig: string): string;
export declare const MINT_SIGNATURES: MintSelector[];
export interface PriceReader {
    sig: string;
    selector: string;
    /** Some readers take a quantity argument. */
    takesAmount: boolean;
}
export declare const PRICE_READERS: PriceReader[];
export declare const SEADROP_V2 = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
export declare const SEADROP_V1 = "0x00000000006c3852cbef3e08e8df289169ede581";
export interface SeaDropDetection {
    version: "v1" | "v2" | null;
    /** True when there is POSITIVE evidence the contract is SeaDrop-managed. */
    managed: boolean;
    reason: string;
}
/**
 * Detect whether a contract is managed by a SeaDrop singleton.
 *
 * Requires POSITIVE EVIDENCE, not merely a non-reverting call: SeaDrop returns
 * an all-zero tuple for tokens it does not manage, which would otherwise look
 * like a valid (free, always-open) drop. Evidence is a configured public drop,
 * a non-zero allowlist merkle root, or a registered creator payout address.
 */
export declare function isSeadropContract(nftContract: string, provider: JsonRpcProvider): Promise<SeaDropDetection>;
export interface SynthContext {
    to: string;
    amount: bigint;
}
/**
 * Build the argument list for a selector.
 *
 * Returns null when a required argument cannot be synthesized safely — the
 * caller must SKIP the selector rather than guess. This is the guard that
 * prevents encoding a fabricated proof or signature.
 */
export declare function buildArgs(selector: MintSelector, ctx: SynthContext): (string | bigint)[] | null;
export interface DetectedMint {
    selector: MintSelector;
    /** True when the probe reverted with data (exists but needs payment/proof). */
    revertedWithData: boolean;
}
/**
 * Probe candidate mint signatures via eth_call.
 *
 * The distinction that makes this work:
 *   - revert WITH data  → the selector EXISTS (it reverted on state/payment)
 *   - revert with NO data → the selector does not exist
 *
 * Selectors that need a proof or signature are only returned when the caller
 * has supplied one; otherwise they are skipped, because we cannot build their
 * calldata.
 */
export declare function detectMintFunction(contract: string, provider: JsonRpcProvider, from: string, amount: bigint, opts?: {
    proof?: string[];
    signature?: string;
}): Promise<DetectedMint | null>;
/**
 * Read the mint price from the contract.
 *
 * Returns null when no price reader exists. A returned 0n is ambiguous — it
 * can mean "free mint" or "reader does not exist" — so callers should treat 0
 * with caution and prefer a reader that is known to exist.
 */
export declare function detectPrice(contract: string, provider: JsonRpcProvider, amount?: bigint): Promise<{
    price: bigint;
    reader: string;
} | null>;
export interface GasPlan {
    gasLimit: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
}
/**
 * Estimate gas with a 20% buffer and derive EIP-1559 fees with headroom.
 * Falls back to legacy gasPrice on chains without maxFeePerGas.
 */
export declare function autoGas(provider: JsonRpcProvider, tx: {
    to: string;
    from: string;
    data: string;
    value: bigint;
}): Promise<GasPlan>;
export interface GenericMintPlan {
    to: string;
    data: string;
    value: bigint;
    selector: string;
    price: bigint;
    gas: GasPlan;
    /** True when the simulation reverted — the plan must NOT be broadcast. */
    simulationReverted: boolean;
    simulationError?: string;
}
/**
 * Build a generic mint plan for a contract.
 *
 * Order: detect the mint function, read the price, encode, simulate, estimate
 * gas. The simulation result is returned rather than thrown so the caller can
 * decide — but simulationReverted: true means the tx will fail.
 */
export declare function buildGenericMintTx(contract: string, provider: JsonRpcProvider, from: string, amount: bigint, opts?: {
    proof?: string[];
    signature?: string;
}): Promise<GenericMintPlan | null>;
/** True when the plan is safe to sign and broadcast. */
export declare function isPlanBroadcastable(plan: GenericMintPlan): boolean;
