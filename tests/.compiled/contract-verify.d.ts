import { JsonRpcProvider } from "ethers";
export declare const ERC165 = "0x01ffc9a7";
export declare const ERC721 = "0x80ac58cd";
export declare const ERC721_ENUMERABLE = "0x780e9d63";
export declare const ERC721_METADATA = "0x5b5e139f";
export declare const ERC1155 = "0xd9b67a26";
export declare const ERC1155_METADATA_URI = "0x0e89341c";
export declare const SEADROP_V2 = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
export declare const SEADROP_V1 = "0x00000000006c3852cbef3e08e8df289169ede581";
/** Well-known token addresses that frequently appear in scraped page data. */
export declare const KNOWN_TOKENS: Record<string, string>;
export type ErcStandard = "erc721" | "erc1155" | "unknown";
export type Platform = "seadrop-v2" | "seadrop-v1" | "none";
export interface VerificationResult {
    address: string;
    chainId: number;
    /** False when eth_getCode returned empty — an EOA or a non-contract. */
    isContract: boolean;
    standard: ErcStandard;
    /** True when ERC165 answered; false when we fell back to probing. */
    erc165Supported: boolean;
    platform: Platform;
    /** Human-readable reason, always populated when isContract is false. */
    reason?: string;
}
/**
 * eth_getCode returns the contract's bytecode. An EOA returns "0x".
 * This single call is what separates "scraped a token address" from
 * "found the NFT contract".
 *
 * ⚠ EIP-7702 caveat (verified 2026-11-06): a delegated EOA has bytecode of the
 * form 0xef0100 + 20-byte address. eth_getCode therefore returns non-empty for
 * an EOA that has delegated its execution. Callers that need certainty should
 * treat a 0xef0100-prefixed result as "not a contract" — see isDelegatedEoa.
 */
export declare function getCode(address: string, chainId: number): Promise<string>;
/** True when the bytecode is an EIP-7702 delegation designator. */
export declare function isDelegatedEoaCode(code: string): boolean;
export declare function isContract(address: string, chainId: number): Promise<boolean>;
/**
 * Many older ERC721/ERC1155 contracts predate ERC165 or simply do not implement
 * it. Probe for the distinguishing functions instead.
 *
 * The key distinction: ERC1155's balanceOf takes (address,uint256); ERC721's
 * takes (address). A contract that answers the two-arg form is ERC1155.
 */
export declare function detectStandardFallback(provider: JsonRpcProvider, address: string): Promise<{
    standard: ErcStandard;
    erc165Supported: false;
}>;
/**
 * Verify a candidate address on a specific chain.
 *
 * Order matters: getCode first (cheapest, eliminates the most candidates),
 * then ERC165, then fallback probes.
 */
export declare function verifyContract(address: string, chainId: number): Promise<VerificationResult>;
/**
 * Try the chain the page indicated first, then every other configured chain.
 * An address that is a contract on Base and an EOA on Ethereum is a Base
 * contract — assuming Ethereum is how you scrape the wrong chain.
 */
export declare function verifyAcrossChains(address: string, preferredChainId?: number): Promise<VerificationResult>;
/** True when the address is a known token (WETH/USDC/...) — not an NFT. */
export declare function isKnownToken(address: string): string | null;
