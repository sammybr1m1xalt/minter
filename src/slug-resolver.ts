// Slug → contract address resolution for OpenSea collections.
//
// REST v2 is the primary path. GraphQL is a fallback when REST needs a key
// that isn't available. Addresses (0x…) bypass slug resolution entirely.

const REST_URL = "https://api.opensea.io/api/v2/collections";
const GQL_URL = "https://gql.opensea.io/graphql";

// ── REST v2 (primary) ────────────────────────────────────────────────────────

export interface RestCollection {
  slug: string;
  address: string;
  chain: { identifier: string; networkId: number };
}

async function restCollectionBySlug(slugOrAddress: string, apiKey = ""): Promise<RestCollection | null> {
  const url = `${REST_URL}/${slugOrAddress}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

  let res: Response;
  try {
    res = await fetch(url, { headers });
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

async function gqlCollectionBySlug(slug: string): Promise<GqlCollection | null> {
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

async function gqlSearchByAddress(address: string): Promise<{ slug: string }[]> {
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
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];
  const json = (await res.json()) as any;
  if (json.errors && json.errors.length > 0) return [];
  return (json.data?.collectionsByQuery ?? []) as { slug: string }[];
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CollectionInfo {
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
  const wanted = preferredChain?.trim().toLowerCase();

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

  // 3. REST v2 with key as last resort
  if (apiKey && apiKey.trim()) {
    const rest2 = await restCollectionBySlug(slug, apiKey);
    if (rest2?.address) {
      return {
        name: rest2.slug,
        contractAddress: rest2.address,
        chain: rest2.chain.identifier ?? "",
      };
    }
  }

  throw new Error(`Could not resolve slug "${slug}" — OpenSea doesn't know about it, or it needs an API key we don't have.`);
}

export function isSlug(input: string): boolean {
  return !input.startsWith("0x");
}

// ── Contract address → OpenSea slug (for drops endpoint) ────────────────────
// /collections/{slug}/drops needs a slug. When given a CA, resolve it first.

export async function resolveContractToSlug(
  nftContract: string,
  apiKey = "",
  timeoutMs = 10000
): Promise<string | null> {
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

  // 2. GraphQL search by address
  try {
    const hits = await gqlSearchByAddress(nftContract);
    if (hits.length > 0 && hits[0].slug) {
      console.error("[resolveContractToSlug] GraphQL found slug:", hits[0].slug);
      return hits[0].slug;
    }
    console.error("[resolveContractToSlug] GraphQL returned no hits for", nftContract);
  } catch (err: any) {
    console.error("[resolveContractToSlug] GraphQL failed:", err?.message || err);
  }

  return null;
}
