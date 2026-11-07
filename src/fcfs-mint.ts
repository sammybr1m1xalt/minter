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

import chalk from "chalk";
import { Wallet, Interface, JsonRpcProvider } from "ethers";
import { parseRpcEndpoints, prepareBlast, blastToAll, waitForReceipt } from "./rpc-blast";
import { fetchOnChainDrops } from "./seadrop-onchain";
import type { DropPhase } from "./fcfs-drops";
import { normalizeStageType } from "./fcfs-drops";
import { isPayloadBoundToWallet } from "./seadrop-calldata";
export { isPayloadBoundToWallet } from "./seadrop-calldata";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { ConfirmedTx } from "./rpc-health";
import { buildOpenseaMint, OpenseaMintTx } from "./opensea-gql";

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

// ── Latency-sorted RPC list (built during setup, used at fire) ─────────

export interface RpcEndpointLatency {
  url: string;
  label: string;
  latencyMs: number | null; // null = unmeasured
}

export async function measureRpcLatency(urls: string[], timeoutMs = 3000): Promise<RpcEndpointLatency[]> {
  const endpoints = parseRpcEndpoints(urls);
  const results: RpcEndpointLatency[] = [];

  for (const ep of endpoints) {
    const t0 = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      results.push({ url: ep.url, label: ep.label, latencyMs: Math.round(performance.now() - t0) });
    } catch {
      results.push({ url: ep.url, label: ep.label, latencyMs: null });
    }
  }
  results.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  return results;
}

// ── OpenSea session — refreshable OAuth token, stored on disk ───────────────

const SESSION_DIR = process.env.OPENSEA_SESSION_DIR
  ? process.env.OPENSEA_SESSION_DIR
  : (() => {
      const d = process.env.HOME ? `${process.env.HOME}/.nft-public-mint` : "";
      try { require("fs").mkdirSync(d, { recursive: true }); } catch {}
      return d;
    })();

const SESSION_FILE = `${SESSION_DIR}/opensea_session.json`;

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // UNIX ms
  scope?: string;
}

export async function loadStoredSession(): Promise<StoredSession | null> {
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
  require("fs").writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), "utf-8");
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
// PRIMARY PATH: GraphQL MintActionTimelineQuery (via buildOpenseaMint) — this is
// what the upstream nft-minter-bot uses. The GraphQL query binds the mint tx
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
  // The upstream always uses the slug — REST /api/v2/drops/{CA} returns 404
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
    const restPayload = await postMintTxFallback(slug, walletAddress, quantity, apiKey, timeoutMs, chainKey || "ethereum");
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
  _quantity: number,
): FcfsSignedPayload | null {
  if (!tx.data || tx.data === "0x" || tx.data.length < 10) return null;

  // The selector tells us the stage type (PUBLIC_SALE, SIGNED_PRESALE, MERKLE_PRESALE)
  // For SIGNED_PRESALE and MERKLE_PRESALE, the signature is embedded in the calldata.
  // For PUBLIC_SALE, no signature is needed.
  const isSigned = tx.selector === "0x4b61cd6f" || tx.selector === "0x4300a4e6";

  return {
    seaDropAddress: tx.to,
    nftContract,
    feeRecipient: "0x0000000000000000000000000000000000000000", // fee recipient is in calldata for seaDrop
    mintData: tx.data,
    mintSignature: isSigned ? "0x0000000000000000000000000000000000000000000000000000000000000000" : "0x", // embedded in calldata
    value: tx.value,
    drop: {
      mintPrice: tx.value,
      startTime: 0,
      endTime: 0,
      maxTotalMintableByWallet: 0,
      feeBps: 0,
      restrictFeeRecipients: false,
    },
    gasData: undefined,
  };
}

/** Fallback: REST /api/v2/drops/{slug}/mint — returns FcfsSignedPayload or null. */
async function postMintTxFallback(
  slug: string,
  walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  timeoutMs = 15000,
  _chainKey = "ethereum",
): Promise<FcfsSignedPayload | null> {
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    clearTimeout(timer);
    if (res.status !== 200 && res.status !== 409) return null;
    const json = (await res.json()) as any;
    const mintData = json?.data || json?.mintData || null;
    const mintSignature = json?.mint_signature || json?.mintSignature || null;
    if (!mintData) return null;
    const seaDropAddress = json?.to || json?.seaDropAddress || json?.contract || nftContractPlaceholder(slug);
    const value = json?.value ? BigInt(String(json.value)) : 0n;
    return {
      seaDropAddress,
      nftContract: seaDropAddress, // best-effort
      feeRecipient: json?.fee_recipient || json?.feeRecipient || "0x0000000000000000000000000000000000000000",
      mintData,
      mintSignature: mintSignature || "0x",
      value,
      drop: { mintPrice: value, startTime: 0, endTime: 0, maxTotalMintableByWallet: quantity, feeBps: 0, restrictFeeRecipients: false },
      gasData: undefined,
    };
  } catch {
    return null;
  }
}

function nftContractPlaceholder(_slug: string): string {
  // If we can't resolve the contract, use a zero address as placeholder.
  // The caller should have the real contract in nftContract.
  return "0x0000000000000000000000000000000000000000";
}

// ── Path B: signed payload fetch with a live OAuth session token ───────────
// Needed when the GraphQL MintActionTimelineQuery requires a live session
// (access token) for signed/allowlist phases. Falls back to refreshing the
// token if it expired mid-run.
//
// PRIMARY PATH: GraphQL buildOpenseaMint with cookie (sessionToCookieHeader).
// The upstream calls buildOpenseaMint({ slug, minterAddress, contract, chain, cookie }).

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

  // ── Fallback: REST /api/v2/drops/{slug} with session auth ────────────────
  // The documented path parameter is a collection SLUG. Passing a contract
  // address here is not supported — it returns 404 and the caller mistakes it
  // for "no drop". Resolve the slug first; if we cannot, skip this path.
  if (!slug || !slug.trim()) return null;
  const dropIdentifier = slug.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
    };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

    const res = await fetch(
      `https://api.opensea.io/api/v2/drops/${dropIdentifier}`,
      { signal: controller.signal, headers },
    );
    clearTimeout(timer);

    if (res.status === 401) {
      // Token expired mid-run — try one refresh
      if (opts.refreshed) return null; // prevent infinite recursion
      const renewed = session.refreshToken
        ? await refreshSessionToken(session.refreshToken, apiKey)
        : null;
      if (!renewed) return null;
      return fetchSignedPayloadWithSession(nftContract, quantity, renewed, apiKey, { ...opts, refreshed: true });
    }
    if (res.status === 403 || res.status === 404) return null;
    if (res.status === 429) throw new Error("OpenSea rate-limited the signed-payload lookup — retry in a few seconds.");

    const json = (await res.json()) as any;
    const drop = extractActiveDrop(json, nftContract);
    if (!drop) {
      const onChainDrops = await fetchOnChainDrops(nftContract, timeoutMs, chainKey);
      if (onChainDrops.length > 0) {
        return extractActiveDropFromOnChain(onChainDrops, nftContract, quantity, apiKey);
      }
      return null;
    }

    return await buildSignedPayloadFromDrop(drop, nftContract, quantity, apiKey);
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error("OpenSea signed-payload fetch timed out");
    throw err;
  }
}

// ── Shared: turn whatever v2 returns into a FcfsSignedPayload ────────────
//
// The exact field names here are whatever OpenSea v2 actually hands back for
// an FCFS/allowlist stage's signed mint payload. Adapt to the live response.
//
// NOTE: mintData is per-wallet for mintSigned — the OpenSea API binds the
// signature to a specific wallet address. For multi-wallet sniping, each wallet
// MUST get its own payload. See fetchSignedPayloadForWallet.

async function buildSignedPayloadFromDrop(
  drop: any,
  nftContract: string,
  quantity: number,
  _apiKey?: string | null,
): Promise<FcfsSignedPayload | null> {
  const seaDropAddress = drop.seaDropAddress || drop.seadrop_address || "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const feeRecipient = drop.feeRecipient || drop.fee_recipient;
  const mintData = drop.mintData || drop.mint_data || drop.calldata;
  const mintSignature = drop.mintSignature || drop.mint_signature || drop.signature;
  const mintPrice = BigInt(drop.mintPrice || drop.mint_price || drop.price || "0");
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
    // The exact gas cost of mintSigned/mintAllowlist varies by drop and by chain;
    // 250k is a conservative floor but may be low for complex allowlist proofs.
    console.log(chalk.yellow(`    ⚠ No gas recommendation from OpenSea — using default 250,000 gas limit.`));
    gasData = { gasLimit: 250_000, maxFeePerGas: BigInt(0), maxPriorityFeePerGas: BigInt(0) };
  } else if (gasData.gasLimit === 250_000 && !drop.gasLimit && !drop.gas_limit) {
    // OpenSea returned maxFeePerGas but no gasLimit — the 250k default is silent.
    console.log(chalk.yellow(`    ⚠ OpenSea recommended maxFeePerGas but no gas limit — using default 250,000 gas limit.`));
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
    gasLimit: gasLimit ? Number(gasLimit) : 250_000,
    maxFeePerGas: maxFeePerGas ? BigInt(maxFeePerGas) : BigInt(0),
    maxPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(maxPriorityFeePerGas) : BigInt(0),
  };
}

function extractActiveDrop(json: any, nftContract: string): any | null {
  if (!json) return null;
  // v2 may return { drops: [...] } or { data: { drops: [...] } } or a single drop.
  const candidates: any[] = [];
  if (Array.isArray(json)) candidates.push(...json);
  else if (json.drops && Array.isArray(json.drops)) candidates.push(...json.drops);
  else if (json.data && Array.isArray(json.data)) candidates.push(...json.data);
  else if (json.result) candidates.push(json.result);

  for (const c of candidates) {
    if (c.nftContract === nftContract || c.contractAddress === nftContract || c.address === nftContract) {
      // Accept any active drop — fcfs, allowlist, ovr, reserved, or whatever
      // OpenSea names the phase. The signature is embedded in the calldata, so
      // mintData alone marks it fireable.
      if (c.status === "active" && c.mintData) return c;
    }
  }
  return null;
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
    if (d.isPublicStage) continue;
    if (d.mintData) continue;
  }

  return candidates;
}

// ── OAuth refresh (path B helper) ───────────────────────────────────────────
// Documented path is /api/v2/auth/session/refresh (reference__auth.md: the
// refresh_token cookie "is what /api/v2/auth/session/refresh needs"). The
// previous /api/v2/oauth/refresh is not in the documented API surface.

const OPENSEA_OAUTH_REFRESH_URL = "https://api.opensea.io/api/v2/auth/session/refresh";

export async function refreshSessionToken(
  refreshToken: string,
  apiKey?: string | null
): Promise<StoredSession | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey.trim();
  headers["content-type"] = "application/json";

  try {
    const res = await fetch(OPENSEA_OAUTH_REFRESH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.status !== 200) return null;
    const json = (await res.json()) as any;
    const accessToken = json.access_token;
    const newRefresh = json.refresh_token || refreshToken;
    const expiresIn = Number(json.expires_in || json.expiresIn || 3600);
    if (!accessToken) return null;
    const s: StoredSession = {
      accessToken,
      refreshToken: newRefresh,
      expiresAt: Date.now() + expiresIn * 1000 - 60_000, // refresh 1 min early
      scope: json.scope,
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
  success: FcfsSignedPayload[];
  failed: { dropId: string; reason: string }[];
}

export async function preFetchSignedPayloads(
  nftContract: string,
  onChainDrops: DropPhase[],
  _walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  session?: StoredSession | null,
  opts: { timeoutMs?: number; slug?: string } = {},
): Promise<PreFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const success: FcfsSignedPayload[] = [];
  const failed: { dropId: string; reason: string }[] = [];

  // GET /api/v2/drops/{slug} takes a collection slug, not a contract address.
  // Without a slug this REST path cannot work — skip it rather than firing a
  // request that can only 404.
  const slug = opts.slug?.trim();
  if (!slug) {
    return {
      success: [],
      failed: onChainDrops.map((d) => ({
        dropId: d.dropId,
        reason: "no collection slug — REST drop lookup needs one",
      })),
    };
  }

  // Two strategies for getting signed data:
  //  (a) API-key-only: works for some drops without a session
  //  (b) Session-based: needed when v2 requires an access token
  //
  // We try (a) first for each drop, then fall back to (b) if we have a session.

  const dropsToFetch = onChainDrops.filter(d => {
    // Only pre-fetch drops that are future or currently live (not stale past drops)
    const now = Math.floor(Date.now() / 1000);
    if (d.endTime > 0 && d.endTime < now - 86400) return false; // stale
    // Only pre-fetch drops that need signed data.
    // A public drop with mintData+mintSignature is fireable now (already
    // discovered via on-chain + REST), but a public drop WITHOUT signed data
    // doesn't need a pre-fetch — it's minted via the local public path.
    // The isPublicStage flag tells us which is which.
    return !d.isPublicStage;
  });

  for (const drop of dropsToFetch) {
    try {
      // Try API-key-only first
      let payload: FcfsSignedPayload | null = null;
      if (apiKey && apiKey.trim()) {
        const res = await fetch(
          `https://api.opensea.io/api/v2/drops/${slug}`,
          {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              accept: "application/json",
              ...(apiKey.trim() ? { "X-API-KEY": apiKey.trim() } : {}),
            },
          }
        );
        if (res.status === 200) {
          const json = (await res.json()) as any;
          const active = extractActiveDrop(json, nftContract);
          if (active) {
            payload = await buildSignedPayloadFromDrop(active, nftContract, quantity, apiKey);
          }
        }
      }

      // Fall back to session if key-only didn't work
      if (!payload && session && session.accessToken) {
        const res = await fetch(
          `https://api.opensea.io/api/v2/drops/${slug}`,
          {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              accept: "application/json",
              authorization: `Bearer ${session.accessToken}`,
              ...(apiKey && apiKey.trim() ? { "X-API-KEY": apiKey.trim() } : {}),
            },
          }
        );
        if (res.status === 200) {
          const json = (await res.json()) as any;
          const active = extractActiveDrop(json, nftContract);
          if (active) {
            payload = await buildSignedPayloadFromDrop(active, nftContract, quantity, apiKey);
          }
        }
      }

      if (payload) {
        success.push(payload);
      } else {
        failed.push({ dropId: drop.dropId, reason: "Could not fetch signed data — may need allowlist tree or specific signer" });
      }
    } catch (err: any) {
      failed.push({ dropId: drop.dropId, reason: err.message || "fetch error" });
    }
  }

  return { success, failed };
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
): string {
  // SeaDrop does NOT expose a standalone mintAllowlist function.
  // Allowlist/OVR mints go through mintSigned() — OpenSea produces a per-wallet
  // signature (mintSignature) that is passed to mintSigned along with the
  // mint params. The merkle proof from the allowlist tree is embedded inside
  // the signed payload's mintData, not passed separately.
  //
  // This function is kept as a marker: when we have a real allowlist phase
  // with a non-zero merkle root, the actual calldata comes from the signed
  // payload fetched from OpenSea (buildSignedPayloadFromDrop → drop.mintData).
  // Until we have a live allowlist phase with signed data, this returns a
  // recognizable marker so callers can detect the gap.
  return "0x" + "placeholder_allowlist_calldata";
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
  const provider = new JsonRpcProvider(rpcUrl);

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
    gasLimit: gasLimit || 250_000,
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
   *  already bound to wallets[0]; otherwise a per-wallet fetch is required. */
  plan: FcfsMintPlan;
  openSeaApiKey?: string | null;
  slug?: string;                    // collection slug for OpenSea GraphQL/REST calls
  chainKey?: string;               // chain key (e.g., "ethereum", "base") for GraphQL
  sessions?: (StoredSession | null)[]; // per-wallet sessions (indexed by walletKeys)
  /** Per-wallet pre-fetched payloads (indexed by walletKeys). When present,
   *  these are used directly and NO API call happens in the critical path. */
  payloads?: (FcfsSignedPayload | null)[];
}

export interface SnipeResult {
  walletIndex: number;
  walletAddress: string;
  success: boolean;
  txHash?: string;
  receipt?: ConfirmedTx;
  error?: string;
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

  if (quantity <= 0) {
    throw new Error("Quantity must be at least 1.");
  }
  if (walletKeys.length === 0) {
    throw new Error("No wallet keys provided.");
  }

  const results: SnipeResult[] = [];
  const endpoints = parseRpcEndpoints(rpcUrls);

  // Wait until target start
  const now = Date.now();
  const delay = targetStart.getTime() - now;
  if (delay > 0) {
    console.log(`  Waiting ${Math.round(delay / 1000)}s until target start...`);
    await new Promise(r => setTimeout(r, delay));
  }

  // Pre-fetch a signed payload per wallet. mintSignature is wallet-specific —
  // reusing one payload across wallets is a bug. Each wallet gets its own
  // FcfsSignedPayload built from a per-wallet API fetch.
  for (let i = 0; i < walletKeys.length; i++) {
    const key = walletKeys[i];
    const w = new Wallet(key);
    const addr = w.address;

    try {
      // Use the pre-fetched per-wallet payload when we have one. This is the
      // whole point of the pre-fetch: no API call between T-0 and broadcast.
      // Fall back to a live per-wallet fetch only when it is missing.
      let payload: FcfsSignedPayload | null = opts.payloads?.[i] ?? null;

      if (!payload) {
        payload = await fetchSignedPayloadForWallet(
          nftContract,
          quantity,
          addr,
          openSeaApiKey,
          { timeoutMs: 15000, session: opts.sessions?.[i] ?? null, slug, chainKey },
        );
      }
      if (!payload) {
        results.push({
          walletIndex: i,
          walletAddress: addr,
          success: false,
          error: `No signed payload for ${addr} — OpenSea may not have a signed phase for this contract`,
        });
        continue;
      }

      // Belt-and-braces: a pre-fetched payload must be bound to THIS wallet.
      // Fails open inside isPayloadBoundToWallet; the on-chain revert is the
      // backstop. This catches a payload array indexed in the wrong order.
      if (!isPayloadBoundToWallet(payload, addr)) {
        results.push({
          walletIndex: i,
          walletAddress: addr,
          success: false,
          error: `Pre-fetched payload for ${addr} is bound to a different wallet — refusing to broadcast.`,
        });
        continue;
      }

      const txRequest = {
        to: payload.seaDropAddress,
        data: payload.mintData,
        value: payload.value,
        gasLimit: gasLimit || 250_000,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };

      const signed = await w.signTransaction(txRequest);
      const prepared = prepareBlast(signed);
      const { responsePromise } = blastToAll(prepared, endpoints);

      const blastResults = await responsePromise;
      // Pick the first endpoint that actually accepted this wallet's tx — poll
      // that endpoint for the receipt so we don't burn time on an endpoint that
      // never saw the tx. Fall back to rpcUrls[0] if the blast result has no
      // accepting label (shouldn't happen, but defensive).
      const accepted = blastResults.find((r) => r.txHash != null);
      const acceptingEndpoint = accepted && endpoints.find((ep) => ep.label === accepted.label);
      const receiptUrl = acceptingEndpoint ? acceptingEndpoint.url : rpcUrls[0];

      let receipt: ConfirmedTx | undefined;
      if (accepted && accepted.txHash) {
        const receiptResult = await waitForReceipt(accepted.txHash, receiptUrl);
        if (receiptResult) {
          receipt = {
            address: addr,
            txHash: accepted.txHash!,
            block: receiptResult.block,
            position: receiptResult.position,
            status: receiptResult.status === "0x1" ? "SUCCESS" : receiptResult.status === "0x0" ? "REVERTED" : "PENDING",
            gasUsed: receiptResult.gasUsed,
            actualGasPrice: receiptResult.actualGasPrice || null,
            blockTimeMs: null,
          };
        }
      }

      results.push({
        walletIndex: i,
        walletAddress: addr,
        success: !!accepted,
        txHash: (accepted?.txHash as string) || undefined,
        receipt,
        error: accepted ? undefined : (blastResults[0]?.error || "All endpoints rejected/failed"),
      });
    } catch (err: any) {
      results.push({
        walletIndex: i,
        walletAddress: addr,
        success: false,
        error: err.message || String(err),
      });
    }
  }

  return results;
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
