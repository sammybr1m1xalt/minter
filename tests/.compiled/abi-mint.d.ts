import { JsonRpcProvider } from "ethers";
export interface AbiFetchResult {
    abi: any[] | null;
    source: "sourcify" | "etherscan" | null;
    error?: string;
}
/** Fetch the verified ABI from Sourcify. Returns null when not verified. */
export declare function fetchAbiFromSourcify(chainId: number, address: string, timeoutMs?: number): Promise<AbiFetchResult>;
/** Fetch the verified ABI from Etherscan V2. Requires ETHERSCAN_API_KEY. */
export declare function fetchAbiFromEtherscan(chainId: number, address: string, apiKey: string | undefined, timeoutMs?: number): Promise<AbiFetchResult>;
/**
 * Fetch the ABI, trying Sourcify first then Etherscan.
 * Returns the first success; error reports the last failure.
 */
export declare function fetchAbi(chainId: number, address: string, opts?: {
    etherscanKey?: string;
    timeoutMs?: number;
}): Promise<AbiFetchResult>;
/**
 * Heuristic: does this function look like a mint?
 *
 * Deliberately broad — the cost of a false positive is one extra eth_call, while
 * the cost of a false negative is a mint we never find. Excludes view/pure
 * functions (they cannot mint) and obvious non-mints.
 */
export declare function looksLikeMint(name: string, stateMutability: string): boolean;
export interface AbiMintCandidate {
    name: string;
    signature: string;
    selector: string;
    inputs: {
        name: string;
        type: string;
        internalType?: string;
    }[];
    stateMutability: string;
    payable: boolean;
}
/**
 * Derive mint candidates from an ABI.
 *
 * Each candidate carries its real parameter names and types, which is what makes
 * argument synthesis possible: `mintMiladys(uint256 numberOfTokens)` tells us the
 * parameter is a token count, whereas a bare `uint256` does not.
 */
export declare function deriveMintCandidates(abi: any[]): AbiMintCandidate[];
export interface SynthContext {
    to: string;
    amount: bigint;
    /** Optional off-chain data, keyed by role. */
    proof?: string[];
    signature?: string;
    /** Token id, when the contract exposes one. */
    tokenId?: bigint;
}
export interface SynthResult {
    ok: boolean;
    args?: any[];
    reason?: string;
}
/**
 * Classify an ABI parameter by its name and type.
 *
 * This is the core of argument synthesis. Parameter NAMES are the signal:
 * `numberOfTokens` is a quantity, `to` is a recipient, `merkleProof` is a proof.
 * Types alone are ambiguous — `uint256` could be a quantity, a price, or an id.
 */
export type ParamRole = "recipient" | "quantity" | "tokenId" | "proof" | "signature" | "data" | "unknown";
export declare function classifyParam(name: string, type: string): ParamRole;
/**
 * Build calldata arguments from an ABI candidate and a synthesis context.
 *
 * Returns { ok: false, reason } when a parameter cannot be filled safely — the
 * caller must SKIP rather than guess. This is the guard that prevents encoding a
 * fabricated proof, a wrong price, or a referral address.
 */
export declare function synthFromAbi(candidate: AbiMintCandidate, ctx: SynthContext): SynthResult;
export interface ProbeResult {
    candidate: AbiMintCandidate;
    /** True when the call reverted WITH data — the selector exists. */
    exists: boolean;
    /** True when the call succeeded (would have minted, if broadcast). */
    wouldSucceed: boolean;
    error?: string;
}
/**
 * Probe an ABI-derived candidate against the chain.
 *
 * Distinguishes:
 *   - exists: false            → selector absent, skip
 *   - exists: true, wouldSucceed: false → present but reverting (needs payment,
 *     proof, allowlist, or the sale is closed)
 *   - exists: true, wouldSucceed: true  → the mint would go through
 */
export declare function probeAbiCandidate(contract: string, provider: JsonRpcProvider, candidate: AbiMintCandidate, args: any[], from: string, value: bigint): Promise<ProbeResult>;
/**
 * Find a price by reading the contract's own price getter.
 *
 * Prefers getters whose name mentions mint/price/cost/sale. Returns null when
 * none exists — a free mint is a legitimate outcome, but the caller should
 * confirm via simulation rather than assume.
 */
export declare function readPriceFromAbi(contract: string, provider: JsonRpcProvider, abi: any[], amount?: bigint): Promise<{
    price: bigint;
    getter: string;
} | null>;
