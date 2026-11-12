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

// Only ONE pinned hash is ever used — MintActionTimelineQuery. The four that
// used to live here (mintModule, dropEligibility, mintQuery, collectionDrops)
// were referenced by nothing; they were deleted rather than left to rot.
// This value is exactly sha256 of our own MintActionTimelineQuery text, not a
// frontend secret, so a server-side rotation can only retire it — and the APQ
// fallback below re-registers and executes in the same call.
export const GQL_HASHES = {
  mintTimeline: process.env.OS_HASH_MINT_TIMELINE || "1a786dd183540c6143038435ebb7d48c6e2007150210585e45137c8e1d779801",
};

// A hash that a successful APQ registration proved to work. Without this the
// recovered hash was discarded and every later call in the run retried the dead
// pinned hash first, paying the APQ penalty again for the rest of the run.
// In-process only: a persisted hash would outlive the query text it was
// computed from, and the text is the source of truth.
const recoveredHashes = new Map<string, string>();

// GraphQL query texts for APQ registration when pinned hashes are retired.
// These match the exact queries the OpenSea frontend uses, so the server
// has them pre-registered — but APQ is our fallback if the hash changes.
export const GQL_QUERY_TEXTS: Record<string, string> = {
  MintActionTimelineQuery: `query MintActionTimelineQuery($address: Address! $fromAssets: [AssetQuantityInput!]! $toAssets: [AssetQuantityInput!]! $recipient: Address) { swap(address: $address fromAssets: $fromAssets toAssets: $toAssets recipient: $recipient action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } } }`,
  MintModuleQuery: `query MintModuleQuery($collectionSlug: String!) { dropBySlug(slug: $collectionSlug) { __typename stages { __typename stageType stageIndex startTime endTime maxTotalMintableByWallet allowlistMemberCount price { token { unit symbol contractAddress chain { identifier } } } label } } }`,
  DropEligibilityQuery: `query DropEligibilityQuery($collectionSlug: String!, $address: Address!) { dropBySlug(slug: $collectionSlug) { __typename ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) } accountStageEligibility { walletCount allowlistedWalletCount wallets { address quantityMinted stages { dropStageUuid isEligible maxTotalMintableByWallet } } } stages { uuid stageType stageIndex startTime endTime isEligible eligibleMinterAddress maxTotalMintableByWallet allowlistMemberCount eligibleMaxTotalMintableByWallet eligiblePrice { token { unit symbol } } } } }`,
  // Verified against the live schema (collectr, 2026-11-05; re-checked
  // 2026-11-08). collectionBySlug DOES answer collection metadata
  // (`... on Collection { slug address chain { identifier networkId } }`) — that
  // is what slug-resolver.ts uses — but it does not expose drop stages, and the
  // older `CollectionDropStage` inline fragment does not exist. dropBySlug is the
  // working root for stages; see the CollectionDropsQuery entry in this map
  // for the field-by-field verification.
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
  InsufficientMintsRemainingError: "mint supply exhausted (already at the per-wallet max)",
  DropNotMintingError: "stage is not open yet",
  DropStageNotActiveError: "stage is not active",
  NotEligibleError: "wallet is not eligible",
  InsufficientFundError: "insufficient balance",
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
 * Convert a GQL `token.unit` price to wei.
 *
 * The GQL surface is ETH by contract — a float, or a JSON integer when the
 * amount is a whole number (0.0056 arrives as 0.0056, but 1 ETH arrives as 1).
 * `parsePriceToWei` cannot tell the surfaces apart and treats an integer as
 * wei, so a 1 ETH drop read as 1 wei and the price-protection floor was
 * satisfied trivially. This function is explicit: everything from GQL is ETH.
 * The REST `price` field is wei and must go through `parsePriceToWei`.
 */
export function parseGqlPriceToWei(value: unknown): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.round(value * 1e18));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return 0n;
    if (/^-?\d+$/.test(s)) return BigInt(s) * 1000000000000000000n;
    if (/^-?\d*\.\d+$/.test(s)) return parsePriceToWei(s);
    return 0n;
  }
  return 0n;
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

/**
 * Read a price field that may be a bare scalar (wei string, ETH float) or a
 * nested { token: { unit } } object — OpenSea's REST and GraphQL surfaces
 * return both. A nested object handed straight to parsePriceToWei yields 0n,
 * which silently turns a paid mint into a free one.
 */
export function parsePriceField(value: unknown): bigint {
  if (value != null && typeof value === "object") {
    const v = value as Record<string, any>;
    return parsePriceToWei(v.token?.unit ?? v.unit ?? v.value ?? 0);
  }
  return parsePriceToWei(value);
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

/**
 * Normalize any OpenSea timestamp to UNIX seconds.
 *
 * GraphQL returns ISO-8601 strings; other surfaces return UNIX seconds as a
 * number or numeric string. `new Date(1786000000)` reads a seconds value as
 * MILLISECONDS and lands in 1970 — a silent wrong answer, not a throw.
 * Returns null when the value is absent or unparseable.
 */
export function toUnixSecondsSafe(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);            // UNIX seconds
  const parsed = Date.parse(s);                      // ISO-8601
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}


// Issue a persisted GraphQL query (GET, like the frontend). On
// PERSISTED_QUERY_NOT_FOUND (OpenSea redeploys rotate hashes), re-register the
// query via APQ — POST the full query text once with its sha256, then retry
// hash-only. Returns parsed JSON; GraphQL errors stay in the payload.
/**
 * OpenSea's wallet-scoped endpoints authenticate with
 * `Authorization: Bearer <wallet JWT>` — the docs are explicit that
 * "Wallet-specific REST requests need both the API key and wallet JWT", and that
 * the SIWE session cookies are only for managing personal access tokens.
 *
 * The session is stored here as an `access_token=…` cookie, so derive the token
 * back out and send BOTH headers. Sending only the cookie left every
 * eligibility lookup unauthenticated: OpenSea could not see which wallet was
 * asking, so a wallet allowlisted for presale stages read as not eligible.
 */
export function bearerFromSessionCookie(cookie?: string | null): string | null {
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)access_token=([^;]*)/);
  const token = m?.[1]?.trim();
  return token ? token : null;
}

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
  const bearer = bearerFromSessionCookie(cookie);
  if (bearer) baseHeaders["authorization"] = `Bearer ${bearer}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const effectiveHash = recoveredHashes.get(operationName) ?? hash;
  const ext = JSON.stringify({ persistedQuery: { sha256Hash: effectiveHash, version: 1 } });
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
    const parsed = (await pr.json()) as any;
    if (parsed?.errors?.length) throw new Error(`opensea gql ${operationName} APQ returned errors`);
    recoveredHashes.set(operationName, computed);
    return parsed;
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
  const bearer = bearerFromSessionCookie(cookie);
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;

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
    // `value` may be a wei string, an ETH float, or a nested { token: { unit } }
    // object. BigInt(String(...)) throws on the object form and on a float,
    // taking down the whole mint POST.
    const value = json?.value ? parsePriceField(json.value) : null;

    // Documented DropMintResponse fields. stage_uuid names the stage the tx was
    // built for; a presale tx reverts if mined outside stage_start/end_time, so
    // the caller can and should verify these against the intended stage.
    const stageUuid = json?.stage_uuid ?? null;
    const stageType = json?.stage_type ?? null;
    const stageStart = toUnixSecondsSafe(json?.stage_start_time);
    const stageEnd = toUnixSecondsSafe(json?.stage_end_time);

    return {
      eligible: isEligible,
      // Surface the explanation for EVERY non-success. The previous
      // `res.status === 422 ? ... : undefined` computed the 409 reason and then
      // threw it away, leaving the caller only a numeric status.
      reason: isEligible ? undefined : reason || "not eligible",
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
// The mint transaction is
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
  // previous offset (hex 576..640) read the wrong word inside the mintParams
  // tuple; dropStageIndex is mintParams field 4, at word 8 / hex char 522.
  const stageIndex = stageType === "PUBLIC_SALE" ? 0 : decodeStageIndexImpl(data);

  return {
    to: t.to,
    data,
    // MintActionTimeline values have appeared as wei strings and as ETH floats;
    // a raw BigInt throws on a float and takes down the whole payload fetch.
    value: parsePriceToWei(t.value),
    networkId: t.chain?.networkId ?? null,
    crossChain: !!mintAction.relayerFulfillment?.crossChain,
    requestId: mintAction.relayerFulfillment?.requestId || null,
    selector,
    stageType,
    stageIndex,
  };
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
// Uses the
// authenticated DropEligibilityQuery to get per-stage isEligible for a wallet.
// REQUIRES an authenticated session — without one OpenSea returns
// isEligible: null. The token goes out as a Bearer header (see
// bearerFromSessionCookie); the cookie is also sent for compatibility.

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
  /**
   * The queried wallet's RUNNING cap per stage uuid, from
   * accountStageEligibility.wallets[].stages[].maxTotalMintableByWallet.
   *
   * This is the number the docs describe: "the limits of every stage up to and
   * including this one that the wallet is listed on, added together, clamped to
   * supply", with the public stage's own limit added only on the public stage's
   * result. `stages[].maxPerWallet` is the STAGE's own cap and is NOT this —
   * for a wallet that is not listed they differ by the whole stage limit.
   *
   * null  = the account block was not returned (unauthorized / not queried).
   * Map   = the wallet's own entries. A uuid ABSENT from the map means the
   *         wallet is not listed on that stage; a present entry with null means
   *         OpenSea reported no cap for it.
   */
  walletRunningCapByUuid: Map<string, number | null> | null;
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
      startTime: toUnixSecondsSafe(s.startTime),
      endTime: toUnixSecondsSafe(s.endTime),
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
  // The queried wallet's own running cap per stage. Built from the same block as
  // otherEligibleByStage, but keyed by dropStageUuid and kept per wallet: the
  // docs define this field as the wallet's running cap, which is what SeaDrop
  // actually enforces against the lifetime minted count.
  let walletRunningCapByUuid: Map<string, number | null> | null = null;
  if (ase?.wallets?.length) {
    const byUuid = new Map(stages.filter((s) => s.uuid).map((s) => [s.uuid as string, s.stageIndex]));
    otherEligibleByStage = {};
    for (const wl of ase.wallets) {
      if (!wl.address) continue;
      if (wl.address.toLowerCase() === minterAddress.toLowerCase()) {
        if (walletRunningCapByUuid == null) {
          walletRunningCapByUuid = new Map();
          for (const st of wl.stages || []) {
            if (st.dropStageUuid == null) continue;
            const raw = st.maxTotalMintableByWallet;
            walletRunningCapByUuid.set(
              st.dropStageUuid,
              raw == null || raw === "" ? null : parseInt(raw, 10)
            );
          }
        }
        continue;
      }
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
    walletRunningCapByUuid,
  };
}
