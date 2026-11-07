/** Canonical stage-type tokens we reason about. */
export type StageTypeToken = "public" | "allowlist" | "ovr" | "token_gated" | "fcfs" | "reserved" | "unknown";
/** Normalize any OpenSea stageType casing to a canonical lowercase token. */
export declare function normalizeStageType(raw: string | null | undefined): StageTypeToken;
/** True when the stage is open to all — mintable on-chain with no signature. */
export declare function classifyStageType(raw: string | null | undefined): boolean;
/** True when the stage needs a per-wallet server signature. */
export declare function isSignedStageType(raw: string | null | undefined): boolean;
export interface DropPhase {
    dropId: string;
    nftContract: string;
    name: string | null;
    type: string | null;
    startTime: number;
    endTime: number;
    mintPrice: bigint;
    maxTotalMintableByWallet: number;
    maxTotalMintable: number;
    totalMinted: number;
    feeBps: number;
    feeRecipient: string | null;
    mintData: string | null;
    mintSignature: string | null;
    gasLimit: number | null;
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
    eligible: boolean | null;
    eligibleCount: number | null;
    totalAllocated: number | null;
    eligiblePrice: bigint | null;
    allowlistedAddresses: string[];
    allowlistHash: string | null;
    /** True when this phase is a public/open stage — targetable on-chain with no
     *  OpenSea key or signed payload. Matches osnm-z's PUBLIC_SALE handling:
     *  discovered from metadata, auto-eligible, no session needed. */
    isPublicStage: boolean;
    raw: Record<string, any>;
}
export interface GasState {
    chainId: number;
    baseFeePerGas: bigint;
    suggestedMaxFeePerGas: bigint;
    suggestedMaxPriorityFeePerGas: bigint;
    latestBlockNumber: number;
    gasUsedPercentage: number;
    timestamp: number;
    urgency: "low" | "normal" | "high" | "extreme";
}
export interface CollectionDropsInventory {
    nftContract: string;
    chainId: number | null;
    drops: DropPhase[];
    fetchedAt: number;
    apiKeyUsed: boolean;
    /** Why no drops were found, if applicable. */
    notFoundReason?: "not_found" | "rate_limited" | "key_required" | "no_phases" | "network_error";
}
export interface EligibilityReport {
    drop: DropPhase;
    ourWalletEligible: boolean | null;
    allocationRemaining: number | null;
    isOverAllocated: boolean | null;
    recommendation: "target" | "skip" | "check-manually";
    reason: string;
}
export interface GasRecommendation {
    currentBaseFeeGwei: number;
    currentBaseFeeWei: bigint;
    suggestedMaxFeePerGasWei: bigint;
    suggestedMaxPriorityFeePerGasWei: bigint;
    suggestedGasLimit: number;
    rationale: string;
    urgency: "low" | "normal" | "high" | "extreme";
}
export declare function fetchAllActiveDrops(nftContract: string, apiKey: string | null | undefined, timeoutMs?: number, slug?: string, chainKey?: string): Promise<CollectionDropsInventory>;
export declare function assessDropEligibility(drop: DropPhase, _ourWallet: string): EligibilityReport;
/**
 * Sort phases by start time (soonest first), keeping the original index so
 * callers can map a report back to `inventory.drops[i]`.
 *
 * OpenSea returns stages in an unspecified order. Every downstream consumer —
 * the wizard's phase picker, the eligibility report, the pre-fetch loop —
 * assumes index alignment with `inventory.drops`, so the sort must happen once
 * here, at the boundary, rather than in each consumer.
 */
export declare function orderDropsByStartTime(drops: DropPhase[]): DropPhase[];
export declare function reportInventoryEligibility(inventory: CollectionDropsInventory, ourWallet: string): EligibilityReport[];
export declare function printDropsInventory(inventory: CollectionDropsInventory, eligibility: EligibilityReport[], ourWallet: string, chainName: string): void;
export declare function fetchGasState(rpcUrls: string[], chainId: number, timeoutMs?: number): Promise<GasState | null>;
export declare function printGasState(gas: GasState | null, chainName: string): void;
export declare function recommendGasSettings(gasState: GasState | null, openSeaGas: {
    gasLimit: number | null;
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
} | null, defaultGasLimit?: number): GasRecommendation;
export declare function printGasRecommendation(rec: GasRecommendation, chainName: string): void;
export declare function gasChoiceAssessment(userMaxFee: bigint, userPriority: bigint, recommendation: GasRecommendation): {
    ok: boolean;
    message: string;
};
