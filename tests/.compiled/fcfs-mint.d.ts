import type { DropPhase } from "./fcfs-drops";
export { isPayloadBoundToWallet } from "./seadrop-calldata";
import { ConfirmedTx } from "./rpc-health";
export interface SeaDropDropMeta {
    mintPrice: bigint;
    startTime: number;
    endTime: number;
    maxTotalMintableByWallet: number;
    feeBps: number;
    restrictFeeRecipients: boolean;
}
export interface FcfsGasData {
    gasLimit: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}
export interface FcfsSignedPayload {
    seaDropAddress: string;
    nftContract: string;
    feeRecipient: string;
    mintData: string;
    mintSignature: string;
    value: bigint;
    drop: SeaDropDropMeta;
    gasData?: FcfsGasData;
}
export interface FcfsMintPlan {
    payload: FcfsSignedPayload;
    quantity: number;
    gasLimit: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}
export { DropPhase, GasState, CollectionDropsInventory, EligibilityReport, GasRecommendation } from "./fcfs-drops";
export { fetchAllActiveDrops, reportInventoryEligibility, assessDropEligibility, printDropsInventory, fetchGasState, printGasState, recommendGasSettings, printGasRecommendation, gasChoiceAssessment, } from "./fcfs-drops";
export interface RpcEndpointLatency {
    url: string;
    label: string;
    latencyMs: number | null;
}
export declare function measureRpcLatency(urls: string[], timeoutMs?: number): Promise<RpcEndpointLatency[]>;
export interface StoredSession {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scope?: string;
}
export declare function loadStoredSession(): Promise<StoredSession | null>;
export declare function saveStoredSession(s: StoredSession): Promise<void>;
export declare function clearStoredSession(): Promise<void>;
/** Convert a StoredSession to a cookie header string for GraphQL/OpenSea API calls.
 *  The OpenSea GraphQL endpoint uses the access_token cookie for authentication
 *  (equivalent to the Bearer token in the REST path). */
export declare function sessionToStoredSessionCookie(session: StoredSession): string;
export declare function fetchSignedPayload(nftContract: string, quantity: number, apiKey?: string | null, opts?: {
    timeoutMs?: number;
    walletAddress?: string;
    slug?: string;
    chainKey?: string;
}): Promise<FcfsSignedPayload | null>;
export declare function fetchSignedPayloadWithSession(nftContract: string, quantity: number, session: StoredSession, apiKey?: string | null, opts?: {
    timeoutMs?: number;
    refreshed?: boolean;
    walletAddress?: string;
    slug?: string;
    chainKey?: string;
}): Promise<FcfsSignedPayload | null>;
export interface OnChainDrop {
    dropId: string;
    nftContract: string;
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
    allowlistedAddresses: string[];
    allowlistHash: string | null;
    seaDropAddress: string;
    raw: Record<string, any>;
}
export interface AllowlistPreFetchCandidate {
    drop: DropPhase;
    merkleRoot: string | null;
    feeRecipient: string | null;
    needsAllowlistData: boolean;
    needsSignature: boolean;
}
export declare function identifyAllowlistPreFetchCandidates(onChainDrops: DropPhase[], _nftContract: string): AllowlistPreFetchCandidate[];
export declare function refreshSessionToken(refreshToken: string, apiKey?: string | null): Promise<StoredSession | null>;
export interface PreFetchResult {
    success: FcfsSignedPayload[];
    failed: {
        dropId: string;
        reason: string;
    }[];
}
export declare function preFetchSignedPayloads(nftContract: string, onChainDrops: DropPhase[], _walletAddress: string, quantity: number, apiKey?: string | null, session?: StoredSession | null, opts?: {
    timeoutMs?: number;
    slug?: string;
}): Promise<PreFetchResult>;
export interface AllowlistMintCalldata {
    to: string;
    data: string;
    value: bigint;
    feeRecipient: string;
    merkleRoot: string;
}
export declare function encodeAllowlistMintCalldata(_nftContract: string, _feeRecipient: string, _quantity: number, _merkleRoot: string, _merkleProof: string[], // hex-encoded proof paths from the allowlist tree
_walletAddress: string, // the allowlisted wallet
_mintPrice: bigint): string;
export type MintMode = "public" | "signed" | "allowlist" | "token-gated" | "unknown";
export declare function classifyMintMode(drop: DropPhase): {
    mode: MintMode;
    fireableLocally: boolean;
    preFetchNeeded: boolean;
};
export declare function fetchTokenGatedMintParams(nftContract: string, gateToken: string, rpcUrl: string): Promise<SeaDropDropMeta | null>;
export declare function buildFcfsMintPlan(payload: FcfsSignedPayload, gasLimit: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, quantity: number): FcfsMintPlan;
export interface ExecuteSnipeOpts {
    nftContract: string;
    quantity: number;
    walletKeys: string[];
    rpcUrls: string[];
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gasLimit: number;
    targetStart: Date;
    /** Structural template from buildFcfsMintPlan. `payload` is used when it is
     *  already bound to wallets[0]; otherwise a per-wallet fetch is required. */
    plan: FcfsMintPlan;
    openSeaApiKey?: string | null;
    slug?: string;
    chainKey?: string;
    sessions?: (StoredSession | null)[];
    /** Per-wallet pre-fetched payloads (indexed by walletKeys). When present,
     *  these are used directly and NO API call happens in the critical path. */
    payloads?: (FcfsSignedPayload | null)[];
    /** Maximum total price (wei) the user will accept. Asserted before signing. */
    maxPriceWei?: bigint | null;
}
export interface SnipeResult {
    walletIndex: number;
    walletAddress: string;
    success: boolean;
    txHash?: string;
    receipt?: ConfirmedTx;
    error?: string;
    /** True when the failure is timing-related and a later attempt could work. */
    retryable?: boolean;
}
export declare function executeFcfsSnipe(opts: ExecuteSnipeOpts): Promise<SnipeResult[]>;
export declare function fetchSignedPayloadForWallet(nftContract: string, quantity: number, walletAddress: string, apiKey?: string | null, opts?: {
    timeoutMs?: number;
    session?: StoredSession | null;
    slug?: string;
    chainKey?: string;
}): Promise<FcfsSignedPayload | null>;
