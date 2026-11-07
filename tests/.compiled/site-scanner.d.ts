export interface AddressCandidate {
    address: string;
    /** 0–100. Higher = more likely to be the collection contract. */
    score: number;
    /** Where it was found — surfaced in the UI so the user can judge. */
    source: "json-key" | "contracts-block" | "script-blob" | "html-text" | "mint-button";
    /** The JSON key it appeared under, when known (e.g. "contractAddress"). */
    key?: string;
    /** How many times it appeared on the page. */
    occurrences: number;
}
export interface ScanResult {
    candidates: AddressCandidate[];
    /** Total distinct addresses found, before ranking. */
    totalFound: number;
    /** True when the page yielded nothing — the caller should say so. */
    empty: boolean;
}
export declare function extractAddresses(html: string): string[];
/** Pull out the bodies of every <script> tag. */
export declare function scriptBodies(html: string): string[];
/**
 * Rank candidates by evidence. The ordering reflects how trustworthy each
 * signal is:
 *
 *   mint-button attribute  → the page itself links this address to minting
 *   strong JSON key        → "contractAddress" is unambiguous
 *   contracts block        → a dedicated contracts list
 *   repeated occurrence    → the collection address usually appears many times
 *   script blob            → embedded config, better than visible text
 *   bare html text         → weakest; could be anything
 *
 * Deductions apply for known-bad keys (fee recipient, payout, currency).
 */
export declare function rankCandidates(keyed: {
    address: string;
    key: string;
}[], contractsBlock: string[], scriptHits: string[], buttonHits: string[], allAddresses: string[], 
/** Optional per-address nesting depth, from extractKeyedAddressesWithDepth. */
depths?: Map<string, number>): AddressCandidate[];
/**
 * Scan a page and return ranked candidate addresses.
 *
 * Pure function — the caller fetches the HTML. Keeping this separate from the
 * network means it can be tested against saved fixtures.
 */
export declare function scanHtml(html: string): ScanResult;
/** Extract API paths referenced in a JS bundle. */
export declare function extractApiPaths(js: string, baseUrl: string): string[];
/**
 * Expand templated API paths into concrete candidates.
 *
 * Bundles build paths with template literals: `/api/campaigns/drops/${slug}`.
 * The literal prefix is the useful part — the variable part is usually a slug
 * the page already knows.
 *
 * This is generic: it substitutes whatever slug the page URL carries, and tries
 * every suffix of the path. A bundle's route naming does not have to match the
 * server's — the same endpoint is often reachable at several depths — so we
 * enumerate the possibilities rather than guessing one.
 */
export declare function expandApiPaths(paths: string[], pageUrl: string): string[];
/** Extract <script src> and modulepreload href URLs from a shell page. */
export declare function extractScriptUrls(html: string, baseUrl: string): string[];
export interface BundleScanResult {
    candidates: AddressCandidate[];
    /** API endpoints that were tried, with the outcome. */
    apiCalls: {
        url: string;
        ok: boolean;
        addressesFound: number;
    }[];
}
/**
 * Follow a shell page's JS bundles and their API calls.
 *
 * Order: shell HTML → script bundles → API endpoints discovered in the bundles.
 * Each stage is scanned with the same ranking as the raw HTML.
 */
export declare function scanWithBundles(url: string, timeoutMs?: number, maxBundles?: number, maxApiCalls?: number): Promise<ScanResult & {
    apiCalls: BundleScanResult["apiCalls"];
}>;
/**
 * Fetch and scan a URL. Returns null when the page cannot be retrieved —
 * a 403/429/Cloudflare challenge is reported as "no result", never as a
 * wrong address.
 */
export declare function scanUrl(url: string, timeoutMs?: number): Promise<ScanResult | null>;
