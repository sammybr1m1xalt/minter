export interface ConfirmedTx {
    address: string;
    txHash: string;
    block: number | null;
    position: number | null;
    status: "SUCCESS" | "REVERTED" | "PENDING" | "NOT_FOUND" | "TIMEOUT";
    gasUsed: number | null;
    actualGasPrice: bigint | null;
    blockTimeMs: number | null;
}
export declare function sweepOnChain(firedTxs: {
    address: string;
    txHash: string;
    dispatchedAt: number;
}[], rpcUrls: string[], timeoutMs?: number): Promise<ConfirmedTx[]>;
export declare function summarizeOnChain(confirmed: ConfirmedTx[]): string;
