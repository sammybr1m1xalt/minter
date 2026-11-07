/** Selectors this module knows how to decode. */
export declare const SIGNED_SELECTOR = "0x4b61cd6f";
export declare const MERKLE_SELECTOR = "0x4300a4e6";
export declare const PUBLIC_SELECTOR = "0x161ac21f";
export declare function isKnownMintSelector(data: string): boolean;
export interface DecodedMintCalldata {
    selector: string;
    nftContract: string;
    feeRecipient: string;
    /** The address OpenSea bound this payload to. */
    minter: string;
    quantity: bigint;
    dropStageIndex: number;
}
/**
 * Decode a SeaDrop mint payload. Returns null when the calldata is not a
 * SeaDrop mint we understand — callers must treat null as "cannot verify",
 * never as "verified".
 */
export declare function decodeMintCalldata(data: string): DecodedMintCalldata | null;
/**
 * Is this payload bound to `walletAddress`?
 *
 * FAILS OPEN: returns true when the calldata cannot be decoded. The rationale
 * is that a false negative would silently discard a valid payload and skip a
 * mint, whereas a false positive is caught on-chain by the receipt poll. The
 * per-wallet fetch is the primary protection; this is a secondary check.
 */
export declare function isPayloadBoundToWallet(payload: {
    mintData: string | null;
}, walletAddress: string): boolean;
/**
 * Read dropStageIndex out of mint calldata. Returns null for public-sale
 * mints (no stage index exists) and for anything undecodable.
 */
export declare function decodeStageIndex(data: string): number | null;
