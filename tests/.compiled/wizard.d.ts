import { RunLogger } from "./logger";
export { runFcfsBranch, runFcfsBranchCli, runEligibilityCheck } from "./wizard-fcfs-new";
export interface WizardOptions {
    /** Schedule the mint for a specific time instead of asking. */
    at?: string | null;
    /** Poll the on-chain open time and mint the instant it opens. */
    whenOpen?: boolean;
    /** Max total price in ETH, "free", or "any". */
    maxPrice?: string | null;
    /** Wallet selection: all | N | 1,3,4. */
    wallets?: string | null;
    /** Chain key override. */
    chain?: string | null;
    /** Quantity per wallet. */
    quantity?: number | null;
    /** Pre-filled mint target, skipping the prompt. */
    target?: string | null;
}
export declare function runWizard(log: RunLogger, opts?: WizardOptions): Promise<void>;
export interface LoadedWallet {
    address: string;
    privateKey: string;
}
export declare function loadEnvKeys(): LoadedWallet[];
/**
 * Select a subset by spec: all | * | N | 1,3,4 (1-based).
 * Ported from wallets.js selectWallets().
 */
export declare function selectFromLoaded(all: LoadedWallet[], spec: string): LoadedWallet[];
