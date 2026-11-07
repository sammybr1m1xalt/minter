import { Wallet } from "ethers";
import { ChainProfile } from "./chains";
export interface SnipeReadyInput {
    chainProfile: ChainProfile;
    rpcUrls: string[];
    wallets: Wallet[];
    balances: (bigint | null)[];
    nftContract: string;
    quantity: number;
    valuePerWallet: bigint;
    required: bigint;
    gasLimit: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    address?: string;
    slug?: string;
    targetStart: Date | null;
    timingLabel: string;
    modeLabel: string;
    targetLabel: string;
    promptForGas?: boolean;
    openSeaGasInfo?: string;
}
export declare function promptGasGwei(chainProfile: ChainProfile, rpcUrls: string[], envMaxFeeOverride?: number, envPriorityOverride?: number): Promise<{
    maxFeePerGasWei: bigint;
    maxPriorityFeePerGasWei: bigint;
    defaultGasLimit: number;
}>;
export declare function displayBalances(input: SnipeReadyInput): {
    shortCount: number;
    poorerBalance: bigint | null;
};
export declare function confirmSnipe(input: SnipeReadyInput): Promise<boolean>;
export declare function promptTiming(dropStartTime: Date | null): Promise<{
    targetStart: Date | null;
    timingLabel: string;
}>;
