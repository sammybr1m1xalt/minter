// Reading LISTINGS, and buying one.
//
// The rest of this repo reads OFFERS (bids) and sells. This is the other side:
// is a token already listed, where, and for how much.
//
// WARNING — the OpenSea key on disk is expired, so nothing here has been
// exercised against a live listing. The request shapes come from OpenSea's own
// published skill reference, not from a response we have seen. Every extractor
// is therefore defensive and reports "unknown" rather than guessing a field.
// Treat a live run as the first real test, not a formality.
import chalk from "chalk";
const OPENSEA_BASE = "https://api.opensea.io";

/**
 * GET with the status preserved.
 *
 * fetchJson() collapses every non-2xx into null, which would report an
 * expired API key as "not listed" — the most expensive possible misreading.
 * "Not listed" is only a real answer when the API actually answered.
 */
async function getJson(
  path: string,
  apiKey: string,
  timeoutMs = 15_000
): Promise<{ status: number; json: any }> {
  try {
    const r = await fetch(`${OPENSEA_BASE}${path}`, {
      headers: { accept: "application/json", "x-api-key": apiKey.trim() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: r.status, json };
  } catch {
    // No response at all: transport failure, not a verdict about the key.
    return { status: 0, json: null };
  }
}

export interface ListingSummary {
  tokenId: string;
  orderHash: string | null;
  protocolAddress: string | null;
  chain: string | null;
  maker: string | null;
  currency: string | null;
  /** Raw base units, exactly as returned. Never divide by a guessed decimals. */
  value: string | null;
  decimals: number | null;
  /** value / 10^decimals, or null when either half is unknown. */
  price: number | null;
  error: string | null;
}

/** Pull a field from the first place it appears. OpenSea nests differently per surface. */
function pick(obj: any, ...paths: string[][]): any {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const k of path) {
      if (cur == null || typeof cur !== "object" || !(k in cur)) {
        ok = false;
        break;
      }
      cur = cur[k];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function summarizeListing(tokenId: string, raw: any): ListingSummary {
  const base: ListingSummary = {
    tokenId,
    orderHash: null,
    protocolAddress: null,
    chain: null,
    maker: null,
    currency: null,
    value: null,
    decimals: null,
    price: null,
    error: null,
  };
  if (!raw || typeof raw !== "object") {
    return { ...base, error: "empty body" };
  }
  // /nfts/{id}/best returns the order object itself; /all returns the same shape
  // inside a `listings` array. Verified live against boredapeyachtclub.
  const order = raw?.order_hash ? raw : raw.order ?? raw.listing ?? raw;
  base.orderHash = pick(order, ["order_hash"], ["hash"], ["orderHash"]) ?? null;
  base.protocolAddress =
    pick(order, ["protocol_address"], ["protocolAddress"], ["protocol"]) ?? null;
  base.chain = pick(order, ["chain"], ["chain_name"]) ?? null;
  // The seller is the offerer, nested inside the signed Seaport parameters.
  base.maker =
    pick(order, ["protocol_data", "parameters", "offerer"], ["maker", "address"], ["maker"], ["offerer"]) ?? null;
  // The token id is asset.identifier, not a top-level token_id.
  const ident = pick(order, ["asset", "identifier"], ["token_id"], ["tokenId"]);
  if (ident != null && String(ident) !== base.tokenId) {
    base.tokenId = String(ident);
  }

  // Documented shape: price.current = { currency, decimals, value }.
  const cur = pick(order, ["price", "current"], ["current_price"], ["price"]) ?? null;
  if (cur && typeof cur === "object") {
    base.currency = cur.currency ?? cur.symbol ?? null;
    base.value = cur.value != null ? String(cur.value) : null;
    const d = cur.decimals;
    base.decimals = d != null && Number.isFinite(Number(d)) ? Number(d) : null;
  } else if (cur != null) {
    base.value = String(cur);
  }
  if (base.value != null && base.decimals != null) {
    const n = Number(base.value);
    if (Number.isFinite(n)) base.price = n / 10 ** base.decimals;
  }
  return base;
}

/**
 * Best (cheapest) listing for one token.
 * GET /api/v2/listings/collection/{slug}/nfts/{token_id}/best
 * A 404 or an empty body means "not listed" — which is a real answer, not an
 * error, so it is returned as a summary with error "not listed".
 */
export async function fetchBestListing(
  slug: string,
  tokenId: string,
  apiKey: string,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<ListingSummary> {
  const path = `/api/v2/listings/collection/${encodeURIComponent(slug)}/nfts/${encodeURIComponent(tokenId)}/best`;
  const { status, json } = await getJson(path, apiKey, opts.timeoutMs);
  if (status === 401 || status === 403) {
    return { ...summarizeListing(tokenId, null), error: `could not read (HTTP ${status} — API key rejected)` };
  }
  if (status === 0) {
    return { ...summarizeListing(tokenId, null), error: "could not read (no response)" };
  }
  const order = json?.order_hash ? json : (json?.order ?? json?.listing ?? json?.data ?? null);
  if (!order) {
    return { ...summarizeListing(tokenId, null), error: status === 404 ? "not listed" : `not listed (HTTP ${status})` };
  }
  return summarizeListing(tokenId, json);
}

/** All listings for a collection, one page. */
export async function fetchCollectionListings(
  slug: string,
  apiKey: string,
  opts: { timeoutMs?: number; limit?: number; maker?: string } = {}
): Promise<ListingSummary[]> {
  const q = new URLSearchParams();
  if (opts.maker) q.set("maker", opts.maker);
  if (opts.limit) q.set("limit", String(opts.limit));
  const suffix = q.size > 0 ? `?${q.toString()}` : "";
  const path = `/api/v2/listings/collection/${encodeURIComponent(slug)}/all${suffix}`;
  const { json } = await getJson(path, apiKey, opts.timeoutMs);
  const arr = Array.isArray(json) ? json : json?.listings ?? json?.orders ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.map((o: any, i: number) => {
    const tid = String(
      pick(o, ["asset", "identifier"], ["token_id"], ["tokenId"], ["criteria", "token_id"]) ?? i
    );
    return summarizeListing(tid, o);
  });
}

export interface BuyTransaction {
  function: string;
  chain: number;
  to: string;
  value: string;
  inputData: Record<string, unknown>;
  raw: any;
}

/**
 * Ask OpenSea for the transaction that buys a listing.
 * POST /api/v2/listings/fulfillment_data
 *
 * Documented body:
 *   { "listing": { "hash", "chain", "protocol_address" },
 *     "fulfiller": { "address" } }
 *
 * Payment is NOT always native: an ERC20-priced listing returns value "0" and
 * pulls payment with transferFrom, so the caller must approve the spender and
 * must not attach native value. That is why this returns the raw transaction
 * rather than sending it.
 */
export async function fetchListingBuyTransaction(
  listing: ListingSummary,
  buyer: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {}
): Promise<BuyTransaction | null> {
  if (!listing.orderHash || !listing.chain || !listing.protocolAddress) {
    return null;
  }
  let json: any = null;
  try {
    const r = await fetch(`${OPENSEA_BASE}/api/v2/listings/fulfillment_data`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": apiKey.trim() },
      body: JSON.stringify({
        listing: {
          hash: listing.orderHash,
          chain: listing.chain,
          protocol_address: listing.protocolAddress,
        },
        fulfiller: { address: buyer },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (r.status === 401 || r.status === 403) return null;
    const text = await r.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  } catch {
    return null;
  }
  const tx = json?.fulfillment_data?.transaction ?? null;
  if (!tx) return null;
  return {
    function: String(tx.function ?? ""),
    chain: Number(tx.chain ?? 0),
    to: String(tx.to ?? ""),
    value: String(tx.value ?? "0"),
    inputData: (tx.input_data ?? {}) as Record<string, unknown>,
    raw: tx,
  };
}

/** Render a price without ever inventing a number. */
export function formatListingPrice(l: ListingSummary): string {
  if (l.error) return l.error;
  if (l.price == null) {
    if (l.value != null) return `${l.value} (decimals unknown)`;
    return "listed, price unknown";
  }
  const sym = l.currency ?? "ETH";
  return `${l.price} ${sym}`;
}

/** Inline price cell for a rarity row: an answer or an honest reason, never both. */
export function formatRarityListing(l: ListingSummary): string {
  return l.error ? l.error : `listed ${formatListingPrice(l)}`;
}

/** One line per token, for the rarity table. */
export function printListingLine(l: ListingSummary): string {
  const who = l.maker ? ` seller ${l.maker.slice(0, 10)}…` : "";
  return `    token ${String(l.tokenId).padStart(6)}  ${formatListingPrice(l)}${who}`;
}

// ── Executing the buy ────────────────────────────────────────────────────────
import { Interface, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { chainKeyFromId } from "./chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Validate the vended transaction BEFORE encoding or estimating gas.
 * ethers throws "invalid address value=null" for a null tuple field, and the
 * broad try around estimateGas used to mislabel that as a gas failure. Name
 * the offending field instead; an unknown value is not a gas problem.
 */
function buyTxProblem(tx: BuyTransaction): string | null {
  if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
    return `buy transaction has no valid 'to' address (got ${tx.to || "null"})`;
  }
  const d = tx.inputData as any;
  const shape = Object.keys(d ?? {}).join(",") || "none";
  const missing = (what: string) =>
    `buy transaction has no ${what} (function=${tx.function || "unknown"}, input_data keys: ${shape}) — nothing was sent`;
  const address = (value: unknown, field: string) =>
    value == null || !/^0x[0-9a-fA-F]{40}$/.test(String(value))
      ? `buy transaction has null/invalid ${field} — nothing was sent`
      : null;
  const bytes32 = (value: unknown, field: string) =>
    value == null || !/^0x[0-9a-fA-F]{64}$/.test(String(value))
      ? `buy transaction has null/invalid ${field} — nothing was sent`
      : null;

  // Seaport 1.6 hands OpenSea two DIFFERENT fulfillment shapes. A collection
  // whose items use criteria/resolvers gets fulfillAdvancedOrder, whose data
  // has `advancedOrder` instead of `parameters`. Refusing it as "missing
  // parameters" is not ignorance — it is a vocabulary mismatch in this tool.
  if (d?.advancedOrder) {
    const p = d.advancedOrder.parameters;
    if (!p || typeof p !== "object") return missing("advancedOrder.parameters");
    for (const [field, value] of [
      ["offerer", p.offerer], ["zone", p.zone], ["recipient", d.recipient],
    ] as [string, unknown][]) {
      const bad = address(value, field);
      if (bad) return bad;
    }
    // Conduit keys are bytes32, not addresses — validating them as addresses
    // refused every advanced-order fill with a false null/invalid field.
    for (const [field, value] of [
      ["zoneHash", p.zoneHash], ["conduitKey", p.conduitKey],
      ["fulfillerConduitKey", d.fulfillerConduitKey],
    ] as [string, unknown][]) {
      const bad = bytes32(value, field);
      if (bad) return bad;
    }
    for (const item of [...(p.offer ?? []), ...(p.consideration ?? [])]) {
      const bad = address(item?.token, "item.token");
      if (bad) return bad;
      if (item?.recipient != null) {
        const badRecipient = address(item.recipient, "item.recipient");
        if (badRecipient) return badRecipient;
      }
    }
    return null;
  }

  const p = d?.parameters;
  if (!p || typeof p !== "object") return missing("input_data.parameters");
  for (const field of ["offerer", "zone", "offerToken"]) {
    const bad = address(p[field], field);
    if (bad) return bad;
  }
  for (const field of ["zoneHash", "offererConduitKey", "fulfillerConduitKey"]) {
    const bad = bytes32(p[field], field);
    if (bad) return bad;
  }
  return null;
}

export interface BuyOutcome {
  sent: boolean;
  txHash: string | null;
  reason: string | null;
  price: number | null;
  currency: string | null;
}

/**
 * Buy one listed token.
 *
 * The wallet is supplied by the caller, which loads it through the same
 * wallet-file path the wizard uses — so an encrypted `wallets.json` works here
 * exactly as it does there (WALLETS_PASSPHRASE, or an interactive prompt).
 *
 * Only native-priced listings are sent. An ERC20-priced listing returns value
 * "0" and pulls payment with transferFrom, so it needs a spender approval first;
 * that is reported rather than guessed. The OpenSea API also refuses burn and
 * system addresses as payer, so the buyer is derived from the key, not chosen.
 */
export async function executeListingBuy(o: {
  listing: ListingSummary;
  buyerKey: string;
  apiKey: string;
  rpcUrl: string;
  chainId: number;
  yes: boolean;
  ask?: (q: string, defaultYes: boolean) => Promise<boolean>;
}): Promise<BuyOutcome> {
  const fail = (reason: string): BuyOutcome => ({
    sent: false,
    txHash: null,
    reason,
    price: o.listing.price,
    currency: o.listing.currency,
  });

  if (o.listing.error) return fail(o.listing.error);
  if (!o.rpcUrl) return fail("no RPC endpoint");

  const buyer = new Wallet(o.buyerKey);
  const tx = await fetchListingBuyTransaction(o.listing, buyer.address, o.apiKey);
  if (!tx) return fail("OpenSea would not vend a buy transaction for this listing");
  const problem = buyTxProblem(tx);
  if (problem) return fail(problem);

  // An ERC20-priced listing sends no native value and needs an approval first.
  const value = BigInt(tx.value ?? "0");
  if (value === 0n && (o.listing.currency ?? "ETH") !== "ETH") {
    return fail(
      `${o.listing.currency}-priced listing: needs a spender approval before buying. Not sent.`
    );
  }

  const provider = new JsonRpcProvider(o.rpcUrl, o.chainId, { staticNetwork: true });
  try {
    // Seaport validates msg.sender against the fulfiller encoded in the order.
    // Without `from`, eth_estimateGas runs as the zero address and reverts even
    // when the very same wallet can fill the order. Pass the buyer explicitly.
    const gas = await provider.estimateGas({
      from: buyer.address,
      to: tx.to,
      data: encodeBuyInput(tx),
      value,
    });
    const fee = await provider.getFeeData();
    const gasCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    console.log(chalk.gray(`    gas estimate: ${gas} (≈ ${gasCost} wei at current fees)`));
    const balance = await provider.getBalance(buyer.address);
    const needed = value + gasCost;
    if (balance < needed) {
      provider.destroy();
      return fail(
        `insufficient ETH balance: have ${formatEther(balance)}, need ≈ ${formatEther(needed)} (price + gas) — nothing was sent`
      );
    }
  } catch (e: any) {
    provider.destroy();
    return fail(`gas estimate failed: ${e?.message ?? e}`);
  }

  if (!o.yes) {
    const askFn = o.ask;
    if (!askFn) {
      provider.destroy();
      return fail("not confirmed (pass --yes to send)");
    }
    const ok = await askFn(
      `Buy token ${o.listing.tokenId} for ${formatListingPrice(o.listing)}?`,
      false
    );
    if (!ok) {
      provider.destroy();
      return fail("declined");
    }
  }

  try {
    const txRes = await buyer.connect(provider).sendTransaction({
      to: tx.to,
      data: encodeBuyInput(tx),
      value,
    });
    const hash = txRes.hash;
    provider.destroy();
    return { sent: true, txHash: hash, reason: null, price: o.listing.price, currency: o.listing.currency };
  } catch (e: any) {
    provider.destroy();
    return fail(`send failed: ${e?.message ?? e}`);
  }
}

/**
 * Rebuild the calldata from the vended transaction.
 *
 * OpenSea vends `calldata_suffix` (the 4-byte selector) plus the Seaport order
 * parameters in named form, so the tuple is re-encoded here rather than trusting
 * a blob. The argument order is the one in `function`:
 *
 *   (considerationToken, considerationIdentifier, considerationAmount, offerer,
 *    zone, offerToken, offerIdentifier, offerAmount, basicOrderType, startTime,
 *    endTime, zoneHash, salt, offererConduitKey, fulfillerConduitKey,
 *    totalOriginalAdditionalRecipients, additionalRecipients, signature)
 *
 * Verified live: the re-encoded selector matches the vendored `calldata_suffix`
 * (0xcdb44011 for fulfillBasicOrder_efficient_6GL6yc).
 */
const BASIC_FULFILL =
  "function fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))";
// Verified from OpenSea's own vended `function` string for an advanced-order
// collection; keccak256 of it is 0xe7acab24, which is the real selector. The
// `calldata_suffix` 0xcdb44011 is trailing attribution, NOT the selector.
const ADVANCED_FULFILL =
  "function fulfillAdvancedOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)";

function encodeBasicInput(tx: BuyTransaction): string {
  const p = (tx.inputData as any)?.parameters ?? {};
  const tuple = [
    p.considerationToken ?? ZERO_ADDRESS,
    BigInt(p.considerationIdentifier ?? 0),
    BigInt(p.considerationAmount ?? 0),
    p.offerer,
    p.zone,
    p.offerToken,
    BigInt(p.offerIdentifier ?? 0),
    BigInt(p.offerAmount ?? 0),
    Number(p.basicOrderType ?? 0),
    BigInt(p.startTime ?? 0),
    BigInt(p.endTime ?? 0),
    p.zoneHash,
    BigInt(p.salt ?? 0),
    p.offererConduitKey,
    p.fulfillerConduitKey,
    BigInt(p.totalOriginalAdditionalRecipients ?? 0),
    (p.additionalRecipients ?? []).map((r: any) => [BigInt(r.amount ?? 0), r.recipient]),
    p.signature ?? "0x",
  ];
  return new Interface([BASIC_FULFILL]).encodeFunctionData("fulfillBasicOrder_efficient_6GL6yc", [tuple]);
}

function encodeAdvancedInput(tx: BuyTransaction): string {
  const d = tx.inputData as any;
  const adv = d.advancedOrder;
  const p = adv.parameters;
  const item = (i: any, withRecipient: boolean) => [
    Number(i.itemType),
    i.token,
    BigInt(i.identifierOrCriteria),
    BigInt(i.startAmount),
    BigInt(i.endAmount),
    ...(withRecipient ? [i.recipient] : []),
  ];
  const order = [
    [
      p.offerer,
      p.zone,
      (p.offer ?? []).map((i: any) => item(i, false)),
      (p.consideration ?? []).map((i: any) => item(i, true)),
      Number(p.orderType),
      BigInt(p.startTime),
      BigInt(p.endTime),
      p.zoneHash,
      BigInt(p.salt),
      p.conduitKey,
      BigInt(p.totalOriginalConsiderationItems ?? 0),
    ],
    BigInt(adv.numerator ?? 1),
    BigInt(adv.denominator ?? 1),
    adv.signature ?? "0x",
    adv.extraData ?? "0x",
  ];
  const resolvers = (d.criteriaResolvers ?? []).map((r: any) => [
    BigInt(r.orderIndex),
    Number(r.side),
    BigInt(r.index),
    BigInt(r.identifier),
    (r.criteriaProof ?? []).map((proof: string) => proof),
  ]);
  return new Interface([ADVANCED_FULFILL]).encodeFunctionData("fulfillAdvancedOrder", [
    order,
    resolvers,
    d.fulfillerConduitKey,
    d.recipient,
  ]);
}

/**
 * Buy several EXACT listings in one transaction.
 *
 * The single-listing `/fulfillment_data` endpoint cannot do this, and
 * `/listings/sweep` buys the cheapest N with substitution. The verified bulk
 * surface is `/listings/cross_chain_fulfillment_data` with an explicit
 * `listings[]` and same-chain native payment: a same-chain probe with two
 * orders returned ONE tx to Seaport using `fulfillAvailableAdvancedOrders`
 * (selector 0x87201b41). More than one returned tx is refused rather than
 * broadcasting half a plan; ERC20 payment can add approval steps.
 */
export async function executeBatchListingBuy(o: {
  listings: ListingSummary[];
  buyerKey: string;
  apiKey: string;
  rpcUrl: string;
  chainId: number;
  yes: boolean;
  ask?: (q: string, defaultYes: boolean) => Promise<boolean>;
}): Promise<BuyOutcome> {
  const fail = (reason: string): BuyOutcome => ({
    sent: false, txHash: null, reason,
    price: o.listings.reduce((a, l) => a + (l.price ?? 0), 0),
    currency: o.listings[0]?.currency ?? null,
  });
  if (!o.listings.length) return fail("no listings selected — nothing was sent");
  if (!o.rpcUrl) return fail("no RPC endpoint");
  const chain = chainKeyFromId(o.chainId);
  if (!chain) return fail(`unknown chain id ${o.chainId} — nothing was sent`);
  for (const l of o.listings) {
    if (!l.orderHash || !l.chain || !l.protocolAddress) {
      return fail(`listing for token ${l.tokenId} is incomplete — nothing was sent`);
    }
  }
  const buyer = new Wallet(o.buyerKey);
  let txs: any[] = [];
  try {
    const r = await fetch("https://api.opensea.io/api/v2/listings/cross_chain_fulfillment_data", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": o.apiKey.trim() },
      body: JSON.stringify({
        fulfiller: { address: buyer.address },
        listings: o.listings.map((l) => ({
          chain: l.chain, hash: l.orderHash, protocol_address: l.protocolAddress,
        })),
        payment: { chain, token_address: ZERO_ADDRESS },
        recipient: buyer.address,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    const json: any = text ? JSON.parse(text) : null;
    if (!r.ok) return fail(`bulk fulfillment HTTP ${r.status}: ${String(json?.error?.message ?? "").slice(0, 160)}`);
    txs = Array.isArray(json?.transactions) ? json.transactions : [];
  } catch (e: any) {
    return fail(`bulk fulfillment request failed: ${e?.message ?? e}`);
  }
  if (!txs.length) return fail("OpenSea returned no transactions for the selected listings");
  if (txs.length !== 1) {
    return fail(
      `OpenSea returned ${txs.length} transactions for ${o.listings.length} listings; this command sends one — nothing was sent`
    );
  }
  const tx = txs[0];
  if (!tx?.to || typeof tx.data !== "string") return fail("bulk transaction has no to/data — nothing was sent");
  const value = BigInt(tx.value ?? "0");
  const provider = new JsonRpcProvider(o.rpcUrl, o.chainId, { staticNetwork: true });
  try {
    const gas = await provider.estimateGas({ from: buyer.address, to: tx.to, data: tx.data, value });
    const fee = await provider.getFeeData();
    const gasCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    console.log(chalk.gray(`    gas estimate: ${gas} (≈ ${gasCost} wei at current fees)`));
    const balance = await provider.getBalance(buyer.address);
    const needed = value + gasCost;
    if (balance < needed) {
      provider.destroy();
      return fail(
        `insufficient ETH balance: have ${formatEther(balance)}, need ≈ ${formatEther(needed)} (price + gas) — nothing was sent`
      );
    }
  } catch (e: any) {
    provider.destroy();
    return fail(`gas estimate failed: ${e?.message ?? e}`);
  }
  if (!o.yes) {
    const askFn = o.ask;
    if (!askFn) {
      provider.destroy();
      return fail("not confirmed (pass --yes to send)");
    }
    const ok = await askFn(
      `Buy ${o.listings.length} listed tokens for ≈ ${formatEther(value)} ETH?`,
      false
    );
    if (!ok) {
      provider.destroy();
      return fail("declined");
    }
  }
  try {
    const sent = await buyer.connect(provider).sendTransaction({ to: tx.to, data: tx.data, value });
    provider.destroy();
    return { sent: true, txHash: sent.hash, reason: null, price: o.listings.reduce((a, l) => a + (l.price ?? 0), 0), currency: o.listings[0]?.currency ?? null };
  } catch (e: any) {
    provider.destroy();
    return fail(`send failed: ${e?.message ?? e}`);
  }
}

/** Rebuild the calldata from whichever fulfillment shape OpenSea vended. */
export function encodeBuyInput(tx: BuyTransaction): string {
  const d = tx.inputData as any;
  const encoded = d?.advancedOrder ? encodeAdvancedInput(tx) : encodeBasicInput(tx);
  // `calldata_suffix` is NOT the selector: it is the first four bytes of
  // keccak256("api.opensea.io") (verified: 0xcdb44011), appended as TRAILING
  // calldata so the fill is attributed to OpenSea onchain. Seaport reads its
  // arguments by offset and ignores trailing bytes, so it is safe to append and
  // wrong to treat as the selector.
  const suffix = (tx.raw?.calldata_suffix as string) ?? "";
  if (!suffix) return encoded;
  if (!/^0x[0-9a-fA-F]{8}$/.test(suffix)) return encoded;
  return encoded + suffix.slice(2);
}
