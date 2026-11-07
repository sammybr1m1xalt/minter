/** Sentinel the contract uses for "unlimited" wallet/list limits (uint32 max). */
export declare const SCATTER_UNLIMITED = 4294967295;
export interface ScatterCollection {
    address: string;
    chainId: number;
    name: string;
    maxItems: number | null;
    numItems: number | null;
    website: string | null;
    twitter: string | null;
    discord: string | null;
    opensea: string | null;
    creator: string | null;
    slug: string;
}
export interface ScatterList {
    id: string;
    name: string;
    token_price: string | number;
    currency_address: string | null;
    currency_symbol: string | null;
    start_time: string | null;
    end_time?: string | null;
    [k: string]: any;
}
/**
 * Fetch a collection by slug. Returns null when it isn't a Scatter collection
 * (404) or the API is unreachable.
 *
 * Only slugs resolve — the API has no address lookup, so callers must pass the
 * collection's Scatter slug.
 */
export declare function getScatterCollection(slug: string): Promise<ScatterCollection | null>;
/**
 * Fetch the mint lists a wallet is eligible for. Without minterAddress the API
 * returns public lists only. Returns [] on error (treated as "no lists").
 */
export declare function getEligibleLists(slug: string, minterAddress?: string): Promise<ScatterList[]>;
/** A list is "public" when its currency is native and it has no wallet gate. */
export declare function isNativeList(list: ScatterList): boolean;
/**
 * Choose the best list to mint from among eligible lists: cheapest native-token
 * list wins (free > paid), tie-break by earliest start. ERC20-priced lists are
 * only chosen when no native list exists.
 */
export declare function pickBestList(lists: ScatterList[]): ScatterList | null;
export interface ScatterMintTx {
    to: string;
    value: bigint;
    data: string;
    erc20s: {
        address: string;
        amount: string;
    }[];
}
/**
 * Build the mint transaction via the API.
 * `lists` is [{ id, quantity }]. affiliate is an optional shill address.
 */
export declare function buildScatterMint(args: {
    collectionAddress: string;
    chainId: number;
    minterAddress: string;
    lists: {
        id: string;
        quantity: number;
    }[];
    affiliate?: string;
}): Promise<ScatterMintTx>;
export declare const SCATTER_NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000";
