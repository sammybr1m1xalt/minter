/** Parse a "when" spec into an absolute unix-seconds timestamp. */
export declare function parseWhen(spec: string, nowMs?: number): number;
/**
 * True when a spec parses. Useful for validating user input before committing
 * to a long wait.
 */
export declare function isValidWhen(spec: string): boolean;
/** Format a unix-seconds timestamp as a human-readable remaining duration. */
export declare function formatWait(unixSeconds: number, nowMs?: number): string;
