"use strict";
// ── ABI-driven mint discovery ───────────────────────────────────────────────
//
// The selector registry in mint-generic.ts is a fixed list of 37 signatures.
// That caps coverage: Milady's real mint is `mintMiladys(uint256 numberOfTokens)`
// and appears in no registry. The ABI is the truth.
//
// This module fetches a contract's verified ABI and derives mint candidates
// from it, so coverage is bounded by what the contract actually exposes rather
// than by a hand-maintained list.
//
// Sources, in order:
//   1. Sourcify — open, no API key, covers most verified mainnet contracts.
//      https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi
//   2. Etherscan V2 — requires ETHERSCAN_API_KEY, covers chains Sourcify misses.
//      https://api.etherscan.io/v2/api?chainid={id}&module=contract&action=getabi
//
// Both are read-only public lookups. Nothing here signs or broadcasts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAbiFromSourcify = fetchAbiFromSourcify;
exports.fetchAbiFromEtherscan = fetchAbiFromEtherscan;
exports.fetchAbi = fetchAbi;
exports.looksLikeMint = looksLikeMint;
exports.deriveMintCandidates = deriveMintCandidates;
exports.classifyParam = classifyParam;
exports.synthFromAbi = synthFromAbi;
exports.probeAbiCandidate = probeAbiCandidate;
exports.readPriceFromAbi = readPriceFromAbi;
const ethers_1 = require("ethers");
/** Sourcify chain-path map. Only chains Sourcify serves need entries. */
const SOURCIFY_CHAIN_PATHS = {
    1: "1",
    10: "10",
    56: "56",
    100: "100",
    137: "137",
    250: "250",
    8453: "8453",
    42161: "42161",
    43114: "43114",
    59144: "59144",
    534352: "534352",
    11155111: "11155111",
};
/** Fetch the verified ABI from Sourcify. Returns null when not verified. */
async function fetchAbiFromSourcify(chainId, address, timeoutMs = 15_000) {
    const path = SOURCIFY_CHAIN_PATHS[chainId];
    if (!path)
        return { abi: null, source: null, error: `chain ${chainId} not served by Sourcify` };
    const url = `https://sourcify.dev/server/v2/contract/${path}/${address}?fields=abi`;
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { accept: "application/json" },
        });
        if (!res.ok) {
            return { abi: null, source: null, error: `sourcify HTTP ${res.status}` };
        }
        const json = (await res.json());
        if (!Array.isArray(json.abi) || json.abi.length === 0) {
            return { abi: null, source: null, error: "sourcify returned no abi" };
        }
        return { abi: json.abi, source: "sourcify" };
    }
    catch (e) {
        return { abi: null, source: null, error: `sourcify: ${e?.message ?? "fetch failed"}` };
    }
}
/** Fetch the verified ABI from Etherscan V2. Requires ETHERSCAN_API_KEY. */
async function fetchAbiFromEtherscan(chainId, address, apiKey, timeoutMs = 15_000) {
    if (!apiKey)
        return { abi: null, source: null, error: "no ETHERSCAN_API_KEY" };
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok)
            return { abi: null, source: null, error: `etherscan HTTP ${res.status}` };
        const json = (await res.json());
        if (json.status !== "1") {
            return { abi: null, source: null, error: `etherscan: ${json.result ?? json.message}` };
        }
        const abi = JSON.parse(json.result);
        if (!Array.isArray(abi))
            return { abi: null, source: null, error: "etherscan returned a non-array" };
        return { abi, source: "etherscan" };
    }
    catch (e) {
        return { abi: null, source: null, error: `etherscan: ${e?.message ?? "fetch failed"}` };
    }
}
/**
 * Fetch the ABI, trying Sourcify first then Etherscan.
 * Returns the first success; error reports the last failure.
 */
async function fetchAbi(chainId, address, opts = {}) {
    const sourcify = await fetchAbiFromSourcify(chainId, address, opts.timeoutMs);
    if (sourcify.abi)
        return sourcify;
    if (opts.etherscanKey) {
        const etherscan = await fetchAbiFromEtherscan(chainId, address, opts.etherscanKey, opts.timeoutMs);
        if (etherscan.abi)
            return etherscan;
        return { abi: null, source: null, error: `sourcify: ${sourcify.error}; etherscan: ${etherscan.error}` };
    }
    return { abi: null, source: null, error: sourcify.error ?? "no abi source available" };
}
// ── Mint-function derivation ────────────────────────────────────────────────
/**
 * Heuristic: does this function look like a mint?
 *
 * Deliberately broad — the cost of a false positive is one extra eth_call, while
 * the cost of a false negative is a mint we never find. Excludes view/pure
 * functions (they cannot mint) and obvious non-mints.
 */
function looksLikeMint(name, stateMutability) {
    if (stateMutability === "view" || stateMutability === "pure")
        return false;
    if (!/mint|claim|purchase|buy|publicsale|presale|whitelist|allowlist/i.test(name))
        return false;
    // Exclude setters and config — they are not user-facing mints.
    if (/^set|^configure|^flip|^toggle|^withdraw|^pause|^unpause|^renounce|^transfer|^approve/i.test(name)) {
        return false;
    }
    // Exclude owner-only helpers. These are real mints but not callable by us, and
    // probing them wastes calls and produces misleading "exists" results.
    if (/^reserve|^edit|^admin|^owner|^team|^founder|^dao|^airdrop/i.test(name))
        return false;
    return true;
}
/**
 * Derive mint candidates from an ABI.
 *
 * Each candidate carries its real parameter names and types, which is what makes
 * argument synthesis possible: `mintMiladys(uint256 numberOfTokens)` tells us the
 * parameter is a token count, whereas a bare `uint256` does not.
 */
function deriveMintCandidates(abi) {
    const iface = new ethers_1.Interface(abi);
    const out = [];
    for (const fragment of iface.fragments) {
        if (fragment.type !== "function")
            continue;
        const fn = fragment;
        if (!looksLikeMint(fn.name, fn.stateMutability))
            continue;
        const inputs = (fn.inputs ?? []).map((i) => ({
            name: i.name ?? "",
            type: i.type,
            internalType: i.internalType,
        }));
        out.push({
            name: fn.name,
            signature: fn.format("sighash"),
            selector: fn.selector,
            inputs,
            stateMutability: fn.stateMutability,
            payable: fn.payable,
        });
    }
    // Most specific first: functions with fewer parameters are more likely to be
    // the simple public mint, and are cheaper to probe.
    return out.sort((a, b) => a.inputs.length - b.inputs.length);
}
function classifyParam(name, type) {
    const n = name.toLowerCase().replace(/_/g, "");
    const t = type.toLowerCase();
    // Addresses: recipient unless the name says otherwise.
    if (t === "address") {
        if (/referr|fee|royalt|payable|payment|commission/i.test(n))
            return "unknown";
        return "recipient";
    }
    // bytes32[] is almost always a merkle proof.
    if (t === "bytes32[]")
        return "proof";
    // bytes / bytes4 / string: signature or arbitrary data.
    if (t === "bytes" || t.startsWith("bytes")) {
        if (/sign|sig|signature/i.test(n))
            return "signature";
        if (/proof|merkle/i.test(n))
            return "proof";
        return "data";
    }
    if (t === "string") {
        if (/uri|tokenuri|metadata/i.test(n))
            return "unknown";
        return "data";
    }
    // uint / int: quantity, token id, or something we cannot know.
    if (/^u?int/.test(t)) {
        if (/proof|merkle|index|stage|round|phase|nonce|salt/i.test(n))
            return "unknown";
        if (/tokenid|token_id|tokenids/i.test(n))
            return "tokenId";
        if (/referr|fee|price|cost|amountpaid|value/i.test(n))
            return "unknown";
        if (/number|quantity|qty|count|amount|num|supply|limit|max/i.test(n))
            return "quantity";
        // A bare uint256 with no informative name: assume quantity. This is the
        // common case for `mint(uint256)`, and the simulation gate catches errors.
        return "quantity";
    }
    return "unknown";
}
/**
 * Build calldata arguments from an ABI candidate and a synthesis context.
 *
 * Returns { ok: false, reason } when a parameter cannot be filled safely — the
 * caller must SKIP rather than guess. This is the guard that prevents encoding a
 * fabricated proof, a wrong price, or a referral address.
 */
function synthFromAbi(candidate, ctx) {
    const args = [];
    for (const input of candidate.inputs) {
        const role = classifyParam(input.name, input.type);
        switch (role) {
            case "recipient":
                if (!ctx.to || /^0x0+$/.test(ctx.to))
                    return { ok: false, reason: "no recipient address" };
                args.push(ctx.to);
                break;
            case "quantity":
                args.push(ctx.amount > 0n ? ctx.amount : 1n);
                break;
            case "tokenId":
                args.push(ctx.tokenId ?? 0n);
                break;
            case "proof":
                if (!ctx.proof || ctx.proof.length === 0) {
                    return { ok: false, reason: `needs a merkle proof (${input.name})` };
                }
                args.push(ctx.proof);
                break;
            case "signature":
                if (!ctx.signature) {
                    return { ok: false, reason: `needs a signature (${input.name})` };
                }
                args.push(ctx.signature);
                break;
            case "data":
                args.push("0x");
                break;
            case "unknown":
                // A parameter we cannot classify. Refuse rather than guess — a wrong
                // value here is a silent failure that costs gas to discover.
                return { ok: false, reason: `unclassifiable parameter ${input.name}:${input.type}` };
        }
    }
    return { ok: true, args };
}
/**
 * Probe an ABI-derived candidate against the chain.
 *
 * Distinguishes:
 *   - exists: false            → selector absent, skip
 *   - exists: true, wouldSucceed: false → present but reverting (needs payment,
 *     proof, allowlist, or the sale is closed)
 *   - exists: true, wouldSucceed: true  → the mint would go through
 */
async function probeAbiCandidate(contract, provider, candidate, args, from, value) {
    const iface = new ethers_1.Interface([`function ${candidate.signature}${candidate.payable ? " payable" : ""}`]);
    let data;
    try {
        data = iface.encodeFunctionData(candidate.name, args);
    }
    catch (e) {
        return { candidate, exists: false, wouldSucceed: false, error: `encode failed: ${e?.message}` };
    }
    try {
        await provider.call({ to: contract, from, data, value });
        return { candidate, exists: true, wouldSucceed: true };
    }
    catch (e) {
        const errData = e?.data ?? e?.info?.error?.data;
        if (errData && errData !== "0x") {
            return { candidate, exists: true, wouldSucceed: false, error: e?.reason ?? e?.shortMessage };
        }
        return { candidate, exists: false, wouldSucceed: false, error: e?.reason ?? e?.shortMessage };
    }
}
// ── Price reading from ABI ──────────────────────────────────────────────────
/**
 * Find a price by reading the contract's own price getter.
 *
 * Prefers getters whose name mentions mint/price/cost/sale. Returns null when
 * none exists — a free mint is a legitimate outcome, but the caller should
 * confirm via simulation rather than assume.
 */
async function readPriceFromAbi(contract, provider, abi, amount = 1n) {
    const iface = new ethers_1.Interface(abi);
    const getters = iface.fragments.filter((f) => f.type === "function" &&
        f.stateMutability === "view" ||
        f.stateMutability === "pure");
    const viewGetters = getters.filter((f) => (f.inputs?.length ?? 0) <= 1 &&
        /^u?int/.test(f.outputs?.[0]?.type ?? "") &&
        /price|cost|fee|mint|sale/i.test(f.name));
    // Prefer the most specific name.
    viewGetters.sort((a, b) => {
        const score = (n) => /mintprice|^price$|publicsaleprice|^cost$|saleprice/.test(n.toLowerCase()) ? 0 : 1;
        return score(a.name) - score(b.name);
    });
    for (const g of viewGetters) {
        try {
            const args = g.inputs.length === 1 ? [amount] : [];
            const data = iface.encodeFunctionData(g.name, args);
            const raw = await provider.call({ to: contract, data });
            const decoded = iface.decodeFunctionResult(g.name, raw);
            const v = decoded[0];
            if (typeof v === "bigint")
                return { price: v, getter: g.name };
        }
        catch {
            continue;
        }
    }
    return null;
}
//# sourceMappingURL=abi-mint.js.map