export interface RunLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    field(key: string, value: string | number | boolean): void;
    dumpError(err: unknown, context?: Record<string, string>): void;
    end(): void;
}
export declare function createRunLogger(opts: {
    mode: string;
    label?: string;
}): RunLogger;
