// sell-after-mint.ts — sell minted tokens into the best OpenSea offer,
// guarded so a sale never happens below cost.
//
// STUB — the implementation lands test-first. See tests/sell-after-mint.test.mjs.

export interface OfferConsiderationItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient?: string;
}

export interface OfferParameters {
  offerer: string;
  zone: string;
  offer: OfferConsiderationItem[];
  consideration: OfferConsiderationItem[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: string;
}

export interface SellOffer {
  orderHash: string;
  chain: string;
  protocolAddress: string;
  offerer: string | null;
  priceWei: bigint;
  pricePerItemWei: bigint;
  currency: string;
  decimals: number;
  remainingQuantity: number;
  status: string;
  contract: string;
  tokenId: string | null;
  parameters: OfferParameters | null;
  signature: string | null;
}

/**
 * How many NFTs an order is for.
 *
 * An offer's price and fee lines are TOTALS for that quantity. Reading them as
 * a per-token figure overstates the proceeds by `quantity ×` — verified live
 * against a BAYC offer of 28.56 WETH for 8 NFTs, whose fulfillment order paid
 * the seller 3.5343 WETH for one token.
 *
 * The quantity is the NFT line(s) in the order: for an offer, the line payable
 * to the offerer; for a seller's counter-order, its own offer line.
 */
function orderQuantity(
  consideration: OfferConsiderationItem[] | undefined,
  offer: OfferConsiderationItem[] | undefined,
  offerer: string | null
): bigint | null {
  const NFT_TYPES = new Set([2, 3, 4, 5]); // ERC721, ERC1155, and their criteria forms

  const fromConsideration = (consideration ?? []).filter(
    (i) => NFT_TYPES.has(i.itemType) &&
      (offerer == null || (i.recipient || "").toLowerCase() === offerer.toLowerCase())
  );
  const fromOffer = (offer ?? []).filter((i) => NFT_TYPES.has(i.itemType));

  const chosen = fromConsideration.length > 0 ? fromConsideration : fromOffer;
  const sum = chosen.reduce((a, i) => a + parseWei(i.startAmount), 0n);

  // No NFT line anywhere means the quantity cannot be established. Refuse
  // rather than assume 1: an assumed quantity of 1 when the offer is really
  // for 8 OVERSTATES the per-token net by 8x, which is the one direction the
  // guard must never err in.
  return sum > 0n ? sum : null;
}

/**
 * Net proceeds the SELLER receives PER TOKEN, in the offer currency's base
 * unit. Returns null when the order cannot answer.
 *
 * Two shapes of order reach this function:
 *
 *  - The FULL order, from the fulfillment_data response. It carries the
 *    seller's own consideration line, so net is the sum of the payment lines
 *    payable to the seller.
 *  - The REDACTED order, from the collection/token offers listing. OpenSea
 *    omits the seller's line there (the seller is not known until fulfillment)
 *    and the signature. Every payment line that survives is a fee, so net is
 *    price minus those lines.
 *
 * Both are divided by the order's NFT quantity: comparing a whole-offer total
 * against a per-token cost floor would accept an offer that loses money on
 * every token.
 */
export function computeNetProceeds(offer: SellOffer, seller: string): bigint | null {
  const params = offer.parameters;
  if (!params) return null;

  // itemType 0 = NATIVE, 1 = ERC20. The NFT lines (2/3/4/5) are not payments.
  const paymentItems = params.consideration.filter(
    (i) => i.itemType === 0 || i.itemType === 1
  );
  if (paymentItems.length === 0) return null;

  const sellerAddr = seller.toLowerCase();
  const toSeller = paymentItems.filter(
    (i) => (i.recipient || "").toLowerCase() === sellerAddr
  );

  const quantity = orderQuantity(params.consideration, params.offer, params.offerer);
  if (quantity == null || quantity <= 0n) return null;

  if (toSeller.length > 0) {
    const total = toSeller.reduce((sum, i) => sum + parseWei(i.startAmount), 0n);
    return total / quantity;
  }

  // Redacted listing: no seller line, so every payment line is a fee.
  const fees = paymentItems.reduce((sum, i) => sum + parseWei(i.startAmount), 0n);
  return (offer.priceWei - fees) / quantity;
}

/**
 * Parse a decimal price string into a base-unit bigint.
 *
 * The offers endpoint returns a wei decimal string ("5510000000000000000").
 * A float string is tolerated and read as a whole-currency amount (ETH → wei)
 * rather than throwing: BigInt("0.0056") throws, and a throw inside a caller's
 * catch becomes a silent "no offers". Anything unrecognisable reads as 0, which
 * makes the guard reject the offer instead of accepting a wrong price.
 */
export function parseWei(value: unknown): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) ? BigInt(value) : parseWei(value.toString());
  }
  const s = String(value).trim();
  if (s === "") return 0n;
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (m && (m[2] !== "" || (m[3] ?? "") !== "")) {
    const frac = ((m[3] ?? "") + "0".repeat(18)).slice(0, 18);
    const n = BigInt(m[2] || "0") * 10n ** 18n + BigInt(frac || "0");
    return m[1] === "-" ? -n : n;
  }
  return 0n;
}

/** Normalize an OpenSea offers-endpoint row into a SellOffer. */
export function parseOffer(raw: any): SellOffer {
  const params = raw?.protocol_data?.parameters ?? null;
  const price = raw?.price ?? null;
  const perItem = raw?.price_per_item ?? null;
  return {
    orderHash: raw?.order_hash ?? "",
    chain: raw?.chain ?? "",
    protocolAddress: raw?.protocol_address ?? "",
    offerer: params?.offerer ?? null,
    priceWei: parseWei(price?.value),
    pricePerItemWei: parseWei(perItem?.value ?? price?.value),
    currency: price?.currency ?? "",
    decimals: price?.decimals ?? 18,
    remainingQuantity: raw?.remaining_quantity ?? 0,
    status: raw?.status ?? "",
    contract: raw?.asset?.contract ?? raw?.criteria?.contract?.address ?? null,
    tokenId: raw?.asset?.identifier ?? null,
    parameters: params,
    signature: raw?.protocol_data?.signature || null,
  };
}

/**
 * Rank offers by net proceeds, best first.
 *
 * Drops anything that cannot be fulfilled: a non-ACTIVE status, a missing
 * order hash (a Solana order carries `svm_order` instead and cannot settle on
 * Seaport), a non-positive remaining quantity, and an order whose net cannot
 * be derived at all.
 */
export function rankOffers(offers: SellOffer[], seller: string): SellOffer[] {
  return offers
    .filter((o) => o.status === "ACTIVE")
    .filter((o) => o.orderHash !== "")
    .filter((o) => o.remainingQuantity > 0)
    .map((o) => ({ offer: o, net: computeNetProceeds(o, seller) }))
    .filter((x): x is { offer: SellOffer; net: bigint } => x.net != null)
    .sort((a, b) => (a.net < b.net ? 1 : a.net > b.net ? -1 : 0))
    .map((x) => x.offer);
}

import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, formatEther, id } from "ethers";
import {
  SEAPORT_1_5_ABI,
  SEAPORT_1_5_ADDRESS,
  SEAPORT_1_6_ABI,
  SEAPORT_1_6_ADDRESS,
} from "./seaport-abi";

/** The transaction block of a fulfillment_data response. */
export interface FulfillmentTransaction {
  function: string;
  chain: number;
  to: string;
  value: string;
  value_hex?: string | null;
  calldata_suffix?: string | null;
  input_data: Record<string, unknown>;
}

export interface EncodedSellTx {
  to: string;
  data: string;
  value: bigint;
  functionName: string;
}

const ZERO_CONDUIT_KEY = "0x" + "00".repeat(32);

/**
 * Which keys of `input_data` feed each Seaport entrypoint's arguments, in the
 * order the ABI declares them.
 *
 * The API returns the argument struct keyed by name, and for the tuple
 * arguments those names differ from the ABI's own component names (the ABI
 * leaves several tuple parameters unnamed), so the mapping is explicit rather
 * than derived. `function` itself may arrive as a bare name or a full
 * signature — both are handled by splitting on "(".
 */
const PARAM_KEYS: Record<string, string[]> = {
  matchAdvancedOrders: ["orders", "criteriaResolvers", "fulfillments", "recipient"],
  matchOrders: ["orders", "fulfillments"],
  fulfillAdvancedOrder: ["advancedOrder", "criteriaResolvers", "fulfillerConduitKey", "recipient"],
  fulfillAvailableAdvancedOrders: [
    "orders", "criteriaResolvers", "fulfillments", "fulfillerConduitKey", "recipient",
  ],
  fulfillOrder: ["order", "fulfillerConduitKey"],
  fulfillAvailableOrders: [
    "orders", "offerFulfillments", "considerationFulfillments", "fulfillerConduitKey", "maximumFulfilled",
  ],
  fulfillBasicOrder: ["parameters"],
  fulfillBasicOrder_efficient_6GL6yc: ["parameters"],
};

/** Arguments the API may omit, with the value Seaport expects for them. */
function defaultArg(key: string): unknown {
  if (key === "fulfillerConduitKey") return ZERO_CONDUIT_KEY;
  if (key.endsWith("Fulfillments")) return [];
  if (key === "criteriaResolvers") return [];
  if (key === "maximumFulfilled") return 0;
  return undefined;
}

/** The Seaport ABI for a deployment address. Unknown addresses get 1.6, the
 *  current default; the order's own protocol_address is authoritative. */
export function seaportAbiForAddress(address: string): any[] {
  return (address || "").toLowerCase() === SEAPORT_1_5_ADDRESS.toLowerCase()
    ? SEAPORT_1_5_ABI
    : SEAPORT_1_6_ABI;
}

// Event topics are computed, never hand-typed: a typed selector that drifts
// from the real signature fails silently and reads as "no tokens minted".
const ERC721_TRANSFER = id("Transfer(address,address,uint256)");
const ERC1155_TRANSFER_SINGLE = id("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_TRANSFER_BATCH = id("TransferBatch(address,address,address,uint256[],uint256[])");
const ZERO_ADDRESS = "0x" + "00".repeat(20);
const abiCoder = AbiCoder.defaultAbiCoder();

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40);
}

/**
 * Token ids minted to `wallet`, read from transaction receipt logs.
 *
 * A mint is an ERC721 `Transfer` from the zero address, or an ERC1155
 * `TransferSingle`/`TransferBatch` from the zero address. Requiring the zero
 * sender is what separates a mint from an ordinary transfer in: a receipt can
 * carry both, and selling a token the wallet did not just mint would be a
 * transfer of a pre-existing holding.
 */
export function extractMintedTokenIds(logs: readonly any[], wallet: string): string[] {
  const wanted = wallet.toLowerCase();
  const ids: string[] = [];
  const seen = new Set<string>();

  const push = (idStr: string) => {
    if (!seen.has(idStr)) {
      seen.add(idStr);
      ids.push(idStr);
    }
  };

  for (const log of logs) {
    const topics: string[] = log?.topics ?? [];
    const topic = topics[0];
    if (!topic) continue;

    if (topic === ERC721_TRANSFER) {
      if (topics.length < 3) continue;
      if (topicToAddress(topics[1]) !== ZERO_ADDRESS) continue;
      if (topicToAddress(topics[2]) !== wanted) continue;
      try {
        push(BigInt(log.data).toString());
      } catch {
        // Malformed data — skip the log rather than abort the whole receipt.
      }
    } else if (topic === ERC1155_TRANSFER_SINGLE) {
      if (topics.length < 4) continue;
      if (topicToAddress(topics[2]) !== ZERO_ADDRESS) continue;
      if (topicToAddress(topics[3]) !== wanted) continue;
      try {
        const [tokenId] = abiCoder.decode(["uint256", "uint256"], log.data);
        push(tokenId.toString());
      } catch {
        // skip
      }
    } else if (topic === ERC1155_TRANSFER_BATCH) {
      if (topics.length < 4) continue;
      if (topicToAddress(topics[2]) !== ZERO_ADDRESS) continue;
      if (topicToAddress(topics[3]) !== wanted) continue;
      try {
        const [tokenIds] = abiCoder.decode(["uint256[]", "uint256[]"], log.data);
        for (const t of tokenIds) push(t.toString());
      } catch {
        // skip
      }
    }
  }

  return ids;
}

/**
 * Refuse a sale whose net proceeds do not cover the cost of acquiring the token.
 *
 * Both sides must be in the same unit. The offer is paid in WETH and the mint
 * cost is in the chain's native token; on the chains this tool serves those
 * are 1:1, so the wei amounts compare directly.
 */
export function assertSaleProfitable(netWei: bigint, costWei: bigint, symbol = "ETH"): void {
  if (netWei < costWei) {
    // Human-readable: raw wei is ~18 digits and impossible to compare against a
    // price at a glance, which is the whole point of the guard.
    throw new Error(
      `Sale would lose money: net proceeds ${formatEther(netWei)} ${symbol} < ` +
        `cost ${formatEther(costWei)} ${symbol} (mint price + gas). Refusing to sell.`
    );
  }
}

/**
 * Turn a fulfillment_data transaction into signable calldata.
 *
 * The API returns the entrypoint NAME and its argument STRUCT, not calldata —
 * the ABI is what encodes it. `calldata_suffix` is a 4-byte attribution suffix
 * appended after the encoded calldata; omitting it does not affect execution,
 * but OpenSea's own SDK restores it, so it is restored here too.
 */
export function encodeFulfillmentCalldata(
  tx: FulfillmentTransaction,
  abi?: any[]
): EncodedSellTx {
  const useAbi = abi ?? seaportAbiForAddress(tx.to);
  const name = (tx.function || "").split("(")[0].trim();
  if (!name) throw new Error("fulfillment_data: empty function name");

  const iface = new Interface(useAbi);
  const fn = iface.getFunction(name);
  if (!fn) throw new Error(`fulfillment_data: unknown Seaport entrypoint "${name}"`);

  const keys = PARAM_KEYS[name];
  if (!keys) throw new Error(`fulfillment_data: no argument mapping for "${name}"`);

  const args = keys.map((k) => tx.input_data[k] ?? defaultArg(k));
  const data = iface.encodeFunctionData(fn, args);
  const suffix = tx.calldata_suffix ? tx.calldata_suffix.slice(2) : "";

  return {
    to: tx.to,
    data: data + suffix,
    value: parseWei(tx.value),
    functionName: name,
  };
}

// ── Sale decision ───────────────────────────────────────────────────────────

export interface SaleDecision {
  offer: SellOffer;
  netWei: bigint;
}

/**
 * Net proceeds PER TOKEN from the FULL fulfillment order set, in base units.
 *
 * The listing omits the seller's consideration line; the fulfillment_data
 * response includes it. Summing every payment line payable to the seller
 * across all orders is authoritative and does not depend on which order is
 * the seller's counter-order. Divided by the NFT quantity the seller's order
 * offers, so the figure is per token and comparable with the mint cost floor.
 */
export function netFromOrders(orders: any[], seller: string): bigint | null {
  const sellerAddr = seller.toLowerCase();
  let total = 0n;
  let quantity = 0n;
  let found = false;

  for (const order of orders) {
    const params = order?.parameters;
    const consideration = params?.consideration;
    if (!Array.isArray(consideration)) continue;

    // The seller's own counter-order names the NFT(s) it offers; that amount
    // is the quantity its consideration lines pay for.
    if ((params?.offerer ?? "").toLowerCase() === sellerAddr) {
      for (const item of params?.offer ?? []) {
        if (item?.itemType === 2 || item?.itemType === 3 || item?.itemType === 4 || item?.itemType === 5) {
          quantity += parseWei(item?.startAmount);
        }
      }
    }

    for (const item of consideration) {
      if (item?.itemType !== 0 && item?.itemType !== 1) continue;
      if ((item?.recipient || "").toLowerCase() !== sellerAddr) continue;
      total += parseWei(item?.startAmount);
      found = true;
    }
  }

  if (!found) return null;
  // Without the seller's own order there is no quantity to divide by, and
  // returning the undivided total would present a whole-order figure as a
  // per-token one — overstating the proceeds by the order size, which is the
  // direction the cost guard must never err in. Refuse, the same way
  // orderQuantity() does.
  if (quantity <= 0n) return null;
  return total / quantity;
}

/**
 * Pick the best offer that clears the cost floor.
 *
 * Offers are ranked by net proceeds; the first one that passes the guard wins.
 * An offer below cost is skipped rather than aborting the search — a second,
 * better offer may still clear.
 */
export function chooseOffer(
  offers: SellOffer[],
  seller: string,
  costWei: bigint,
  symbol = "ETH"
): SaleDecision | null {
  for (const offer of rankOffers(offers, seller)) {
    const net = computeNetProceeds(offer, seller);
    if (net == null) continue;
    try {
      assertSaleProfitable(net, costWei, symbol);
    } catch {
      continue;
    }
    return { offer, netWei: net };
  }
  return null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

const CONDUIT_CONTROLLER_ADDRESS = "0x00000000f9490004c11cef243f5400493c00ad63";
const CONDUIT_CONTROLLER_ABI = [
  {
    name: "getConduit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "conduitKey", type: "bytes32" }],
    outputs: [
      { name: "conduit", type: "address" },
      { name: "exists", type: "bool" },
    ],
  },
] as const;

const ERC721_APPROVAL_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const ZERO_BYTES32 = "0x" + "00".repeat(32);

/**
 * Re-read the fee market at sell time and apply the chosen mode's multipliers.
 *
 * The quote shown at scheduling time is an estimate; the sell happens minutes
 * or hours later, so the fee is read again here. The mode is a policy, not a
 * snapshot.
 */
export async function liveGasQuote(
  provider: JsonRpcProvider,
  mode: GasMode,
  gasLimit: number
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null> {
  try {
    const [block, feeData] = await Promise.all([
      provider.getBlock("latest"),
      provider.getFeeData(),
    ]);
    // ethers' getFeeData().maxFeePerGas is an ESTIMATE (base*2 + tip), not the
    // base fee. The block's baseFeePerGas is the network's actual price.
    const base = block?.baseFeePerGas ?? null;
    const tip = feeData?.maxPriorityFeePerGas ?? 1_000_000_000n;
    if (base == null) return null;
    const quote = quoteGasModes(
      { baseFeePerGas: base, priorityFeePerGas: tip, gasLimit },
      null
    ).find((q) => q.mode === mode);
    return quote
      ? { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas }
      : null;
  } catch {
    return null;
  }
}

/**
 * The address that will pull the seller's NFT, resolved from the order's own
 * conduit key via Seaport's ConduitController.
 *
 * A zero key means "no conduit" — the NFT is pulled directly from a Seaport
 * approval, so the Seaport contract itself is the operator to approve.
 */
export async function approvalOperator(
  provider: JsonRpcProvider,
  conduitKey: string | null,
  seaportAddress: string
): Promise<string | null> {
  if (!conduitKey || conduitKey === ZERO_BYTES32) return seaportAddress;
  try {
    const controller = new Contract(CONDUIT_CONTROLLER_ADDRESS, CONDUIT_CONTROLLER_ABI, provider);
    const [conduit, exists] = await controller.getConduit(conduitKey);
    return exists ? conduit : null;
  } catch {
    return null;
  }
}

/** Approve `operator` for the NFT contract unless the wallet already has. */
export async function ensureApproval(
  provider: JsonRpcProvider,
  wallet: Wallet,
  contract: string,
  operator: string
): Promise<{ needed: boolean; txHash?: string; error?: string }> {
  try {
    const token = new Contract(contract, ERC721_APPROVAL_ABI, provider);
    const approved = await token.isApprovedForAll(wallet.address, operator);
    if (approved) return { needed: false };

    const tx = await wallet.sendTransaction(
      await token.setApprovalForAll.populateTransaction(operator, true)
    );
    await tx.wait();
    return { needed: true, txHash: tx.hash };
  } catch (e: any) {
    return { needed: false, error: e?.message ?? String(e) };
  }
}

export interface SellWalletOpts {
  walletKey: string;
  contract: string;
  slug: string;
  chainKey: string;
  apiKey: string;
  rpcUrl: string;
  chainId: number;
  quantity: number;
  gasMode: GasMode;
  /** Per-token floor: mint unit price + estimated sell gas, in wei. */
  costWeiPerToken: bigint;
  /** Native token symbol, for the cost-guard message. Defaults to ETH. */
  symbol?: string;
  /** The mint transaction whose receipt logs identify the minted tokens. */
  mintTxHash: string;
  gasLimit?: number;
  /** Injectable for tests; a provider is created when omitted. */
  provider?: any;
}

/** A Seaport offer fulfillment costs roughly 150-250k gas. */
export const SELL_GAS_LIMIT = 250_000;

export interface SoldToken {
  tokenId: string;
  offerHash: string;
  netWei: bigint;
  txHash?: string;
  error?: string;
}

export interface SellWalletResult {
  walletAddress: string;
  mintedTokenIds: string[];
  heldTokenIds: string[];
  sold: SoldToken[];
  approvalTxHash?: string;
  approvalError?: string;
  skippedReason?: string;
  error?: string;
}

/**
 * Sell up to `quantity` minted tokens from one wallet into the best offer.
 *
 * Sequential by contract: the caller runs one wallet at a time, because two
 * wallets accepting the same criteria offer race on `remaining_quantity` — one
 * fills it and the other reverts. Offers are re-fetched before EVERY token for
 * the same reason: the book moves after each sale.
 */
export async function executeSellAfterMint(
  opts: SellWalletOpts
): Promise<SellWalletResult> {
  // A caller-supplied provider is not ours to destroy.
  const ownedProvider = !opts.provider;
  const provider: any = opts.provider ?? new JsonRpcProvider(opts.rpcUrl, opts.chainId, { staticNetwork: true });
  // The wallet must be CONNECTED to the provider. `Wallet.sendTransaction`
  // broadcasts through `wallet.provider`; a bare Wallet throws
  // "missing provider (operation=\"sendTransaction\", code=UNSUPPORTED_OPERATION)"
  // on ethers 6, which made every approval and every sale in this module
  // impossible. Signing locally and broadcasting through `provider` would also
  // work, but connecting the wallet keeps the call sites unchanged.
  const wallet = new Wallet(opts.walletKey, provider);

  const result: SellWalletResult = {
    walletAddress: wallet.address,
    mintedTokenIds: [],
    heldTokenIds: [],
    sold: [],
  };

  try {
    // 1. The mint receipt is authoritative: it names the tokens this wallet
    //    actually received, not the quantity that was requested.
    const receipt = await provider.getTransactionReceipt(opts.mintTxHash);
    if (!receipt) {
      result.skippedReason = `no receipt for mint tx ${opts.mintTxHash}`;
      return result;
    }
    result.mintedTokenIds = extractMintedTokenIds(receipt.logs, wallet.address);
    if (result.mintedTokenIds.length === 0) {
      result.skippedReason = "no mint logs found in the mint receipt";
      return result;
    }

    // 2. Confirm ownership on-chain before offering anything for sale. A log
    //    can be misleading (a transfer out in the same tx, a burned token).
    const token = new Contract(opts.contract, ERC721_APPROVAL_ABI, provider);
    for (const id of result.mintedTokenIds) {
      try {
        const owner = await token.ownerOf(id);
        if (owner.toLowerCase() === wallet.address.toLowerCase()) {
          result.heldTokenIds.push(id);
        }
      } catch {
        // Not held (or not ERC721) — skip it.
      }
    }
    if (result.heldTokenIds.length === 0) {
      result.skippedReason = "wallet holds none of the minted tokens";
      return result;
    }

    // 3. Sell one at a time, re-reading the book before each.
    for (const tokenId of result.heldTokenIds.slice(0, opts.quantity)) {
      try {
        const [tokenOffers, collectionOffers] = await Promise.all([
          fetchTokenOffers(opts.slug, tokenId, opts.apiKey),
          fetchCollectionOffers(opts.slug, opts.apiKey),
        ]);
        const decision = chooseOffer(
          [...tokenOffers, ...collectionOffers],
          wallet.address,
          opts.costWeiPerToken,
          opts.symbol
        );
        if (!decision) {
          result.sold.push({
            tokenId,
            offerHash: "",
            netWei: 0n,
            error: "no offer clears the cost floor",
          });
          continue;
        }

        const tx = await fetchFulfillmentData(decision.offer, wallet.address, tokenId, opts.apiKey);
        if (!tx) {
          result.sold.push({
            tokenId,
            offerHash: decision.offer.orderHash,
            netWei: decision.netWei,
            error: "OpenSea would not vend fulfillment data",
          });
          continue;
        }

        // The full order set is authoritative — re-derive net from it and
        // re-apply the guard against the listing-time estimate.
        const fullNet = netFromOrders(
          (tx.input_data?.orders as any[]) ?? [],
          wallet.address
        );
        const net = fullNet ?? decision.netWei;
        try {
          assertSaleProfitable(net, opts.costWeiPerToken, opts.symbol);
        } catch (e: any) {
          result.sold.push({
            tokenId,
            offerHash: decision.offer.orderHash,
            netWei: net,
            error: e?.message ?? String(e),
          });
          continue;
        }

        const encoded = encodeFulfillmentCalldata(tx);

        // Approve the conduit that will pull this NFT, unless already approved.
        const sellerOrder = ((tx.input_data?.orders as any[]) ?? []).find(
          (o: any) => (o?.parameters?.offerer ?? "").toLowerCase() === wallet.address.toLowerCase()
        );
        const operator = await approvalOperator(
          provider,
          sellerOrder?.parameters?.conduitKey ?? null,
          encoded.to
        );
        if (operator) {
          const approval = await ensureApproval(provider, wallet, opts.contract, operator);
          if (approval.error) {
            result.approvalError = approval.error;
          } else if (approval.txHash) {
            result.approvalTxHash = approval.txHash;
          }
        }

        const gasLimit = opts.gasLimit ?? SELL_GAS_LIMIT;
        const fees = await liveGasQuote(provider, opts.gasMode, gasLimit);
        const sent = await wallet.sendTransaction({
          to: encoded.to,
          data: encoded.data,
          value: encoded.value,
          gasLimit,
          maxFeePerGas: fees?.maxFeePerGas,
          maxPriorityFeePerGas: fees?.maxPriorityFeePerGas,
        });
        const receipt2 = await sent.wait();
        result.sold.push({
          tokenId,
          offerHash: decision.offer.orderHash,
          netWei: net,
          txHash: sent.hash,
          error: receipt2?.status === 0 ? "sale transaction reverted on-chain" : undefined,
        });
      } catch (e: any) {
        result.sold.push({
          tokenId,
          offerHash: "",
          netWei: 0n,
          error: e?.message ?? String(e),
        });
      }
    }

    return result;
  } catch (e: any) {
    result.error = e?.message ?? String(e);
    return result;
  } finally {
    if (ownedProvider) provider.destroy();
  }
}

// ── Gas modes ───────────────────────────────────────────────────────────────

export type GasMode = "slow" | "fast" | "ultra";

export interface FeeData {
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
  gasLimit: number;
}

export interface GasQuote {
  mode: GasMode;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  costWei: bigint;
  costUsd: number | null;
}

/**
 * Each mode is a rational multiple of the live fee data, kept as (num, den)
 * so the arithmetic stays in bigint and never rounds through a float.
 *
 * These multipliers are a policy choice, not a network rule: "slow" clears in
 * the next few blocks, "fast" competes with ordinary traffic, "ultra" is for
 * an offer that may be front-run. The user picks one before the mint; the
 * cost is reported for all three so the choice is informed.
 */
const MODE_FACTORS: Record<GasMode, { baseNum: bigint; baseDen: bigint; tipNum: bigint; tipDen: bigint }> = {
  slow: { baseNum: 11n, baseDen: 10n, tipNum: 1n, tipDen: 1n },
  fast: { baseNum: 15n, baseDen: 10n, tipNum: 2n, tipDen: 1n },
  ultra: { baseNum: 2n, baseDen: 1n, tipNum: 4n, tipDen: 1n },
};

const MODE_ORDER: GasMode[] = ["slow", "fast", "ultra"];

/** Quote the cost of one sell transaction under each gas mode. */
export function quoteGasModes(fee: FeeData, usdPrice: number | null): GasQuote[] {
  return MODE_ORDER.map((mode) => {
    const f = MODE_FACTORS[mode];
    const maxPriorityFeePerGas = (fee.priorityFeePerGas * f.tipNum) / f.tipDen;
    const maxFeePerGas =
      (fee.baseFeePerGas * f.baseNum) / f.baseDen + maxPriorityFeePerGas;
    const costWei = maxFeePerGas * BigInt(fee.gasLimit);
    const costUsd = usdPrice == null ? null : (Number(costWei) / 1e18) * usdPrice;
    return { mode, maxFeePerGas, maxPriorityFeePerGas, costWei, costUsd };
  });
}

// ── Fetch layer ─────────────────────────────────────────────────────────────

const API_BASE = "https://api.opensea.io";
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface FetchOpts {
  timeoutMs?: number;
  limit?: number;
  maxPages?: number;
}

function apiHeaders(apiKey: string): Record<string, string> {
  return { "X-API-KEY": apiKey, "content-type": "application/json" };
}

async function fetchJson(
  path: string,
  apiKey: string,
  opts: { timeoutMs?: number; method?: string; body?: unknown; retries?: number } = {}
): Promise<any | null> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: opts.method ?? "GET",
        headers: apiHeaders(apiKey),
        body: opts.body == null ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      // 429 is the API's own back-off signal. Honour Retry-After (capped — a
      // free key's fulfillment quota is 5/m, so the reset can be minutes away
      // and waiting it out is not always the right call). Any other non-OK is
      // a verdict, not a throttle.
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 15_000)
          : 2_000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function fetchOfferPages(
  firstPath: string,
  apiKey: string,
  opts: FetchOpts
): Promise<SellOffer[]> {
  const limit = opts.limit ?? 50;
  const maxPages = opts.maxPages ?? 10;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const out: SellOffer[] = [];
  let next: string | null = null;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (next) qs.set("next", next);
    const body = await fetchJson(`${firstPath}?${qs.toString()}`, apiKey, { timeoutMs });
    if (!body) break;
    for (const raw of body.offers ?? []) out.push(parseOffer(raw));
    next = body.next ?? null;
    pages++;
  } while (next && pages < maxPages);

  return out;
}

/** Collection-wide criteria offers for a slug. */
export async function fetchCollectionOffers(
  slug: string,
  apiKey: string,
  opts: FetchOpts = {}
): Promise<SellOffer[]> {
  return fetchOfferPages(
    `/api/v2/offers/collection/${encodeURIComponent(slug)}`,
    apiKey,
    opts
  );
}

/** Token-specific offers for one minted token id. */
export async function fetchTokenOffers(
  slug: string,
  tokenId: string,
  apiKey: string,
  opts: FetchOpts = {}
): Promise<SellOffer[]> {
  return fetchOfferPages(
    `/api/v2/offers/collection/${encodeURIComponent(slug)}/nfts/${encodeURIComponent(tokenId)}`,
    apiKey,
    opts
  );
}

/**
 * Ask OpenSea for the calldata that accepts an offer.
 *
 * The server validates that `seller` owns `tokenId` before vending anything,
 * so this is only callable after the mint — which is exactly the ordering the
 * sell flow needs.
 */
export async function fetchFulfillmentData(
  offer: SellOffer,
  seller: string,
  tokenId: string,
  apiKey: string,
  opts: { timeoutMs?: number; unitsToFill?: number; includeOptionalCreatorFees?: boolean } = {}
): Promise<FulfillmentTransaction | null> {
  const body = {
    offer: {
      chain: offer.chain,
      hash: offer.orderHash,
      protocol_address: offer.protocolAddress,
    },
    fulfiller: { address: seller },
    consideration: {
      asset_contract_address: offer.contract,
      token_id: tokenId,
    },
    units_to_fill: opts.unitsToFill ?? 1,
    include_optional_creator_fees: opts.includeOptionalCreatorFees ?? false,
  };
  const json = await fetchJson("/api/v2/offers/fulfillment_data", apiKey, {
    method: "POST",
    body,
    timeoutMs: opts.timeoutMs,
  });
  return json?.fulfillment_data?.transaction ?? null;
}

/**
 * USD price of a chain's NATIVE token, used to express the gas cost.
 *
 * The zero address is OpenSea's identifier for the native token on most EVM
 * chains (ETH on Ethereum, Base, Robinhood and Soneium), verified live: it
 * returns symbol ETH with a usd_price.
 *
 * Arc is the exception. Its gas token is native USDC at 0x3600…0000, and the
 * zero address is NOT a contract there — verified live: eth_call against it
 * fails to decode, and OpenSea has no token for it. Querying the zero address
 * on Arc returned no usd_price, so the gas report silently dropped its dollar
 * figure. Hence the small per-chain table; the API is the authority on which
 * tokens exist, but it can only be asked about an address that does.
 */
const NATIVE_TOKEN_ADDRESS_BY_CHAIN: Record<string, string> = {
  arc: "0x3600000000000000000000000000000000000000",
};

export async function fetchUsdPrice(
  chain: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {}
): Promise<number | null> {
  const token = NATIVE_TOKEN_ADDRESS_BY_CHAIN[chain?.trim().toLowerCase() ?? ""] ?? NATIVE_TOKEN_ADDRESS;
  const json = await fetchJson(
    `/api/v2/chain/${encodeURIComponent(chain)}/token/${token}`,
    apiKey,
    { timeoutMs: opts.timeoutMs }
  );
  const raw = json?.usd_price;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
