import { JsonRpcProvider } from "ethers";
import { fetchPublicDrop } from "./seadrop-public";
export type MintAdapter = "seadrop-public" | "seadrop-allowlist" | "generic-registry" | "abi-driven";
export interface UniversalMintPlan {
    adapter: MintAdapter;
    to: string;
    data: string;
    value: bigint;
    /** Human-readable description of what will be called. */
    description: string;
    /** The function signature, when known. */
    signature?: string;
    /** True when the plan was confirmed by simulation. */
    simulated: boolean;
    simulationReason?: string;
}
export interface UniversalMintResult {
    plan: UniversalMintPlan | null;
    /** Every adapter that was tried and why it did not produce a plan. */
    attempts: {
        adapter: MintAdapter;
        ok: boolean;
        reason: string;
    }[];
}
/**
 * Try every mint adapter against a contract and return the first plan that
 * simulates.
 *
 * `from` is the wallet that would sign — simulation is wallet-specific for
 * allowlist and per-wallet-limit mints, so the caller must pass the real one.
 */
export declare function findUniversalMint(contract: string, provider: JsonRpcProvider, from: string, amount: bigint, opts?: {
    proof?: string[];
    rpcUrl?: string;
}): Promise<UniversalMintResult>;
/**
 * Human-readable summary of why a contract could not be minted. Used by the
 * wizard to explain a refusal rather than just saying "no".
 */
export declare function explainFailure(result: UniversalMintResult): string;
/** Re-export for callers that need the drop shape. */
export { fetchPublicDrop };
