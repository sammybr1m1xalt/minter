import { JsonRpcProvider } from "ethers";
/**
 * Fetch the most recent allowListURI emitted for nftContract on seadropAddr.
 * Returns null when no such event exists or the RPC refuses the range.
 */
export declare function fetchAllowListUri(seadropAddr: string, nftContract: string, provider: JsonRpcProvider): Promise<string | null>;
interface AllowlistEntry {
    address?: string;
    minter?: string;
    wallet?: string;
    mintParams?: any;
    params?: any;
    proof?: string[];
    proofs?: string[];
}
interface AllowlistTree {
    root: string | null;
    byAddr: Map<string, AllowlistEntry>;
}
/**
 * Download and index the allowlist tree by lowercased address.
 * Accepts the common shapes: { allowList:[...] }, { merkleTree:[...] },
 * { entries:[...] }, or a bare array.
 */
export declare function fetchTree(uri: string): Promise<AllowlistTree>;
/**
 * Normalize an entry's mintParams into the 8-field tuple order SeaDrop's ABI
 * expects. Field order matters — a wrong order silently mints at the wrong
 * price or reverts.
 */
export declare function toMintParams(mp: any): bigint[];
export interface AllowlistCheck {
    eligible: boolean;
    hasAllowlist: boolean;
    reason?: string;
    mintParams?: bigint[];
    proof?: string[];
    raw?: any;
}
/**
 * Check a wallet's allowlist eligibility for a SeaDrop drop.
 *
 * `root` is the on-chain merkle root from getAllowListMerkleRoot. A zero root
 * means no allowlist is configured — the caller should mint publicly instead.
 */
export declare function checkAllowlist(seadropAddr: string, nftContract: string, minter: string, provider: JsonRpcProvider, root: string | null): Promise<AllowlistCheck>;
/**
 * Read the on-chain merkle root for a contract. Returns null when unset.
 * Exported so callers can decide between the public and allowlist paths.
 */
export declare function getAllowlistRoot(seadropAddr: string, nftContract: string, provider: JsonRpcProvider): Promise<string | null>;
export {};
