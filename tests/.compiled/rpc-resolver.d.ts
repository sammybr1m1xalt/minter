interface ResolvedRpcs {
    urls: string[];
    source: string;
}
export declare function privateRpcsFromEnv(chainKey: string): string[];
export declare function resolveRpcsForChain(chainKey: string, manual?: string[]): ResolvedRpcs;
export declare function toRpcUrl(value: string, chainKey: string): string | null;
export declare function maskRpc(url: string): string;
interface RpcPlan {
    urls: string[];
    verified: boolean;
    dropped: {
        url: string;
        chainId: number;
    }[];
    sendOnly: string[];
    failures: {
        url: string;
        message: string;
    }[];
}
export declare function planRpcs(urls: string[], expectedChainId: number): Promise<RpcPlan>;
export {};
