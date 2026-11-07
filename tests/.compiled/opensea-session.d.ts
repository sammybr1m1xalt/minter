import { Wallet } from "ethers";
export interface StoredSession {
    cookies: Map<string, string>;
    token: string;
    exp: number;
}
export interface StoredSiweSession extends StoredSession {
}
export declare function getSessionCookies(wallet: Wallet): Promise<string>;
export declare function refreshSiweSession(wallet: Wallet): Promise<string>;
