// ── Scatter.art launchpad integration ──────────────────────────────────────
//
// Scatter contracts use a custom mint(auth, quantity, affiliate, signature)
// entrypoint, so generic mint-selector probing does NOT work — the ABI is not
// discoverable from the contract alone. Instead the public API resolves the
// collection, the wallet's eligible mint lists, and builds the exact mint
// transaction (proof + signature included).
//
// No API key required.
//
// Shapes here were verified against the live API (2026-11):
//   /v1/collection/<slug>                       → collection metadata
//   /v1/collection/<slug>/eligible-invite-lists → mint lists (array)
//   /v1/mint                                    → { mintTransaction, erc20s, listPayments }
// and against Scatter's own reference client (github.com/guminc/scatter-api-example),
// which is where the ERC20 approval target and the allowance check come from.

const SCATTER_API = "https://api.scatter.art/v1";

const NATIVE = "0x0000000000000000000000000000000000000000";

/** The contract's own "no limit" sentinel. */
export const SCATTER_MAX_LIMIT = 4294967295;

export interface ScatterCollection {
  address: string;
  chainId: number;
  name: string;
  symbol: string | null;
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
  /** The list key (Merkle root) the contract knows it by. */
  root: string | null;
  /** The collection this list belongs to. */
  address: string | null;
  /** Price per mint in WHOLE currency units ("0.001" ETH, "1111" NOCK). */
  token_price: string | number;
  currency_address: string | null;
  currency_symbol: string | null;
  /** Currency decimals — required to turn token_price into a base-unit amount. */
  decimals: number | null;
  start_time: string | null;
  end_time?: string | null;
  /** Per-wallet cap, in NFTs. */
  wallet_limit: number | null;
  /** Total cap for the list, in NFTs. */
  list_limit: number | null;
  /** NFTs received per unit in the quantity field. Absent means 1. */
  unit_size: number | null;
  [k: string]: any;
}

export interface ScatterListPayment {
  id: string;
  name: string;
  root: string | null;
  quantity: number;
  currencyAddress: string | null;
  currencySymbol: string | null;
  currencyDecimals: number | null;
  /** Price per unit in the currency's base units. */
  unitPaymentValue: string;
  /** Total currency cost for this list, in base units. */
  paymentValue: string;
  /** Native fee on top of the currency cost, in wei. */
  nativeFeeValue: string;
}

export interface ScatterMintTx {
  to: string;
  value: bigint;
  data: string;
  erc20s: { address: string; amount: string }[];
  listPayments: ScatterListPayment[];
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
      symbol: j.symbol || null,
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
 * returns public lists only.
 *
 * An empty array is ambiguous — "no lists" and "the API did not answer" look the
 * same here. Callers that must tell them apart should treat an empty result as
 * "cannot mint" and say so, never as "nothing is available".
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
    if (!Array.isArray(j)) return [];
    return j.map((l: any) => ({
      ...l,
      root: l.root ?? null,
      address: l.address ?? null,
      currency_address: l.currency_address ?? null,
      currency_symbol: l.currency_symbol ?? null,
      decimals: l.decimals ?? null,
      wallet_limit: l.wallet_limit ?? null,
      list_limit: l.list_limit ?? null,
      unit_size: l.unit_size ?? null,
    }));
  } catch {
    return [];
  }
}

/** A list is "public" when its currency is native and it has no wallet gate. */
export function isNativeList(list: ScatterList): boolean {
  return !list.currency_address || list.currency_address.toLowerCase() === NATIVE;
}

/** True when a cap is absent or is the contract's "unlimited" sentinel. */
export function isUnlimited(n: number | null | undefined): boolean {
  return n == null || !Number.isFinite(Number(n)) || Number(n) >= SCATTER_MAX_LIMIT;
}

/** NFTs received per unit of the quantity field. */
export function unitSizeOf(list: ScatterList): number {
  const n = Number(list.unit_size ?? 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * The list price in the currency's BASE units.
 *
 * `token_price` is a decimal in whole currency units — "0.001" ETH, "1111" NOCK
 * with 16 decimals — not a wei string. Reading it as an integer base-unit amount
 * would underpay by 10^decimals and the mint would revert.
 */
export function listPriceBaseUnits(list: ScatterList): bigint | null {
  const raw = list.token_price;
  if (raw == null || raw === "") return null;
  const decimals = Number.isFinite(Number(list.decimals)) ? Number(list.decimals) : 18;
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

export interface ListWindow {
  open: boolean;
  startsAt: number | null;
  endsAt: number | null;
  /** Why the list is not open, when it is not. */
  reason: string | null;
}

/** Whether the list's mint window is currently open. */
export function listWindow(list: ScatterList, nowMs: number = Date.now()): ListWindow {
  const start = list.start_time ? Date.parse(list.start_time) : NaN;
  const end = list.end_time ? Date.parse(list.end_time) : NaN;
  const startsAt = Number.isNaN(start) ? null : start;
  const endsAt = Number.isNaN(end) ? null : end;
  if (startsAt != null && nowMs < startsAt) {
    return { open: false, startsAt, endsAt, reason: `opens ${new Date(startsAt).toISOString()}` };
  }
  if (endsAt != null && nowMs >= endsAt) {
    return { open: false, startsAt, endsAt, reason: `ended ${new Date(endsAt).toISOString()}` };
  }
  return { open: true, startsAt, endsAt, reason: null };
}

/**
 * Choose the list to mint from.
 *
 * Native-currency lists win outright: an ERC20 price cannot be compared with a
 * native one, and a native mint needs no token approval. Within one currency the
 * cheapest wins, tie-break by earliest start. A list whose window is closed is
 * only chosen when nothing open exists — minting into it reverts, so the caller
 * must be told (see listWindow).
 */
export function pickBestList(lists: ScatterList[], nowMs: number = Date.now()): ScatterList | null {
  if (!lists.length) return null;
  const ranked = lists
    .map((l) => ({
      list: l,
      price: listPriceBaseUnits(l),
      native: isNativeList(l),
      symbol: (l.currency_symbol || (isNativeList(l) ? "native" : l.currency_address || "")).toLowerCase(),
      open: listWindow(l, nowMs).open,
      start: l.start_time ? Date.parse(l.start_time) : NaN,
    }))
    .sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1;
      if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
      if (a.price != null && b.price != null && a.price !== b.price) {
        return a.price < b.price ? -1 : 1;
      }
      if (a.open !== b.open) return a.open ? -1 : 1;
      const as = Number.isNaN(a.start) ? 0 : a.start;
      const bs = Number.isNaN(b.start) ? 0 : b.start;
      return as - bs;
    });
  return ranked[0].list;
}

/**
 * Build the mint transaction via the API.
 * `lists` is [{ id, quantity }] where quantity is in UNITS (see unitSizeOf).
 * affiliate is an optional shill address.
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
  // The API reports a sold-out collection as 409 with a plain-text body. That
  // is a verdict, not a failure — surface the text rather than a generic status.
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`scatter /mint ${r.status}: ${txt.slice(0, 200) || "no detail"}`);
  }
  const j: any = await r.json();
  if (!j?.mintTransaction?.to) throw new Error("scatter /mint: no mintTransaction in response");
  return {
    to: j.mintTransaction.to,
    // value is a wei decimal string; a float would throw BigInt() and take down
    // the whole build.
    value: BigInt(j.mintTransaction.value || 0),
    data: j.mintTransaction.data,
    erc20s: Array.isArray(j.erc20s) ? j.erc20s : [],
    listPayments: Array.isArray(j.listPayments) ? j.listPayments : [],
  };
}
