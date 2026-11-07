import { ChainProfile } from "./chains";
import { RunLogger } from "./logger";
export declare function runFcfsBranch(log: RunLogger, walletKeys: string[], chainProfile: ChainProfile, chainKey: string, nftContract: string, quantity: number, rpcUrls: string[], target: {
    label: string;
    at?: string | null;
    whenOpen?: boolean;
    maxPrice?: string | null;
}): Promise<void>;
export declare function runEligibilityCheck(_log: RunLogger, nftContract: string): Promise<void>;
export interface FcfsCliOptions {
    at?: string | null;
    whenOpen?: boolean;
    maxPrice?: string | null;
    wallets?: string | null;
    chain?: string | null;
    quantity?: number | null;
}
export declare function runFcfsBranchCli(log: RunLogger, targetArg: string, opts?: FcfsCliOptions): Promise<void>;
