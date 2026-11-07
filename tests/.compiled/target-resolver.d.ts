import { isSlug } from "./slug-resolver";
import { ScatterCollection } from "./scatter";
export declare function chainSlug(s: string | null | undefined): string;
export type TargetPlatform = "opensea" | "scatter" | "manifold" | "zora" | "direct";
export interface ParsedTarget {
    platform: TargetPlatform;
    /** Contract address, when known at parse time. */
    contract?: string;
    /** Collection slug (OpenSea or Scatter). */
    slug?: string;
    /** Manifold claim id. */
    claimId?: string;
    chain?: string;
    tokenId?: string;
    amount: number;
}
export interface ResolvedTarget {
    platform: TargetPlatform;
    contract: string;
    chainKey: string;
    /** OpenSea slug when the platform is opensea. */
    slug?: string;
    /** Scatter collection metadata when the platform is scatter. */
    scatter?: ScatterCollection;
    amount: number;
    tokenId?: string;
    /** True when resolution used a fallback (scrape / Scatter API) rather than
     *  the authoritative REST endpoint. */
    resolvedViaFallback: boolean;
}
/**
 * Parse any mint-target input into a descriptor.
 *
 * Mirrors parse.js, with one extension: a bare slug is tagged `opensea` at
 * parse time (the primary platform) and re-tried as Scatter during resolution
 * if OpenSea cannot resolve it.
 */
export declare function parseTarget(input: string): ParsedTarget;
/**
 * Resolve a parsed target to a concrete contract + chain.
 *
 * Returns null when the target cannot be resolved — the caller decides whether
 * that is fatal. Manifold is deliberately NOT resolved: a claim slug is not a
 * contract, and guessing one would mean minting against an address we invented.
 */
export declare function resolveTarget(target: ParsedTarget, apiKey?: string, preferredChain?: string): Promise<ResolvedTarget | null>;
/**
 * Parse and resolve in one call. Throws with a platform-specific message when
 * the target is unresolvable, so the caller can show something actionable.
 */
export declare function parseAndResolve(input: string, apiKey?: string, preferredChain?: string): Promise<ResolvedTarget>;
export { isSlug };
