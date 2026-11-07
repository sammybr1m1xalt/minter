export declare function closePrompts(): void;
export declare function ask(prompt: string, fallback?: string): Promise<string>;
export declare function askHidden(prompt: string): Promise<string>;
export interface Choice<T> {
    label: string;
    value: T;
    hint?: string;
}
export declare function askChoice<T>(title: string, choices: Choice<T>[], defaultIndex?: number): Promise<T>;
export declare function askNumber(question: string, fallback: number, opts?: {
    min?: number;
    max?: number;
}): Promise<number>;
export declare function askText(question: string, fallback?: string): Promise<string>;
export declare function askYesNo(question: string, defaultYes?: boolean): Promise<boolean>;
