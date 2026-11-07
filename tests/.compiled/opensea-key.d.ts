export interface KeyPoolEntry {
    api_key: string;
    name: string;
    expires_at: string;
    minted_at: string;
    times_used: number;
    last_probe: "alive" | "throttled" | "dead" | "timeout" | "unknown" | "alive_but_exhausted" | "server_error";
    last_probe_at: string;
    probe_latency_ms: number;
    score: number;
    remaining_calls: number;
    rate_limit_reset: number;
}
/** Strip stale keys: expired (expires_at past) or older than 7 days. */
export declare function pruneStaleKeys(pool: KeyPoolEntry[]): KeyPoolEntry[];
export declare function loadKeyPool(): KeyPoolEntry[];
export declare function saveKeyPool(pool: KeyPoolEntry[]): void;
export declare function clearKeyPool(): void;
export declare function probeKey(apiKey: string, timeoutMs?: number): Promise<{
    status: "alive" | "throttled" | "dead" | "alive_but_exhausted" | "timeout" | "server_error";
    latencyMs: number;
    remaining: number;
    resetAt: number;
}>;
export declare function computeScore(entry: KeyPoolEntry): number;
export declare function probeAndRankPool(pool: KeyPoolEntry[]): Promise<{
    pool: KeyPoolEntry[];
    best: KeyPoolEntry | null;
}>;
export declare function pickBestKey(pool: KeyPoolEntry[]): Promise<{
    api_key: string;
    source: string;
    entry: KeyPoolEntry;
} | null>;
export declare function addKeyToPool(meta: {
    api_key: string;
    name: string;
    expires_at: string;
}): KeyPoolEntry;
export declare function removeKeyFromPool(apiKey: string): void;
export declare function getValidApiKey(_opts?: {
    timeoutMs?: number;
}): Promise<{
    api_key: string;
    source: string;
} | null>;
export declare function probeApiKey(apiKey: string, timeoutMs?: number): Promise<boolean>;
