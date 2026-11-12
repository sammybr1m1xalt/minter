// ── Scatter.art launchpad integration ──────────────────────────────────────
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

const SCATTER_API = "https://api.scatter.art/v1";

const NATIVE = "0x0000000000000000000000000000000000000000";

export interface ScatterCollection {
  address: string;
  chainId: number;
  name: string;
  maxItems: number | null;
  numItems: number | null;
  website: string | null;
  twitter: string | null;
  discord: string | null;
  opensea: string | null;
  creator: string | null;
  slug: string;
}

export interface ScatterList {
  id: string;
  name: string;
  token_price: string | number;
  currency_address: string | null;
  currency_symbol: string | null;
  start_time: string | null;
  end_time?: string | null;
  [k: string]: any;
}

/**
 * Fetch a collection by slug. Returns null when it isn't a Scatter collection
 * (404) or the API is unreachable.
 *
 * Only slugs resolve — the API has no address lookup, so callers must pass the
 * collection's Scatter slug.
 */
export async function getScatterCollection(
  slug: string,
  timeoutMs = 15_000
): Promise<ScatterCollection | null> {
  try {
    // Bounded: a stalled API must not hang the mint path.
    const r = await fetch(`${SCATTER_API}/collection/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j?.address) return null;
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
  } catch {
    return null;
  }
}

/**
 * Fetch the mint lists a wallet is eligible for. Without minterAddress the API
 * returns public lists only. Returns [] on error (treated as "no lists").
 */
export async function getEligibleLists(
  slug: string,
  minterAddress?: string,
  timeoutMs = 15_000
): Promise<ScatterList[]> {
  const url = `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists${
    minterAddress ? `?minterAddress=${minterAddress}` : ""
  }`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return [];
    const j: any = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** A list is "public" when its currency is native and it has no wallet gate. */
export function isNativeList(list: ScatterList): boolean {
  return !list.currency_address || list.currency_address.toLowerCase() === NATIVE;
}

/**
 * Choose the best list to mint from among eligible lists: cheapest native-token
 * list wins (free > paid), tie-break by earliest start. ERC20-priced lists are
 * only chosen when no native list exists.
 */
export function pickBestList(lists: ScatterList[]): ScatterList | null {
  if (!lists.length) return null;
  const priced = lists
    .map((l) => {
      // Number() maps an oversized price string to Infinity, which would sort
      // first as "cheapest". Read it as a finite number or treat it as unknown.
      const n = Number(l.token_price ?? 0);
      return { list: l, price: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER, native: isNativeList(l) };
    })
    .sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1; // native first
      if (a.price !== b.price) return a.price - b.price; // cheapest first
      return new Date(a.list.start_time || 0).getTime() - new Date(b.list.start_time || 0).getTime();
    });
  return priced[0].list;
}

export interface ScatterMintTx {
  to: string;
  value: bigint;
  data: string;
  erc20s: { address: string; amount: string }[];
}

/**
 * Build the mint transaction via the API.
 * `lists` is [{ id, quantity }]. affiliate is an optional shill address.
 */
export async function buildScatterMint(args: {
  collectionAddress: string;
  chainId: number;
  minterAddress: string;
  lists: { id: string; quantity: number }[];
  affiliate?: string;
  timeoutMs?: number;
}): Promise<ScatterMintTx> {
  const body: any = {
    collectionAddress: args.collectionAddress,
    chainId: args.chainId,
    minterAddress: args.minterAddress,
    lists: args.lists,
  };
  if (args.affiliate) body.affiliateAddress = args.affiliate;

  // This fetch builds the actual mint transaction, so a stall here hangs the
  // run with a wallet already funded and a stage about to open.
  const r = await fetch(`${SCATTER_API}/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(args.timeoutMs ?? 20_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`scatter /mint ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j: any = await r.json();
  if (!j?.mintTransaction?.to) throw new Error("scatter /mint: no mintTransaction in response");
  return {
    to: j.mintTransaction.to,
    value: BigInt(j.mintTransaction.value || 0),
    data: j.mintTransaction.data,
    erc20s: Array.isArray(j.erc20s) ? j.erc20s : [],
  };
}

