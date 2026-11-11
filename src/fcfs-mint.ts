// ── Signed-mint / allowlist snipe — pre-fetch ahead of T-0 ─────────────────
//
// SeaDrop has two mint modes, and they have different data requirements:
//
//   PUBLIC  (mintPublic)          — everything is on-chain. Encode the calldata
//                                   locally, sign, hold, fire at T-0. Zero API calls.
//                                   See seadrop-public.ts for the full public path.
//
//   SIGNED  (mintSigned)          — requires OpenSea to produce a per-wallet
//                                   signature (mintSignature). The mint params are
//                                   partially on-chain (mintPrice, startTime, etc.)
//                                   but the signature must come from the API.
//
//   ALLOWLIST/OVR (mintAllowlist) — the merkle root is on-chain (getAllowListMerkleRoot),
//                                   fee recipients are on-chain (getAllowedFeeRecipients),
//                                   but the actual allowlist tree + your merkle proof live
//                                   off-chain with OpenSea. You need their data to build
//                                   the mint calldata, then sign locally.
//
// The old "FCFS" naming was wrong — these functions handle signed/allowlist phases,
// NOT public FCFS. Renamed here to match what they actually do.
//
// ARCHITECTURE GOAL: move all API calls OUT of the critical path.
//   1. On-chain discovery tells us WHAT phases exist (public / signed / allowlist /
//      token-gated) and their basic params (mintPrice, startTime, feeBps, ...).
//   2. For signed/allowlist phases, PRE-FETCH the missing pieces (signatures,
//      allowlist proofs) WHILE THE DROP IS STILL FUTURE, cache them.
//   3. At T-0, broadcast the pre-built transaction. Fire time = propagation latency.
//
// This is the same speed as public mint for signed phases too — the only difference
// is that you need to have done the API round-trip BEFORE the window opens.

import path from "path";
import chalk from "chalk";
import { Wallet, Interface, JsonRpcProvider } from "ethers";
import { parseRpcEndpoints, prepareBlast, blastToAll, waitForReceipt, type PreparedBlast } from "./rpc-blast";
import { resolveChain } from "./chains";
import { fetchOnChainDrops } from "./seadrop-onchain";
import type { DropPhase } from "./fcfs-drops";
import { normalizeStageType } from "./fcfs-drops";
import { isPayloadBoundToWallet, SIGNED_SELECTOR, MERKLE_SELECTOR } from "./seadrop-calldata";
export { isPayloadBoundToWallet } from "./seadrop-calldata";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { ConfirmedTx } from "./rpc-health";
import { buildOpenseaMint, OpenseaMintTx, parsePriceField, parsePriceToWei } from "./opensea-gql";
import { simulateTx, classifyRevert, type SimulateResult } from "./simulate";
import { autoGasBounded } from "./auto-gas";
import { withDeadlineOrThrow } from "./deadline";
import { assertPriceProtection } from "./price-protection";
import { reconcileQuantity } from "./mint-cap";
import { warmConnections, pingRpcs, rankRpcEndpoints, settleRanking, type RankedEndpoint } from "./connection-warmer";

/** How many of the fastest endpoints to fire at before escalating to the rest. */
const BLAST_FIRST_WAVE = 2;

// Fallback gas limit for signed / allowlist stages when neither OpenSea nor a
// live estimate provides one. Higher than the public-mint floor because these
// transactions carry a mintParams struct and (for allowlist stages) a merkle
// proof whose length varies with the tree.
const SIGNED_GAS_FLOOR = 400_000;

// ── OpenSea v2 shapes (read from the live response, not hardcoded magic) ──

export interface SeaDropDropMeta {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface FcfsGasData {
  gasLimit: number;
  maxFeePerGas: bigint;       // wei
  maxPriorityFeePerGas: bigint; // wei
}

export interface FcfsSignedPayload {
  seaDropAddress: string;   // who we send the mint tx to (usually the SeaDrop singleton)
  nftContract: string;      // the token contract
  feeRecipient: string;     // SeaDrop fee recipient for this drop
  mintData: string;         // hex calldata for mintSigned(nftContract, feeRecipient, ...)
  mintSignature: string;    // OpenSea's server signature bound to this wallet (per-wallet!)
  value: bigint;            // mintPrice × quantity
  drop: SeaDropDropMeta;
  gasData?: FcfsGasData;   // optional — OpenSea sometimes recommends gas fields
}

export interface FcfsMintPlan {
  payload: FcfsSignedPayload;
  quantity: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// ── Multi-drop inventory (re-exports from fcfs-drops) ─────────────────────────

export { DropPhase, GasState, CollectionDropsInventory, EligibilityReport, GasRecommendation } from "./fcfs-drops";
export {
  fetchAllActiveDrops,
  reportInventoryEligibility,
  assessDropEligibility,
  printDropsInventory,
  fetchGasState,
  printGasState,
  recommendGasSettings,
  printGasRecommendation,
  gasChoiceAssessment,
} from "./fcfs-drops";

// ── OpenSea session — refreshable OAuth token, stored on disk ───────────────

const SESSION_DIR = (() => {
  const explicit = process.env.OPENSEA_SESSION_DIR?.trim();
  if (explicit) return explicit;
  // Everything the minter stores lives inside the project, never in the user's
  // home directory. PACKAGE_ROOT is the directory holding package.json (dist/..
  // once compiled), so the cache follows the install rather than the machine —
  // and clearing ~/.nft-public-mint cannot invalidate a working setup.
  const d = path.join(path.resolve(__dirname, ".."), ".minter-session");
  try { require("fs").mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {}
  return d;
})();

const SESSION_FILE = `${SESSION_DIR}/opensea_session.json`;

// A session cached by an older build under the user's home directory. Read once,
// on first load, so an existing login survives the move. Never written to.
const LEGACY_SESSION_FILE = (() => {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".nft-public-mint", "opensea_session.json") : "";
})();

let legacySessionMigrated = false;

function migrateLegacySession(): void {
  if (legacySessionMigrated || !LEGACY_SESSION_FILE) return;
  legacySessionMigrated = true;
  try {
    const fs = require("fs");
    if (fs.existsSync(SESSION_FILE) || !fs.existsSync(LEGACY_SESSION_FILE)) return;
    fs.copyFileSync(LEGACY_SESSION_FILE, SESSION_FILE);
    console.log(chalk.gray(`  OpenSea: migrated the cached session from ${LEGACY_SESSION_FILE}`));
  } catch {}
}

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // UNIX ms
  scope?: string;
}

export async function loadStoredSession(): Promise<StoredSession | null> {
  migrateLegacySession();
  try {
    const raw = require("fs").readFileSync(SESSION_FILE, "utf-8");
    const s = JSON.parse(raw) as StoredSession;
    if (Date.now() >= s.expiresAt) return null; // expired — caller renews
    return s;
  } catch {
    return null;
  }
}

export async function saveStoredSession(s: StoredSession): Promise<void> {
  // Contains a bearer token — owner-only.
  require("fs").writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function clearStoredSession(): Promise<void> {
  try { require("fs").unlinkSync(SESSION_FILE); } catch {}
}

/** Convert a StoredSession to a cookie header string for GraphQL/OpenSea API calls.
 *  The OpenSea GraphQL endpoint uses the access_token cookie for authentication
 *  (equivalent to the Bearer token in the REST path). */
export function sessionToStoredSessionCookie(session: StoredSession): string {
  return `access_token=${session.accessToken}`;
}

// ── Path A: API-key-only signed payload fetch (try first) ──────────────────
// Best for signed-mint / allowlist phases where OpenSea's GraphQL endpoint can
// produce a per-wallet signed mint transaction without a full SIWE session.
//
// PRIMARY PATH: GraphQL MintActionTimelineQuery (via buildOpenseaMint) — the
// GraphQL query binds the mint tx
// to a specific wallet address server-side and returns { to, data, value } ready
// to sign+send. REST /api/v2/drops/{slug} is a fallback when GraphQL fails.
//
// Returns null when no signed payload is available for this wallet/collection.

export async function fetchSignedPayload(
  nftContract: string,
  quantity: number,
  apiKey?: string | null,
  opts: { timeoutMs?: number; walletAddress?: string; slug?: string; chainKey?: string } = {},
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const { slug, walletAddress, chainKey } = opts;

  // ── Primary: GraphQL MintActionTimelineQuery ────────────────────────────
  // Requires a slug (for dropBySlug) and optionally a chainKey.
  // Always use the slug — REST /api/v2/drops/{CA} returns 404
  // for raw contract addresses, which is why the old auto-mint path was broken.
  if (slug && slug.trim() && walletAddress) {
    try {
      const gqlResult = await buildOpenseaMint({
        slug: slug.trim(),
        minterAddress: walletAddress,
        contract: nftContract,
        chain: chainKey || "ethereum",
        quantity,
        apiKey: apiKey || null,
        timeoutMs,
      });
      const payload = openseaMintTxToSignedPayload(gqlResult, nftContract, quantity);
      if (payload) return payload;
    } catch (err: any) {
      // GraphQL errors (e.g. NotEligibleError, DropNotMintingError) are expected
      // for wallets not on the allowlist. Don't log these — they're normal.
      if (!err?.message?.includes("opensea drop:")) {
        // Unexpected error — log and fall through to REST
        console.warn(`    ⚠ GraphQL signed payload fetch error: ${err.message}`);
      }
    }
  }

  // ── Fallback: REST /api/v2/drops/{slug}/mint ─────────────────────────────
  // Only reached if no slug, no walletAddress, or GraphQL failed.
  // This POST endpoint returns per-wallet signed data when the slug is known.
  if (slug && walletAddress) {
    const restPayload = await postMintTxFallback(slug, walletAddress, quantity, apiKey, timeoutMs, chainKey || "ethereum", nftContract);
    if (restPayload) return restPayload;
  }

  // ── Fallback: on-chain SEADROP discovery ──────────────────────────────────
  // Only returns data for public stages (no signature needed). Signed/allowlist
  // phases cannot be obtained from on-chain — they require OpenSea's server.
  if (!slug || !walletAddress) {
    const onChainDrops = await fetchOnChainDrops(nftContract, timeoutMs, chainKey);
    if (onChainDrops.length > 0) {
      return extractActiveDropFromOnChain(onChainDrops, nftContract, quantity, apiKey);
    }
  }

  return null;
}

/** Convert an OpenseaMintTx (from GraphQL MintActionTimelineQuery) into a
 *  FcfsSignedPayload that the rest of the sniper pipeline expects.
 *
 *  The GraphQL mint tx already contains the server-signed calldata (data field),
 *  so mintData = the full calldata and mintSignature is embedded in it.
 *  We set a dummy mintSignature since the signature is baked into the calldata.
 */
function openseaMintTxToSignedPayload(
  tx: OpenseaMintTx,
  nftContract: string,
  quantity: number,
): FcfsSignedPayload | null {
  if (!tx.data || tx.data === "0x" || tx.data.length < 10) return null;

  // The selector tells us the stage type (PUBLIC_SALE, SIGNED_PRESALE, MERKLE_PRESALE)
  // For SIGNED_PRESALE and MERKLE_PRESALE, the signature is embedded in the calldata.
  // For PUBLIC_SALE, no signature is needed.
  // Named constants, not literal hex — seadrop-calldata.ts owns these values and
  // hardcoding them here was a second source of truth for the same selectors.
  const isSigned = tx.selector === SIGNED_SELECTOR || tx.selector === MERKLE_SELECTOR;

  // `value` is the TOTAL transaction value (mintPrice × quantity) — the spec
  // describes it as "Native currency to send with the transaction", and
  // postMintTxFallback divides it by quantity for the same reason. Reporting it
  // as the per-unit mintPrice overstated the price by `quantity ×` on every
  // multi-token mint, and made the wizard print `total × quantity = total`.
  const totalValue = tx.value;
  const mintPrice = quantity > 0 ? totalValue / BigInt(quantity) : totalValue;

  return {
    seaDropAddress: tx.to,
    nftContract,
    feeRecipient: "0x0000000000000000000000000000000000000000", // fee recipient is in calldata for seaDrop
    mintData: tx.data,
    mintSignature: isSigned ? "0x0000000000000000000000000000000000000000000000000000000000000000" : "0x", // embedded in calldata
    value: totalValue,
    drop: {
      mintPrice,
      // The MintActionTimeline response carries no stage window or per-wallet
      // cap, so these stay 0 (= unknown). Callers that have the inventory should
      // overlay it; 0 must never be read as 1970 or "unlimited".
      startTime: 0,
      endTime: 0,
      maxTotalMintableByWallet: 0,
      feeBps: 0,
      restrictFeeRecipients: false,
    },
    gasData: undefined,
  };
}

/** ISO-8601 → UNIX seconds. The mint response's stage times are ISO strings;
 *  0 means "unknown", never 1970. */
function isoToUnixSeconds(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/**
 * Turn a POST /api/v2/drops/{slug}/mint body into a FcfsSignedPayload.
 *
 * The documented DropMintResponse is
 *   { chain, data, to, value, stage_start_time, stage_end_time, stage_type, stage_uuid }
 * — there is no mint_signature and no fee recipient. The per-wallet signature is
 * inside `data`, and the fee recipient is inside the calldata, so both fields are
 * informational here.
 */
export function mintResponseToPayload(
  json: any,
  nftContract: string,
  quantity: number,
): FcfsSignedPayload | null {
  const mintData = json?.data || json?.mintData || null;
  if (!mintData) return null;
  const mintSignature = json?.mint_signature || json?.mintSignature || null;
  const seaDropAddress = json?.to || json?.seaDropAddress || json?.contract || SEADROP_ADDRESS;
  const value = json?.value != null ? parsePriceField(json.value) : 0n;
  // The collection contract is NOT the SeaDrop singleton. Reporting the
  // seadrop address here made every downstream "which NFT did I mint" check
  // compare against the wrong address.
  const collection = nftContract || json?.nftContract || json?.contract_address || "";
  return {
    seaDropAddress,
    nftContract: collection,
    feeRecipient: json?.fee_recipient || json?.feeRecipient || "0x0000000000000000000000000000000000000000",
    mintData,
    mintSignature: mintSignature || "0x",
    value,
    drop: {
      // `value` is the TOTAL tx value; the unit price is what a per-wallet cap
      // and a price check are expressed against.
      mintPrice: quantity > 0 ? value / BigInt(quantity) : value,
      // The docs are explicit that a presale tx "carries this stage's start and
      // end times in its signed parameters and reverts if mined outside them",
      // so dropping these (the previous behaviour) threw away the only window
      // the payload itself can prove.
      startTime: isoToUnixSeconds(json?.stage_start_time ?? json?.stageStartTime),
      endTime: isoToUnixSeconds(json?.stage_end_time ?? json?.stageEndTime),
      // Not present in DropMintResponse. 0 = unknown, NOT the requested
      // quantity — the old fallback invented a cap that overstated the
      // allowance whenever the real one was lower.
      maxTotalMintableByWallet: Number(
        json?.maxTotalMintableByWallet ?? json?.max_total_mintable_by_wallet ?? 0
      ),
      feeBps: 0,
      restrictFeeRecipients: false,
    },
    gasData: undefined,
  };
}

/** Fallback: REST /api/v2/drops/{slug}/mint — returns FcfsSignedPayload or null.
 *
 *  `accessToken` (the wallet JWT) is required for presale stages: the endpoint
 *  builds a per-wallet transaction, and OpenSea answers 401/422 without it.
 */
export async function postMintTxFallback(
  slug: string,
  walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  timeoutMs = 15000,
  _chainKey = "ethereum",
  nftContract = "",
  accessToken?: string | null,
): Promise<FcfsSignedPayload | null> {
  const r = await postMintRequest(slug, walletAddress, quantity, apiKey, timeoutMs, accessToken);
  // 409 is NOT_MINTING per the docs — it is a refusal, not a payload. Treating
  // it as success here inverted the status classification.
  if (!r || r.status !== 200) return null;
  return mintResponseToPayload(r.json, nftContract, quantity);
}

/**
 * POST /api/v2/drops/{slug}/mint and return the raw status + body.
 *
 * Shared by postMintTxFallback and the session path so the latter can tell a
 * 401 (token expired — worth one refresh) apart from a 404/409 (retrying with
 * a new token cannot help).
 */
async function postMintRequest(
  slug: string,
  walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  timeoutMs = 15000,
  accessToken?: string | null,
): Promise<{ status: number; json: any } | null> {
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `https://api.opensea.io/api/v2/drops/${slug}/mint`,
        {
          method: "POST",
          signal: controller.signal,
          headers,
          // skip_balance_check lets OpenSea build the payload for a wallet we will
          // fund before submitting, instead of rejecting it with 422 here.
          body: JSON.stringify({ minter: walletAddress, quantity, skip_balance_check: true }),
        },
      );
      return { status: res.status, json: await res.json().catch(() => null) };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// ── Path B: signed payload fetch with a live OAuth session token ───────────
// Needed when the GraphQL MintActionTimelineQuery requires a live session
// (access token) for signed/allowlist phases. Falls back to refreshing the
// token if it expired mid-run.
//
// PRIMARY PATH: GraphQL buildOpenseaMint with cookie (sessionToCookieHeader).

export async function fetchSignedPayloadWithSession(
  nftContract: string,
  quantity: number,
  session: StoredSession,
  apiKey?: string | null,
  opts: { timeoutMs?: number; refreshed?: boolean; walletAddress?: string; slug?: string; chainKey?: string } = {},
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const { slug, walletAddress, chainKey } = opts;

  // Build cookie header from the StoredSession's accessToken
  const cookie = sessionToStoredSessionCookie(session);

  // ── Primary: GraphQL MintActionTimelineQuery with session cookie ────────
  if (slug && slug.trim() && walletAddress) {
    try {
      const gqlResult = await buildOpenseaMint({
        slug: slug.trim(),
        minterAddress: walletAddress,
        contract: nftContract,
        chain: chainKey || "ethereum",
        quantity,
        cookie,
        apiKey: apiKey || null,
        timeoutMs,
      });
      const payload = openseaMintTxToSignedPayload(gqlResult, nftContract, quantity);
      if (payload) return payload;
    } catch (err: any) {
      if (err && err.name === "AbortError") throw new Error("OpenSea GraphQL signed-payload fetch timed out");
      // Expected for ineligible wallets — fall through to REST
    }
  }

  // ── Fallback: REST POST /api/v2/drops/{slug}/mint with session auth ───────
  // GET /api/v2/drops/{slug} returns DropDetailedResponse — stage metadata with
  // NO mintData (the documented DropStageResponse has no such field), so the
  // previous implementation could never produce a payload here. The signed
  // per-wallet calldata comes from the mint endpoint.
  //
  // The documented path parameter is a collection SLUG. Passing a contract
  // address here is not supported — it returns 404 and the caller mistakes it
  // for "no drop".
  if (!slug || !slug.trim() || !walletAddress) return null;

  const r = await postMintRequest(
    slug.trim(), walletAddress, quantity, apiKey, timeoutMs, session.accessToken,
  );

  if (r && r.status === 200) {
    const payload = mintResponseToPayload(r.json, nftContract, quantity);
    if (payload) return payload;
  }

  // Token expired mid-run — try exactly one refresh. A 404/409 is a verdict, not
  // an auth failure, so retrying it with a new token cannot help.
  if (r && r.status === 401 && !opts.refreshed) {
    const renewed = session.refreshToken
      ? await refreshSessionToken(session.refreshToken, apiKey)
      : null;
    if (renewed) {
      return fetchSignedPayloadWithSession(nftContract, quantity, renewed, apiKey, { ...opts, refreshed: true });
    }
  }
  if (r && r.status === 429) {
    throw new Error("OpenSea rate-limited the signed-payload lookup — retry in a few seconds.");
  }
  return null;
}

// ── Shared: turn whatever v2 returns into a FcfsSignedPayload ────────────
//
// The exact field names here are whatever OpenSea v2 actually hands back for
// an FCFS/allowlist stage's signed mint payload. Adapt to the live response.
//
// NOTE: mintData is per-wallet for mintSigned — the OpenSea API binds the
// signature to a specific wallet address. For multi-wallet sniping, each wallet
// MUST get its own payload. See fetchSignedPayloadForWallet.

export async function buildSignedPayloadFromDrop(
  drop: any,
  nftContract: string,
  quantity: number,
  _apiKey?: string | null,
): Promise<FcfsSignedPayload | null> {
  const seaDropAddress = drop.seaDropAddress || drop.seadrop_address || "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const feeRecipient = drop.feeRecipient || drop.fee_recipient;
  const mintData = drop.mintData || drop.mint_data || drop.calldata;
  const mintSignature = drop.mintSignature || drop.mint_signature || drop.signature;
  const mintPrice = parsePriceField(drop.mintPrice ?? drop.mint_price ?? drop.price ?? "0");
  const startTime = Number(drop.startTime || drop.start_time || drop.start || 0);
  const endTime = Number(drop.endTime || drop.end_time || drop.end || 0);
  const maxTotal = Number(drop.maxTotalMintableByWallet || drop.max_total_mintable_by_wallet || drop.maxPerWallet || 0);
  const feeBps = Number(drop.feeBps || drop.fee_bps || 0);
  const restrict = Boolean(drop.restrictFeeRecipients || drop.restrict_fee_recipients || false);

  // The signature is embedded in the calldata for mintSigned/mintAllowList
  // (the documented DropMintResponse has no mint_signature field at all), so
  // mintData alone is the fireability test. Requiring mintSignature here made
  // this function unreachable for every OpenSea-sourced payload.
  if (!mintData) return null;

  const value = mintPrice * BigInt(quantity);
  let gasData = buildGasDataFromDrop(drop);
  if (!gasData) {
    // OpenSea did not return any gas recommendation (no gasLimit, no maxFeePerGas).
    //
    // 400k, not 250k. A signed mint (mintSigned) or merkle allowlist mint
    // (mintAllowList) carries a mintParams struct and, for allowlist stages, a
    // merkle proof whose length varies with the tree — both cost materially more
    // than a plain publicMint. 250k is a comfortable floor for public mints and
    // a genuine under-estimate for proof-bearing stages, which then revert on
    // out-of-gas at T-0 with no way to recover.
    //
    // The T-0 path still runs autoGasBounded for a real estimate; this is only
    // the fallback when that estimate cannot be obtained.
    console.log(chalk.yellow(`    ⚠ No gas recommendation from OpenSea — using default 400,000 gas limit.`));
    gasData = { gasLimit: SIGNED_GAS_FLOOR, maxFeePerGas: BigInt(0), maxPriorityFeePerGas: BigInt(0) };
  } else if (gasData.gasLimit === SIGNED_GAS_FLOOR && !drop.gasLimit && !drop.gas_limit) {
    // OpenSea returned maxFeePerGas but no gasLimit — the default is silent.
    console.log(chalk.yellow(`    ⚠ OpenSea recommended maxFeePerGas but no gas limit — using default ${SIGNED_GAS_FLOOR.toLocaleString()} gas limit.`));
  }

  return {
    seaDropAddress,
    nftContract,
    feeRecipient: feeRecipient || "0x0000a26b00c1F0DF003000390027140000fAa719",
    mintData,
    mintSignature,
    value,
    drop: { mintPrice, startTime, endTime, maxTotalMintableByWallet: maxTotal, feeBps, restrictFeeRecipients: restrict },
    gasData,
  };
}

function buildGasDataFromDrop(drop: any): FcfsGasData | undefined {
  const gasLimit = drop.gasLimit || drop.gas_limit;
  const maxFeePerGas = drop.maxFeePerGas || drop.max_fee_per_gas;
  const maxPriorityFeePerGas = drop.maxPriorityFeePerGas || drop.max_priority_fee_per_gas;
  if (!gasLimit && !maxFeePerGas) return undefined;
  return {
    gasLimit: gasLimit ? Number(gasLimit) : SIGNED_GAS_FLOOR,
    maxFeePerGas: maxFeePerGas ? parsePriceToWei(maxFeePerGas) : BigInt(0),
    maxPriorityFeePerGas: maxPriorityFeePerGas ? parsePriceToWei(maxPriorityFeePerGas) : BigInt(0),
  };
}

export function extractActiveDrop(json: any, nftContract: string): any | null {
  if (!json || typeof json !== "object") return null;

  // The documented shape is DropDetailedResponse:
  //   { active_stage, next_stage, stages: DropStageResponse[], is_minting, ... }
  // DropStageResponse carries stage_type / start_time / end_time / price /
  // max_per_wallet / uuid. It has NO mintData and NO status field — the previous
  // implementation required `c.status === "active" && c.mintData`, which no real
  // response can satisfy, and it never looked at `stages` at all (a
  // DropDetailedResponse matches none of its candidate branches). It could
  // therefore never return anything.
  //
  // Signed calldata is NOT available from this endpoint; use
  // POST /api/v2/drops/{slug}/mint for that.
  const now = Date.now();
  const unixSec = (v: unknown): number => {
    if (v == null || v === "") return 0;
    const n = Number(v);
    if (String(v).trim() !== "" && Number.isFinite(n)) return Math.floor(n);
    const parsed = Date.parse(String(v));
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  };
  // 0 means unknown: an unknown bound must not exclude the stage.
  const isLive = (s: any): boolean => {
    if (!s || typeof s !== "object") return false;
    const start = unixSec(s.start_time ?? s.startTime);
    const end = unixSec(s.end_time ?? s.endTime);
    if (end > 0 && now >= end * 1000) return false;
    if (start > 0 && now < start * 1000) return false;
    return true;
  };

  if (isLive(json.active_stage)) return json.active_stage;
  const stages = Array.isArray(json.stages) ? json.stages : [];
  return stages.find(isLive) ?? null;
}

// ── Extract a fireable payload from on-chain SEADROP results ───────────────
//
// On-chain drops from fetchOnChainDrops carry what the SEADROP contract exposes:
//   - Public drops: mintPrice, startTime, endTime, maxTotalMintableByWallet, feeBps,
//     restrictFeeRecipients — FULLY actionable on-chain.
//   - Allowlist/OVR drops: merkle root + fee recipients — signals existence, but
//     mintData/mintSignature are NULL because they live off-chain with OpenSea.
//   - Token-gated drops: full mint params on-chain IF you know the gate token.
//
// This function filters for drops that are immediately fireable (have mintData) AND
// also surfaces allowlist drops as "pre-fetch candidates" — phases we know exist on
// chain but need off-chain data (signature / merkle proof) before they become
// fireable. The caller decides whether to trigger that pre-fetch.

export interface OnChainDrop {
  dropId: string;
  nftContract: string;
  type: string | null;
  startTime: number;
  endTime: number;
  mintPrice: bigint;
  maxTotalMintableByWallet: number;
  maxTotalMintable: number;
  totalMinted: number;
  feeBps: number;
  feeRecipient: string | null;
  mintData: string | null;
  mintSignature: string | null;
  gasLimit: number | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  eligible: boolean | null;
  eligibleCount: number | null;
  totalAllocated: number | null;
  allowlistedAddresses: string[];
  allowlistHash: string | null;
  seaDropAddress: string;
  raw: Record<string, any>;
}

export interface AllowlistPreFetchCandidate {
  drop: DropPhase;          // the on-chain drop info
  merkleRoot: string | null;
  feeRecipient: string | null;
  needsAllowlistData: boolean; // true → must fetch allowlist tree from OpenSea
  needsSignature: boolean;     // true → must fetch mintSignature from OpenSea
}

async function extractActiveDropFromOnChain(
  drops: DropPhase[],
  nftContract: string,
  quantity: number,
  apiKey?: string | null,
): Promise<FcfsSignedPayload | null> {
  // On-chain drops from fetchOnChainDrops never carry mintData or mintSignature —
  // those live off-chain with OpenSea. This path is kept for the FCFS REST fallback
  // (when REST returns no active drop but on-chain discovery found drops), but the
  // filter below always skips, so this function effectively returns null. Kept for
  // call-site stability; when off-chain signed data becomes available on-chain this
  // is where it would be picked up.
  for (const d of drops) {
    if (!d.mintData) continue;
    // Map DropPhase → the drop shape buildSignedPayloadFromDrop expects
    const mapped = {
      ...d,
      seaDropAddress: d.raw?.seaDropAddress || d.raw?.seadrop_address || "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
    } as any;
    const result = await buildSignedPayloadFromDrop(mapped, nftContract, quantity, apiKey);
    if (result) return result;
  }
  return null;
}

// ── Identify allowlist/OVR phases that need off-chain data pre-fetch ───────
// Called AFTER on-chain discovery returns. Returns the list of allowlist phases
// that exist on-chain but need their off-chain data (signatures, merkle proofs)
// fetched from OpenSea before they become fireable.
//
// The actual pre-fetch is done by the caller (wizard / preparation module) using
// fetchSignedPayload or fetchSignedPayloadWithSession — this function just tells
// you WHICH phases to pre-fetch and what they need.

export function identifyAllowlistPreFetchCandidates(
  onChainDrops: DropPhase[],
  _nftContract: string,
): AllowlistPreFetchCandidate[] {
  const candidates: AllowlistPreFetchCandidate[] = [];

  for (const d of onChainDrops) {
    if (d.isPublicStage) continue;   // public stages are fireable locally
    if (d.mintData) continue;        // already fireable — nothing to pre-fetch
    // A non-empty, non-zero allowlistHash is the real signal that this phase
    // needs an off-chain merkle proof. An all-zero root means "no allowlist".
    const rawHash = d.allowlistHash || "";
    const hexPart = rawHash.startsWith("0x") ? rawHash.slice(2) : rawHash;
    const isAllowlistHashReal =
      hexPart.length >= 2 && ![...hexPart].every((c) => c === "0");
    if (isAllowlistHashReal || d.allowlistedAddresses.length > 0) {
      candidates.push({
        drop: d,
        merkleRoot: d.allowlistHash ?? null,
        feeRecipient: d.feeRecipient ?? null,
        needsAllowlistData: isAllowlistHashReal,
        needsSignature: true,
      });
    }
  }

  return candidates;
}

// ── OAuth refresh (path B helper) ───────────────────────────────────────────
// Documented path is /api/v2/auth/session/refresh (reference__auth.md: the
// refresh_token cookie "is what /api/v2/auth/session/refresh needs"). The
// previous /api/v2/oauth/refresh is not in the documented API surface.

// The refresh endpoint is the web app's, not the documented v2 API: it lives on
// opensea.io/__api/auth and takes the refresh token as a COOKIE, not a JSON body.
// Verified live 2026-11-08: POST with `cookie: refresh_token=…` returns 200 and
// rotates the session via Set-Cookie. The rotated access_token is NOT in the JSON
// body — reading json.access_token returned null on every successful refresh.
const OPENSEA_SESSION_REFRESH_URL = "https://opensea.io/__api/auth/session/refresh";

/** Decode a JWT's exp claim (seconds) without verifying it. Returns null if absent. */
function jwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function refreshSessionToken(
  refreshToken: string,
  apiKey?: string | null
): Promise<StoredSession | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey.trim();

  try {
    const res = await fetch(OPENSEA_SESSION_REFRESH_URL, {
      method: "POST",
      headers: { ...headers, cookie: `refresh_token=${refreshToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    // The rotated cookies come back in Set-Cookie; the body is a user object.
    const jar = new Map<string, string>();
    const setCookie = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const accessToken = jar.get("access_token");
    if (!accessToken) return null;

    const newRefresh = jar.get("refresh_token") || refreshToken;
    // Fall back to a conservative lifetime only when the JWT carries no exp.
    const expiresAt = jwtExpiryMs(accessToken) ?? Date.now() + 3_600_000;
    const s: StoredSession = {
      accessToken,
      refreshToken: newRefresh,
      expiresAt: expiresAt - 60_000, // refresh 1 min early
    };
    await saveStoredSession(s);
    return s;
  } catch {
    return null;
  }
}

// ── Pre-fetch signed payloads for all discovered phases ─────────────────────
// Run this BEFORE the mint window opens. For each phase discovered on-chain (or
// via REST), fetch the signed data from OpenSea and cache it. At T-0, use the
// cached payload to broadcast — no API call in the critical path.
//
// IMPORTANT: mintSignature is wallet-specific. The pre-fetch at line 563/585
// fetches ONE payload per drop (quantity=1), which is only correct for a
// single-wallet run. For multi-wallet sniping, each wallet needs its own
// per-wallet pre-fetch (see fetchSignedPayloadForWallet at line 912). If you
// pass the result of this function into executeFcfsSnipe for a multi-wallet
// run, the wrong signature may be used for wallets other than the one that
// was pre-fetched. Either pre-fetch per-wallet here, or let executeFcfsSnipe
// do its own per-wallet fetch at T-0.
//
// Returns a map of dropId → pre-fetched FcfsSignedPayload, so the fire step can
// pick the right one without calling the API again.

export interface PreFetchResult {
  /** Wallet-indexed payloads, in the same order as the `walletAddresses` passed
   *  in. null = no payload for that wallet. This is exactly the shape
   *  executeFcfsSnipe's `payloads` option consumes. */
  payloads: (FcfsSignedPayload | null)[];
  failed: { walletAddress: string; reason: string }[];
}

/**
 * Pre-fetch OpenSea's signed calldata for every wallet, ahead of the window.
 *
 * Mint signatures are wallet-specific, so each wallet needs its own payload —
 * and the result must stay wallet-indexed so it can be handed straight to
 * executeFcfsSnipe. The previous shape (a single wallet address, a flat array)
 * could not be passed to a multi-wallet snipe at all.
 */
export async function preFetchSignedPayloads(
  nftContract: string,
  drop: DropPhase,
  walletAddresses: string[],
  quantity: number,
  apiKey?: string | null,
  session?: StoredSession | null,
  opts: { timeoutMs?: number; slug?: string; chainKey?: string } = {},
): Promise<PreFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const failed: { walletAddress: string; reason: string }[] = [];

  // POST /api/v2/drops/{slug}/mint takes a collection SLUG, not a contract
  // address, and a minter address. Without either this path cannot work.
  const slug = opts.slug?.trim();
  if (!slug || walletAddresses.length === 0) {
    return {
      payloads: walletAddresses.map(() => null),
      failed: walletAddresses.map((a) => ({
        walletAddress: a,
        reason: "no collection slug / minter address — the mint endpoint needs both",
      })),
    };
  }

  // Public stages are minted through the local on-chain path, not OpenSea's
  // signed-payload flow.
  if (drop.isPublicStage) {
    return {
      payloads: walletAddresses.map(() => null),
      failed: walletAddresses.map((a) => ({
        walletAddress: a,
        reason: "public stage — minted on-chain, no signed payload needed",
      })),
    };
  }

  // The signed calldata comes from POST /drops/{slug}/mint. GET /drops/{slug}
  // returns DropDetailedResponse — stage metadata with NO mintData — so it can
  // never produce a payload.
  //
  // The wallet JWT is required for presale stages; an API key alone only works
  // for some public drops.
  const accessToken = session?.accessToken || null;

  const payloads = await Promise.all(walletAddresses.map(async (addr) => {
    try {
      return await postMintTxFallback(
        slug, addr, quantity, apiKey, timeoutMs, opts.chainKey, nftContract, accessToken,
      );
    } catch (err: any) {
      failed.push({ walletAddress: addr, reason: err.message || "fetch error" });
      return null;
    }
  }));

  return { payloads, failed };
}

// ── Build allowlist mint calldata locally (NO OpenSea signature needed) ─────
// When we have the allowlist merkle proof for our wallet, we can build the
// mintAllowlist calldata entirely on-chain — no API call at fire time.
//
// This is the analog of encodeMintPublic() in seadrop-public.ts, but for the
// allowlist path. The merkle proof comes from the allowlist tree data (fetched
// from OpenSea ahead of time), not from the chain.

export interface AllowlistMintCalldata {
  to: string;           // always the SeaDrop singleton
  data: string;         // mintAllowlist(...) calldata — same for every wallet
  value: bigint;        // mintPrice × quantity
  feeRecipient: string; // SeaDrop fee recipient
  merkleRoot: string;   // the on-chain merkle root (for verification)
}

// Note: the exact SeaDrop function name for allowlist mints may vary by version.
// Common patterns: mintAllowlist, mintWithProof, mintAllowlistWithSig.
// Adjust the function name below when the real ABI is known.

export function encodeAllowlistMintCalldata(
  _nftContract: string,
  _feeRecipient: string,
  _quantity: number,
  _merkleRoot: string,
  _merkleProof: string[],   // hex-encoded proof paths from the allowlist tree
  _walletAddress: string,   // the allowlisted wallet
  _mintPrice: bigint,
): string | null {
  // SeaDrop does NOT expose a standalone mintAllowlist function.
  // Allowlist/OVR mints go through mintSigned() — OpenSea produces a per-wallet
  // signature (mintSignature) that is passed to mintSigned along with the
  // mint params. The merkle proof from the allowlist tree is embedded inside
  // the signed payload's mintData, not passed separately.
  //
  // This previously returned the literal string "0xplaceholder_allowlist_calldata",
  // which a caller could have broadcast as if it were real calldata. Returning
  // null is the honest answer: there is no local allowlist mint to encode.
  // The real calldata comes from the signed payload fetched from OpenSea
  // (buildSignedPayloadFromDrop -> drop.mintData).
  return null;
}

// ── Determine mint mode from on-chain data ──────────────────────────────────
// Given an on-chain DropPhase, returns what mint mode it uses and whether it's
// immediately fireable locally (public) or needs an API pre-fetch (signed/allowlist).
//
// IMPORTANT: this function must not key off the absence of mintData/mintSignature
// to decide "public" — a signed/allowlist stage BEFORE its payload is published
// will have null signed fields but is NOT a public stage. Use isPublicStage
// (which is derived from stageType) to classify public vs non-public. The signed-
// data check is only used to detect "already have a signature, ready to fire".

export type MintMode = "public" | "signed" | "allowlist" | "token-gated" | "unknown";

export function classifyMintMode(drop: DropPhase): { mode: MintMode; fireableLocally: boolean; preFetchNeeded: boolean } {
  // A public stage is fireable locally whether or not it costs anything.
  // Requiring mintPrice > 0 here misclassified every FREE public mint as
  // "unknown" + preFetchNeeded, sending it down the signed-payload path where
  // it can never succeed. Free mints are common (and are the whole point of a
  // public-mint tool), so the price must not gate the classification.
  if (drop.isPublicStage) {
    return { mode: "public", fireableLocally: true, preFetchNeeded: false };
  }

  if (drop.mintData) {
    return { mode: "signed", fireableLocally: false, preFetchNeeded: false }; // already have signature
  }

  // A non-empty allowlistHash is ONLY a real signal if it's not all zeros.
  // The on-chain fallback sometimes creates a stub allowlist phase with an
  // all-zeros merkle root (which means "no allowlist configured for this
  // contract"). We must not treat that stub as a real allowlist/OVR phase.
  const rawHash = drop.allowlistHash || "";
  // Strip the 0x prefix if present, then check every remaining char is '0'.
  // Require at least 2 hex chars (1 byte) so a bare "0x" doesn't count.
  const hexPart = rawHash.startsWith("0x") ? rawHash.slice(2) : rawHash;
  const isAllowlistHashReal =
    hexPart.length >= 2 &&
    ![...hexPart].every((c) => c === "0");
  if (isAllowlistHashReal || drop.allowlistedAddresses.length > 0) {
    return { mode: "allowlist", fireableLocally: false, preFetchNeeded: true };
  }

  // OVR phases: detected by type string. OVR mints go through mintSigned with a
  // server-produced signature, so they need a pre-fetch just like signed/allowlist
  // phases. (The allowlistHash/allowlistedAddresses signals were already handled
  // above — this branch only catches OVRs identified by their type label.)
  // Normalize the casing: GQL emits "OVR", REST emits "ovr".
  if (normalizeStageType(drop.type) === "ovr") {
    return { mode: "allowlist", fireableLocally: false, preFetchNeeded: true };
  }

  const st = normalizeStageType(drop.type);
  if (st === "token_gated") {
    return { mode: "token-gated", fireableLocally: false, preFetchNeeded: true };
  }
  if (st === "allowlist") {
    return { mode: "allowlist", fireableLocally: false, preFetchNeeded: true };
  }

  return { mode: "unknown", fireableLocally: false, preFetchNeeded: true };
}

// ── Token-gated mint (probe with known gate token) ──────────────────────────
// Token-gated phases store everything on-chain IF you know the gate token address.
// The mint params come from getTokenGatedDrop(nftContract, gateToken).
// Once you have them, this is identical to public mint — pre-build, pre-sign, fire.

export async function fetchTokenGatedMintParams(
  nftContract: string,
  gateToken: string,
  rpcUrl: string,
): Promise<SeaDropDropMeta | null> {
  // Direct on-chain call to getTokenGatedDrop(nftContract, gateToken)
  // This is the same function seadrop-onchain.ts uses in fetchTokenGatedPhase
  const ABI = [
    "function getTokenGatedDrop(address nftContract, address allowedNftToken) view returns (" +
      "uint80 mintPrice, " +
      "uint16 maxTotalMintableByWallet, " +
      "uint48 startTime, " +
      "uint48 endTime, " +
      "uint8 dropStageIndex, " +
      "uint32 maxTokenSupplyForStage, " +
      "uint16 feeBps, " +
      "bool restrictFeeRecipients" +
    ")",
  ];
  const iface = new Interface(ABI);
  // staticNetwork: true — without it ethers performs a network detection
  // (eth_chainId) on first use, which adds a round trip and, on a slow or
  // rate-limited endpoint, times out before the read it was created for.
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });

  try {
    const data = iface.encodeFunctionData("getTokenGatedDrop", [nftContract, gateToken]);
    const result = await provider.send("eth_call", [{ to: SEADROP_ADDRESS, data }, "latest"]);
    if (!result || result === "0x") return null;

    const d = iface.decodeFunctionResult("getTokenGatedDrop", result);
    const startTime = Number(d.startTime);
    const endTime = Number(d.endTime);

    if (startTime === 0 && endTime === 0) return null;

    return {
      mintPrice: d.mintPrice || 0n,
      startTime,
      endTime,
      maxTotalMintableByWallet: Number(d.maxTotalMintableByWallet),
      feeBps: Number(d.feeBps),
      restrictFeeRecipients: Boolean(d.restrictFeeRecipients),
    };
  } catch {
    return null;
  } finally {
    // ethers keeps a polling timer alive on every provider; without an explicit
    // destroy the process never exits.
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}


// ── Build a mint plan from a fetched signed payload ─────────────────────────
export function buildFcfsMintPlan(
  payload: FcfsSignedPayload,
  gasLimit: number,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
  quantity: number,
): FcfsMintPlan {
  return {
    payload,
    quantity,
    gasLimit: gasLimit || SIGNED_GAS_FLOOR,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

// ── Execute a signed/allowlist snipe across multiple wallets ─────────────────
export interface ExecuteSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: number;
  targetStart: Date;
  /** Structural template from buildFcfsMintPlan. `payload` is used when it is
   *  already bound to wallets[0]; otherwise a per-wallet fetch is required.
   *  Null when the selected phase opens in the future and no payload exists yet. */
  plan: FcfsMintPlan | null;
  openSeaApiKey?: string | null;
  slug?: string;                    // collection slug for OpenSea GraphQL/REST calls
  chainKey?: string;               // chain key (e.g., "ethereum", "base") for GraphQL
  sessions?: (StoredSession | null)[]; // per-wallet sessions (indexed by walletKeys)
  /** Per-wallet pre-fetched payloads (indexed by walletKeys). When present,
   *  these are used directly and NO API call happens in the critical path. */
  payloads?: (FcfsSignedPayload | null)[];
  /**
   * True when the selected phase opens in the future. A signed payload for a
   * future phase cannot exist — OpenSea only signs a mint for a stage that is
   * live — so phase 1 must not fetch one and phase 2 must fetch at T-0.
   * Without this the payload is fetched before the wait, found missing, and the
   * wallet is dropped before it ever had a chance to mint.
   */
  phaseOpensInFuture?: boolean;
  /** Maximum total price (wei) the user will accept. Asserted before signing. */
  maxPriceWei?: bigint | null;
  /** Per-unit price OpenSea quoted for this wallet during the eligibility check.
   *  When set alongside maxPriceWei, a quote that has risen above the cap is
   *  refused before any payload is fetched or signed. */
  quotedPriceWei?: bigint | null;
  /** EIP-155 chain id. Derived from `chainKey` when omitted — a transaction
   *  without one is signed with chainId 0, which no node accepts. */
  chainId?: number | null;
  /**
   * Re-read the per-wallet cap at T-0 and report how many tokens the wallet can
   * still mint, or null when it cannot be determined.
   *
   * A drop's per-wallet limit can be edited in the last minutes before its stage
   * opens, and the signed calldata binds the quantity — so a reduced cap means
   * every payload fetched so far is for the wrong quantity and must be
   * re-fetched. Omitted by callers that cannot ask (headless runs); the fire
   * then proceeds at the originally planned quantity.
   */
  recheckMintable?: (quantity: number) => Promise<number | null>;
}

export type SnipeStatus = "SUCCESS" | "REVERTED" | "UNKNOWN" | "FAILED";

export interface SnipeResult {
  walletIndex: number;
  walletAddress: string;
  /** True only when a receipt confirmed the mint. */
  success: boolean;
  /**
   * Confirmed outcome. UNKNOWN means the tx was broadcast but no receipt could
   * be read — it may have landed, so it must be reported as neither success nor
   * failure. Absent on results built before the receipt stage, where `success`
   * is the only signal.
   */
  status?: SnipeStatus;
  txHash?: string;
  receipt?: ConfirmedTx;
  error?: string;
  /** True when the failure is timing-related and a later attempt could work. */
  retryable?: boolean;
}

/**
 * Sleep until the target while keeping the RPC sockets alive.
 *
 * The first request after an idle period pays a reconnect: measured at
 * +200-400 ms on public Base endpoints, where the socket dies roughly 3-4 s
 * after the last request. A silent eth_blockNumber poll every 2 s keeps the
 * session warm so T-0 does not pay that.
 *
 * The final second is left quiet so no ping is still in flight when the fire
 * path wants the socket.
 */
async function waitWithKeepAlive(rpcUrls: string[], delayMs: number): Promise<void> {
  const PING_INTERVAL_MS = 2_000;
  const QUIET_MS = 1_000;
  const deadline = Date.now() + delayMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const quiet = remaining <= QUIET_MS;
    const nap = quiet ? remaining : Math.min(PING_INTERVAL_MS, remaining - QUIET_MS);
    await new Promise((r) => setTimeout(r, nap));
    if (!quiet) void pingRpcs(rpcUrls);
  }
}

export async function executeFcfsSnipe(opts: ExecuteSnipeOpts): Promise<SnipeResult[]> {
  const {
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    targetStart,
    plan: _plan,
    openSeaApiKey,
    slug,
    chainKey,
  } = opts;

  if (quantity <= 0) throw new Error("Quantity must be at least 1.");
  if (walletKeys.length === 0) throw new Error("No wallet keys provided.");
  if (rpcUrls.length === 0) throw new Error("No RPC endpoints provided.");

  // Every transaction MUST carry a chain id and a nonce. A provider-less Wallet
  // signs exactly what it is given (ethers v6 BaseWallet.signTransaction does NOT
  // populate), so a missing chain id defaults to 0 — which every node rejects with
  // "transaction type not supported".
  const chainId = opts.chainId ?? (chainKey ? resolveChain(chainKey)?.chainId ?? null : null);
  if (chainId == null) {
    throw new Error("executeFcfsSnipe: no chain id (pass chainId or a valid chainKey)");
  }

  // Indexed by wallet so a slow wallet cannot reorder the report.
  const results: (SnipeResult | null)[] = new Array(walletKeys.length).fill(null);
  const endpoints = parseRpcEndpoints(rpcUrls);

  // Rank the endpoints concurrently with phase 1 (payload fetching, which can
  // take seconds), so the ordering is in hand by T-0. The fire path never waits
  // for this — see settleRanking.
  const ranking = rankRpcEndpoints(rpcUrls);

  // ══ PHASE 1 — everything that does not depend on the wall clock ══════════
  //
  // OpenSea's signed calldata is stable for the whole stage, so it is fetched
  // now, not at T-0. This is the only slow step — an API round trip per wallet —
  // and it is the one that used to sit inside the critical path.
  //
  // The transaction itself cannot be finished here, for two reasons:
  //   • the nonce is unknowable ahead of time;
  //   • a signed mint carries its stage window in the signed parameters and
  //     reverts outside it, so gas estimation and simulation are meaningless
  //     before the window opens.
  interface ReadyTx {
    walletIndex: number;
    addr: string;
    to: string;
    data: string;
    value: bigint;
    gasLimit: number;
  }
  const ready: ReadyTx[] = [];
  // Wallets held back because the phase opens in the future. Their payloads are
  // fetched at T-0, after the wait — see phase 2.
  const pendingAtT0: { walletIndex: number; addr: string }[] = [];

  // Establish the TCP/TLS sessions NOW, while there is time to spare. Without
  // this the first RPC at T-0 pays the handshake, and the public path has always
  // warmed for exactly this reason.
  await warmConnections(rpcUrls);

  // ── Pre-read nonces while there is time ────────────────────────────────────
  //
  // The nonce is not "unknowable ahead of time" — a wallet that has not sent a
  // transaction during the wait has a stable pending nonce, and reading it now
  // removes one RPC round trip from the T-0 critical path. It is still re-read
  // at T-0 (see phase 2): a wallet that sent something while we waited must use
  // the newer value, and broadcasting with a stale nonce produces a stuck tx.
  //
  // This is a pure latency optimisation — the T-0 read remains authoritative.
  const prewarmedNonces = new Map<number, number>();
  try {
    const nonceProvider = new JsonRpcProvider(rpcUrls[0], chainId, {
      staticNetwork: true,
      pollingInterval: 4000,
    });
    await Promise.all(
      walletKeys.map(async (key, i) => {
        try {
          const addr = new Wallet(key).address;
          const n = await withDeadlineOrThrow(
            nonceProvider.getTransactionCount(addr, "pending"),
            3_000,
            `prewarm nonce for ${addr}`
          );
          prewarmedNonces.set(i, n);
        } catch {
          // Non-fatal: phase 2 reads it again with a full budget.
        }
      })
    );
    nonceProvider.destroy();
  } catch {
    // Provider setup failed — phase 2 reads nonces itself.
  }
  if (prewarmedNonces.size > 0) {
    console.log(chalk.gray(`  Pre-read nonces for ${prewarmedNonces.size}/${walletKeys.length} wallet(s).`));
  }

  await Promise.all(walletKeys.map(async (key, i) => {
    const w = new Wallet(key);
    const addr = w.address;
    try {
      // Prefer the pre-fetched per-wallet payload; fall back to a live fetch NOW
      // (still before T-0) — never at fire time.
      //
      // EXCEPT when the phase opens in the future. OpenSea will not sign a mint
      // for a stage that is not live, so a fetch here always returns null and
      // the wallet is dropped before the wait even starts. Defer it to T-0.
      let payload: FcfsSignedPayload | null = opts.payloads?.[i] ?? null;
      if (!payload && !opts.phaseOpensInFuture) {
        payload = await fetchSignedPayloadForWallet(
          nftContract,
          quantity,
          addr,
          openSeaApiKey,
          { timeoutMs: 15000, session: opts.sessions?.[i] ?? null, slug, chainKey },
        );
      }
      if (!payload && opts.phaseOpensInFuture) {
        // Not an error — the payload cannot exist yet. Hold the wallet back and
        // let phase 2 fetch it at T-0.
        pendingAtT0.push({ walletIndex: i, addr });
        return;
      }
      if (!payload) {
        results[i] = {
          walletIndex: i,
          walletAddress: addr,
          success: false,
          error: `No signed payload for ${addr} — OpenSea may not have a signed phase for this contract`,
        };
        return;
      }

      // Belt-and-braces: a pre-fetched payload must be bound to THIS wallet.
      // Fails open inside isPayloadBoundToWallet; the on-chain revert is the
      // backstop. This catches a payload array indexed in the wrong order.
      if (!isPayloadBoundToWallet(payload, addr)) {
        results[i] = {
          walletIndex: i,
          walletAddress: addr,
          success: false,
          error: `Pre-fetched payload for ${addr} is bound to a different wallet — refusing to broadcast.`,
        };
        return;
      }

      // ── Price protection (local, no RPC) ────────────────────────────────
      // The eligibility check quoted a per-wallet price; a signed payload carries
      // the price OpenSea quoted when it was built. Checking the quote first
      // catches a price rise before anything is signed.
      if (opts.quotedPriceWei != null && opts.maxPriceWei != null) {
        try {
          assertPriceProtection({
            actualPriceWei: opts.quotedPriceWei * BigInt(quantity),
            maxPriceWei: opts.maxPriceWei,
            context: `OpenSea quoted price × ${quantity}`,
          });
        } catch (e: any) {
          results[i] = {
            walletIndex: i, walletAddress: addr, success: false,
            error: e?.message || String(e), retryable: false,
          };
          return;
        }
      }
      if (opts.maxPriceWei != null) {
        try {
          assertPriceProtection({
            actualPriceWei: payload.value,
            maxPriceWei: opts.maxPriceWei,
            context: `signed mint × ${quantity}`,
          });
        } catch (e: any) {
          results[i] = {
            walletIndex: i, walletAddress: addr, success: false,
            error: e?.message || String(e), retryable: false,
          };
          return;
        }
      }

      ready.push({
        walletIndex: i,
        addr,
        to: payload.seaDropAddress,
        data: payload.mintData,
        value: payload.value,
        gasLimit: gasLimit || SIGNED_GAS_FLOOR,
      });
    } catch (err: any) {
      results[i] = {
        walletIndex: i, walletAddress: addr, success: false,
        error: err.message || String(err),
      };
    }
  }));

  // Nothing survived phase 1 — do not sit through the wait for a fire that
  // cannot happen. Wallets held back for a future phase are the exception: they
  // have not failed, they are waiting for T-0.
  if (ready.length === 0 && pendingAtT0.length === 0) {
    return results.filter((r): r is SnipeResult => r != null);
  }

  // ══ WAIT ════════════════════════════════════════════════════════════════
  const delay = targetStart.getTime() - Date.now();
  if (delay > 0) {
    console.log(`  Waiting ${Math.round(delay / 1000)}s until target start...`);
    await waitWithKeepAlive(rpcUrls, delay);
  }

  // ══ PHASE 2 — T-0: refresh only what can have moved, then blast ═════════
  //
  // Per wallet, ONE parallel batch: nonce + gas estimate + simulation. That is
  // the entire fire-time RPC cost — a single round trip — followed by local
  // signing and the blast.
  //
  // The per-wallet cap is re-read first. The signed calldata binds the quantity,
  // so a cap that dropped while we were waiting invalidates every payload
  // already fetched — they must be re-fetched at the reduced quantity rather
  // than broadcast to revert.
  let fireQuantity = quantity;
  let requeryPayloads = false;
  if (opts.recheckMintable && ready.length + pendingAtT0.length > 0) {
    try {
      const mintable = await opts.recheckMintable(quantity);
      if (mintable != null) {
        const r = reconcileQuantity(quantity, mintable);
        if (r.exhausted) {
          console.log(chalk.red("  ✗ This wallet's allocation is used up — refusing to mint."));
          for (const entry of [...ready, ...pendingAtT0]) {
            results[entry.walletIndex] = {
              walletIndex: entry.walletIndex,
              walletAddress: entry.addr,
              success: false,
              error: "Per-wallet allocation was used up before T-0.",
            };
          }
          return results.filter((r): r is SnipeResult => r != null);
        }
        if (r.clamped) {
          console.log(
            chalk.yellow(
              `  ⚠ Per-wallet limit changed to ${mintable} — minting ${r.quantity} instead of ${quantity}.`
            )
          );
          fireQuantity = r.quantity;
          requeryPayloads = true;
        }
      }
    } catch (e: any) {
      // A failed re-check must not stop the fire; the original quantity is still
      // the best information available, and the on-chain revert is the backstop.
      console.log(chalk.gray(`  ⚠ Could not re-check the per-wallet limit: ${e?.message ?? e}`));
    }
  }

  if (requeryPayloads) {
    // Every payload in hand is for the wrong quantity. Re-fetch them all.
    for (const entry of ready) {
      pendingAtT0.push({ walletIndex: entry.walletIndex, addr: entry.addr });
    }
    ready.length = 0;
  }

  // Wallets held back for a future phase get their payload fetched HERE, after
  // the wait. OpenSea signs a mint only for a live stage, so this is the first
  // moment the payload can exist. A short retry window covers the lag between
  // the on-chain start and OpenSea's signer coming online.
  if (pendingAtT0.length > 0) {
    console.log(
      `  Phase is live — fetching signed payloads for ${pendingAtT0.length} wallet(s)...`
    );
    const fetched = await Promise.all(
      pendingAtT0.map(async ({ walletIndex, addr }) => {
        // Retry briefly: the stage can be live on-chain a few seconds before
        // OpenSea will sign for it. A single attempt would fail the whole run.
        let payload: FcfsSignedPayload | null = null;
        let lastErr: string | null = null;
        for (let attempt = 0; attempt < 4 && !payload; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 1500));
          }
          try {
            payload = await fetchSignedPayloadForWallet(
              nftContract,
              fireQuantity,
              addr,
              openSeaApiKey,
              {
                timeoutMs: 8000,
                session: opts.sessions?.[walletIndex] ?? null,
                slug,
                chainKey,
              },
            );
          } catch (err: any) {
            lastErr = err?.message || String(err);
          }
        }
        if (!payload) {
          results[walletIndex] = {
            walletIndex,
            walletAddress: addr,
            success: false,
            error:
              `No signed payload at T-0 for ${addr}` +
              (lastErr ? ` — last error: ${lastErr}` : " — OpenSea did not return signed data."),
            retryable: true,
          };
          return null;
        }
        if (!isPayloadBoundToWallet(payload, addr)) {
          results[walletIndex] = {
            walletIndex,
            walletAddress: addr,
            success: false,
            error: `T-0 payload for ${addr} is bound to a different wallet — refusing to broadcast.`,
          };
          return null;
        }
        return { walletIndex, addr, payload };
      })
    );

    // Promote the successful fetches into the ready set so the blast below
    // treats them exactly like wallets that had a payload all along.
    for (const entry of fetched) {
      if (!entry) continue;
      ready.push({
        walletIndex: entry.walletIndex,
        addr: entry.addr,
        to: entry.payload.seaDropAddress,
        data: entry.payload.mintData,
        value: entry.payload.value,
        gasLimit: gasLimit || SIGNED_GAS_FLOOR,
      });
    }
  }

  // The wait may have produced no ready wallets at all (every wallet was held
  // back and every T-0 fetch failed) — nothing to blast.
  if (ready.length === 0) {
    return results.filter((r): r is SnipeResult => r != null);
  }

  // The chainId is passed explicitly. Without it ethers performs a network
  // detection (eth_chainId) on the first request — an extra round trip inside
  // the T-0 critical path, and on some endpoints it retries first.
  const fireProvider = new JsonRpcProvider(rpcUrls[0], chainId, {
    staticNetwork: true,
    pollingInterval: 1000,
  });
  const toBlast: { walletIndex: number; addr: string; blast: PreparedBlast }[] = [];
  try {
    await Promise.all(ready.map(async (r) => {
      const w = new Wallet(walletKeys[r.walletIndex]);
      try {
        const [sim, est, nonceResult] = await Promise.all([
          // Tightly bounded: a simulation is a nice-to-have and must never be
          // able to eat the T-0 window. Inconclusive fails open below.
          simulateTx(fireProvider, { to: r.to, from: r.addr, data: r.data, value: r.value }, 2_000),
          // No .catch(() => null) here. autoGasBounded returns null ONLY on a
          // timeout (could not tell) and RETHROWS a failed estimate, which is
          // almost always a revert — that is do-not-send evidence and must reach
          // the catch below, not be downgraded to "inconclusive, send anyway".
          autoGasBounded(
            fireProvider,
            { to: r.to, from: r.addr, data: r.data, value: r.value },
            2_000
          ),
          // Bounded like its two siblings. ethers has no timeout option and its
          // FetchRequest defaults to 300s with 429 backoff, so an unbounded nonce
          // read would hold the entire T-0 batch on one stalled endpoint.
          //
          // The prewarmed nonce is used as the fallback: if this read times out
          // but we read the nonce before the wait, the tx can still go out with
          // a known-good value instead of being dropped.
          withDeadlineOrThrow(
            fireProvider.getTransactionCount(r.addr, "pending"),
            2_000,
            "nonce"
          ).catch(() => prewarmedNonces.get(r.walletIndex) ?? null),
        ]);
        const nonce = nonceResult;
        if (nonce == null) {
          // No nonce from either read — without one the tx cannot be built.
          throw new Error("Could not read a nonce at T-0 (RPC timed out and no prewarmed value).");
        }

        // An INDETERMINATE result (timeout, network error) is not evidence the tx
        // reverts — it means we could not tell. Fail OPEN: blocking a good mint
        // because a public RPC had a bad moment is worse than sending a tx that
        // might revert. A definitive revert still blocks.
        if (!sim.ok && sim.reverted) {
          const classified = classifyRevert(sim.reason);
          const label = classified ? `[${classified.label}] ` : "";
          results[r.walletIndex] = {
            walletIndex: r.walletIndex,
            walletAddress: r.addr,
            success: false,
            error: `Simulation refused to broadcast: ${label}${sim.reason ?? "unknown revert"}`,
            retryable: classified?.retryable ?? false,
          };
          return;
        }
        if (!sim.ok && sim.indeterminate) {
          console.log(
            chalk.yellow(`    ⚠ Simulation inconclusive (${sim.reason}) — proceeding; the tx may still revert.`)
          );
        }

        const signed = await w.signTransaction({
          to: r.to,
          data: r.data,
          value: r.value,
          gasLimit: est ? Number(est.gasLimit) : r.gasLimit,
          maxFeePerGas: est?.maxFeePerGas ?? maxFeePerGas,
          maxPriorityFeePerGas: est?.maxPriorityFeePerGas ?? maxPriorityFeePerGas,
          nonce,
          chainId,
        });
        toBlast.push({ walletIndex: r.walletIndex, addr: r.addr, blast: prepareBlast(signed) });
      } catch (err: any) {
        results[r.walletIndex] = {
          walletIndex: r.walletIndex,
          walletAddress: r.addr,
          success: false,
          error: err.message || String(err),
        };
      }
    }));
  } finally {
    try {
      fireProvider.destroy();
    } catch {
      // Already destroyed.
    }
  }

  // ── Blast everything, then collect ──────────────────────────────────────
  // All transactions go out within microseconds of each other, and the receipts
  // are collected in parallel for the same reason: each wallet's poll is
  // independent, so a serial loop puts every wallet after the first a full poll
  // budget (60s) behind — 10 wallets is ~10 minutes before the last one is
  // checked, which also delays the sell-after-mint step.
  // Zero budget: the ranking is an optimisation and must never hold up the
  // fire. If it is not already finished, fire against the original order.
  const ranked = await settleRanking(ranking, 0);
  const blastEndpoints: RankedEndpoint[] =
    ranked && ranked.length > 0 ? ranked : endpoints.map((e) => ({ ...e, latencyMs: null }));
  if (blastEndpoints.length > 1) {
    console.log(
      `  Fastest endpoints: ${blastEndpoints
        .slice(0, BLAST_FIRST_WAVE)
        .map((e) => `${e.label}${e.latencyMs != null ? ` ${e.latencyMs}ms` : ""}`)
        .join(", ")} — escalating to the rest if none accepts`
    );
  }

  const inflight = toBlast.map((b) => ({
    b,
    responsePromise: blastToAll(b.blast, blastEndpoints, {
      firstWave: BLAST_FIRST_WAVE,
      // 350ms, not the 600ms default. The first wave is 1-2 of the fastest
      // endpoints measured by the pre-sort; if neither accepts within 350ms
      // something is wrong with the route, and waiting longer only delays the
      // escalation that will actually land the tx.
      escalateAfterMs: 350,
    }).responsePromise,
  }));

  const collected = await Promise.all(
    inflight.map(async ({ b, responsePromise }) => {
      const blastResults = await responsePromise;
      // Pick the first endpoint that actually accepted this wallet's tx — poll
      // that endpoint for the receipt so we don't burn time on an endpoint that
      // never saw the tx. Fall back to rpcUrls[0] if the blast result has no
      // accepting label (shouldn't happen, but defensive).
      const accepted = blastResults.find((r) => r.txHash != null);
      const acceptingEndpoint = accepted && blastEndpoints.find((ep) => ep.label === accepted.label);
      const receiptUrl = acceptingEndpoint ? acceptingEndpoint.url : rpcUrls[0];

      let receipt: ConfirmedTx | undefined;
      if (accepted && accepted.txHash) {
        const receiptResult = await waitForReceipt(accepted.txHash, receiptUrl);
        if (receiptResult) {
          receipt = {
            address: b.addr,
            txHash: accepted.txHash,
            block: receiptResult.block,
            position: receiptResult.position,
            // waitForReceipt already normalises the hex status to SUCCESS/REVERTED
            // ("0x1" / "0x0"). Comparing against the hex values here made every
            // receipt — including a successful mint — read back as PENDING.
            status: receiptResult.status === "REVERTED" ? "REVERTED" : "SUCCESS",
            gasUsed: receiptResult.gasUsed,
            actualGasPrice: receiptResult.actualGasPrice || null,
            blockTimeMs: null,
          };
        }
      }
      return { b, blastResults, accepted, receipt };
    })
  );

  for (const { b, blastResults, accepted, receipt } of collected) {

    // Three distinct outcomes, and they must not collapse into one boolean:
    //   REVERTED — a receipt says the mint failed
    //   SUCCESS  — a receipt says the mint landed
    //   UNKNOWN  — the tx was broadcast but no receipt could be read; it may
    //              have landed, so it is neither a success nor a failure
    //   FAILED   — the blast never produced a tx hash
    // `success` is true only for a confirmed SUCCESS. Reporting a missing
    // receipt as success made the sell-after-mint step try to sell tokens that
    // were never minted.
    const status: SnipeStatus = !accepted
      ? "FAILED"
      : receipt
        ? (receipt.status === "REVERTED" ? "REVERTED" : "SUCCESS")
        : "UNKNOWN";

    let error: string | undefined;
    if (!accepted) {
      error = blastResults[0]?.error || "All endpoints rejected/failed";
    } else if (status === "REVERTED") {
      error = "Transaction reverted on-chain.";
    } else if (status === "UNKNOWN") {
      error = "Receipt not available before the poll timed out — the mint may still have landed.";
    }

    results[b.walletIndex] = {
      walletIndex: b.walletIndex,
      walletAddress: b.addr,
      success: status === "SUCCESS",
      status,
      txHash: (accepted?.txHash as string) || undefined,
      receipt,
      error,
    };
  }

  return results.filter((r): r is SnipeResult => r != null);
}

// ── Fetch a wallet-specific signed payload ──────────────────────────────────
// Each wallet's mintSignature is bound to that wallet address by OpenSea.
// Calling fetchSignedPayload(nftContract, qty, apiKey) returns a payload whose
// mintSignature is bound to… whoever called it last. For multi-wallet sniping
// we MUST re-fetch per wallet so each signature covers the right address.
//
// This is a thin wrapper that delegates to fetchSignedPayload / fetchSignedPayloadWithSession
// with the wallet address embedded in the request where the API supports it.
export async function fetchSignedPayloadForWallet(
  nftContract: string,
  quantity: number,
  walletAddress: string,
  apiKey?: string | null,
  opts: { timeoutMs?: number; session?: StoredSession | null; slug?: string; chainKey?: string } = {},
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 15000;

  // Try API-key-only path first
  if (apiKey && apiKey.trim()) {
    const payload = await fetchSignedPayload(nftContract, quantity, apiKey, {
      timeoutMs, slug: opts.slug, walletAddress, chainKey: opts.chainKey
    });
    if (payload) {
      // OpenSea binds mintSignature to a wallet. If the returned payload's
      // mintData/signature is not for this wallet, reject it.
      // The mintData calldata encodes the recipient; we check it here.
      // Verify the payload is bound to the requested wallet address before using it.
      if (!isPayloadBoundToWallet(payload, walletAddress)) {
        return null; // payload is for a different wallet — reject, don't use it
      }
      return payload;
    }
  }

  // Fall back to session-based fetch.
  // Use the per-wallet session if provided (from warmAllSessions),
  // otherwise fall back to loading a stored session from disk.
  const session = opts.session ?? await loadStoredSession();
  if (session && session.accessToken) {
    const payload = await fetchSignedPayloadWithSession(
      nftContract, quantity, session, apiKey, { timeoutMs, slug: opts.slug, walletAddress, chainKey: opts.chainKey }
    );
    if (payload && isPayloadBoundToWallet(payload, walletAddress)) {
      return payload;
    }
  }

  return null;
}

// isPayloadBoundToWallet is imported from ./seadrop-calldata — the single
// implementation. A previous duplicate here sliced hex[8,48), which reads the
// nftContract address rather than the minter, so it only ever matched when the
// wallet happened to BE the NFT contract.
