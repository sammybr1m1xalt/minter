// ── OpenSea GraphQL infrastructure (APQ + persisted queries) ──────────────────
// Shared between fcfs-drops.ts and fcfs-mint.ts. Splitting this into its own
// module breaks the circular dependency that existed when gqlApqQuery lived in
// fcfs-drops.ts (which imports postMintTx from fcfs-mint.ts).
//
// Usage:
//   gqlPersistedQuery — pinned hash (fast GET, fallback APQ on hash rotation)
//   gqlApqQuery       — compute sha256 locally, register + execute in one POST
//
// Override pinned hashes via env (OS_HASH_MINT_MODULE, OS_HASH_MINT_TIMELINE,
// OS_HASH_DROP_ELIGIBILITY, OS_HASH_MINT_QUERY, OS_HASH_COLLECTION_DROPS).

import { osChain } from "./chains";
import {
  isPayloadBoundToWallet as isPayloadBoundToWalletImpl,
  decodeStageIndex as decodeStageIndexImpl,
  decodeMintCalldata,
  isKnownMintSelector,
  SIGNED_SELECTOR,
  MERKLE_SELECTOR,
  PUBLIC_SELECTOR,
} from "./seadrop-calldata";

// Re-exported so callers have one import site for calldata decoding.
export { decodeMintCalldata, isKnownMintSelector, SIGNED_SELECTOR, MERKLE_SELECTOR, PUBLIC_SELECTOR };
export const decodeStageIndex = decodeStageIndexImpl;

const OPENSEA_GQL_URL = "https://gql.opensea.io/graphql";

export const GQL_HASHES = {
  mintModule: process.env.OS_HASH_MINT_MODULE || "bb4a5cd4809b2214c900a91d066158a5fc27a82fcb8cbcc13db34053a88fa05c",
  mintTimeline: process.env.OS_HASH_MINT_TIMELINE || "1a786dd183540c6143038435ebb7d48c6e2007150210585e45137c8e1d779801",
  dropEligibility: process.env.OS_HASH_DROP_ELIGIBILITY || "e1b54354df0d26d39c6b81429bd5e5d37749eaa4bdc027f987128f8c1e7d2308",
  mintQuery: process.env.OS_HASH_MINT_QUERY || "15d500b9dab94cd28b158ebc43ac446c3c71250178c22cdbdf152bc302154310",
  // Computed sha256 of the CollectionDropsQuery text below — used for initial
  // hash-only GET (faster). Falls back to APQ registration on PERSISTED_QUERY_NOT_FOUND.
  collectionDrops: process.env.OS_HASH_COLLECTION_DROPS || "c9c322e2f709d3533ee09e496f6dbda9048387d18e194d53c1f7ba6433613b56",
};

// GraphQL query texts for APQ registration when pinned hashes are retired.
// These match the exact queries the OpenSea frontend uses, so the server
// has them pre-registered — but APQ is our fallback if the hash changes.
export const GQL_QUERY_TEXTS: Record<string, string> = {
  MintActionTimelineQuery: `query MintActionTimelineQuery($address: Address! $fromAssets: [AssetQuantityInput!]! $toAssets: [AssetQuantityInput!]! $recipient: Address) { swap(address: $address fromAssets: $fromAssets toAssets: $toAssets recipient: $recipient action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } } }`,
  MintModuleQuery: `query MintModuleQuery($collectionSlug: String!) { dropBySlug(slug: $collectionSlug) { __typename stages { __typename stageType stageIndex startTime endTime maxTotalMintableByWallet allowlistMemberCount price { token { unit symbol contractAddress chain { identifier } } } label } } }`,
  DropEligibilityQuery: `query DropEligibilityQuery($collectionSlug: String!, $address: Address!) { dropBySlug(slug: $collectionSlug) { __typename ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) } accountStageEligibility { walletCount allowlistedWalletCount wallets { address quantityMinted stages { dropStageUuid isEligible maxTotalMintableByWallet } } } stages { uuid stageType stageIndex startTime endTime isEligible eligibleMinterAddress maxTotalMintableByWallet allowlistMemberCount eligibleMaxTotalMintableByWallet eligiblePrice { token { unit symbol } } } } }`,
  // Verified against the live schema (collectr, 2026-11-05). The previous
  // version queried collectionBySlug, whose result type (CollectionResult)
  // exposes NONE of slug/name/address/chain/stages — every field was rejected
  // with "Cannot query field", and the inline fragment type CollectionDropStage
  // does not exist. dropBySlug is the working root.
  //
  // Live-verified fields on Erc721SeaDropV1Stage:
  //   uuid, stageType, stageIndex, label, startTime, endTime,
  //   maxTotalMintableByWallet, allowlistMemberCount, price { token { ... } }
  // NOT present on that type: mintData, mintSignature, gasLimit, maxFeePerGas,
  //   maxPriorityFeePerGas, eligible, eligibleCount, totalAllocated,
  //   allowlistedAddresses, allowlistHash, feeRecipient, isEligible,
  //   eligiblePrice, eligibleMinterAddress, maxPerWallet.
  // The eligibility fields exist but require a wallet JWT (UNAUTHORIZED
  // without one), so they are queried separately by DropEligibilityQuery.
  // minterQuantityMinted needs a real Address and is per-wallet, so it is
  // fetched by DropEligibilityQuery rather than here.
  CollectionDropsQuery: `query CollectionDrops($slug: String!) { dropBySlug(slug: $slug) { __typename collection { slug name address chain { identifier networkId } } stages { __typename uuid stageType stageIndex label startTime endTime maxTotalMintableByWallet allowlistMemberCount price { token { unit symbol contractAddress chain { identifier } } } } } }`,
};

// Structured error codes OpenSea returns when a mint tx can't be built.
const OS_ERROR_MEANINGS: Record<string, string> = {
  InsufficientMintsRemainingError: "jatah mint habis (sudah mint maksimal)",
  DropNotMintingError: "stage belum buka",
  DropStageNotActiveError: "stage belum aktif",
  NotEligibleError: "wallet tidak eligible",
  InsufficientFundError: "saldo tidak cukup",
};

export function explainOpenseaError(msg: string): { code: string | null; meaning: string } {
  for (const [code, meaning] of Object.entries(OS_ERROR_MEANINGS)) {
    if (msg.includes(code)) return { code, meaning };
  }
  return { code: null, meaning: msg.replace(/^opensea drop:\s*/, "") };
}

// SeaDrop mint selectors → stage type
export const SELECTOR_STAGE: Record<string, string> = {
  "0x161ac21f": "PUBLIC_SALE",    // mintPublic
  "0x4b61cd6f": "SIGNED_PRESALE",  // mintSigned (GTD / allowlist w/ server signature)
  "0x4300a4e6": "MERKLE_PRESALE",  // mintAllowList (on-chain merkle)
};

// ── Price unit handling ──────────────────────────────────────────────────────
// OpenSea returns prices in TWO different units depending on the surface, and
// mixing them up is silent:
//
//   REST  /api/v2/drops/{slug}      price: "5600000000000000"   wei, decimal string
//   GQL   dropBySlug.stages.price   token.unit: 0.0056           ETH, float
//
// Verified live against collectr: GQL said 0.0056 ETH and the on-chain
// getPublicDrop returned 5600000000000000 wei for the same drop.
//
// The previous code did BigInt(String(price)) on whatever arrived. On a GQL
// float that THROWS ("Cannot convert 0.0056 to a BigInt"), and the throw was
// swallowed by an outer catch — so the entire GQL inventory silently returned
// empty and the primary path never worked for any fractional-ETH drop.

/** True when a value is already a whole-wei quantity (integer or int string). */
export function isWholeWei(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value);
  if (typeof value === "string") return /^-?\d+$/.test(value.trim());
  return false;
}

/**
 * Convert any OpenSea price representation to wei.
 *
 * ETH floats are scaled by 1e18; whole-wei values pass through. Anything
 * unparseable yields 0n rather than throwing — a price we cannot read should
 * degrade to "free", never take down the whole inventory fetch.
 */
export function parsePriceToWei(value: unknown): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    if (Number.isInteger(value)) return BigInt(value);
    // ETH float. Round to the nearest wei to avoid float drift.
    return BigInt(Math.round(value * 1e18));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return 0n;
    if (/^-?\d+$/.test(s)) return BigInt(s);          // wei decimal string
    if (/^-?\d*\.\d+$/.test(s)) {
      // ETH decimal string (e.g. "0.0056")
      const [whole, frac = ""] = s.replace("-", "").split(".");
      const neg = s.startsWith("-");
      const padded = (frac + "0".repeat(18)).slice(0, 18);
      const out = BigInt(whole || "0") * 1000000000000000000n + BigInt(padded || "0");
      return neg ? -out : out;
    }
    return 0n;
  }
  return 0n;
}

// ── Mint status semantics ────────────────────────────────────────────────────
// Documented for POST /api/v2/drops/{slug}/mint:
//   200  ready-to-sign transaction data
//   409  drop is NOT currently minting (not started / ended / paused), code NOT_MINTING
//   422  minting precondition failed (MINTER_NOT_ELIGIBLE, ...)
//
// The previous code treated 409 as ELIGIBLE — the exact inverse of the docs —
// so a drop that had not opened yet was reported as mintable.

/** True only when OpenSea actually returned a buildable transaction. */
export function isEligibleStatus(status: number): boolean {
  return status === 200;
}


// Issue a persisted GraphQL query (GET, like the frontend). On
// PERSISTED_QUERY_NOT_FOUND (OpenSea redeploys rotate hashes), re-register the
// query via APQ — POST the full query text once with its sha256, then retry
// hash-only. Returns parsed JSON; GraphQL errors stay in the payload.
export async function gqlPersistedQuery(
  operationName: string,
  hash: string,
  variables: Record<string, any>,
  cookie?: string | null,
  apiKey?: string | null,
  timeoutMs = 10000,
): Promise<any> {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    origin: "https://opensea.io",
    referer: "https://opensea.io/",
    "x-app-id": "os2-web",
  };
  if (apiKey && apiKey.trim()) baseHeaders["X-API-KEY"] = apiKey.trim();
  if (cookie) baseHeaders["cookie"] = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const ext = JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } });
  const url =
    `${OPENSEA_GQL_URL}?app_id=os2-web&operationName=${operationName}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(ext)}`;

  try {
    const r = await fetch(url, { headers: baseHeaders, signal: controller.signal });
    if (r.ok) {
      clearTimeout(timer);
      return await r.json();
    }

    // Hash may be retired (frontend redeploy). Fall back to APQ registration:
    // send the full query text with its sha256; the server registers it
    // and executes in the same call. Subsequent calls go back to hash-only GET.
    const body: any = await r.json().catch(() => ({}));
    const notFound = body?.errors?.some?.((e: any) => e?.extensions?.code === "PERSISTED_QUERY_NOT_FOUND");
    const text = GQL_QUERY_TEXTS[operationName];
    if (!notFound || !text) throw new Error(`opensea gql ${operationName} ${r.status}`);

    const { createHash } = await import("node:crypto");
    const computed = createHash("sha256").update(text).digest("hex");
    const pr = await fetch(OPENSEA_GQL_URL, {
      method: "POST",
      headers: { ...baseHeaders },
      body: JSON.stringify({
        operationName,
        query: text,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: computed } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!pr.ok) throw new Error(`opensea gql ${operationName} APQ ${pr.status}`);
    return await pr.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error("OpenSea GraphQL query timed out");
    throw err;
  }
}

// Run a query with our own text+hash via APQ directly (skip the pinned hash).
// Use when we need fields the frontend's pinned-hash version doesn't return.
export async function gqlApqQuery(
  operationName: string,
  variables: Record<string, any>,
  cookie?: string | null,
  apiKey?: string | null,
  timeoutMs = 10000,
): Promise<any> {
  const text = GQL_QUERY_TEXTS[operationName];
  if (!text) throw new Error(`no query text for ${operationName}`);

  const { createHash } = await import("node:crypto");
  const computed = createHash("sha256").update(text).digest("hex");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    origin: "https://opensea.io",
    referer: "https://opensea.io/",
    "x-app-id": "os2-web",
  };
  if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
  if (cookie) headers["cookie"] = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENSEA_GQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName,
        query: text,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: computed } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`opensea gql ${operationName} ${res.status}`);
    return await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`OpenSea GraphQL ${operationName} timed out`);
    throw err;
  }
}

// ── POST /drops/{slug}/mint + payload-bound-to-wallet check ───────────────────
//
// These were extracted from fcfs-mint.ts into this module to break a circular
// dependency: fcfs-drops.ts needs postMintTx + isPayloadBoundToWallet for
// eligibility checks, while fcfs-mint.ts re-exports DropPhase types from
// fcfs-drops.ts. By hosting both here (which has no upward deps), both sides
// can import from opensea-gql.ts without a cycle.

export interface PostMintTxResult {
  eligible: boolean;
  reason?: string;
  mintData?: string | null;
  mintSignature?: string | null;
  seaDropAddress?: string | null;
  feeRecipient?: string | null;
  value?: bigint | null;
  status?: number;      // HTTP status code for diagnostics
  code?: string | null; // stable machine-readable error code — branch on this
  stageUuid?: string | null;
  stageType?: string | null;
  stageStart?: number | null; // UNIX seconds
  stageEnd?: number | null;   // UNIX seconds
}

export async function postMintTx(
  slug: string,
  walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  timeoutMs = 15000,
  chainKey?: string,
  sessionCookie?: string | null,
): Promise<PostMintTxResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
    if (sessionCookie) headers["cookie"] = sessionCookie;

    // skip_balance_check: we fund wallets before firing, and an underfunded
    // wallet should still get a buildable payload (the tx then fails on
    // submission, which the receipt poll reports) rather than a 422 here.
    // Documented in DropMintRequest.
    const body = JSON.stringify({
      minter: walletAddress,
      quantity: quantity,
      skip_balance_check: true,
    });

    const res = await fetch(
      `https://api.opensea.io/api/v2/drops/${slug}/mint`,
      {
        method: "POST",
        signal: controller.signal,
        headers,
        body,
      },
    );
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new Error("OpenSea rejected the mint POST — API key or session required");
    }
    if (res.status === 404) {
      // Bug M fix: 404 can mean either "not a drop" OR "drop has ended".
      // Return structured result so caller can distinguish via recommendation.
      return {
        eligible: false,
        reason: `No drop found for slug "${slug}" — the collection may not be an OpenSea-managed drop, or the drop has ended.`,
        status: 404,
      };
    }
    if (res.status === 429) {
      throw new Error("OpenSea rate-limited the mint POST — retry in a few seconds");
    }

    const json = (await res.json()) as any;

    // The docs are explicit: "Error bodies ... carry a stable `code` alongside
    // `errors`. Branch on `code`, not on the message text." The previous code
    // string-matched the message, which breaks silently whenever OpenSea
    // rewords an error.
    const errObj = json?.errors?.[0] ?? json ?? null;
    const code: string | null = errObj?.code ?? json?.code ?? null;
    const message: string = errObj?.message || json?.message || res.statusText;

    // Documented: 200 = transaction data, 409 = NOT minting (NOT_MINTING),
    // 422 = precondition failed. Only 200 means we got a buildable mint.
    const isEligible = isEligibleStatus(res.status);
    let reason: string;

    if (res.status === 409) {
      reason = code
        ? `[${code}] ${message} — the drop is not minting right now (not started, ended, or paused)`
        : "the drop is not minting right now (not started, ended, or paused)";
    } else if (res.status === 422) {
      // Documented 422 codes: MINTER_NOT_ELIGIBLE, MINT_LIMIT_EXCEEDED,
      // SUPPLY_EXHAUSTED, INSUFFICIENT_BALANCE, NO_PAYOUT_ADDRESS.
      switch (code) {
        case "MINTER_NOT_ELIGIBLE":
          reason = `${message} — wallet is not on the active presale's allowlist`;
          break;
        case "MINT_LIMIT_EXCEEDED":
          reason = `${message} — over the wallet's limit for this stage; try reducing quantity`;
          break;
        case "SUPPLY_EXHAUSTED":
          reason = `${message} — supply exhausted; try a different wallet or stage`;
          break;
        case "INSUFFICIENT_BALANCE":
          reason = `${message} — wallet cannot pay the price and gas`;
          break;
        case "NO_PAYOUT_ADDRESS":
          reason = `${message} — paid stage on a drop with no creator payout address`;
          break;
        default:
          // Unknown code: fall back to the message, but surface the code so a
          // new one is visible in logs rather than silently mis-bucketed.
          reason = code ? `[${code}] ${message}` : (message || "not eligible");
      }
    } else {
      reason = code ? `[${code}] ${message}` : (message || res.statusText);
    }

    const responseChain = json?.chain || null;
    if (responseChain && chainKey && responseChain !== chainKey) {
      console.warn(`  ⚠ Chain mismatch: OpenSea returned "${responseChain}" but expected "${chainKey}"`);
    }
    const mintData = json?.data || null;
    const seaDropAddress = json?.to || null;
    const value = json?.value ? BigInt(String(json.value)) : null;

    // Documented DropMintResponse fields. stage_uuid names the stage the tx was
    // built for; a presale tx reverts if mined outside stage_start/end_time, so
    // the caller can and should verify these against the intended stage.
    const stageUuid = json?.stage_uuid ?? null;
    const stageType = json?.stage_type ?? null;
    const stageStartRaw = json?.stage_start_time ?? null;
    const stageEndRaw = json?.stage_end_time ?? null;
    const stageStart = stageStartRaw ? Math.floor(new Date(stageStartRaw).getTime() / 1000) : null;
    const stageEnd = stageEndRaw ? Math.floor(new Date(stageEndRaw).getTime() / 1000) : null;

    return {
      eligible: isEligible,
      reason: res.status === 422 ? reason || "not eligible" : undefined,
      mintData,
      mintSignature: json?.mint_signature || json?.mintSignature || null,
      seaDropAddress,
      feeRecipient: json?.fee_recipient || json?.feeRecipient || null,
      value,
      status: res.status, // HTTP status for diagnostics
      code,               // stable machine-readable error code (branch on this)
      stageUuid,
      stageType,
      stageStart,
      stageEnd,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error("OpenSea mint POST timed out");
    }
    throw err;
  }
}

/**
 * Check whether a signed payload's mintData is bound to a specific wallet address.
 *
 * OpenSea's v2 signed mint payload binds mintSignature to a specific recipient
 * wallet. The mintData calldata carries that address in the `minterIfNotPayer`
 * argument of mintSigned/mintAllowList. Decoding is delegated to
 * seadrop-calldata.ts, which uses ethers' own decoder rather than a hand-rolled
 * hex slice — the previous implementation read word 3 (quantity) instead of
 * word 2 (minter), so it never matched any real wallet.
 */
export function isPayloadBoundToWallet(payload: { mintData: string | null }, walletAddress: string): boolean {
  return isPayloadBoundToWalletImpl(payload, walletAddress);
}

// ── OpenSea Drop (OS2) via GraphQL MintActionTimelineQuery ────────────────────
// Mirrors repo (opensea-drop.js buildOpenseaMint): the mint transaction is
// generated server-side (relayer + requestId). We replay the same persisted
// GraphQL query the frontend uses. Returns { to, data, value, networkId,
// crossChain, requestId, selector, stageType, stageIndex } — ready to sign+send.
//
// The MintActionTimelineQuery returns a swap action whose
// transactionSubmissionData contains the signed mint calldata. The selector
// (first 4 bytes) reveals the SeaDrop stage type:
//   0x161ac21f → PUBLIC_SALE (mintPublic)
//   0x4b61cd6f → SIGNED_PRESALE (mintSigned, needs server signature)
//   0x4300a4e6 → MERKLE_PRESALE (mintAllowList, needs merkle proof)
//
// For presale stages, stageIndex is decoded from ABI word 8 (offset 4 + 8*32).

const NATIVE = "0x0000000000000000000000000000000000000000";

export interface OpenseaMintTx {
  to: string;
  data: string;
  value: bigint;
  networkId: string | null;
  crossChain: boolean;
  requestId: string | null;
  selector: string;
  stageType: string | null;
  stageIndex: number | null;
}

/** Build a mint transaction via OpenSea's GraphQL MintActionTimelineQuery. */
export async function buildOpenseaMint(args: {
  slug: string;
  minterAddress: string;
  contract: string;
  chain: string;
  tokenId?: string;
  quantity?: number;
  cookie?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}): Promise<OpenseaMintTx> {
  const { minterAddress, contract, chain, tokenId = "0", quantity = 1, cookie, apiKey, timeoutMs = 10000 } = args;
  const osc = osChain(chain);
  const variables = {
    address: minterAddress,
    capabilities: { eip7702: false },
    fromAssets: [{ asset: { chain: osc, contractAddress: NATIVE } }],
    toAssets: [{ asset: { chain: osc, contractAddress: contract, tokenId: String(tokenId) }, quantity: String(quantity) }],
  };
  // Try pinned hash first (fast GET), fall back to APQ on PERSISTED_QUERY_NOT_FOUND.
  const j = await gqlPersistedQuery("MintActionTimelineQuery", GQL_HASHES.mintTimeline, variables, cookie, apiKey, timeoutMs);
  const swap = j?.data?.swap;
  const actions = swap?.actions || [];
  const mintAction = actions.find((a: any) => a.__typename === "MintAction" && a.transactionSubmissionData);

  if (!mintAction) {
    // Surface the specific reason OpenSea gave (drop closed, ineligible, funds).
    const errs = (swap?.errors || []).map((e: any) => e.__typename).filter(Boolean);
    const gql = (j?.errors || []).map((e: any) => e.message).filter(Boolean);
    const reason = errs[0] || gql[0] || "no mint action returned";
    throw new Error(`opensea drop: ${reason}`);
  }

  const t = mintAction.transactionSubmissionData;
  const data = t.data || "0x";
  const selector = data.slice(0, 10).toLowerCase();
  const stageType = SELECTOR_STAGE[selector] || null;
  // Decode the stage index with ethers rather than a hand-rolled slice. The
  // previous offset (hex 522..586) landed inside the mintParams tuple and read
  // garbage; dropStageIndex is mintParams field 4, at hex char 576.
  const stageIndex = stageType === "PUBLIC_SALE" ? 0 : decodeStageIndexImpl(data);

  return {
    to: t.to,
    data,
    value: BigInt(t.value || 0),
    networkId: t.chain?.networkId ?? null,
    crossChain: !!mintAction.relayerFulfillment?.crossChain,
    requestId: mintAction.relayerFulfillment?.requestId || null,
    selector,
    stageType,
    stageIndex,
  };
}

/**
 * Documented REST eligibility check: GET /api/v2/drops/{slug}/eligibility.
 *
 * This is the API's own eligibility endpoint — it needs only the slug and a
 * wallet JWT, and returns per-stage is_eligible / stage_uuid / price. The code
 * previously re-derived all of this from GraphQL (which returns UNAUTHORIZED
 * for the eligibility fields without a JWT) and from POST /mint status codes.
 *
 * Returns null when the endpoint is unavailable (no session, 401/403/404) so
 * callers can fall back to the GQL path.
 */
export async function fetchRestEligibility(
  slug: string,
  cookie?: string | null,
  apiKey?: string | null,
  timeoutMs = 10000,
): Promise<{
  stages: {
    stageUuid: string | null;
    isEligible: boolean;
    price: bigint | null;
    maxTotalMintableByWallet: number | null;
  }[];
} | null> {
  if (!slug || !slug.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
    if (cookie) headers["cookie"] = cookie;

    const res = await fetch(
      `https://api.opensea.io/api/v2/drops/${slug.trim()}/eligibility`,
      { signal: controller.signal, headers },
    );
    if (res.status !== 200) return null;
    const json = (await res.json()) as any;
    const stages = json?.stages;
    if (!Array.isArray(stages)) return null;

    return {
      stages: stages.map((s: any) => ({
        stageUuid: s.stage_uuid ?? null,
        isEligible: Boolean(s.is_eligible),
        // Documented as a wei decimal string.
        price: s.price != null ? parsePriceToWei(s.price) : null,
        maxTotalMintableByWallet:
          s.max_total_mintable_by_wallet != null
            ? Number(s.max_total_mintable_by_wallet)
            : null,
      })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether a wallet can mint a drop RIGHT NOW by attempting to build the
 * mint tx via GraphQL. Returns { mintable:true, tx } or { mintable:false, code, reason, funds }.
 */
export async function probeOpenseaMint(args: {
  slug: string;
  minterAddress: string;
  contract: string;
  chain: string;
  cookie?: string | null;
  apiKey?: string | null;
}): Promise<{ mintable: boolean; tx?: OpenseaMintTx; code: string | null; reason: string; funds: boolean }> {
  try {
    const tx = await buildOpenseaMint(args);
    return { mintable: true, tx, code: null, reason: "", funds: false };
  } catch (e: any) {
    const { code, meaning } = explainOpenseaError(e.message);
    const funds = code === "InsufficientFundError";
    return { mintable: false, code, reason: meaning, funds };
  }
}

// ── Per-wallet stage eligibility via GraphQL ─────────────────────────────────
// Mirrors nft-minter-bot/opensea-drop.js getDropEligibility: uses the
// authenticated DropEligibilityQuery to get per-stage isEligible for a wallet.
// REQUIRES a session cookie — without it OpenSea returns isEligible: null.

export interface DropEligibilityStage {
  stageIndex: number;
  uuid: string | null;
  stageType: string | null;
  startTime: number | null;
  endTime: number | null;
  isEligible: boolean | null;
  eligibleMinterAddress: string | null;
  maxPerWallet: number | null;
  priceUnit: number | null;
  symbol: string;
  allowlistMemberCount: number | null;
}

export interface DropEligibilityResult {
  typename: string | null;
  stages: DropEligibilityStage[];
  authed: boolean;
  minted: number | null;
  walletCount: number | null;
  allowlistedWalletCount: number | null;
  otherEligibleByStage: Record<number, number> | null;
}

export async function getDropEligibility(
  slug: string,
  minterAddress: string,
  cookie?: string | null,
  apiKey?: string | null,
  timeoutMs = 15000,
): Promise<DropEligibilityResult | null> {
  const j = await gqlApqQuery(
    "DropEligibilityQuery",
    { address: minterAddress, collectionSlug: slug },
    cookie,
    apiKey,
    timeoutMs,
  );
  const drop = j?.data?.dropBySlug;
  if (!drop) return null;

  const stages: DropEligibilityStage[] = (drop.stages || []).map((s: any) => {
    const tok = s.eligiblePrice?.token;
    return {
      stageIndex: s.stageIndex,
      uuid: s.uuid || null,
      stageType: s.stageType || null,
      startTime: s.startTime ? Math.floor(new Date(s.startTime).getTime() / 1000) : null,
      endTime: s.endTime ? Math.floor(new Date(s.endTime).getTime() / 1000) : null,
      isEligible: s.isEligible,
      eligibleMinterAddress: s.eligibleMinterAddress || null,
      maxPerWallet: s.eligibleMaxTotalMintableByWallet ?? s.maxTotalMintableByWallet ?? null,
      priceUnit: tok?.unit ?? null,
      symbol: tok?.symbol || "ETH",
      allowlistMemberCount: s.allowlistMemberCount ?? null,
    };
  });

  const ase = drop.accountStageEligibility || null;
  const authed = stages.some((s) => s.isEligible !== null);
  let otherEligibleByStage: Record<number, number> | null = null;
  if (ase?.wallets?.length) {
    const byUuid = new Map(stages.filter((s) => s.uuid).map((s) => [s.uuid as string, s.stageIndex]));
    otherEligibleByStage = {};
    for (const wl of ase.wallets) {
      if (!wl.address || wl.address.toLowerCase() === minterAddress.toLowerCase()) continue;
      for (const st of wl.stages || []) {
        if (!st.isEligible) continue;
        const idx = byUuid.get(st.dropStageUuid);
        if (idx == null) continue;
        otherEligibleByStage[idx] = (otherEligibleByStage[idx] || 0) + 1;
      }
    }
  }

  return {
    typename: drop.__typename || null,
    stages,
    authed,
    minted: drop.minterQuantityMinted ?? null,
    walletCount: ase?.walletCount ?? null,
    allowlistedWalletCount: ase?.allowlistedWalletCount ?? null,
    otherEligibleByStage,
  };
}
