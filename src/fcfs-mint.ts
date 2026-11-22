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
import { Wallet, JsonRpcProvider, Interface } from "ethers";
import { parseRpcEndpoints, prepareBlast, blastToAll, waitForReceipt, type PreparedBlast, type BlastResult } from "./rpc-blast";
import { resolveChain } from "./chains";
import { fetchOnChainDrops } from "./seadrop-onchain";
import type { DropPhase } from "./fcfs-drops";
import { normalizeStageType } from "./fcfs-drops";
import { isPayloadBoundToWallet, decodeMintParams, SIGNED_SELECTOR, MERKLE_SELECTOR } from "./seadrop-calldata";
export { isPayloadBoundToWallet } from "./seadrop-calldata";
import { SEADROP_ADDRESS, OPENSEA_FEE_RECIPIENT } from "./seadrop-public";
import { ConfirmedTx } from "./rpc-health";
import { buildOpenseaMint, OpenseaMintTx, parsePriceField, parsePriceToWei } from "./opensea-gql";
import { noteKeyCall } from "./opensea-key";
import { simulateTx, classifyRevert, type SimulateResult } from "./simulate";
import { autoGasBounded, SIGNED_GAS_FLOOR } from "./auto-gas";
import { withDeadlineOrThrow } from "./deadline";
import { waitForSupplyPosition, type SupplyPosition } from "./supply-position";
import { assertPriceProtection } from "./price-protection";
import { reconcileQuantity } from "./mint-cap";
import { sessionDir, legacySessionFile, legacyHomeSessionFile } from "./session-store";
import { say } from "./logger";
import { warmConnections, pingRpcs, rankRpcEndpoints, settleRanking, type RankedEndpoint } from "./connection-warmer";

/** How many of the fastest endpoints to fire at before escalating to the rest. */
const BLAST_FIRST_WAVE = 2;

// How long the T-0 signed-payload fetch keeps retrying, and the gap between
// attempts.
//
// OpenSea's signer can lag the on-chain stage start by several seconds, and a
// null response is ambiguous: it means either "signer not ready yet" or "this
// wallet is not allowlisted". Retrying across a real window is the only way to
// tell them apart without giving up on a mint that would have succeeded.
//
// 30s with a 2s gap is ~15 attempts — enough to cover signer lag, bounded so a
// genuinely ineligible wallet still fails in reasonable time. The per-request
// timeout stays 8s, so one hung request cannot exceed the window by much.
const T0_PAYLOAD_WINDOW_MS = 30_000;
// Signer lag is a STARTUP phenomenon: a signer that is warming up starts
// answering within a few seconds, and a wallet that is not allowlisted never
// will. So the first retries are fast (250ms — the old flat 2s could put the
// second attempt 2s past T-0) and then back off to the old 2s cadence for the
// long tail. A flat 250ms across the whole window would spend ~45 requests
// against a rate bucket shared by every key on the account; this spends about
// as many as before while being 8x quicker off the mark.
const T0_PAYLOAD_RETRY_MS = 250;
const T0_PAYLOAD_BACKOFF_AFTER_MS = 3_000;
const T0_PAYLOAD_BACKOFF_MS = 2_000;
const T0_PAYLOAD_MAX_ATTEMPTS = 80;
// A brief coalescing window after the FIRST payload lands, so wallets whose
// payloads arrive milliseconds apart still go out in one blast rather than one
// wave each. Deliberately not a fixed gate: the old flat 1.5s made a wallet
// that was ready now wait for a straggler, and the pre-poll has already spent
// 30s trying, so a payload that has not landed by T-0 is usually one that will
// never land.
const T0_PAYLOAD_COALESCE_MS = 200;

// Pre-poll window: how far before T-0 to start trying to fetch signed payloads.
//
// A payload issued before its stage opens cannot be broadcast (the signed
// mintParams carry startTime/endTime), but having it in hand removes the fetch
// from the T-0 critical path. 30s is long enough to catch a signer that comes
// up early, short enough that a payload found at the very start is still likely
// to be the final one — and it is re-checked at T-0 regardless.
const PREPOLL_LEAD_MS = 30_000;
// 5s, not 2s. Every poll costs one API call per still-missing wallet, and the
// free tier is ~120 calls/min. At 2s a 90s pre-poll window is 44 calls per
// wallet — 6 wallets would be ~176/min and would rate-limit itself into the
// exact failure this is meant to prevent. 5s is ~18 calls per wallet, and a
// signer that comes up usually stays up, so 5s granularity does not meaningfully
// delay discovery.
const PREPOLL_INTERVAL_MS = 5_000;

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

/** The stage a signed payload is actually for. Nulls mean "not stated". */
export interface SignedStage {
  uuid: string | null;
  /**
   * Canonical stage type: "public_sale" | "signed_presale" | "merkle_presale".
   *
   * Only the GraphQL surface leaves this null — and it does not: the selector
   * names the entrypoint (mintPublic / mintSigned / mintAllowList) and
   * `buildOpenseaMint` already decodes it. It also decodes the stage INDEX from
   * mintParams, which is carried below for the same reason.
   */
  type: string | null;
  /** UNIX seconds. null = unknown — never read as 0/1970. */
  startTime: number | null;
  endTime: number | null;
  /**
   * OpenSea's stage index, decoded from mintParams. Compared only when the
   * window is missing on a side and cannot arbitrate — see ExpectedStage.index
   * for why this is a last resort.
   */
  index: number | null;
}

/**
 * The stage the user selected, carried to the fire so a payload can be checked
 * against it. `dropId` is OpenSea's stage uuid for API-discovered phases.
 */
export interface ExpectedStage {
  uuid?: string | null;
  type?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  /**
   * OpenSea's `stageIndex` for the selected stage, when the inventory stated one.
   *
   * A LAST RESORT, not a primary check. The signed calldata's `dropStageIndex`
   * and the API's `stageIndex` are two numberings that have not been proven
   * identical — on lagrange-bend-by-jiwa the public stage is `stageIndex` 0 while
   * sitting at array position 2, so the API's numbering is demonstrably not the
   * array's. Refusing on the index alone could therefore block valid mints, the
   * one direction this check must never err in. It is consulted only when the
   * window is missing on a side and cannot arbitrate.
   */
  index?: number | null;
}

/** OpenSea stage uuids are 32 hex chars, dashed or plain. */
const UUID_SHAPED = /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function normUuid(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = u.trim().toLowerCase();
  return UUID_SHAPED.test(s) ? s.replace(/-/g, "") : null;
}

/**
 * Do these two describe the same stage?
 *
 * Only compares what BOTH sides state. A payload that carries no stage identity
 * (GraphQL) cannot be checked and returns true — "cannot tell" is not
 * "matches", but refusing every GraphQL payload would stop the primary path.
 * Where a comparison IS possible and the two disagree, this returns false.
 */
export function stageMatches(payload: FcfsSignedPayload, expected: ExpectedStage | null | undefined): boolean {
  return stageMismatchReason(payload, expected) == null;
}

/**
 * Build the refusal for a payload whose stage is known and differs from the
 * selected one, or null when it may proceed. Shared by every place a payload
 * enters the fire set, so the three cannot drift.
 */
function stageRefusal(
  payload: FcfsSignedPayload,
  walletIndex: number,
  addr: string,
  expected: ExpectedStage | null | undefined,
): SnipeResult | null {
  const why = stageMismatchReason(payload, expected);
  if (!why) return null;
  say(`    ${addr} — ${why}. Refusing to broadcast.`, "error");
  return {
    walletIndex,
    walletAddress: addr,
    success: false,
    error: `${why} — refusing to broadcast.`,
    retryable: true,
  };
}

/** A canonical OpenSea stage type, or null when the label is not one we know. */
function canonicalStageType(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "public" || s === "public_sale" || s === "publicsale") return "public_sale";
  if (s === "signed_presale" || s === "signed" || s === "signature_presale") return "signed_presale";
  if (s === "merkle_presale" || s === "merkle") return "merkle_presale";
  return null;
}

/**
 * A one-line description of the mismatch, for the message that refuses to fire.
 *
 * Compares, in order, only what BOTH sides state:
 *   1. the stage uuid — when both look like OpenSea stage uuids
 *   2. the stage type — public_sale / signed_presale / merkle_presale
 *   3. the stage window — when both state a real start/end time
 *   4. the stage index — only when the window is missing on a side, so the
 *      index is a last resort rather than a second opinion on a settled matter
 *
 * A payload that carries no stage at all cannot be checked and returns null.
 * "Cannot tell" is not "matches", but refusing every such payload would stop a
 * path that has no alternative. Where a comparison IS possible and the two
 * disagree, this refuses.
 */
export function stageMismatchReason(payload: FcfsSignedPayload, expected: ExpectedStage | null | undefined): string | null {
  if (!expected) return null;
  const s = payload.stage;
  if (!s) return null;

  // uuid comparison, only when both sides actually look like OpenSea stage
  // uuids — dropId can be a hash for on-chain phases, and comparing those
  // would refuse a perfectly good payload.
  const a = normUuid(s.uuid);
  const b = normUuid(expected.uuid);
  if (a && b && a !== b) {
    return `payload is for stage ${a}, but stage ${b} was selected`;
  }

  // Stage type. This is the comparison the GraphQL path can actually make: the
  // selector names the entrypoint, so a presale payload returned for a public
  // selection is caught here rather than silently minted.
  //
  // Only OpenSea's own type vocabulary participates. An unrecognised label on
  // either side means "cannot tell" — refusing on a vocabulary guess would
  // block valid mints, which is the one direction this check must never err in.
  const pt = canonicalStageType(s.type);
  const et = canonicalStageType(expected.type);
  if (pt && et && pt !== et) {
    return (
      `payload is for a ${pt.replace("_", " ")} stage, ` +
      `but a ${et.replace("_", " ")} stage was selected`
    );
  }

  // Stage window. GraphQL participates now: OpenSea signs startTime/endTime
  // into mintParams, so the payload states them even though the response does
  // not. This is the comparison that separates two stages of the SAME type —
  // the uuid is absent on that surface and the type is equal by construction.
  const fmt = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19);
  const sStart = s.startTime != null && s.startTime > 0 ? s.startTime : null;
  const eStart = expected.startTime != null && expected.startTime > 0 ? expected.startTime : null;
  const sEnd = s.endTime != null && s.endTime > 0 ? s.endTime : null;
  const eEnd = expected.endTime != null && expected.endTime > 0 ? expected.endTime : null;
  if (sStart != null && eStart != null && sStart !== eStart) {
    return `payload is for a stage opening ${fmt(sStart)}, but the selected stage opens ${fmt(eStart)}`;
  }
  if (sEnd != null && eEnd != null && sEnd !== eEnd) {
    return `payload is for a stage closing ${fmt(sEnd)}, but the selected stage closes ${fmt(eEnd)}`;
  }

  // Stage index, only when the window could not arbitrate — that is, when a side
  // is missing either endpoint. Both sides stating an index is not the same as the
  // two numberings agreeing, which is why this sits behind the window rather than
  // beside it.
  const windowComplete = sStart != null && eStart != null && sEnd != null && eEnd != null;
  if (!windowComplete) {
    if (s.index != null && expected.index != null && s.index !== expected.index) {
      return `payload is for stage index ${s.index}, but stage index ${expected.index} was selected`;
    }
  }
  return null;
}

/** Which OpenSea surface produced a signed payload. */
export type PayloadSource =
  | "gql"     // GraphQL MintActionTimelineQuery
  | "rest"    // POST /api/v2/drops/{slug}/mint
  | "local";  // assembled from a drop object already in hand

export interface FcfsSignedPayload {
  seaDropAddress: string;   // who we send the mint tx to (usually the SeaDrop singleton)
  nftContract: string;      // the token contract
  feeRecipient: string;     // SeaDrop fee recipient for this drop
  mintData: string;         // hex calldata for mintSigned(nftContract, feeRecipient, ...)
  mintSignature: string;    // OpenSea's server signature bound to this wallet (per-wallet!)
  value: bigint;            // mintPrice × quantity
  drop: SeaDropDropMeta;
  gasData?: FcfsGasData;    // optional — OpenSea sometimes recommends gas fields
  /**
   * Which stage OpenSea actually signed for.
   *
   * Null when the surface does not say — GraphQL's MintActionTimeline carries
   * no stage identity at all. Without this, a payload for a DIFFERENT stage
   * than the one selected was silently accepted, and the wait was then taken
   * from the signed stage's window rather than the chosen one.
   */
  stage?: SignedStage | null;
  /**
   * Which leg produced this payload. Reported per wallet so a run says what it
   * actually used — a payload that came back through the REST fallback looks
   * exactly like a GraphQL one downstream.
   */
  source?: PayloadSource;
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

const SESSION_DIR = sessionDir();
const SESSION_FILE = legacySessionFile();

// A session cached by an older build under the user's home directory. Read once,
// on first load, so an existing login survives the move. Never written to.
const LEGACY_SESSION_FILE = legacyHomeSessionFile();

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

/**
 * First payload to arrive from any surface, bounded by `timeoutMs`.
 *
 * A surface that produces nothing must not win the race, so each promise is
 * wrapped so that only a real payload resolves it. If every surface comes back
 * empty the wrapped promises never settle, and the timer is what ends the wait —
 * without it, a run where both surfaces fail would hang here forever.
 */
async function racePayloadSurfaces(
  surfaces: { source: PayloadSource; promise: Promise<FcfsSignedPayload | null> }[],
  timeoutMs: number
): Promise<FcfsSignedPayload | null> {
  return new Promise<FcfsSignedPayload | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (p: FcfsSignedPayload | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(p);
    };
    timer = setTimeout(() => done(null), Math.max(500, timeoutMs));
    for (const s of surfaces) {
      s.promise.then(
        (p) => {
          if (p) done(p);
        },
        () => {
          // A failed surface must not end the race; the other one may still
          // produce a payload.
        }
      );
    }
  });
}

export async function fetchSignedPayload(
  nftContract: string,
  quantity: number,
  apiKey?: string | null,
  opts: { timeoutMs?: number; walletAddress?: string; slug?: string; chainKey?: string; accessToken?: string | null } = {},
): Promise<FcfsSignedPayload | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const { slug, walletAddress, chainKey } = opts;

  // ── Primary: GraphQL MintActionTimelineQuery ────────────────────────────
  // Requires a slug (for dropBySlug) and optionally a chainKey.
  // Always use the slug — REST /api/v2/drops/{CA} returns 404
  // for raw contract addresses, which is why the old auto-mint path was broken.
  if (slug && slug.trim() && walletAddress) {
    // GraphQL and REST are raced when REST is a real second surface.
    //
    // Sequential meant a GraphQL call that hung consumed the whole timeout
    // before REST was attempted at all — up to 10s of a ~30s pre-poll window,
    // and again at T-0. Racing costs one extra REST call per wallet in the case
    // GraphQL would have succeeded anyway.
    //
    // The race is gated on the wallet JWT. REST needs it for a signed/presale
    // stage, so without one the extra call is guaranteed to fail for exactly the
    // stages it exists to rescue — the rate limit is a shared bucket, but a
    // doomed request is still wasted. Public stages keep the sequential path:
    // the on-chain builder already mints them with no OpenSea call at all.
    const gqlPromise = (async (): Promise<FcfsSignedPayload | null> => {
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
        return openseaMintTxToSignedPayload(gqlResult, nftContract, quantity);
      } catch (err: any) {
        // GraphQL errors (e.g. NotEligibleError, DropNotMintingError) are expected
        // for wallets not on the allowlist. Don't log these — they're normal.
        if (!err?.message?.includes("opensea drop:")) {
          // Unexpected error — surface it, the REST probe may still succeed.
          console.warn(`    ⚠ GraphQL signed payload fetch error: ${err.message}`);
        }
        return null;
      }
    })();

    if (opts.accessToken) {
      const raced = await racePayloadSurfaces(
        [
          { source: "gql", promise: gqlPromise },
          {
            source: "rest",
            promise: postMintTxFallback(
              slug, walletAddress, quantity, apiKey, timeoutMs,
              chainKey || "ethereum", nftContract, opts.accessToken,
            ),
          },
        ],
        timeoutMs
      );
      if (raced) return raced;
    } else {
      const payload = await gqlPromise;
      if (payload) return payload;
    }
  }

  // ── Fallback: REST /api/v2/drops/{slug}/mint ─────────────────────────────
  // Only reached when GraphQL was NOT raced against REST — i.e. there is no
  // wallet JWT, so REST could not have been probed in parallel above. This POST
  // endpoint returns per-wallet signed data when the slug is known.
  //
  // accessToken is the wallet JWT. The endpoint is wallet-scoped, so a
  // signed/presale stage is refused without it — but the call still goes out
  // and postMintRequest logs the refusal instead of collapsing it to a null.
  if (!opts.accessToken && slug && walletAddress) {
    const restPayload = await postMintTxFallback(
      slug, walletAddress, quantity, apiKey, timeoutMs, chainKey || "ethereum", nftContract,
      null,
    );
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
    // Silent here reads as "this contract has no phases", which is a different
    // claim from "we could not ask the chain".
    say(`    on-chain discovery found no phases for ${nftContract}`, "warn");
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

  // The signed mintParams are the authoritative stage record: OpenSea signs the
  // window, the per-wallet cap and the stage index into the calldata. Reading
  // them here is what ties a payload to the stage it was issued for.
  const mintParams = isSigned ? decodeMintParams(tx.data) : null;

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
    source: "gql",
    feeRecipient: "0x0000000000000000000000000000000000000000", // fee recipient is in calldata for seaDrop
    mintData: tx.data,
    mintSignature: isSigned ? "0x0000000000000000000000000000000000000000000000000000000000000000" : "0x", // embedded in calldata
    value: totalValue,
    drop: {
      mintPrice,
      // The MintActionTimeline RESPONSE carries no stage window or per-wallet
      // cap, so these stay 0 (= unknown). The calldata does carry them — see
      // `stage` below — but `drop` is the inventory's shape and callers overlay
      // it; 0 must never be read as 1970 or "unlimited".
      startTime: 0,
      endTime: 0,
      maxTotalMintableByWallet: 0,
      feeBps: 0,
      restrictFeeRecipients: false,
    },
    // GraphQL states no stage UUID, but it DOES state a stage type (the selector
    // names the entrypoint) and — from the calldata OpenSea signed — the stage
    // window. The window is what separates two stages of the SAME type: on
    // lagrange-bend-by-jiwa the two SIGNED_PRESALE phases are 16:00–16:10 and
    // 16:10–16:15, so a type-only check could not tell them apart and this can.
    stage: {
      uuid: null,
      type: tx.stageType,
      startTime: mintParams?.startTime ?? null,
      endTime: mintParams?.endTime ?? null,
      index: tx.stageIndex,
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
  if (!mintData) {
    // A 200 with no calldata means the response shape changed. Say what actually
    // came back — a bare null here reads as "this drop has no signed phase".
    say(
      `    REST mint returned no calldata — keys: ${Object.keys(json ?? {}).join(", ") || "(none)"}`,
      "warn",
    );
    return null;
  }
  const mintSignature = json?.mint_signature || json?.mintSignature || null;
  // `to` is the SeaDrop singleton. `contract` in a mint response is the
  // COLLECTION — falling back to it would build a transaction sent to the NFT
  // contract, which can never mint. The singleton is the only safe default.
  const seaDropAddress = json?.to || json?.seaDropAddress || SEADROP_ADDRESS;
  const value = json?.value != null ? parsePriceField(json.value) : 0n;
  // The collection contract is NOT the SeaDrop singleton. Reporting the
  // seadrop address here made every downstream "which NFT did I mint" check
  // compare against the wrong address.
  const collection = nftContract || json?.nftContract || json?.contract_address || "";
  return {
    seaDropAddress,
    nftContract: collection,
    source: "rest",
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
    // The REST body states which stage it signed for. Recording it is what
    // makes the payload checkable against the stage the user selected.
    stage: {
      uuid: json?.stage_uuid ?? json?.stageUuid ?? null,
      type: json?.stage_type ?? json?.stageType ?? null,
      startTime: isoToUnixSeconds(json?.stage_start_time ?? json?.stageStartTime) || null,
      endTime: isoToUnixSeconds(json?.stage_end_time ?? json?.stageEndTime) || null,
      index: null,
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
      const json: any = await res.json().catch(() => null);
      if (res.status !== 200) {
        // Every caller collapses a non-200 to null, so without this line a
        // refusal is indistinguishable from "REST never ran" — which is how a
        // missing JWT and an unparsed body both passed unnoticed.
        const first = json?.errors?.[0];
        const why = json?.code ?? (typeof first === "string" ? first : (first?.code ?? ""));
        const level = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500
          ? "warn"
          : "info";
        say(`    REST mint ${slug}: ${res.status}${why ? ` — ${why}` : ""}`, level);
      }
      return { status: res.status, json };
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

// ── Shared: turn whatever v2 returns into a FcfsSignedPayload ──────────────
//
// Field names verified against the live endpoint on 2026-11-15 (collectr, base,
// public_sale, quantity 1):
//
//   {
//     "to": "0x00005ea00ac477b1030ce78506496e8c2de24bf5",   // SeaDrop singleton
//     "data": "0x161ac21f…",                                 // the signed calldata
//     "value": "5600000000000000",                           // wei, TOTAL
//     "chain": "base",
//     "stage_uuid": "…", "stage_type": "public_sale",
//     "stage_start_time": "2026-11-01T00:00:00Z",
//     "stage_end_time": "2026-12-01T00:00:00Z"
//   }
//
// There is no mint_signature field — the signature is inside `data`. There is
// also no fee_recipient or per-wallet cap, so those read as unknown rather than
// being invented.
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
  const seaDropAddress = drop.seaDropAddress || drop.seadrop_address || SEADROP_ADDRESS;
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
    source: "local",
    feeRecipient: feeRecipient || OPENSEA_FEE_RECIPIENT,
    mintData,
    mintSignature,
    value,
    drop: { mintPrice, startTime, endTime, maxTotalMintableByWallet: maxTotal, feeBps, restrictFeeRecipients: restrict },
    // Assembled from a known drop, so the stage is known — carry it, for the
    // same reason the REST path does.
    stage: {
      // `dropId` is the DropPhase field; `stageUuid` is the REST/local shape.
      // Both are accepted, and stageMismatchReason only compares uuids that
      // actually look like OpenSea stage uuids, so an on-chain hash in dropId
      // is never mistaken for a stage id.
      uuid: drop?.stageUuid ?? drop?.stage_uuid ?? drop?.dropId ?? null,
      type: drop?.type ?? drop?.stageType ?? null,
      startTime: startTime > 0 ? startTime : null,
      endTime: endTime > 0 ? endTime : null,
      index: null,
    },
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
      seaDropAddress: d.raw?.seaDropAddress || d.raw?.seadrop_address || SEADROP_ADDRESS,
    } as any;
    const result = await buildSignedPayloadFromDrop(mapped, nftContract, quantity, apiKey);
    if (result) return result;
  }
  return null;
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
  /**
   * Notified after each wave's mints have been blasted, with that wave's
   * results so far. Called without being awaited, so a slow consumer cannot
   * delay the next wave.
   *
   * This exists because a wallet whose payload never arrives used to hold the
   * whole run open for its full retry window, and the sell-after-mint step runs
   * after the snipe returns — so one dead wallet delayed the sale of every
   * wallet that had already minted. Selling on wave 1 while wave 2 is still
   * settling is the fix.
   */
  onWave?: (wave: number, results: SnipeResult[]) => void;
  /**
   * Hold the fire until the minted supply reaches `tokenId - quantity`, so the
   * mint starts at `tokenId - quantity + 1` and therefore lands on `tokenId`.
   *
   * Token ids are sequential, so this is a POSITION target, not a rarity
   * ranking — it only means something once you know the id -> artwork mapping
   * (see `--reveal-scan`). Bounded by `timeoutMs`; on timeout it fires anyway
   * rather than refusing, because a mint at the wrong position is still a mint.
   */
  fireOnSupplyReached?: SupplyPosition;
  /**
   * The stage the user selected. A payload whose own stage identity is known
   * and differs from this is refused rather than broadcast — firing a calldata
   * for a stage the user did not pick is the failure this guards.
   */
  expectedStage?: ExpectedStage | null;
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
  recheckMintable?: (walletAddress: string, quantity: number) => Promise<number | null>;
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
  /**
   * Wall-clock ms at which this wallet's transaction was dispatched, or
   * undefined when nothing was sent. A later confirmation sweep uses it to
   * report a real dispatch→inclusion time; without it the sweep would have to
   * invent one.
   */
  dispatchedAt?: number;
}

// ── Nonce repair ────────────────────────────────────────────────────────────
// Skipping the T-0 nonce read (see the fire block) is only safe if a stale nonce
// is recoverable. It is: a nonce the network does not want is rejected by every
// endpoint with a recognisable error, and the SAME transaction can be re-signed
// under the correct nonce and blasted unchanged.
//
// Without this pass the optimisation would trade a ~90ms read for an occasionally
// dead mint — the tx is not mined, nothing retries it, and the wallet simply
// loses the mint.
const STALE_NONCE_RE =
  /nonce too low|nonce too high|nonce mismatch|incorrect nonce|replacement transaction underpriced/i;
// "already known" means that node already has the tx — it is propagating, not
// failing. Re-blasting under a different nonce would create a SECOND transaction
// for the same wallet, so it must never trigger a repair.
const ALREADY_IN_POOL_RE = /already known|already exists|transaction already/i;

interface BlastVerdict {
  b: {
    walletIndex: number;
    addr: string;
    blast: PreparedBlast;
    ctx: {
      to: string;
      data: string;
      value: bigint;
      gasLimit: number;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
    };
  };
  dispatchedAt: number;
  blastResults: BlastResult[];
  accepted: BlastResult | null;
  /** Set to the replacement nonce when this verdict is the result of a repair. */
  nonceRepair?: number;
}

/**
 * Re-read the nonce and re-blast the wallets whose every rejection was a nonce
 * error. Returns the verdict list with those entries replaced.
 *
 * Only nonce errors qualify. A transport failure says nothing (there is no
 * verdict to repair), and any other rejection — a genuine revert, a closed
 * stage — is not fixed by a different nonce.
 */
async function repairStaleNonces(
  verdicts: BlastVerdict[],
  opts: {
    walletKeys: string[];
    chainId: number;
    endpoints: RankedEndpoint[];
    escalateAfterMs: number;
  }
): Promise<BlastVerdict[]> {
  const repairable = verdicts.filter((v) => {
    if (v.accepted) return false;
    const errors = v.blastResults.map((r) => r.error).filter((e): e is string => !!e);
    if (errors.length === 0) return false;
    if (errors.some((e) => ALREADY_IN_POOL_RE.test(e))) return false;
    return errors.some((e) => STALE_NONCE_RE.test(e));
  });
  if (repairable.length === 0) return verdicts;

  const providers = opts.endpoints.map(
    (ep) => new JsonRpcProvider(ep.url, opts.chainId, { staticNetwork: true, pollingInterval: 4000 })
  );
  try {
    const position = new Map<number, number>();
    verdicts.forEach((v, i) => position.set(v.b.walletIndex, i));
    const out = [...verdicts];
    await Promise.all(
      repairable.map(async (v) => {
        const idx = v.b.walletIndex;
        let nonce: number | null = null;
        for (const p of providers) {
          try {
            nonce = await withDeadlineOrThrow(
              p.getTransactionCount(v.b.addr, "pending"),
              2_000,
              "nonce repair"
            );
            break;
          } catch {
            // Try the next endpoint.
          }
        }
        // Could not tell, or the network already agrees with the nonce we used —
        // neither is a stale-nonce case.
        if (nonce == null || nonce === v.b.ctx.nonce) return;

        const w = new Wallet(opts.walletKeys[idx]);
        const signed = await w.signTransaction({
          to: v.b.ctx.to,
          data: v.b.ctx.data,
          value: v.b.ctx.value,
          gasLimit: v.b.ctx.gasLimit,
          maxFeePerGas: v.b.ctx.maxFeePerGas,
          maxPriorityFeePerGas: v.b.ctx.maxPriorityFeePerGas,
          nonce,
          chainId: opts.chainId,
        });
        const blastResults = await blastToAll(prepareBlast(signed), opts.endpoints, {
          firstWave: BLAST_FIRST_WAVE,
          escalateAfterMs: opts.escalateAfterMs,
        }).responsePromise;
        const accepted = blastResults.find((r) => r.txHash != null) ?? null;
        const at = position.get(idx);
        if (at === undefined) return;
        out[at] = { ...v, blastResults, accepted, nonceRepair: nonce };
        const short = `${v.b.addr.slice(0, 10)}…${v.b.addr.slice(-4)}`;
        console.log(
          accepted
            ? chalk.yellow(`    ↻ nonce repair ${short}: ${v.b.ctx.nonce} → ${nonce} — re-blast accepted`)
            : chalk.yellow(`    ↻ nonce repair ${short}: ${v.b.ctx.nonce} → ${nonce} — still rejected`)
        );
      })
    );
    return out;
  } finally {
    for (const p of providers) {
      try {
        p.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }
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
  // transaction during the wait has a stable pending nonce, and reading it here
  // removes the slowest of the three reads from the T-0 critical path
  // (361-403ms against ~307ms for the simulation and the estimate). The value is
  // used as-is at T-0.
  //
  // A wallet that sent something during the wait makes it stale. That is
  // recovered after the blast rather than prevented before it: every endpoint
  // rejects a stale nonce, and repairStaleNonces re-reads the nonce and
  // re-blasts the same transaction. See the fire block.
  const prewarmedNonces = new Map<number, number>();
  // One provider per endpoint, created up front. Each wallet then walks the
  // list until one answers: pinning every wallet to rpcUrls[0] meant a single
  // dead endpoint left the whole run with no prewarm at all, and the T-0 read
  // below would then have no fallback value. Wallets stay parallel, so a slow
  // first endpoint costs one deadline, not one per wallet.
  const prewarmProviders = rpcUrls.map(
    (url) => new JsonRpcProvider(url, chainId, { staticNetwork: true, pollingInterval: 4000 })
  );
  try {
    await Promise.all(
      walletKeys.map(async (key, i) => {
        const addr = new Wallet(key).address;
        for (const provider of prewarmProviders) {
          try {
            const n = await withDeadlineOrThrow(
              provider.getTransactionCount(addr, "pending"),
              3_000,
              `prewarm nonce for ${addr}`
            );
            prewarmedNonces.set(i, n);
            return;
          } catch {
            // Try the next endpoint. Non-fatal either way: phase 2 reads it
            // again with a full budget.
          }
        }
      })
    );
  } catch {
    // Provider setup failed — phase 2 reads nonces itself.
  } finally {
    for (const provider of prewarmProviders) {
      try {
        provider.destroy();
      } catch {
        // Already destroyed.
      }
    }
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
          // Which surfaces were tried — and why each refused — was already
          // logged by fetchSignedPayloadForWallet. The old text guessed ("may not
          // have a signed phase"), which is wrong far more often than not.
          error: `No signed payload for ${addr}`,
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

      // And it must be for the stage the user selected. A payload carries its
      // stage only when the surface states one (REST does, GraphQL does not);
      // when it does and it disagrees, the calldata is for a different window
      // and firing it is not what was asked for.
      const refused = stageRefusal(payload, i, addr, opts.expectedStage);
      if (refused) {
        results[i] = refused;
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
      // Unit check. MintActionTimeline's `value` is ambiguous for whole numbers
      // (1 = 1 wei under the wei convention, 1 ETH under the ETH one), and the
      // wei reading can only underpay — which reverts on-chain and burns the
      // T-0 window. The eligibility check quoted a per-unit price in wei, so a
      // total orders of magnitude away from that quote is a unit error, not a
      // price move. The 1000x band is far wider than any real movement between
      // the quote and the fire.
      if (opts.quotedPriceWei != null && quantity > 0) {
        const expected = opts.quotedPriceWei * BigInt(quantity);
        const actual = payload.value;
        if (actual !== 0n && (actual < expected / 1000n || actual > expected * 1000n)) {
          results[i] = {
            walletIndex: i,
            walletAddress: addr,
            success: false,
            error:
              `Signed payload value (${actual} wei) is far from the quoted total (${expected} wei) — ` +
              "a price-unit mismatch, not a price move. Refusing to broadcast.",
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

  // ══ PRE-POLL (the last PREPOLL_LEAD_MS before T-0) ═══════════════════════
  //
  // A signed payload cannot be broadcast before its stage opens — the signed
  // mintParams carry startTime/endTime, so an early payload reverts on-chain.
  // But OpenSea will often ISSUE a payload shortly before the window, and
  // fetching it during the wait removes the fetch from the T-0 critical path
  // entirely.
  //
  // A payload found here is held and re-checked at T-0; it is never broadcast
  // early. If OpenSea does not sign until the window opens, the poll simply
  // finds nothing and the T-0 fetch behaves exactly as before.
  //
  // The window is BOUNDED to the last PREPOLL_LEAD_MS, and the wait below is
  // computed from the time actually left. Both were wrong together: the poll
  // ran from `now` to T-30s (so a run scheduled ten minutes out polled for
  // nine and a half minutes) and the wait then slept the ORIGINAL delay
  // again, firing late by exactly the poll's duration — measured, T+100s
  // scheduled fired at +170s.

  // Quantities decided at T-0, hoisted above the pre-poll. The poll fetches at
  // the clamped quantity, and reading this before its declaration threw a TDZ
  // ReferenceError on EVERY attempt — swallowed by the poll callback's own
  // catch, which made the whole pre-poll silently inert (measured: 30s of
  // polling, zero OpenSea calls).
  const fireQuantities = new Map<number, number>();

  const prepollFrom = targetStart.getTime() - PREPOLL_LEAD_MS;
  if (pendingAtT0.length > 0 && Date.now() < prepollFrom) {
    const headStart = prepollFrom - Date.now();
    console.log(
      chalk.gray(`  Waiting ${Math.round(headStart / 1000)}s until the pre-poll window (T-${PREPOLL_LEAD_MS / 1000}s)...`)
    );
    await waitWithKeepAlive(rpcUrls, headStart);
  }
  if (pendingAtT0.length > 0 && Date.now() < targetStart.getTime()) {
    console.log(
      chalk.gray(`  Pre-polling for signed payloads in the last ${PREPOLL_LEAD_MS / 1000}s before T-0...`)
    );
    const prepolled = new Map<number, FcfsSignedPayload>();
    const pollStarted = Date.now();
    while (Date.now() < targetStart.getTime()) {
      const remaining = targetStart.getTime() - Date.now();
      // Poll at most every PREPOLL_INTERVAL_MS, and never past T-0.
      const budget = Math.min(PREPOLL_INTERVAL_MS, Math.max(0, remaining));
      if (budget <= 0) break;
      await new Promise((r) => setTimeout(r, budget));
      if (Date.now() >= targetStart.getTime()) break;
      // Only poll wallets still missing a payload.
      const want = pendingAtT0.filter((p) => !prepolled.has(p.walletIndex));
      if (want.length === 0) break;
      const got = await Promise.all(
        want.map(async ({ walletIndex, addr }) => {
          try {
            const p = await fetchSignedPayloadForWallet(
              nftContract,
              fireQuantities.get(walletIndex) ?? quantity,
              addr,
              openSeaApiKey,
              {
                timeoutMs: 6000,
                session: opts.sessions?.[walletIndex] ?? null,
                slug,
                chainKey,
              },
            );
            return p ? { walletIndex, addr, payload: p } : null;
          } catch {
            return null;
          }
        })
      );
      for (const g of got) {
        if (!g) continue;
        if (!isPayloadBoundToWallet(g.payload, g.addr)) continue;
        prepolled.set(g.walletIndex, g.payload);
        console.log(chalk.green(`    ✓ Payload in hand early for ${g.addr}`));
      }
    }
    if (prepolled.size > 0) {
      const secs = ((Date.now() - pollStarted) / 1000).toFixed(0);
      console.log(chalk.gray(`  Pre-poll secured ${prepolled.size}/${pendingAtT0.length} payload(s) in ${secs}s.`));
      // Move secured wallets from the T-0 set into ready, so the T-0 fetch only
      // runs for the ones still missing.
      for (let i = pendingAtT0.length - 1; i >= 0; i--) {
        const p = pendingAtT0[i];
        const payload = prepolled.get(p.walletIndex);
        if (!payload) continue;
        // Same stage check as phase 1 — a pre-polled payload is still a payload.
        const refused = stageRefusal(payload, p.walletIndex, p.addr, opts.expectedStage);
        if (refused) {
          results[p.walletIndex] = refused;
          continue;
        }
        ready.push({
          walletIndex: p.walletIndex,
          addr: p.addr,
          to: payload.seaDropAddress,
          data: payload.mintData,
          value: payload.value,
          gasLimit: gasLimit || SIGNED_GAS_FLOOR,
        });
        pendingAtT0.splice(i, 1);
      }
    }
  }

  // ══ WAIT ════════════════════════════════════════════════════════════════
  // Whatever is left AFTER the pre-poll — not the delay computed before it.
  const remainingToT0 = targetStart.getTime() - Date.now();
  if (remainingToT0 > 0) {
    console.log(`  Waiting ${Math.round(remainingToT0 / 1000)}s until target start...`);
    await waitWithKeepAlive(rpcUrls, remainingToT0);
  }

  // ── Optional: hold for a SUPPLY POSITION instead of the wall clock ─────────
  // Token ids are assigned sequentially, so the minted supply at the moment of
  // inclusion decides which ids you receive. To land on `tokenId` with a
  // quantity of q, the mint must START at `tokenId - q + 1`, i.e. the supply
  // must already be `tokenId - q`. This is what turns a "the metadata leaked"
  // finding into an action: the mapping gives a position, not a rarity ranking.
  //
  // Bounded, and it fires anyway on timeout rather than refusing — a mint at
  // the wrong position is still a mint, while a refusal loses it entirely.
  if (opts.fireOnSupplyReached) {
    await waitForSupplyPosition(opts.fireOnSupplyReached, {
      nftContract,
      chainId,
      rpcUrls,
    });
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
  // The re-check is PER WALLET. A drop's per-wallet caps are independent, so
  // one recheck applied to every entry gave wallets with different remaining
  // allocations the same number — quoting an exhausted wallet a fresh
  // allowance and clipping one that had not yet minted.
  if (opts.recheckMintable && ready.length + pendingAtT0.length > 0) {
    const entries = [...ready, ...pendingAtT0];
    const rechecked = await Promise.all(
      entries.map(async (entry) => {
        try {
          return { entry, mintable: await opts.recheckMintable!(entry.addr, quantity) };
        } catch (e: any) {
          // A failed re-check must not stop the fire; the original quantity is
          // still the best information available, and the on-chain revert is
          // the backstop.
          console.log(
            chalk.gray(`  ⚠ Could not re-check the per-wallet limit for ${entry.addr}: ${e?.message ?? e}`)
          );
          return { entry, mintable: null };
        }
      })
    );

    const exhausted = new Set<number>();
    const clamped = new Set<number>();
    for (const { entry, mintable } of rechecked) {
      if (mintable == null) continue;
      const r = reconcileQuantity(quantity, mintable);
      if (r.exhausted) {
        console.log(chalk.red(`  ✗ ${entry.addr} allocation is used up — refusing to mint.`));
        results[entry.walletIndex] = {
          walletIndex: entry.walletIndex,
          walletAddress: entry.addr,
          success: false,
          error: "Per-wallet allocation was used up before T-0.",
        };
        exhausted.add(entry.walletIndex);
        continue;
      }
      if (r.clamped) {
        console.log(
          chalk.yellow(
            `  ⚠ ${entry.addr} limit changed to ${mintable} — minting ${r.quantity} instead of ${quantity}.`
          )
        );
        fireQuantities.set(entry.walletIndex, r.quantity);
        clamped.add(entry.walletIndex);
      }
    }

    // Exhausted wallets must not be broadcast at all; clamped wallets keep
    // their slot but lose the payload fetched for the old quantity, so it is
    // re-fetched at T-0 (below) at the reduced quantity.
    for (const list of [ready, pendingAtT0]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (exhausted.has(list[i].walletIndex)) list.splice(i, 1);
      }
    }
    for (let i = ready.length - 1; i >= 0; i--) {
      if (clamped.has(ready[i].walletIndex)) {
        pendingAtT0.push({ walletIndex: ready[i].walletIndex, addr: ready[i].addr });
        ready.splice(i, 1);
      }
    }
  }

  if (ready.length === 0 && pendingAtT0.length === 0) {
    return results.filter((r): r is SnipeResult => r != null);
  }

  // Wallets held back for a future phase get their payload fetched HERE, after
  // the wait. OpenSea signs a mint only for a live stage, so this is the first
  // moment the payload can exist. A retry window covers the lag between the
  // on-chain start and OpenSea's signer coming online.
  //
  // The fetches are STARTED but not awaited before the fire. A wallet with no
  // payload must not hold back the ones that have one: the pre-poll already
  // spent 30s trying, so a wallet still empty at T-0 is either ineligible or
  // served by a signer that is down — and making the other wallets wait up to
  // T0_PAYLOAD_WINDOW_MS for it loses their mints too.
  //
  // Whoever answers within the short gate joins the first wave; whoever answers
  // after it is blasted in a second wave by the same code path. A wallet whose
  // retry budget runs out is recorded as failed and never blocks anything.
  const stragglerRuns: Promise<void>[] = [];
  const lateWave: ReadyTx[] = [];
  const decided = new Set<number>();
  // Assigned synchronously by the promise executor below; the no-op default
  // keeps the type from narrowing to null at the call site.
  let notifyAllDecided: () => void = () => {};
  const allStragglersDecided = new Promise<void>((resolve) => {
    notifyAllDecided = resolve;
  });
  if (pendingAtT0.length > 0) {
    console.log(
      `  Phase is live — fetching signed payloads for ${pendingAtT0.length} wallet(s)...`
    );
    for (const { walletIndex, addr } of pendingAtT0) {
      stragglerRuns.push(
        (async () => {
          // Retry across a real window: the stage can be live on-chain several
          // seconds before OpenSea's signer will issue a payload for it, and a
          // wallet that is not allowlisted gets the same null as a signer that
          // is still warming up — the two are indistinguishable from the
          // response.
          let payload: FcfsSignedPayload | null = null;
          let lastErr: string | null = null;
          const startedAt = Date.now();
          let attempt = 0;
          try {
            for (;;) {
          attempt++;
          if (attempt > 1) {
            // Fast while signer lag is still plausible, then back off.
            const gap =
              Date.now() - startedAt < T0_PAYLOAD_BACKOFF_AFTER_MS
                ? T0_PAYLOAD_RETRY_MS
                : T0_PAYLOAD_BACKOFF_MS;
            await new Promise((r) => setTimeout(r, gap));
          }
          try {
            payload = await fetchSignedPayloadForWallet(
              nftContract,
              fireQuantities.get(walletIndex) ?? quantity,
              addr,
              openSeaApiKey,
              {
                timeoutMs: 8000,
                session: opts.sessions?.[walletIndex] ?? null,
                slug,
                chainKey,
              },
            );
            if (payload) break;
          } catch (err: any) {
            lastErr = err?.message || String(err);
          }
          const elapsed = Date.now() - startedAt;
          if (elapsed >= T0_PAYLOAD_WINDOW_MS) break;
          // Hard ceiling on attempts as well, so a pathological endpoint that
          // answers instantly with null can never spin in a tight loop.
          if (attempt >= T0_PAYLOAD_MAX_ATTEMPTS) break;
        }
        if (!payload) {
          const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
          results[walletIndex] = {
            walletIndex,
            walletAddress: addr,
            success: false,
            error:
              `No signed payload at T-0 for ${addr} after ${attempt} attempt(s) over ${waited}s` +
              (lastErr ? ` — last error: ${lastErr}` : " — OpenSea did not return signed data."),
            retryable: true,
          };
          return;
        }
        if (!isPayloadBoundToWallet(payload, addr)) {
          results[walletIndex] = {
            walletIndex,
            walletAddress: addr,
            success: false,
            error: `T-0 payload for ${addr} is bound to a different wallet — refusing to broadcast.`,
          };
          return;
        }
        // Same stage check — the T-0 fetch is the one that discovers a future
        // phase's real stage, so it is where a mismatch is most likely.
        const refused = stageRefusal(payload, walletIndex, addr, opts.expectedStage);
        if (refused) {
          results[walletIndex] = refused;
          return;
        }
        lateWave.push({
          walletIndex,
          addr,
          to: payload.seaDropAddress,
          data: payload.mintData,
          value: payload.value,
          gasLimit: gasLimit || SIGNED_GAS_FLOOR,
        });
          } catch (e: any) {
            results[walletIndex] = {
              walletIndex,
              walletAddress: addr,
              success: false,
              error: `T-0 payload fetch failed: ${e?.message ?? e}`,
              retryable: true,
            };
          } finally {
            decided.add(walletIndex);
            if (decided.size === pendingAtT0.length) notifyAllDecided();
          }
        })()
      );
    }
    // Fire the moment the first payload is in hand, then give the others a
    // brief chance to join the same blast. `Promise.race(stragglerRuns)` is
    // what makes this "as soon as ready" rather than a fixed delay; the second
    // race only coalesces the stragglers that were already about to land.
    await Promise.race(stragglerRuns);
    await Promise.race([
      allStragglersDecided,
      new Promise((r) => setTimeout(r, T0_PAYLOAD_COALESCE_MS)),
    ]);
    // Take everything settled so far and empty the array: pushes landing after
    // this belong to the second wave.
    ready.push(...lateWave.splice(0));
  }

  // ── The fire, as a closure over this run's state ────────────────────────────
  // Local rather than module-level so it can read the wallets, chain, fees,
  // providers and results without a ten-argument signature. It runs once per
  // wave: the wallets ready at T-0, then any whose payload landed late.
  const fireWave = async (wave: ReadyTx[]): Promise<void> => {
    if (wave.length === 0) return;

  // The chainId is passed explicitly. Without it ethers performs a network
  // detection (eth_chainId) on the first request — an extra round trip inside
  // the T-0 critical path, and on some endpoints it retries first.
  // Resolve the endpoint ranking BEFORE the fire block. The nonce read, the gas
  // estimate and the simulation all go through this one provider, and a failed
  // gas estimate is do-not-send evidence — so pinning it to rpcUrls[0] let a
  // single dead URL fail every wallet at T-0, even though the blast below had
  // live endpoints to send the same transactions to.
  // Zero budget: a ranking that is not done yet must never hold up the fire.
  let fireUrl = rpcUrls[0];
  try {
    const preFire = await settleRanking(ranking, 0);
    if (preFire && preFire.length > 0 && preFire[0].url) fireUrl = preFire[0].url;
  } catch {
    // Fall back to the first configured endpoint.
  }
  const fireProvider = new JsonRpcProvider(fireUrl, chainId, {
    staticNetwork: true,
    pollingInterval: 1000,
  });
  // `ctx` is kept so the nonce-repair pass can re-sign the same transaction
  // without rebuilding it: to/data/value/gas/fees are all known here, and only
  // the nonce (and the signature over it) changes.
  const toBlast: {
    walletIndex: number;
    addr: string;
    blast: PreparedBlast;
    ctx: {
      to: string;
      data: string;
      value: bigint;
      gasLimit: number;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
    };
  }[] = [];
  try {
    await Promise.all(wave.map(async (r) => {
      const w = new Wallet(walletKeys[r.walletIndex]);
      try {
        const [sim, est] = await Promise.all([
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
        ]);
        // The nonce is the one read here whose value is usually stable, and it
        // measured as the SLOWEST of the three (361-403ms p50 against ~307ms for
        // the simulation and the estimate). Prefer the value read before the
        // wait; only fall back to a T-0 read when there is no prewarmed value.
        //
        // A wallet that sent something during the wait makes that value stale.
        // That case is not silent: every endpoint rejects the broadcast with a
        // nonce error, and the repair pass after the blast re-reads the nonce
        // and re-blasts the same transaction. So the stale case costs one extra
        // round trip rather than costing every wallet its T-0 read.
        const nonce =
          prewarmedNonces.get(r.walletIndex) ??
          (await withDeadlineOrThrow(
            fireProvider.getTransactionCount(r.addr, "pending"),
            2_000,
            "nonce"
          ).catch(() => null));
        if (nonce == null) {
          // No nonce from either read — without one the tx cannot be built.
          throw new Error("Could not read a nonce (RPC timed out and no prewarmed value).");
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
        toBlast.push({
          walletIndex: r.walletIndex,
          addr: r.addr,
          blast: prepareBlast(signed),
          ctx: {
            to: r.to,
            data: r.data,
            value: r.value,
            gasLimit: est ? Number(est.gasLimit) : r.gasLimit,
            maxFeePerGas: est?.maxFeePerGas ?? maxFeePerGas,
            maxPriorityFeePerGas: est?.maxPriorityFeePerGas ?? maxPriorityFeePerGas,
            nonce,
          },
        });
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
    dispatchedAt: Date.now(),
    responsePromise: blastToAll(b.blast, blastEndpoints, {
      firstWave: BLAST_FIRST_WAVE,
      // 350ms, not the 600ms default. The first wave is 1-2 of the fastest
      // endpoints measured by the pre-sort; if neither accepts within 350ms
      // something is wrong with the route, and waiting longer only delays the
      // escalation that will actually land the tx.
      escalateAfterMs: 350,
    }).responsePromise,
  }));

  // Verdicts first, with NO receipt waits. The nonce repair below must not be
  // queued behind a 60s receipt poll.
  const verdicts = await Promise.all(
    inflight.map(async ({ b, dispatchedAt, responsePromise }) => {
      const blastResults = await responsePromise;
      const accepted = blastResults.find((r) => r.txHash != null) ?? null;
      return { b, dispatchedAt, blastResults, accepted };
    })
  );

  const repaired = await repairStaleNonces(verdicts, {
    walletKeys,
    chainId,
    endpoints: blastEndpoints,
    escalateAfterMs: 350,
  });

  const collected = await Promise.all(
    repaired.map(async ({ b, dispatchedAt, blastResults, accepted }) => {
      // Pick the endpoint that actually accepted this wallet's tx — poll THAT
      // endpoint for the receipt so we don't burn time on one that never saw
      // the tx. Resolve by INDEX, never by label: labelFromUrl maps every URL
      // containing "alchemy" to "ALCHEMY" (likewise quicknode/infura/ankr), so a
      // label lookup returns the first match, which may not be the endpoint
      // that accepted — and a receipt polled on a wrong endpoint comes back
      // null, reporting a landed mint as UNKNOWN.
      const acceptingEndpoint =
        accepted && accepted.index < blastEndpoints.length
          ? blastEndpoints[accepted.index]
          : undefined;
      // Poll the accepting endpoint FIRST, then every other one. The endpoint
      // that accepted the tx is not the only place the receipt can be read: if
      // that node falls over before the poll completes, a landed mint is
      // reported UNKNOWN — and the sell-after-mint step then skips a wallet
      // that actually holds the tokens.
      const ordered = acceptingEndpoint
        ? [acceptingEndpoint.url, ...rpcUrls.filter((u) => u !== acceptingEndpoint.url)]
        : rpcUrls;

      let receipt: ConfirmedTx | undefined;
      if (accepted && accepted.txHash) {
        const receiptResult = await waitForReceipt(accepted.txHash, ordered);
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
      return { b, dispatchedAt, blastResults, accepted, receipt };
    })
  );

  for (const { b, dispatchedAt, blastResults, accepted, receipt } of collected) {

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
      dispatchedAt,
    };
  }
  };

  // ── Wave 1: whoever is ready at T-0 ────────────────────────────────────────
  const notifyWave = (wave: number) => {
    if (!opts.onWave) return;
    const snapshot = results.filter((r): r is SnipeResult => r != null);
    try {
      const out = opts.onWave(wave, snapshot) as unknown;
      // Not awaited, so a slow consumer cannot delay the next wave — but an
      // unhandled rejection would still crash the run.
      if (out && typeof (out as Promise<void>)?.then === "function") {
        (out as Promise<void>).catch((e: any) => {
          console.log(chalk.gray(`  ⚠ onWave(${wave}) consumer failed: ${e?.message ?? e}`));
        });
      }
    } catch (e: any) {
      console.log(chalk.gray(`  ⚠ onWave(${wave}) threw: ${e?.message ?? e}`));
    }
  };

  await fireWave(ready);
  notifyWave(1);

  // ── Wave 2: payloads that landed after the gate ────────────────────────────
  // Waited on only after the first wave has been blasted, so a late payload
  // costs the run nothing it had not already lost.
  await Promise.all(stragglerRuns);
  if (lateWave.length > 0) {
    console.log(
      chalk.gray(`  Firing ${lateWave.length} wallet(s) whose payload arrived after T-0...`)
    );
    await fireWave(lateWave);
    notifyWave(2);
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
  const short = `${walletAddress.slice(0, 10)}…${walletAddress.slice(-4)}`;
  const tried: string[] = [];
  // Resolved once, then shared with both paths: the API-key path's REST
  // fallback needs the same wallet JWT the session path sends. Resolving it per
  // path meant the first REST attempt always went out with only the API key.
  const session = opts.session ?? await loadStoredSession();

  // Try API-key-only path first
  if (apiKey && apiKey.trim()) {
    tried.push("api-key");
    const payload = await fetchSignedPayload(nftContract, quantity, apiKey, {
      timeoutMs, slug: opts.slug, walletAddress, chainKey: opts.chainKey,
      accessToken: session?.accessToken ?? null,
    });
    if (payload) {
      // OpenSea binds mintSignature to a wallet. If the returned payload's
      // mintData/signature is not for this wallet, reject it.
      // The mintData calldata encodes the recipient; we check it here.
      // Verify the payload is bound to the requested wallet address before using it.
      if (isPayloadBoundToWallet(payload, walletAddress)) {
        // The T-0 burst spends this key once per wallet; recording it here is
        // what keeps the pool's budget gate honest for the next run.
        noteKeyCall(apiKey);
        say(`  ${short}  payload via ${payload.source ?? "unknown"}`);
        return payload;
      }
      // Not bound to this wallet — reject it, but do NOT give up. The session
      // path below asks OpenSea for a payload bound to THIS wallet, and
      // returning null here dropped the wallet outright.
    }
  }

  // Fall back to session-based fetch, using the session resolved above.
  if (session && session.accessToken) {
    tried.push("session");
    const payload = await fetchSignedPayloadWithSession(
      nftContract, quantity, session, apiKey, { timeoutMs, slug: opts.slug, walletAddress, chainKey: opts.chainKey }
    );
    if (payload && isPayloadBoundToWallet(payload, walletAddress)) {
      if (apiKey) noteKeyCall(apiKey);
      say(`  ${short}  payload via ${payload.source ?? "unknown"}`);
      return payload;
    }
  }

  // Nothing produced a payload. "No payload" on its own reads as "this drop has
  // no signed phase", which is usually wrong — say which surfaces were tried.
  const surfaces = tried.length > 0 ? tried.join(" + ") : "none (no API key, no session)";
  const slugNote = opts.slug ? "" : "; no drop slug, so OpenSea could not be addressed";
  say(`  ${short}  no payload — surfaces tried: ${surfaces}${slugNote}`, "warn");
  return null;
}

// isPayloadBoundToWallet is imported from ./seadrop-calldata — the single
// implementation. A previous duplicate here sliced hex[8,48), which reads the
// nftContract address rather than the minter, so it only ever matched when the
// wallet happened to BE the NFT contract.
