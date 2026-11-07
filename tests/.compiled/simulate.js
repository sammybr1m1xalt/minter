// ── Pre-broadcast simulation gate ───────────────────────────────────────────
//
// Ported from nft-minter-bot/src/mint.js, which simulates before EVERY broadcast:
//
//     // Simulate before broadcast.
//     try { await provider.call(txRequest); }
//     catch (e) { throw new Error(`simulation revert: ${parseRevert(e)}`); }
//
// The TS port had no simulation anywhere in the mint path — it signed and
// blasted unconditionally. That means a guaranteed revert (closed sale, wrong
// stage, insufficient allocation, a payload bound to another wallet) still
// costs gas to discover, and the failure surfaces as a reverted receipt rather
// than a refusal to send.
//
// This module is the shared gate. Both mint paths call it before signing.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY SIMULATE AT ALL WHEN WE BLAST TO MANY ENDPOINTS?
// ────────────────────────────────────────────────────────────────────────────
// Simulation is not a substitute for broadcasting — it is a filter. A tx that
// reverts in eth_call will revert on-chain, so sending it buys a guaranteed
// loss of gas plus a receipt poll. The blast is for redundancy against
// endpoint failure, not for hoping one node evaluates the call differently.
import { JsonRpcProvider } from "ethers";
/**
 * Extract a revert reason from an ethers error across the shapes different
 * RPC providers return. Never throws.
 */
export function parseRevert(err) {
    if (!err)
        return {};
    // ethers v6 puts the revert data on err.data, and the reason on
    // err.reason / err.shortMessage. Some providers nest it under
    // err.info.error.data (the raw JSON-RPC error object).
    const data = err.data ??
        err.info?.error?.data ??
        err.error?.data ??
        (typeof err.message === "string" && err.message.startsWith("0x") ? err.message : undefined);
    let reason;
    if (typeof err.reason === "string")
        reason = err.reason;
    else if (typeof err.shortMessage === "string")
        reason = err.shortMessage;
    else if (typeof err.message === "string") {
        // ethers wraps revert data as "execution reverted: <reason>" or
        // "execution reverted (no data present; likely require(false))".
        const m = err.message.match(/execution reverted:?\s*(.*)$/);
        reason = m ? m[1].trim() : err.message;
    }
    // Omit keys that are undefined rather than emitting them explicitly — a
    // caller doing `Object.keys()` or a deep-equal should not see phantom fields.
    const out = {};
    if (reason !== undefined)
        out.reason = reason;
    if (data !== undefined)
        out.data = data;
    return out;
}
/**
 * Simulate a transaction with eth_call.
 *
 * Returns { ok: true } when the call succeeds, { ok: false, reverted: true }
 * when it reverts. A NETWORK failure is reported as reverted: false with a
 * reason, so the caller can distinguish "the tx would revert" from "we could
 * not tell" — those need different handling.
 */
export async function simulateTx(provider, req, timeoutMs = 10_000) {
    // A hard timeout is mandatory. ethers retries a dead endpoint with exponential
    // backoff and no ceiling, so an unreachable RPC would otherwise hang the mint
    // path indefinitely. A simulation is a nice-to-have — it must never be able to
    // block a broadcast forever.
    let timer;
    try {
        await Promise.race([
            provider.call({
                to: req.to,
                from: req.from,
                data: req.data,
                value: req.value,
                ...(req.gasLimit ? { gasLimit: req.gasLimit } : {}),
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`simulation timeout after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
        return { ok: true, reverted: false };
    }
    catch (err) {
        const { reason, data } = parseRevert(err);
        // A missing/empty revert payload usually means the selector does not exist
        // rather than that the call reverted on state. Both are failures, but the
        // distinction matters for the message.
        const noData = !data || data === "0x";
        // Distinguish "the node said no" from "the node did not answer". A timeout
        // or a network error is NOT evidence the transaction reverts — treating it
        // as a revert would block a good mint because a public RPC had a bad moment.
        const msg = String(err?.reason ?? err?.shortMessage ?? err?.message ?? "").toLowerCase();
        const indeterminate = err?.name === "AbortError" ||
            /timeout|timed out|network error|failed to fetch|socket|econnrefused|enotfound|eai_again/i.test(msg);
        if (indeterminate) {
            return {
                ok: false,
                reverted: false,
                indeterminate: true,
                reason: reason ?? "RPC did not answer (timeout/network error)",
            };
        }
        return {
            ok: false,
            reverted: true,
            reason: reason ?? (noData ? "call reverted (no data — selector may not exist)" : undefined),
            data,
        };
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * Simulate against several providers and return the first definitive answer.
 *
 * Why several: a public RPC can be behind or mis-synced, and a single node's
 * "revert" is not always the chain's verdict. We treat a SUCCESS from any
 * endpoint as authoritative (the tx will land), and only refuse when EVERY
 * endpoint agrees it reverts.
 *
 * Returns the aggregate plus the individual results so callers can log which
 * endpoint said what.
 */
export async function simulateWithFallback(providers, req) {
    const attempts = [];
    for (const p of providers) {
        // Stop early on the first success — a successful simulation is definitive.
        const r = await simulateTx(p, req);
        attempts.push(r);
        if (r.ok) {
            return { result: r, attempts, agreeOnRevert: false };
        }
    }
    const agreeOnRevert = attempts.length > 0 && attempts.every((a) => !a.ok);
    return {
        result: attempts[attempts.length - 1] ?? { ok: false, reverted: true, reason: "no provider" },
        attempts,
        agreeOnRevert,
    };
}
// ── Provider lifecycle ──────────────────────────────────────────────────────
// ethers keeps a polling timer alive on every JsonRpcProvider. A provider that
// is never destroyed keeps the Node event loop busy, so a script that finishes
// its work still hangs forever. Every short-lived provider in this codebase must
// be destroyed when done — hence this helper.
/**
 * Build a short-lived provider for one-off reads (simulation, eth_getCode,
 * price reads). The caller MUST call destroy() when finished.
 */
export function shortLivedProvider(rpcUrl, chainId) {
    return new JsonRpcProvider(rpcUrl, chainId, {
        staticNetwork: true,
        // No retries: a dead endpoint should fail immediately, not back off.
        pollingInterval: 1000,
    });
}
/**
 * Run a read against a throwaway provider and always destroy it.
 * Returns null when the read fails — callers treat that as "unknown".
 */
export async function withShortLivedProvider(rpcUrl, fn, chainId) {
    const provider = shortLivedProvider(rpcUrl, chainId);
    try {
        return await fn(provider);
    }
    catch {
        return null;
    }
    finally {
        // Destroy synchronously — this is what lets the process exit.
        try {
            provider.destroy();
        }
        catch {
            // Already destroyed.
        }
    }
}
export const REVERT_PATTERNS = [
    // Order matters: the more specific patterns must come FIRST, or a broader
    // pattern shadows them. "insufficient funds" would otherwise swallow
    // "insufficient funds for gas" and mislabel a gas problem as a balance one.
    { pattern: /insufficient funds for gas/i, label: "insufficient funds for gas", retryable: false },
    { pattern: /insufficient (funds|balance)/i, label: "insufficient funds", retryable: false },
    { pattern: /not active|notactive|not started|notstarted|notenabled|not enabled/i, label: "sale not active", retryable: true },
    { pattern: /before start|too early|not yet/i, label: "sale has not started", retryable: true },
    { pattern: /ended|expired|after end|sale over/i, label: "sale has ended", retryable: false },
    { pattern: /invalid merkle|invalidmerkleproof|not on (the )?allowlist|not eligible/i, label: "wallet not eligible", retryable: false },
    { pattern: /exceeds? (the )?(max|limit|cap)|mint.*too many|over the limit/i, label: "quantity exceeds the per-wallet cap", retryable: false },
    { pattern: /price.*(exceed|changed|mismatch)|incorrect.*(price|value)|wrong price/i, label: "price changed since the payload was built", retryable: false },
    { pattern: /signature.*(invalid|expired|mismatch)|invalid signature|bad signature/i, label: "signature invalid or expired", retryable: false },
    { pattern: /nonce/i, label: "nonce mismatch", retryable: true },
];
/** Classify a revert reason against the known patterns. */
export function classifyRevert(reason) {
    if (!reason)
        return null;
    for (const p of REVERT_PATTERNS) {
        if (p.pattern.test(reason))
            return p;
    }
    return null;
}
