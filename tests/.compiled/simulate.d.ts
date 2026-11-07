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
export declare function parseRevert(err: any): {
    reason?: string;
    data?: string;
};
/**
 * Simulate a transaction with eth_call.
 *
 * Returns { ok: true } when the call succeeds, { ok: false, reverted: true }
 * when it reverts. A NETWORK failure is reported as reverted: false with a
 * reason, so the caller can distinguish "the tx would revert" from "we could
 * not tell" — those need different handling.
 */
export declare function simulateTx(provider: JsonRpcProvider, req: SimulateRequest, timeoutMs?: number): Promise<SimulateResult>;
/**
 * Simulate against several providers and return the first definitive answer.
 *
 * Why several: a public RPC can be behind or mis-synced, and a single node's
 * "revert" is not always the chain's verdict. We treat a SUCCESS from any
 * endpoint as authoritative (the tx will land), and only refuse when EVERY
 * endpoint agrees it reverts.
 *
 * Returns the aggregate plus the individual results so callers can log which
 * endpoint said what.
 */
export declare function simulateWithFallback(providers: JsonRpcProvider[], req: SimulateRequest): Promise<{
    result: SimulateResult;
    attempts: SimulateResult[];
    agreeOnRevert: boolean;
}>;
/**
 * Build a short-lived provider for one-off reads (simulation, eth_getCode,
 * price reads). The caller MUST call destroy() when finished.
 */
export declare function shortLivedProvider(rpcUrl: string, chainId?: number): JsonRpcProvider;
/**
 * Run a read against a throwaway provider and always destroy it.
 * Returns null when the read fails — callers treat that as "unknown".
 */
export declare function withShortLivedProvider<T>(rpcUrl: string, fn: (provider: JsonRpcProvider) => Promise<T>, chainId?: number): Promise<T | null>;
export interface RevertPattern {
    pattern: RegExp;
    label: string;
    /** True when retrying later could succeed (sale not open yet, etc.). */
    retryable: boolean;
}
export declare const REVERT_PATTERNS: RevertPattern[];
/** Classify a revert reason against the known patterns. */
export declare function classifyRevert(reason: string | undefined): RevertPattern | null;
