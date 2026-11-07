interface CollectionInfo {
    name: string;
    contractAddress: string;
    chain: string;
}
/**
 * Resolve a collection slug to its primary contract address + chain.
 *
 * REST v2 is tried first (works with or without a key). GraphQL is a
 * fallback for when REST returns 401/403 and no key was provided.
 */
export declare function resolveSlug(slug: string, apiKey?: string, preferredChain?: string): Promise<CollectionInfo>;
export declare function isSlug(input: string): boolean;
export declare function resolveContractToSlug(nftContract: string, apiKey?: string, timeoutMs?: number): Promise<string | null>;
export {};
