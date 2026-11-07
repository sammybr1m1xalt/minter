import { decodeStageIndex as decodeStageIndexImpl, decodeMintCalldata, isKnownMintSelector, SIGNED_SELECTOR, MERKLE_SELECTOR, PUBLIC_SELECTOR } from "./seadrop-calldata";
export { decodeMintCalldata, isKnownMintSelector, SIGNED_SELECTOR, MERKLE_SELECTOR, PUBLIC_SELECTOR };
export declare const decodeStageIndex: typeof decodeStageIndexImpl;
export declare const GQL_HASHES: {
    mintModule: string;
    mintTimeline: string;
    dropEligibility: string;
    mintQuery: string;
    collectionDrops: string;
};
export declare const GQL_QUERY_TEXTS: Record<string, string>;
export declare function explainOpenseaError(msg: string): {
    code: string | null;
    meaning: string;
};
export declare const SELECTOR_STAGE: Record<string, string>;
/** True when a value is already a whole-wei quantity (integer or int string). */
export declare function isWholeWei(value: unknown): boolean;
/**
 * Convert any OpenSea price representation to wei.
 *
 * ETH floats are scaled by 1e18; whole-wei values pass through. Anything
 * unparseable yields 0n rather than throwing — a price we cannot read should
 * degrade to "free", never take down the whole inventory fetch.
 */
export declare function parsePriceToWei(value: unknown): bigint;
/** True only when OpenSea actually returned a buildable transaction. */
export declare function isEligibleStatus(status: number): boolean;
export declare function gqlPersistedQuery(operationName: string, hash: string, variables: Record<string, any>, cookie?: string | null, apiKey?: string | null, timeoutMs?: number): Promise<any>;
export declare function gqlApqQuery(operationName: string, variables: Record<string, any>, cookie?: string | null, apiKey?: string | null, timeoutMs?: number): Promise<any>;
export interface PostMintTxResult {
    eligible: boolean;
    reason?: string;
    mintData?: string | null;
    mintSignature?: string | null;
    seaDropAddress?: string | null;
    feeRecipient?: string | null;
    value?: bigint | null;
    status?: number;
    code?: string | null;
    stageUuid?: string | null;
    stageType?: string | null;
    stageStart?: number | null;
    stageEnd?: number | null;
}
export declare function postMintTx(slug: string, walletAddress: string, quantity: number, apiKey?: string | null, timeoutMs?: number, chainKey?: string, sessionCookie?: string | null): Promise<PostMintTxResult>;
/**
 * Check whether a signed payload's mintData is bound to a specific wallet address.
 *
 * OpenSea's v2 signed mint payload binds mintSignature to a specific recipient
 * wallet. The mintData calldata carries that address in the `minterIfNotPayer`
 * argument of mintSigned/mintAllowList. Decoding is delegated to
 * seadrop-calldata.ts, which uses ethers' own decoder rather than a hand-rolled
 * hex slice — the previous implementation read word 3 (quantity) instead of
 * word 2 (minter), so it never matched any real wallet.
 */
export declare function isPayloadBoundToWallet(payload: {
    mintData: string | null;
}, walletAddress: string): boolean;
export interface OpenseaMintTx {
    to: string;
    data: string;
    value: bigint;
    networkId: string | null;
    crossChain: boolean;
    requestId: string | null;
    selector: string;
    stageType: string | null;
    stageIndex: number | null;
}
/** Build a mint transaction via OpenSea's GraphQL MintActionTimelineQuery. */
export declare function buildOpenseaMint(args: {
    slug: string;
    minterAddress: string;
    contract: string;
    chain: string;
    tokenId?: string;
    quantity?: number;
    cookie?: string | null;
    apiKey?: string | null;
    timeoutMs?: number;
}): Promise<OpenseaMintTx>;
/**
 * Documented REST eligibility check: GET /api/v2/drops/{slug}/eligibility.
 *
 * This is the API's own eligibility endpoint — it needs only the slug and a
 * wallet JWT, and returns per-stage is_eligible / stage_uuid / price. The code
 * previously re-derived all of this from GraphQL (which returns UNAUTHORIZED
 * for the eligibility fields without a JWT) and from POST /mint status codes.
 *
 * Returns null when the endpoint is unavailable (no session, 401/403/404) so
 * callers can fall back to the GQL path.
 */
export declare function fetchRestEligibility(slug: string, cookie?: string | null, apiKey?: string | null, timeoutMs?: number): Promise<{
    stages: {
        stageUuid: string | null;
        isEligible: boolean;
        price: bigint | null;
        maxTotalMintableByWallet: number | null;
    }[];
} | null>;
/**
 * Probe whether a wallet can mint a drop RIGHT NOW by attempting to build the
 * mint tx via GraphQL. Returns { mintable:true, tx } or { mintable:false, code, reason, funds }.
 */
export declare function probeOpenseaMint(args: {
    slug: string;
    minterAddress: string;
    contract: string;
    chain: string;
    cookie?: string | null;
    apiKey?: string | null;
}): Promise<{
    mintable: boolean;
    tx?: OpenseaMintTx;
    code: string | null;
    reason: string;
    funds: boolean;
}>;
export interface DropEligibilityStage {
    stageIndex: number;
    uuid: string | null;
    stageType: string | null;
    startTime: number | null;
    endTime: number | null;
    isEligible: boolean | null;
    eligibleMinterAddress: string | null;
    maxPerWallet: number | null;
    priceUnit: number | null;
    symbol: string;
    allowlistMemberCount: number | null;
}
export interface DropEligibilityResult {
    typename: string | null;
    stages: DropEligibilityStage[];
    authed: boolean;
    minted: number | null;
    walletCount: number | null;
    allowlistedWalletCount: number | null;
    otherEligibleByStage: Record<number, number> | null;
}
export declare function getDropEligibility(slug: string, minterAddress: string, cookie?: string | null, apiKey?: string | null, timeoutMs?: number): Promise<DropEligibilityResult | null>;
