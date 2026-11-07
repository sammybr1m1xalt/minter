"use strict";
// ── Scatter.art launchpad integration ──────────────────────────────────────
//
// Ported from nft-minter-bot/src/scatter.js.
//
// Scatter contracts use a custom mint(auth, quantity, affiliate, signature)
// entrypoint, so generic mint-selector probing does NOT work — the ABI is not
// discoverable from the contract alone. Instead the public API resolves the
// collection, the wallet's eligible mint lists, and builds the exact mint
// transaction (proof + signature included).
//
// The TS port had no Scatter support at all, so every Scatter collection was
// untargetable.
//
// No API key required.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCATTER_NATIVE_SENTINEL = exports.SCATTER_UNLIMITED = void 0;
exports.getScatterCollection = getScatterCollection;
exports.getEligibleLists = getEligibleLists;
exports.isNativeList = isNativeList;
exports.pickBestList = pickBestList;
exports.buildScatterMint = buildScatterMint;
const SCATTER_API = "https://api.scatter.art/v1";
/** Sentinel the contract uses for "unlimited" wallet/list limits (uint32 max). */
exports.SCATTER_UNLIMITED = 4294967295;
const NATIVE = "0x0000000000000000000000000000000000000000";
/**
 * Fetch a collection by slug. Returns null when it isn't a Scatter collection
 * (404) or the API is unreachable.
 *
 * Only slugs resolve — the API has no address lookup, so callers must pass the
 * collection's Scatter slug.
 */
async function getScatterCollection(slug) {
    try {
        const r = await fetch(`${SCATTER_API}/collection/${encodeURIComponent(slug)}`);
        if (!r.ok)
            return null;
        const j = await r.json();
        if (!j?.address)
            return null;
        return {
            address: j.address,
            chainId: j.chain_id,
            name: j.name,
            maxItems: j.max_items ?? null,
            numItems: j.num_items ?? null,
            website: j.website || null,
            twitter: j.twitter || null,
            discord: j.discord || null,
            opensea: j.opensea || null,
            creator: j.creator_address || j.owner || null,
            slug,
        };
    }
    catch {
        return null;
    }
}
/**
 * Fetch the mint lists a wallet is eligible for. Without minterAddress the API
 * returns public lists only. Returns [] on error (treated as "no lists").
 */
async function getEligibleLists(slug, minterAddress) {
    const url = `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists${minterAddress ? `?minterAddress=${minterAddress}` : ""}`;
    try {
        const r = await fetch(url);
        if (!r.ok)
            return [];
        const j = await r.json();
        return Array.isArray(j) ? j : [];
    }
    catch {
        return [];
    }
}
/** A list is "public" when its currency is native and it has no wallet gate. */
function isNativeList(list) {
    return !list.currency_address || list.currency_address.toLowerCase() === NATIVE;
}
/**
 * Choose the best list to mint from among eligible lists: cheapest native-token
 * list wins (free > paid), tie-break by earliest start. ERC20-priced lists are
 * only chosen when no native list exists.
 */
function pickBestList(lists) {
    if (!lists.length)
        return null;
    const priced = lists
        .map((l) => ({ list: l, price: Number(l.token_price ?? 0), native: isNativeList(l) }))
        .sort((a, b) => {
        if (a.native !== b.native)
            return a.native ? -1 : 1; // native first
        if (a.price !== b.price)
            return a.price - b.price; // cheapest first
        return new Date(a.list.start_time || 0).getTime() - new Date(b.list.start_time || 0).getTime();
    });
    return priced[0].list;
}
/**
 * Build the mint transaction via the API.
 * `lists` is [{ id, quantity }]. affiliate is an optional shill address.
 */
async function buildScatterMint(args) {
    const body = {
        collectionAddress: args.collectionAddress,
        chainId: args.chainId,
        minterAddress: args.minterAddress,
        lists: args.lists,
    };
    if (args.affiliate)
        body.affiliateAddress = args.affiliate;
    const r = await fetch(`${SCATTER_API}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`scatter /mint ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    if (!j?.mintTransaction?.to)
        throw new Error("scatter /mint: no mintTransaction in response");
    return {
        to: j.mintTransaction.to,
        value: BigInt(j.mintTransaction.value || 0),
        data: j.mintTransaction.data,
        erc20s: Array.isArray(j.erc20s) ? j.erc20s : [],
    };
}
exports.SCATTER_NATIVE_SENTINEL = NATIVE;
//# sourceMappingURL=scatter.js.map