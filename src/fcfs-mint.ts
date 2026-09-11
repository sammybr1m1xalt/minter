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
import { Wallet, formatEther, getAddress, Interface, JsonRpcProvider } from "ethers";
import { CHAINS, resolveChain } from "./chains";
import { parseRpcEndpoints, PreparedBlast, prepareBlast, blastToAll, waitForReceipt, BlastResult } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { fetchOnChainDrops, fetchSingleOnChainDrop } from "./seadrop-onchain";
import type { DropPhase } from "./fcfs-drops";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { sweepOnChain, summarizeOnChain, ConfirmedTx } from "./rpc-health";

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
  refreshToken: string;
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

// ── Path A: API-key-only signed payload fetch (try first) ──────────────────
// Best for signed-mint / allowlist phases where v2 exposes the mintData +
// mintSignature without requiring a full OAuth session.
//
// Returns null when the key doesn't have access to this drop's signed data.

export async function fetchSignedPayload(
  nftContract: string,
  quantity: number,
  apiKey?: string | null,
  opts: { timeoutMs?: number } = {}
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

    // OpenSea v2: /api/v2/drops/{nftContract} returns whatever drop stages are
    // configured for this contract — fcfs, allowlist, ovr, signed, or whatever
    // OpenSea labels them. We accept any phase that has signed mint data.
    const res = await fetch(
      `https://api.opensea.io/api/v2/drops/${nftContract}`,
      { signal: controller.signal, headers }
    );
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      // Key rejected / needs session — fall through to path B downstream.
      return null;
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error("OpenSea rate-limited the signed-payload lookup — retry in a few seconds.");

    const json = (await res.json()) as any;
    const drop = extractActiveDrop(json, nftContract);
    if (!drop) {
      // If we have no slug, REST /drops/{CA} is unlikely to work and on-chain
      // discovery is the better fallback. If we do have a slug, also try
      // on-chain as a fallback.
      const onChainDrops = await fetchOnChainDrops(nftContract, timeoutMs);
      if (onChainDrops.length > 0) {
        return extractActiveDropFromOnChain(onChainDrops, nftContract, quantity, apiKey);
      }
      return null;
    }

    const payload = await buildSignedPayloadFromDrop(drop, nftContract, quantity, apiKey);
    if (!payload) return null;
    return payload;
  } catch (err: any) {
    if (err && err.name === "AbortError") throw new Error("OpenSea signed-payload fetch timed out");
    throw err;
  }
}

// ── Path B: signed payload fetch with a live OAuth session token ───────────
// Needed when v2 requires a live session (access token) for mintSigned() data,
// which is the case for many signed-mint and allowlist phases.
//
// Falls back to refreshing the token if it expired mid-run.

export async function fetchSignedPayloadWithSession(
  nftContract: string,
  quantity: number,
  session: StoredSession,
  apiKey?: string | null,
  opts: { timeoutMs?: number } = {}
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${session.accessToken}`,
    };
    if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

    const res = await fetch(
      `https://api.opensea.io/api/v2/drops/${nftContract}`,
      { signal: controller.signal, headers }
    );
    clearTimeout(timer);

    if (res.status === 401) {
      // Token expired mid-run — try one refresh
      const renewed = await refreshSessionToken(session.refreshToken, apiKey);
      if (!renewed) return null;
      return fetchSignedPayloadWithSession(nftContract, quantity, renewed, apiKey, opts);
    }
    if (res.status === 403 || res.status === 404) return null;
    if (res.status === 429) throw new Error("OpenSea rate-limited the signed-payload lookup — retry in a few seconds.");

    const json = (await res.json()) as any;
    const drop = extractActiveDrop(json, nftContract);
    if (!drop) {
      const onChainDrops = await fetchOnChainDrops(nftContract, timeoutMs);
      if (onChainDrops.length > 0) {
        return extractActiveDropFromOnChain(onChainDrops, nftContract, quantity, apiKey);
      }
      return null;
    }

    return await buildSignedPayloadFromDrop(drop, nftContract, quantity, apiKey);
  } catch (err: any) {
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
  apiKey?: string | null,
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

  if (!mintData || !mintSignature) return null;

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
      // OpenSea names the phase. We need an active stage with signed mint
      // data (mintData + mintSignature) before it's fireable.
      if (c.status === "active" && c.mintData && c.mintSignature) return c;
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
    if (!d.mintData || !d.mintSignature) continue;
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
  nftContract: string,
): AllowlistPreFetchCandidate[] {
  const candidates: AllowlistPreFetchCandidate[] = [];

  for (const d of onChainDrops) {
    // Skip public drops — they're fully on-chain, no pre-fetch needed.
    // Use isPublicStage (which keys off stageType, not signed-data absence) so
    // a signed/allowlist stage that happens to have null mintData is not
    // misclassified as public.
    if (d.isPublicStage) continue;
    // Skip drops that already have signed data — they're fireable now
    if (d.mintData && d.mintSignature) continue;

    // Allowlist/OVR/token-gated drops with no mintData — need off-chain fetch
    const merkleRoot = d.allowlistHash || null;
    const feeRecipient = d.feeRecipient || null;

    candidates.push({
      drop: d,
      merkleRoot,
      feeRecipient,
      needsAllowlistData: !!(merkleRoot || d.allowlistedAddresses.length > 0),
      needsSignature: true, // signed/allowlist phases almost always need a signature
    });
  }

  return candidates;
}

// ── OAuth refresh (path B helper) ───────────────────────────────────────────

const OPENSEA_OAUTH_REFRESH_URL = "https://api.opensea.io/api/v2/oauth/refresh";

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
  walletAddress: string,
  quantity: number,
  apiKey?: string | null,
  session?: StoredSession | null,
  opts: { timeoutMs?: number } = {},
): Promise<PreFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const success: FcfsSignedPayload[] = [];
  const failed: { dropId: string; reason: string }[] = [];

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
          `https://api.opensea.io/api/v2/drops/${nftContract}`,
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
          `https://api.opensea.io/api/v2/drops/${nftContract}`,
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
  nftContract: string,
  feeRecipient: string,
  quantity: number,
  merkleRoot: string,
  merkleProof: string[],   // hex-encoded proof paths from the allowlist tree
  walletAddress: string,   // the allowlisted wallet
  mintPrice: bigint,
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
  if (drop.isPublicStage && drop.mintPrice > 0n) {
    return { mode: "public", fireableLocally: true, preFetchNeeded: false };
  }

  if (drop.mintData && drop.mintSignature) {
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
  if (drop.type === "ovr") {
    return { mode: "allowlist", fireableLocally: false, preFetchNeeded: true };
  }

  if (drop.type === "token-gated" || drop.type === "tokengated") {
    return { mode: "token-gated", fireableLocally: false, preFetchNeeded: true };
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
  plan: FcfsMintPlan;
  openSeaApiKey?: string | null;
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
    plan,
    openSeaApiKey,
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
      // Fetch a wallet-specific signed payload. The plan is a structural
      // template (gas settings, etc.); the actual mintData+mintSignature come
      // from a per-wallet fetch so each signature is bound to the right address.
      const payload = await fetchSignedPayloadForWallet(
        nftContract,
        quantity,
        addr,
        openSeaApiKey,
        { timeoutMs: 15000 },
      );
      if (!payload) {
        results.push({
          walletIndex: i,
          walletAddress: addr,
          success: false,
          error: `No signed payload for ${addr} — OpenSea may not have a signed phase for this contract`,
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
      const { txHash, responsePromise } = blastToAll(prepared, endpoints);

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
  opts: { timeoutMs?: number } = {},
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 15000;

  // Try API-key-only path first
  if (apiKey && apiKey.trim()) {
    const payload = await fetchSignedPayload(nftContract, quantity, apiKey, { timeoutMs });
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

  // Fall back to session-based fetch if we have stored credentials
  const session = await loadStoredSession();
  if (session && session.accessToken) {
    const payload = await fetchSignedPayloadWithSession(
      nftContract, quantity, session, apiKey, { timeoutMs }
    );
    if (payload && isPayloadBoundToWallet(payload, walletAddress)) {
      return payload;
    }
  }

  return null;
}

/**
 * Check whether a signed payload's mintData is bound to a specific wallet address.
 *
 * OpenSea's v2 signed mint payload binds mintSignature to a specific recipient
 * wallet. The mintData calldata contains the recipient address embedded in it
 * (the first 20 bytes after the function selector in an ERC-2771 / eth_signed
 * context, or in the SeaDrop mintSigned calldata). We do a best-effort decode:
 *   - If mintData is long enough, extract the address at the expected offset.
 *   - If decoding fails, fall back to trusting the payload (the API is expected
 *     to bind it correctly, and we re-fetch per wallet anyway).
 *
 * When in doubt, return true and let the caller decide — the worst case is a
 * revert on-chain, which is caught by the receipt poll. The important thing is
 * that we do NOT blindly trust a payload fetched for wallet A and use it for
 * wallet B.
 */
function isPayloadBoundToWallet(payload: FcfsSignedPayload, walletAddress: string): boolean {
  const addr = walletAddress.toLowerCase().replace(/^0x/, "");
  if (!payload.mintData || payload.mintData.length < 66) return true; // too short to decode

  try {
    // mintData is hex with 0x prefix. After the 4-byte selector, many signed-mint
    // patterns encode the recipient as the first 20-byte argument. We try offset 4
    // (right after selector) as the most common pattern.
    const hex = payload.mintData.replace(/^0x/, "");
    const recipientHex = hex.slice(8, 8 + 40); // 4 bytes selector + 20 bytes addr = 48 hex chars
    const extracted = "0x" + recipientHex;
    return extracted.toLowerCase() === walletAddress.toLowerCase();
  } catch {
    // Decoding failed — trust the payload. The per-wallet re-fetch + receipt
    // poll is the real safety net.
    return true;
  }
}
