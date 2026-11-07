export interface PriceProtectionResult {
    isUnlimited: boolean;
    maxPriceWei: bigint | null;
    maxPriceEth: string | null;
    unitPriceEth?: string;
    display: string;
}
/**
 * Parse a user-supplied max-price spec.
 *
 * Accepts the same forms as the JS original:
 *   0.01 | 0.01eth | 0.05/unit | 0.05total | free | 0 | any | none | unlimited
 *
 * `amount` is the quantity being minted — a per-unit spec is multiplied up to a
 * total, so the assertion compares totals consistently.
 */
export declare function parsePriceSpec(spec: string, amount?: number): PriceProtectionResult | null;
/**
 * Extract an optional max-price spec from a command string.
 *
 * Supports the JS original's forms:
 *   --max-price 0.01 | --maxprice 0.01 | max:0.01 | max=0.01 | maxprice:0.01
 *   max:free | max:0 | max:0.05/unit | max:0.05total | max:any | max:unlimited
 *   p:0.01 | p=0.01
 *
 * Returns the spec and the string with the spec removed, so a caller can parse
 * the remainder as the mint target.
 */
export declare function extractMaxPriceSpec(input: string): {
    spec: string | null;
    rest: string;
};
/**
 * Assert that the actual price does not exceed the maximum.
 * Throws with an informative message when it does.
 */
export declare function assertPriceProtection(args: {
    actualPriceWei: bigint;
    maxPriceWei: bigint | null | undefined;
    context?: string;
}): void;
/**
 * True when a stored max price is still valid for the current observed price.
 * Non-throwing variant for callers that want to warn rather than abort.
 */
export declare function isPriceProtected(actualPriceWei: bigint, maxPriceWei: bigint | null | undefined): boolean;
