import type { DropPhase } from "./fcfs-drops";
export declare function fetchOnChainDrops(nftContract: string, timeoutMs?: number, chainKey?: string): Promise<DropPhase[]>;
export declare function fetchSingleOnChainDrop(nftContract: string, _timeoutMs?: number, chainKey?: string): Promise<DropPhase | null>;
