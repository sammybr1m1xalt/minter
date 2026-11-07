export interface ChainProfile {
    key: string;
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
    rpc: {
        alchemyHost?: string;
        public: string[];
    };
}
export declare const CHAINS: ChainProfile[];
export declare function resolveChain(idOrKey: string | number | bigint | null | undefined): ChainProfile | undefined;
/** Convert a numeric chain id to our internal chain key. */
export declare function chainKeyFromId(chainId: number): string | null;
/** Convert our internal chain key to OpenSea's GraphQL chain identifier. */
export declare function osChain(chainKey: string): string;
export declare function explorerTx(idOrKey: string | number | bigint | null | undefined, txHash: string): string;
