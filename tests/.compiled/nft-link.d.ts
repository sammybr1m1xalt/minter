export interface LinkTarget {
    kind: "address" | "slug";
    value: string;
    chainHint?: string;
    tokenId?: string;
}
export declare function parseNftLink(input: string): LinkTarget;
