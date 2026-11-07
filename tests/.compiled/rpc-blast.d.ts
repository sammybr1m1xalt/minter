export interface RpcEndpoint {
    url: string;
    label: string;
}
export interface BlastResult {
    label: string;
    txHash: string | null;
    error: string | null;
}
export declare function parseRpcEndpoints(rpcUrls: string[]): RpcEndpoint[];
export interface PreparedBlast {
    txHash: string;
    body: string;
    rawTx: string;
}
export declare function prepareBlast(rawTx: string): PreparedBlast;
export declare function blastToAll(rawTxOrPrepared: string | PreparedBlast, endpoints: RpcEndpoint[]): {
    txHash: string;
    responsePromise: Promise<BlastResult[]>;
};
export declare function waitForReceipt(txHash: string, rpcUrl: string, timeoutMs?: number): Promise<{
    block: number;
    position: number;
    gasUsed: number;
    status: string;
    actualGasPrice?: bigint;
} | null>;
