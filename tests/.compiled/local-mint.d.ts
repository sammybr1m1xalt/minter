import { LocalMintPlan } from "./seadrop-public";
export interface LocalSnipeOpts {
    nftContract: string;
    quantity: number;
    walletKeys: string[];
    rpcUrls: string[];
    maxFeePerGas: bigint;
    maxPriorityFee: bigint;
    gasLimit: number;
    targetStart: Date | null;
    plan: LocalMintPlan;
    /**
     * Maximum total price (wei) the user will accept. When set, the observed
     * price is asserted against it before signing. Ported from price.js —
     * without it a drop that raised its price between planning and firing would
     * be minted at the new price with no warning.
     */
    maxPriceWei?: bigint | null;
}
export declare function localPublicSnipe(opts: LocalSnipeOpts): Promise<void>;
