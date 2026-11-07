"use strict";
// ── Site scanner: extract candidate contract addresses from a web page ──────
//
// Given the HTML of any mint page, produce a ranked list of candidate contract
// addresses. This is the first stage of the scan → verify → mint pipeline.
//
// Design constraints, learned from the OpenSea scrape (slug-resolver.ts):
//
//   1. A page contains MANY 40-hex strings — OpenSea collection pages carry
//      ~154 (WETH, USDC, staked tokens, other collections). Returning the first
//      one is luck, not design. We return all of them, ranked.
//
//   2. The address is often NOT in the visible HTML. React/Next apps embed it
//      in a JSON payload inside a <script> tag, or fetch it after hydration.
//      We scan both the raw HTML and the script bodies.
//
//   3. A plain fetch cannot execute JavaScript. Addresses loaded by a
//      client-side API call after page load are simply not visible to us. We
//      report what we found and say so — we do not guess.
//
// This module is pure: no network, no chain calls. Verification happens in
// contract-verify.ts, which is the gate that makes these candidates trustworthy.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAddresses = extractAddresses;
exports.scriptBodies = scriptBodies;
exports.rankCandidates = rankCandidates;
exports.scanHtml = scanHtml;
exports.extractApiPaths = extractApiPaths;
exports.expandApiPaths = expandApiPaths;
exports.extractScriptUrls = extractScriptUrls;
exports.scanWithBundles = scanWithBundles;
exports.scanUrl = scanUrl;
// ── Extraction ──────────────────────────────────────────────────────────────
const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
/** Keys that strongly suggest the value is a collection contract. */
const STRONG_KEYS = [
    "contractaddress",
    "nftcontract",
    "nftcontractaddress",
    "collectionaddress",
    "contract",
    "collection",
];
/**
 * Keys that are ambiguous: "address" is used both for the collection AND for
 * stage/payment/allowlist contracts. It earns a moderate score, not a strong
 * one — otherwise a drop's stage address outranks its own collection.
 *
 * It is still worth more than an unknown key, because a page that labels a
 * value plainly "address" usually means THE address of the thing being viewed.
 */
const AMBIGUOUS_KEYS = ["address"];
/** Keys that suggest the value is NOT the collection we want. */
const WEAK_KEYS = [
    "feerecipient",
    "payoutaddress",
    "creator",
    "owner",
    "tokenaddress",
    "currency",
    "paymenttoken",
    "royaltypayout",
    "factory",
    "passsigner",
    "underlying",
    "stageaddress",
    "stageaddresses",
];
function extractAddresses(html) {
    const found = new Set();
    for (const m of html.matchAll(ADDR_RE)) {
        found.add(m[0]);
    }
    return [...found];
}
/** Pull out the bodies of every <script> tag. */
function scriptBodies(html) {
    const bodies = [];
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    for (const m of html.matchAll(re)) {
        const body = m[1];
        // Skip obviously empty or pure-src scripts.
        if (body && body.trim().length > 0)
            bodies.push(body);
    }
    return bodies;
}
/** Find addresses that appear under a recognisable JSON key. */
function extractKeyedAddresses(text) {
    const out = [];
    // "key":"0x…" — the shape used by virtually every embedded JSON payload.
    const re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g;
    for (const m of text.matchAll(re)) {
        out.push({ address: m[2], key: m[1] });
    }
    return out;
}
/**
 * Find addresses that appear under a recognisable JSON key, tagged with the
 * nesting depth of the object that holds them.
 *
 * Depth matters: an OpenSea collection page embeds ITEM payloads alongside the
 * COLLECTION payload. An item's "contractAddress" is a different token on the
 * same collection — scoring it as strongly as the collection's own "address"
 * field ranks the wrong contract first. The collection-level object is shallower
 * than the item objects nested inside it.
 *
 * Single pass: the depth is tracked as we walk the text, so an 868KB page does
 * not become O(n²).
 */
function extractKeyedAddressesWithDepth(text) {
    const out = [];
    const re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g;
    let depth = 0;
    let cursor = 0;
    for (const m of text.matchAll(re)) {
        // Walk from the last match to this one, counting braces.
        for (let i = cursor; i < m.index; i++) {
            const ch = text[i];
            if (ch === "{")
                depth++;
            else if (ch === "}")
                depth = Math.max(0, depth - 1);
        }
        cursor = m.index;
        out.push({ address: m[2], key: m[1], depth: Math.max(0, depth) });
    }
    return out;
}
/** Find addresses inside a "contracts":[…] block. */
function extractContractsBlockAddresses(text) {
    const out = [];
    const re = /"contracts"\s*:\s*\[([^\]]{0,4000})\]/g;
    for (const m of text.matchAll(re)) {
        for (const a of m[1].matchAll(ADDR_RE))
            out.push(a[0]);
    }
    return out;
}
/** Find addresses referenced by a mint-style button or link. */
function extractMintButtonAddresses(html) {
    const out = [];
    const re = /(?:data-[a-z-]*address|data-contract|href)\s*=\s*"(0x[a-fA-F0-9]{40})"/gi;
    for (const m of html.matchAll(re))
        out.push(m[1]);
    return out;
}
// ── Ranking ─────────────────────────────────────────────────────────────────
/**
 * Rank candidates by evidence. The ordering reflects how trustworthy each
 * signal is:
 *
 *   mint-button attribute  → the page itself links this address to minting
 *   strong JSON key        → "contractAddress" is unambiguous
 *   contracts block        → a dedicated contracts list
 *   repeated occurrence    → the collection address usually appears many times
 *   script blob            → embedded config, better than visible text
 *   bare html text         → weakest; could be anything
 *
 * Deductions apply for known-bad keys (fee recipient, payout, currency).
 */
function rankCandidates(keyed, contractsBlock, scriptHits, buttonHits, allAddresses, 
/** Optional per-address nesting depth, from extractKeyedAddressesWithDepth. */
depths) {
    const occurrences = new Map();
    for (const a of allAddresses) {
        occurrences.set(a, (occurrences.get(a) ?? 0) + 1);
    }
    const score = new Map();
    const source = new Map();
    const keyName = new Map();
    const bump = (addr, pts, src, key) => {
        const a = addr.toLowerCase();
        score.set(a, (score.get(a) ?? 0) + pts);
        // Keep the strongest source we have seen for this address.
        if (!source.has(a))
            source.set(a, src);
        if (key)
            keyName.set(a, key);
    };
    // Addresses that are never a collection contract. The zero address is a
    // placeholder used throughout OpenSea's payloads; 0x4200…06 is Base's
    // native-token placeholder. Both scored above the real collection because
    // they appear under an "address" key, so they must be excluded outright.
    const isPlaceholder = (addr) => {
        const a = addr.toLowerCase();
        if (/^0x0+$/.test(a))
            return true;
        // Base native token placeholder.
        if (a === "0x4200000000000000000000000000000000000006")
            return true;
        return false;
    };
    // Dedupe keyed hits by (address, key). The same address appears under the
    // same key many times on a real page (OpenSea: 161 occurrences of one
    // address), and scoring each hit separately would multiply the bonus by the
    // occurrence count — a frequency signal would masquerade as a key signal.
    const keyedSeen = new Set();
    const keyedDeduped = [];
    for (const k of keyed) {
        const id = k.address.toLowerCase() + "|" + k.key.toLowerCase();
        if (keyedSeen.has(id))
            continue;
        keyedSeen.add(id);
        keyedDeduped.push(k);
    }
    for (const { address, key } of keyedDeduped) {
        const lowerKey = key.toLowerCase();
        // Nesting depth is a tiebreaker: a shallower object is closer to the page's
        // top-level payload, which describes the thing being viewed. An item nested
        // inside a collection page is deeper than the collection itself.
        const depth = depths?.get(address.toLowerCase()) ?? 0;
        const depthPenalty = Math.min(depth, 10);
        if (WEAK_KEYS.includes(lowerKey)) {
            bump(address, 2, "json-key", key);
        }
        else if (STRONG_KEYS.includes(lowerKey)) {
            bump(address, Math.max(5, 40 - depthPenalty), "json-key", key);
        }
        else if (AMBIGUOUS_KEYS.includes(lowerKey)) {
            // "address" is used for collections AND for stage/payment contracts.
            // Scoring it as strong lets a stage address outrank the collection.
            bump(address, Math.max(5, 12 - Math.floor(depthPenalty / 2)), "json-key", key);
        }
        else {
            bump(address, Math.max(5, 15 - Math.floor(depthPenalty / 2)), "json-key", key);
        }
    }
    // Same dedupe for the contracts block — an address listed twice in a
    // contracts array is one signal, not two.
    const contractsSeen = new Set();
    for (const a of contractsBlock) {
        const lower = a.toLowerCase();
        if (contractsSeen.has(lower))
            continue;
        contractsSeen.add(lower);
        bump(a, 30, "contracts-block");
    }
    const buttonSeen = new Set();
    for (const a of buttonHits) {
        const lower = a.toLowerCase();
        if (buttonSeen.has(lower))
            continue;
        buttonSeen.add(lower);
        bump(a, 50, "mint-button");
    }
    const scriptSeen = new Set();
    for (const a of scriptHits) {
        const lower = a.toLowerCase();
        if (scriptSeen.has(lower))
            continue;
        scriptSeen.add(lower);
        bump(a, 10, "script-blob");
    }
    // Repeated occurrence is a real signal, and on real pages it is the strongest
    // one: the collection address appears dozens of times, while stage and
    // payment addresses appear once or twice. Capped so a page that repeats one
    // address hundreds of times cannot run away with the ranking.
    for (const [addr, count] of occurrences) {
        if (count > 1)
            bump(addr, Math.min(count, 20), source.get(addr) ?? "html-text");
    }
    const seen = new Set();
    const out = [];
    for (const [addr, pts] of score) {
        if (seen.has(addr))
            continue;
        if (isPlaceholder(addr))
            continue;
        seen.add(addr);
        out.push({
            address: addr,
            score: pts,
            source: source.get(addr) ?? "html-text",
            key: keyName.get(addr),
            occurrences: occurrences.get(addr) ?? 1,
        });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}
// ── Main entry ──────────────────────────────────────────────────────────────
/**
 * Scan a page and return ranked candidate addresses.
 *
 * Pure function — the caller fetches the HTML. Keeping this separate from the
 * network means it can be tested against saved fixtures.
 */
function scanHtml(html) {
    const all = extractAddresses(html);
    if (all.length === 0) {
        return { candidates: [], totalFound: 0, empty: true };
    }
    const keyedWithDepth = extractKeyedAddressesWithDepth(html);
    const keyed = keyedWithDepth.map(({ address, key }) => ({ address, key }));
    const depths = new Map();
    for (const k of keyedWithDepth) {
        const a = k.address.toLowerCase();
        // Keep the SHALLOWEST depth seen for each address — an address that
        // appears both at collection level and inside an item should be scored as
        // the collection-level hit.
        const prev = depths.get(a);
        if (prev === undefined || k.depth < prev)
            depths.set(a, k.depth);
    }
    const contractsBlock = extractContractsBlockAddresses(html);
    const buttons = extractMintButtonAddresses(html);
    const scripts = scriptBodies(html);
    const scriptHits = new Set();
    for (const body of scripts) {
        for (const a of extractAddresses(body))
            scriptHits.add(a);
    }
    const candidates = rankCandidates(keyed, contractsBlock, [...scriptHits], buttons, all, depths);
    return { candidates, totalFound: all.length, empty: candidates.length === 0 };
}
// ── JS bundle following ─────────────────────────────────────────────────────
//
// A client-rendered app (Vite/Next/CRA) ships a shell HTML page with an empty
// #root and loads its data from a JSON API. The address is in neither the HTML
// nor the visible text — it is behind an API call the page makes after load.
//
// The bundle contains that API path as a plain string. So we read the bundle,
// extract the paths, and call them. This is what makes fungolabs.org work: the
// shell has zero addresses, but the bundle references `/api/campaigns/drops/…`
// and that endpoint returns the contract.
//
// We do NOT execute JavaScript. We read the bundle as text and follow the
// strings — which is enough for the common case where the API path is a literal.
/** Extract API paths referenced in a JS bundle. */
function extractApiPaths(js, baseUrl) {
    const out = new Set();
    // "/api/..." — absolute path from the app root.
    for (const m of js.matchAll(/["'`](\/[a-zA-Z][a-zA-Z0-9_\-\/]{2,60})["'`]/g)) {
        const p = m[1];
        // Skip static assets and route fragments.
        if (/\.(js|css|svg|png|webp|woff2?|json)$/i.test(p))
            continue;
        if (p.startsWith("/assets/") || p.startsWith("/static/"))
            continue;
        if (!p.startsWith("/api/") && !p.startsWith("/v1/") && !p.startsWith("/v2/"))
            continue;
        out.add(p);
    }
    // Template literals: `/api/campaigns/drops/${...}`. The regex above stops at
    // the `$`, so the captured path is the literal prefix — which is exactly what
    // we want. Record it with a marker so expandApiPaths knows to substitute.
    // The prefix may end with a "/" before the "${" — strip it so substitution
    // does not produce a double slash.
    for (const m of js.matchAll(/[`"'](\/api\/[a-zA-Z0-9_\-\/]{2,50}\/?)\$\{[^}]+\}[`"']/g)) {
        out.add(m[1].replace(/\/$/, "") + "/:slug");
    }
    return [...out];
}
/**
 * Expand templated API paths into concrete candidates.
 *
 * Bundles build paths with template literals: `/api/campaigns/drops/${slug}`.
 * The literal prefix is the useful part — the variable part is usually a slug
 * the page already knows.
 *
 * This is generic: it substitutes whatever slug the page URL carries, and tries
 * every suffix of the path. A bundle's route naming does not have to match the
 * server's — the same endpoint is often reachable at several depths — so we
 * enumerate the possibilities rather than guessing one.
 */
function expandApiPaths(paths, pageUrl) {
    const out = new Set();
    // The last path segment of the page URL is the most likely slug.
    let pageSlug = null;
    try {
        const segs = new URL(pageUrl).pathname.split("/").filter(Boolean);
        if (segs.length > 0) {
            const last = segs[segs.length - 1];
            if (/^[a-zA-Z0-9._-]+$/.test(last))
                pageSlug = last;
        }
    }
    catch {
        // Malformed URL — no slug substitution.
    }
    for (const p of paths) {
        out.add(p);
        if (!pageSlug)
            continue;
        const segs = p.split("/").filter(Boolean);
        const last = segs[segs.length - 1];
        const isPlaceholder = last === ":slug" || last === "[slug]" || last === "{" || last.includes("$");
        if (!isPlaceholder)
            continue;
        segs[segs.length - 1] = pageSlug;
        // Try the full path and every suffix of it. A bundle may name a resource
        // differently from the route that serves it, and the same data is often
        // reachable at more than one depth. Enumerating suffixes costs one extra
        // HTTP call each and removes the need to know the server's routing.
        for (let i = 0; i < segs.length; i++) {
            out.add("/" + segs.slice(i).join("/"));
        }
    }
    return [...out];
}
/**
 * Derive the app root from a page URL.
 *
 * A bundle's `/api/...` strings resolve against the app root, which is not
 * necessarily the site root. A site may serve its app from a subpath
 * (/launchpad/, /app/, /mint/), so `/api/drops/x` must be re-anchored to
 * `<appRoot>/api/drops/x`.
 *
 * Heuristic: the first path segment is the app mount when it is a bare word
 * (not a file, not a common file-extension). This is deliberately broad — a
 * wrong guess costs one extra HTTP call, while a missed mount means the API is
 * never found at all.
 */
function deriveAppRoot(pageUrl) {
    try {
        const u = new URL(pageUrl);
        const segments = u.pathname.split("/").filter(Boolean);
        if (segments.length === 0)
            return null;
        const first = segments[0];
        if (/^[a-z0-9_\-]+$/i.test(first) && !/\.[a-z0-9]+$/i.test(first)) {
            return `/${first}/`;
        }
        return null;
    }
    catch {
        return null;
    }
}
/** Extract <script src> and modulepreload href URLs from a shell page. */
function extractScriptUrls(html, baseUrl) {
    const out = new Set();
    const base = new URL(baseUrl);
    const re = /<(?:script[^>]*src|link[^>]*href)\s*=\s*"([^"]+)"/gi;
    for (const m of html.matchAll(re)) {
        const raw = m[1];
        try {
            const u = new URL(raw, base);
            // Only same-origin JS.
            if (u.origin !== base.origin)
                continue;
            if (!/\.m?js$/i.test(u.pathname))
                continue;
            out.add(u.toString());
        }
        catch {
            // Malformed URL — skip.
        }
    }
    return [...out];
}
/**
 * Follow a shell page's JS bundles and their API calls.
 *
 * Order: shell HTML → script bundles → API endpoints discovered in the bundles.
 * Each stage is scanned with the same ranking as the raw HTML.
 */
async function scanWithBundles(url, timeoutMs = 15000, maxBundles = 8, maxApiCalls = 40) {
    const headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
    };
    let html;
    try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok)
            return { candidates: [], totalFound: 0, empty: true, apiCalls: [] };
        html = await res.text();
    }
    catch {
        return { candidates: [], totalFound: 0, empty: true, apiCalls: [] };
    }
    // Stage 1: the shell itself.
    const shell = scanHtml(html);
    // Stage 2: follow the bundles.
    const scriptUrls = extractScriptUrls(html, url).slice(0, maxBundles);
    let bundleText = "";
    for (const su of scriptUrls) {
        try {
            const r = await fetch(su, {
                headers: { "user-agent": headers["user-agent"] },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (r.ok)
                bundleText += "\n" + (await r.text());
        }
        catch {
            // A bundle we cannot read is not fatal — the next one may work.
        }
    }
    const bundleScan = bundleText ? scanHtml(bundleText) : { candidates: [], totalFound: 0, empty: true };
    // Stage 3: follow the API endpoints the bundles reference.
    //
    // The bundle's paths are relative to the APP root, not the site root. On
    // fungolabs.org the app lives at /launchpad/, so the bundle says `/api/drops/x`
    // but the real endpoint is `/launchpad/api/drops/x`. Resolving against the
    // site root returns 404. We try the site root first, then re-anchor at the
    // app root derived from the page URL.
    const base = new URL(url);
    const appRoot = deriveAppRoot(url);
    const apiPaths = expandApiPaths(extractApiPaths(bundleText, url), url)
        // Concrete slug-substituted paths are far more likely to return this
        // specific drop's data than a static listing endpoint or a raw
        // placeholder. Try them first, shortest (most likely route) first.
        .sort((a, b) => {
        const aC = !a.includes(":slug");
        const bC = !b.includes(":slug");
        if (aC !== bC)
            return aC ? -1 : 1;
        return a.length - b.length;
    })
        .slice(0, maxApiCalls);
    const apiCalls = [];
    let apiText = "";
    for (const p of apiPaths) {
        const candidates = [new URL(p, base).toString()];
        if (appRoot) {
            const alt = new URL(appRoot + p.replace(/^\//, ""), base).toString();
            if (alt !== candidates[0])
                candidates.push(alt);
        }
        for (const apiUrl of candidates) {
            try {
                const r = await fetch(apiUrl, {
                    headers: { "user-agent": headers["user-agent"], accept: "application/json" },
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!r.ok) {
                    apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
                    continue;
                }
                const body = await r.text();
                const found = extractAddresses(body).length;
                apiCalls.push({ url: apiUrl, ok: true, addressesFound: found });
                if (found > 0) {
                    apiText += "\n" + body;
                    break; // This path worked — no need to try the alternative.
                }
            }
            catch {
                apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
            }
        }
    }
    const apiScan = apiText ? scanHtml(apiText) : { candidates: [], totalFound: 0, empty: true };
    // Merge and re-rank. The API is the most authoritative source, so its hits
    // are scored as mint-button strength — the page itself links them to minting.
    const merged = mergeScans([shell, bundleScan, apiScan]);
    return { ...merged, apiCalls };
}
/** Merge several scan results, keeping the highest score per address. */
function mergeScans(scans) {
    const byAddr = new Map();
    let totalFound = 0;
    for (const s of scans) {
        totalFound += s.totalFound;
        for (const c of s.candidates) {
            const existing = byAddr.get(c.address);
            if (!existing) {
                byAddr.set(c.address, { ...c });
            }
            else {
                // Keep the strongest evidence: highest score, and the most specific
                // source we have seen.
                existing.score = Math.max(existing.score, c.score);
                existing.occurrences = Math.max(existing.occurrences, c.occurrences);
                if (c.key && !existing.key)
                    existing.key = c.key;
                if (sourceRank(c.source) > sourceRank(existing.source))
                    existing.source = c.source;
            }
        }
    }
    const candidates = [...byAddr.values()].sort((a, b) => b.score - a.score);
    return { candidates, totalFound, empty: candidates.length === 0 };
}
function sourceRank(s) {
    const order = [
        "html-text",
        "script-blob",
        "json-key",
        "contracts-block",
        "mint-button",
    ];
    return order.indexOf(s);
}
/**
 * Fetch and scan a URL. Returns null when the page cannot be retrieved —
 * a 403/429/Cloudflare challenge is reported as "no result", never as a
 * wrong address.
 */
async function scanUrl(url, timeoutMs = 15000) {
    let res;
    try {
        res = await fetch(url, {
            headers: {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                accept: "text/html,application/xhtml+xml",
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch {
        return null;
    }
    if (!res.ok)
        return null;
    let html;
    try {
        html = await res.text();
    }
    catch {
        return null;
    }
    // A bot wall or consent page is still a 200 with HTML. If it contains no
    // addresses we return empty — which is honest, unlike inventing one.
    return scanHtml(html);
}
//# sourceMappingURL=site-scanner.js.map