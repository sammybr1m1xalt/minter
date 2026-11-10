// Slug → contract address resolution for OpenSea collections.
//
// REST v2 is the primary path. GraphQL is a fallback when REST needs a key
// that isn't available. Addresses (0x…) bypass slug resolution entirely.

const REST_URL = "https://api.opensea.io/api/v2/collections";
const GQL_URL = "https://gql.opensea.io/graphql";

// ── HTML scrape fallback ─────────────────────────────────────────────────────
// When REST + GraphQL both fail, scrape the public collection page.
// OpenSea embeds a "contracts":[{...}] JSON block in the page HTML.

async function htmlScrapeCollection(slug: string, timeoutMs = 10000): Promise<{ address: string; chain: string } | null> {
  let html: string;
  try {
    const res = await fetch(`https://opensea.io/collection/${slug}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  // The page embeds several JSON payloads. The "contracts" block only carries
  // chain info ({chain:{identifier}}), while the contract address lives in the
  // collection payload as "address":"0x…". Anchor on that field instead.
  const contractsBlock = html.match(/"contracts":\[[^\]]{0,500}\]/);
  const chainM = contractsBlock ? contractsBlock[0].match(/"identifier":"([\w-]+)"/) : null;
  // Prefer the address inside the contracts block — that is the collection's own
  // contract. The first bare "address" anywhere in the page can belong to the
  // owner, a fee recipient, or an unrelated collection embedded in the payload.
  const addrInBlock = contractsBlock
    ? contractsBlock[0].match(/"address":"(0x[a-fA-F0-9]{40})"/)
    : null;
  const addrM = addrInBlock || html.match(/"address":"(0x[a-fA-F0-9]{40})"/);
  if (!addrM || /^0x0+$/.test(addrM[1])) return null; // zero-address = placeholder
  return { address: addrM[1], chain: chainM ? chainM[1] : "ethereum" };
}

// ── REST v2 (primary) ────────────────────────────────────────────────────────

interface RestCollection {
  slug: string;
  address: string;
  chain: { identifier: string; networkId: number };
}

async function restCollectionBySlug(slugOrAddress: string, apiKey = "", timeoutMs = 10000): Promise<RestCollection | null> {
  const url = `${REST_URL}/${slugOrAddress}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }

  if (!res.ok) {
    // 401/403 = needs key. 404 = not found. All others = give up.
    return null;
  }
  const json = (await res.json()) as any;
  if (json.errors && json.errors.length > 0) return null;

  // REST v2 /collections/{slug} returns:
  //   { collection: "<slug>", contracts: [{ address, chain }], ... }
  // not { slug, address, chain } as the old parser expected.
  const collection = (json.collection ?? json.slug) as string | undefined;
  const contracts = json.contracts;
  let address = "";
  let chainId = 0;
  let chainIdentifier = "";
  if (Array.isArray(contracts) && contracts.length > 0) {
    const c = contracts[0] as any;
    address = c.address as string || "";
    chainIdentifier = (c.chain as string) || "";
    // chain may be a string like "ethereum" or an object { identifier, networkId }
    if (typeof c.chain === "object" && c.chain !== null) {
      chainIdentifier = (c.chain.identifier as string) || chainIdentifier;
      chainId = Number(c.chain.networkId || c.chain.chainId || 0);
    }
  }
  if (!address) return null;
  return {
    slug: collection ?? slugOrAddress,
    address,
    chain: { identifier: chainIdentifier, networkId: chainId },
  };
}

// ── GraphQL (fallback) ────────────────────────────────────────────────────────

interface GqlCollection {
  slug: string;
  address: string;
  chain: { identifier: string; networkId: number };
}

async function gqlCollectionBySlug(slug: string, timeoutMs = 10000): Promise<GqlCollection | null> {
  const body = JSON.stringify({
    query: "query MintCollectionMetadata($slug: String!) { collectionBySlug(slug: $slug) { __typename ... on Collection { slug address chain { identifier networkId } } } }",
    variables: { slug },
    operationName: "MintCollectionMetadata",
  });

  let res: Response;
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;
  const json = (await res.json()) as any;
  if (json.errors && json.errors.length > 0) return null;
  const c = json.data?.collectionBySlug;
  if (!c || !c.address) return null;
  return c as GqlCollection;
}

interface GqlCollectionHit {
  slug: string;
  address?: string;
  chain?: { identifier?: string; networkId?: number | string };
}

async function gqlSearchByAddress(address: string, timeoutMs = 10000): Promise<GqlCollectionHit[]> {
  const body = JSON.stringify({
    query: "query MintCollectionSearch($query: String!) { collectionsByQuery(query: $query, limit: 50) { __typename slug address chain { identifier networkId } } }",
    variables: { query: address },
    operationName: "MintCollectionSearch",
  });

  let res: Response;
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];
  // gql.opensea.io sits behind Cloudflare Access. An unauthenticated or blocked
  // request returns 200 with an HTML sign-in page, which parses as neither JSON
  // nor a GraphQL error — it would surface as a confusing SyntaxError.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return [];
  let json: any;
  try {
    json = (await res.json()) as any;
  } catch {
    return [];
  }
  if (json.errors && json.errors.length > 0) return [];
  return (json.data?.collectionsByQuery ?? []) as GqlCollectionHit[];
}

// ── Public API ────────────────────────────────────────────────────────────────

interface CollectionInfo {
  name: string;
  contractAddress: string;
  chain: string;
}

/**
 * Resolve a collection slug to its primary contract address + chain.
 *
 * REST v2 is tried first (works with or without a key). GraphQL is a
 * fallback for when REST returns 401/403 and no key was provided.
 */
export async function resolveSlug(
  slug: string,
  apiKey = "",
  preferredChain?: string
): Promise<CollectionInfo> {
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

  // 3. HTML scrape — final fallback
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

export function isSlug(input: string): boolean {
  return !input.startsWith("0x");
}

// ── Contract address → OpenSea slug (for drops endpoint) ────────────────────
// /collections/{slug}/drops needs a slug. When given a CA, resolve it first.

// The SeaDrop singleton is a shared minter contract, not a collection. GraphQL
// still answers for it with a synthetic identifier shaped `<address>-<number>`
// (observed: 0x00005ea00ac477b1030ce78506496e8c2de24bf5-541171828). That string
// is not a collection slug — resolving it later returns the singleton itself but
// on an arbitrary chain (observed: hyperevm), which is a silent wrong-chain mint.
//
// A singleton address can never identify a collection, so it is refused outright
// rather than passed downstream.
const SEADROP_SINGLETON = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";

function isSyntheticSeDropSlug(slug: string, address: string): boolean {
  // <address>-<digits> is GraphQL's placeholder shape for a contract that is not
  // a collection. A real slug is never a 42-char hex string followed by a number.
  return (
    slug.toLowerCase().startsWith(`${address.toLowerCase()}-`) &&
    /-\d+$/.test(slug)
  );
}

export async function resolveContractToSlug(
  nftContract: string,
  apiKey = "",
  timeoutMs = 10000
): Promise<string | null> {
  // The SeaDrop singleton is not a collection and has no slug. Refuse it here
  // rather than letting a downstream step discover the synthetic identifier.
  if (nftContract.toLowerCase() === SEADROP_SINGLETON) {
    console.error(
      "[resolveContractToSlug] The address is the SeaDrop singleton — a shared minter, " +
        "not a collection. It has no slug; target the collection's own contract instead."
    );
    return null;
  }

  // REST v2 /collections/{slug or CA} returns:
  //   { collection: "<slug>", contracts: [{ address, chain }], ... }
  // not { slug, address } as the old parser expected.
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
  try {
    const res = await fetch(`${REST_URL}/${nftContract}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const json = (await res.json()) as any;
      if (json.errors && json.errors.length > 0) return null;
      const collection = (json.collection ?? json.slug) as string | undefined;
      if (collection) return collection;
      // If it's a CA lookup that returned the collection object, also
      // extract slug from contracts array as a fallback
      const contracts = json.contracts;
      if (Array.isArray(contracts) && contracts.length > 0) {
        const c = contracts[0] as any;
        const addr = (c.address as string) || "";
        if (addr.toLowerCase() === nftContract.toLowerCase()) {
          return collection ?? null;
        }
      }
    }
  } catch (err: any) {
    console.error("[resolveContractToSlug] REST failed:", err?.message || err);
  }

  // 2. GraphQL search by address.
  //
  // The response includes each hit's `address`, so the match can be verified.
  // Previously the caller took hits[0].slug unconditionally — the address field
  // was queried but discarded by the {slug: string}[] return type. A fuzzy
  // search can return a collection that merely resembles the query, so an
  // unverified first hit could resolve a CA to the WRONG slug, and every later
  // step (SIWE, eligibility, payload) would run against the wrong collection.
  try {
    const hits = await gqlSearchByAddress(nftContract);
    if (hits.length === 0) {
      console.error("[resolveContractToSlug] GraphQL returned no hits for", nftContract);
    } else {
      const wanted = nftContract.toLowerCase();
      // Prefer an exact address match; a chain match is a weaker but usable signal.
      const exact = hits.find((h) => (h.address || "").toLowerCase() === wanted);
      const chosen = exact || hits.find((h) => h.address);
      if (chosen?.slug) {
        // Reject GraphQL's synthetic placeholder for a contract that is not a
        // collection. Passing it downstream resolves to the wrong chain.
        if (isSyntheticSeDropSlug(chosen.slug, nftContract)) {
          console.error(
            `[resolveContractToSlug] GraphQL returned a synthetic identifier (${chosen.slug}) ` +
              `for ${nftContract} — this contract is not an OpenSea collection.`
          );
          return null;
        }
        if (!exact) {
          console.error(
            `[resolveContractToSlug] ⚠ no exact address match for ${nftContract}; ` +
              `using ${chosen.slug} (${chosen.address}) — verify before minting.`
          );
        } else {
          console.error("[resolveContractToSlug] GraphQL found slug:", chosen.slug);
        }
        return chosen.slug;
      }
      console.error("[resolveContractToSlug] GraphQL hits had no usable slug/address:", hits.length);
    }
  } catch (err: any) {
    console.error("[resolveContractToSlug] GraphQL failed:", err?.message || err);
  }

  return null;
}
