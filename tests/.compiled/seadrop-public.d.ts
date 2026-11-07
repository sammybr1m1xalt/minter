export declare const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
export interface PublicDrop {
    mintPrice: bigint;
    startTime: number;
    endTime: number;
    maxTotalMintableByWallet: number;
    feeBps: number;
    restrictFeeRecipients: boolean;
}
export interface LocalMintPlan {
    to: string;
    data: string;
    value: bigint;
    drop: PublicDrop;
    feeRecipient: string;
}
export declare function fetchPublicDrop(rpcUrl: string, nftContract: string): Promise<PublicDrop | null>;
export declare function resolveFeeRecipient(rpcUrl: string, nftContract: string, restricted: boolean): Promise<{
    address: string;
    source: string;
} | null>;
export declare function encodeMintPublic(nftContract: string, feeRecipient: string, quantity: number): string;
export declare function buildLocalMintPlan(rpcUrl: string, nftContract: string, quantity: number): Promise<LocalMintPlan | null>;
