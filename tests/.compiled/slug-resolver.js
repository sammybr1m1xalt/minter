"use strict";
// Slug → contract address resolution for OpenSea collections.
//
// REST v2 is the primary path. GraphQL is a fallback when REST needs a key
// that isn't available. Addresses (0x…) bypass slug resolution entirely.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSlug = resolveSlug;
exports.isSlug = isSlug;
exports.resolveContractToSlug = resolveContractToSlug;
const REST_URL = "https://api.opensea.io/api/v2/collections";
const GQL_URL = "https://gql.opensea.io/graphql";
// ── HTML scrape fallback (mirrors upstream resolve.js) ────────────────────────
// When REST + GraphQL both fail, scrape the public collection page.
// OpenSea embeds a "contracts":[{...}] JSON block in the page HTML.
async function htmlScrapeCollection(slug, timeoutMs = 10000) {
    let html;
    try {
        const res = await fetch(`https://opensea.io/collection/${slug}`, {
            headers: {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                accept: "text/html,application/xhtml+xml",
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return null;
        html = await res.text();
    }
    catch {
        return null;
    }
    // The page embeds several JSON payloads. The "contracts" block only carries
    // chain info ({chain:{identifier}}), while the contract address lives in the
    // collection payload as "address":"0x…". Anchor on that field instead.
    const addrM = html.match(/"address":"(0x[a-fA-F0-9]{40})"/);
    const contractsBlock = html.match(/"contracts":\[[^\]]{0,500}\]/);
    const chainM = contractsBlock ? contractsBlock[0].match(/"identifier":"([\w-]+)"/) : null;
    if (!addrM || /^0x0+$/.test(addrM[1]))
        return null; // zero-address = placeholder
    return { address: addrM[1], chain: chainM ? chainM[1] : "ethereum" };
}
async function restCollectionBySlug(slugOrAddress, apiKey = "") {
    const url = `${REST_URL}/${slugOrAddress}`;
    const headers = { accept: "application/json" };
    if (apiKey && apiKey.trim())
        headers["X-API-KEY"] = apiKey.trim();
    let res;
    try {
        res = await fetch(url, { headers });
    }
    catch {
        return null;
    }
    if (!res.ok) {
        // 401/403 = needs key. 404 = not found. All others = give up.
        return null;
    }
    const json = (await res.json());
    if (json.errors && json.errors.length > 0)
        return null;
    // REST v2 /collections/{slug} returns:
    //   { collection: "<slug>", contracts: [{ address, chain }], ... }
    // not { slug, address, chain } as the old parser expected.
    const collection = (json.collection ?? json.slug);
    const contracts = json.contracts;
    let address = "";
    let chainId = 0;
    let chainIdentifier = "";
    if (Array.isArray(contracts) && contracts.length > 0) {
        const c = contracts[0];
        address = c.address || "";
        chainIdentifier = c.chain || "";
        // chain may be a string like "ethereum" or an object { identifier, networkId }
        if (typeof c.chain === "object" && c.chain !== null) {
            chainIdentifier = c.chain.identifier || chainIdentifier;
            chainId = Number(c.chain.networkId || c.chain.chainId || 0);
        }
    }
    if (!address)
        return null;
    return {
        slug: collection ?? slugOrAddress,
        address,
        chain: { identifier: chainIdentifier, networkId: chainId },
    };
}
async function gqlCollectionBySlug(slug) {
    const body = JSON.stringify({
        query: "query MintCollectionMetadata($slug: String!) { collectionBySlug(slug: $slug) { __typename ... on Collection { slug address chain { identifier networkId } } } }",
        variables: { slug },
        operationName: "MintCollectionMetadata",
    });
    let res;
    try {
        res = await fetch(GQL_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                origin: "https://opensea.io",
                referer: `https://opensea.io/collection/${slug}`,
                "x-app-id": "os2-web",
            },
            body,
        });
    }
    catch {
        return null;
    }
    if (!res.ok)
        return null;
    const json = (await res.json());
    if (json.errors && json.errors.length > 0)
        return null;
    const c = json.data?.collectionBySlug;
    if (!c || !c.address)
        return null;
    return c;
}
async function gqlSearchByAddress(address) {
    const body = JSON.stringify({
        query: "query MintCollectionSearch($query: String!) { collectionsByQuery(query: $query, limit: 50) { __typename slug address chain { identifier networkId } } }",
        variables: { query: address },
        operationName: "MintCollectionSearch",
    });
    let res;
    try {
        res = await fetch(GQL_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                origin: "https://opensea.io",
                referer: `https://opensea.io/collection/${address}`,
                "x-app-id": "os2-web",
            },
            body,
        });
    }
    catch {
        return [];
    }
    if (!res.ok)
        return [];
    const json = (await res.json());
    if (json.errors && json.errors.length > 0)
        return [];
    return (json.data?.collectionsByQuery ?? []);
}
/**
 * Resolve a collection slug to its primary contract address + chain.
 *
 * REST v2 is tried first (works with or without a key). GraphQL is a
 * fallback for when REST returns 401/403 and no key was provided.
 */
async function resolveSlug(slug, apiKey = "", preferredChain) {
    const _wanted = preferredChain?.trim().toLowerCase();
    // 1. REST v2 — primary. Works unauthenticated for most collections.
    const rest = await restCollectionBySlug(slug, apiKey);
    if (rest?.address) {
        return {
            name: rest.slug,
            contractAddress: rest.address,
            chain: rest.chain.identifier ?? "",
        };
    }
    // 2. GraphQL — fallback when REST denied us (needs key we don't have)
    if (!apiKey || !apiKey.trim()) {
        const gql = await gqlCollectionBySlug(slug);
        if (gql?.address) {
            return {
                name: gql.slug,
                contractAddress: gql.address,
                chain: gql.chain.identifier ?? "",
            };
        }
    }
    // NOTE: there is deliberately no third REST attempt here. It used to re-run
    // restCollectionBySlug(slug, apiKey) with the identical arguments as step 1,
    // so it could only ever repeat step 1's failure. A real retry would need a
    // different input (e.g. a CA-based lookup) — until then, go straight to the
    // HTML scrape.
    // 3. HTML scrape — final fallback (mirrors upstream resolve.js)
    const scraped = await htmlScrapeCollection(slug);
    if (scraped?.address) {
        return {
            name: slug,
            contractAddress: scraped.address,
            chain: preferredChain ?? scraped.chain,
        };
    }
    throw new Error(`Could not resolve slug "${slug}" — OpenSea doesn't know about it, or it needs an API key we don't have.`);
}
function isSlug(input) {
    return !input.startsWith("0x");
}
// ── Contract address → OpenSea slug (for drops endpoint) ────────────────────
// /collections/{slug}/drops needs a slug. When given a CA, resolve it first.
async function resolveContractToSlug(nftContract, apiKey = "", timeoutMs = 10000) {
    // REST v2 /collections/{slug or CA} returns:
    //   { collection: "<slug>", contracts: [{ address, chain }], ... }
    // not { slug, address } as the old parser expected.
    const headers = { accept: "application/json" };
    if (apiKey && apiKey.trim())
        headers["X-API-KEY"] = apiKey.trim();
    try {
        const res = await fetch(`${REST_URL}/${nftContract}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) {
            const json = (await res.json());
            if (json.errors && json.errors.length > 0)
                return null;
            const collection = (json.collection ?? json.slug);
            if (collection)
                return collection;
            // If it's a CA lookup that returned the collection object, also
            // extract slug from contracts array as a fallback
            const contracts = json.contracts;
            if (Array.isArray(contracts) && contracts.length > 0) {
                const c = contracts[0];
                const addr = c.address || "";
                if (addr.toLowerCase() === nftContract.toLowerCase()) {
                    return collection ?? null;
                }
            }
        }
    }
    catch (err) {
        console.error("[resolveContractToSlug] REST failed:", err?.message || err);
    }
    // 2. GraphQL search by address
    try {
        const hits = await gqlSearchByAddress(nftContract);
        if (hits.length > 0 && hits[0].slug) {
            console.error("[resolveContractToSlug] GraphQL found slug:", hits[0].slug);
            return hits[0].slug;
        }
        console.error("[resolveContractToSlug] GraphQL returned no hits for", nftContract);
    }
    catch (err) {
        console.error("[resolveContractToSlug] GraphQL failed:", err?.message || err);
    }
    return null;
}
//# sourceMappingURL=slug-resolver.js.map