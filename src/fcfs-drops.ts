// ── FCFS drops inventory — fetch ALL active drops for a collection ─────────
//
// OpenSea v2 can return multiple active drops/phases for one collection
// (e.g. an allowlist phase + a public FCFS phase + an OVR phase).
// This module pulls all of them, checks basic eligibility signals, and
// reports so the user can pick the right phase to target.
//
// Also includes gas-state polling so the bot can recommend max fee / priority
// fee settings based on current chain conditions.

import chalk from "chalk";
import { formatEther } from "ethers";
import { fetchOnChainDrops } from "./seadrop-onchain";
import {
  parsePriceToWei,
  getDropEligibility,
  fetchRestEligibility,
  type DropEligibilityResult,
  type DropEligibilityStage,
} from "./opensea-gql";
import { resolveChain } from "./chains";

const OPENSEA_BASE = "https://api.opensea.io";

/**
 * Normalize an OpenSea timestamp to UNIX seconds.
 *
 * GQL returns ISO-8601 strings ("2026-11-01T00:00:00.000Z"); REST returns
 * UNIX seconds as a number or numeric string. Number() on an ISO string is
 * NaN, which previously fell back to 0 and made every stage look like it
 * started at the epoch.
 */
function toUnixSeconds(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : 0;
  const s = String(value).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);            // UNIX seconds
  const parsed = Date.parse(s);                     // ISO-8601
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

// ── Stage type classification ────────────────────────────────────────────────
// OpenSea returns the same concept in different casings per surface: GraphQL
// emits SCREAMING_SNAKE_CASE ("PUBLIC_SALE"), REST emits snake_case
// ("public_sale"). Comparing a raw value against one casing makes the other
// surface's branch dead — a public stage classified non-public silently
// disables the fast local mint path. Normalize once, here.

/** Canonical stage-type tokens we reason about. */
export type StageTypeToken =
  | "public"
  | "allowlist"
  | "ovr"
  | "token_gated"
  | "fcfs"
  | "reserved"
  | "unknown";

/** Normalize any OpenSea stageType casing to a canonical lowercase token. */
export function normalizeStageType(raw: string | null | undefined): StageTypeToken {
  if (!raw || typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "public" || s === "public_sale" || s === "publicsale" || s === "open") return "public";
  // `signed_presale` is one of only two stage types OpenSea actually uses (the
  // other is `public_sale`); the spec's underlying enum still carries the legacy
  // `merkle_presale`. Both are allowlist stages — they need a per-wallet
  // signature. This function used to fall through to "unknown", which made
  // classifyMintMode return "unknown" as well, and the eligibility checker only
  // queries OpenSea for modes "signed"/"allowlist" — so an allowlisted wallet's
  // presale eligibility was never asked about, and only the public stage ever
  // reported as eligible.
  if (s === "allowlist" || s === "allow_list" || s === "allowlisted" || s === "gtd" || s === "guaranteed"
    || s === "signed_presale" || s === "merkle_presale" || s === "signature_presale"
    || s === "signed" || s === "presale") return "allowlist";
  if (s === "ovr" || s === "ovr_allowlist" || s === "override") return "ovr";
  if (s === "token_gated" || s === "tokengated" || s === "token_gate" || s === "gated") return "token_gated";
  if (s === "fcfs" || s === "first_come_first_serve") return "fcfs";
  if (s === "reserved") return "reserved";
  return "unknown";
}

/** True when the stage is open to all — mintable on-chain with no signature. */
export function classifyStageType(raw: string | null | undefined): boolean {
  return normalizeStageType(raw) === "public";
}

/** True when the stage needs a per-wallet server signature. */
export function isSignedStageType(raw: string | null | undefined): boolean {
  const t = normalizeStageType(raw);
  return t === "allowlist" || t === "ovr";
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface DropPhase {
  // OpenSea identity
  dropId: string;
  nftContract: string;
  name: string | null;

  // Phase type — OpenSea may label these "fcfs", "allowlist", "ovr",
  // "reserved", "public", or something else. We keep the raw value.
  type: string | null;

  // Timing
  startTime: number; // UNIX seconds
  endTime: number; // UNIX seconds

  // Mint economics
  mintPrice: bigint; // wei
  maxTotalMintableByWallet: number; // per-wallet limit (0 = unlimited)
  maxTotalMintable: number; // total remaining across all wallets (if reported)
  totalMinted: number; // total minted so far (if reported)

  // Fee
  feeBps: number;
  feeRecipient: string | null;

  // Signed mint data — may be present for some phases, absent for others.
  // If present, this phase can be targeted by the sniper. If absent, the
  // phase exists but we can't get a signed payload for it (yet).
  mintData: string | null;
  mintSignature: string | null;

  // OpenSea-provided gas hints (optional)
  gasLimit: number | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;

  // Eligibility signals — OpenSea may include these in the drop payload.
  // We surface whatever is available; absent fields mean "unknown".
  eligible: boolean | null;       // is the current wallet eligible?
  eligibleCount: number | null;   // how many wallets are eligible (if reported)
  totalAllocated: number | null;  // total slots allocated (if reported)
  eligiblePrice: bigint | null;   // per-wallet eligible price in wei (from GQL)
  allowlistedAddresses: string[]; // explicit allowlist (rarely exposed in full)
  allowlistHash: string | null;   // merkle root or similar, if exposed

  // ── Classification (added to match osnm-z pattern) ──────────────────────
  /** True when this phase is a public/open stage — targetable on-chain with no
   *  OpenSea key or signed payload. Matches osnm-z's PUBLIC_SALE handling:
   *  discovered from metadata, auto-eligible, no session needed. */
  isPublicStage: boolean;

  // Raw OpenSea response fragment (for debugging)
  raw: Record<string, any>;
}

// ── Gas state ───────────────────────────────────────────────────────────────

export interface GasState {
  chainId: number;
  baseFeePerGas: bigint;        // wei — current block base fee
  suggestedMaxFeePerGas: bigint; // wei — baseFee × multiplier + buffer
  suggestedMaxPriorityFeePerGas: bigint; // wei — priority tip
  latestBlockNumber: number;
  gasUsedPercentage: number;    // 0-100, how full the latest block was
  timestamp: number;            // UNIX ms
  urgency: "low" | "normal" | "high" | "extreme";
}

// ── Collection drops inventory ──────────────────────────────────────────────

export interface CollectionDropsInventory {
  nftContract: string;
  chainId: number | null;
  drops: DropPhase[];
  fetchedAt: number;
  apiKeyUsed: boolean;
  /** Why no drops were found, if applicable. */
  notFoundReason?: "not_found" | "rate_limited" | "key_required" | "no_phases" | "network_error";
}

// ── Eligibility report (per drop, per wallet) ───────────────────────────────

export interface EligibilityReport {
  drop: DropPhase;
  ourWalletEligible: boolean | null; // null = can't determine
  allocationRemaining: number | null; // slots left (null = unknown)
  isOverAllocated: boolean | null;   // true if totalMinted >= maxTotalMintable
  recommendation: "target" | "skip" | "check-manually";
  reason: string;
  /** Which path produced the verdict. Absent on reports built purely by
   *  assessDropEligibility, which never talks to OpenSea. */
  source?: EligibilitySource;
  /** Per-wallet quoted price for this stage, in wei (GQL eligiblePrice). */
  priceWei?: bigint | null;
  /** Running cap across every stage up to and including this one. This is NOT
   *  a per-stage limit — see the note on getPhaseEligibility. */
  cap?: number | null;
  /** What the wallet has already minted on this drop, lifetime. */
  minted?: number | null;
}

// ── Gas recommendation ──────────────────────────────────────────────────────

export interface GasRecommendation {
  currentBaseFeeGwei: number;
  currentBaseFeeWei: bigint;
  suggestedMaxFeePerGasWei: bigint;
  suggestedMaxPriorityFeePerGasWei: bigint;
  suggestedGasLimit: number;
  rationale: string;
  urgency: "low" | "normal" | "high" | "extreme";
}

// ── Fetch ALL active drops for a collection ─────────────────────────────────

export async function fetchAllActiveDrops(
  nftContract: string,
  apiKey: string | null | undefined,
  timeoutMs = 15000,
  slug?: string,
  chainKey?: string,
): Promise<CollectionDropsInventory> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey.trim();

  // Use slug if provided (CA→slug resolved), otherwise try CA directly
  const lookupTarget = slug || nftContract;

  let drops: DropPhase[] = [];
  let chainId: number | null = null;
  let lastReason: CollectionDropsInventory["notFoundReason"] | undefined;

  // ── Step 1: GraphQL collectionBySlug (primary) ────────────────────────────
  // Per user requirement: "graphql and gpq should fucking be the default!"
  // GQL returns richer data (stage configs, eligibility, etc.) and works
  // without an API key. REST is the fallback when GQL rate-limits or fails.
  try {
    const gqlDrops = await fetchGraphqlDrops(lookupTarget, apiKey || null, Math.min(timeoutMs, 8000));
    if (gqlDrops.length > 0) {
      drops = gqlDrops;
      // The chain lives on dropBySlug.collection, one level above the stages.
      // The previous code looked for d.raw.chain on each stage, which no
      // longer exists, so chainId was always null.
      const rawDrop = (gqlDrops as any)[0]?.raw;
      const chain = rawDrop?.collection?.chain ?? rawDrop?.chain;
      if (chain?.identifier === "ethereum") chainId = 1;
      else if (typeof chain?.networkId === "number") chainId = chain.networkId;
    } else {
      lastReason = "not_found";
    }
  } catch (err: any) {
    if (err && (err.message === "rate_limited" || err.name === "AbortError" || err.name === "TimeoutError")) {
      lastReason = "rate_limited";
    }
  }

  // ── Step 2: REST fallback (if GQL gave nothing) ───────────────────────────
  // REST /api/v2/drops/{slug} works without an API key for most collections.
  // Only reached if GQL returned empty (rate-limited, not found, or errored).
  if (drops.length === 0) {
    try {
      const res = await fetch(
        `${OPENSEA_BASE}/api/v2/drops/${lookupTarget}`,
        { signal: controller.signal, headers },
      );
      // NOTE: the timer is NOT cleared here. Clearing it before the response
      // body is read leaves the fetch unbounded — the controller is the only
      // thing that can abort it. It is cleared in the finally below.

      if (res.status === 429) {
        lastReason = "rate_limited";
        // Don't abort the whole flow for rate limiting — fall through to on-chain
      } else if (res.status === 401 || res.status === 403) {
        // REST requires an API key. Without one we get 401. Fall through to on-chain.
      } else if (res.status !== 200) {
        // Other non-200 — fall through to on-chain
      } else {
        const json = (await res.json()) as any;
        drops = catalogueDrops(json, nftContract);

        for (const d of drops) {
          // Only accept a numeric chain id. A slug string ("ethereum") turned
          // into NaN, which then propagated into planRpcs and made every
          // endpoint look like a chain mismatch.
          const raw = d.raw.chain_id ?? d.raw.chainId;
          if (raw == null) continue;
          const n = typeof raw === "number" ? raw : Number(raw);
          if (Number.isFinite(n) && n > 0) { chainId = n; break; }
        }
      }
    } catch (err: any) {
      if (err && err.name === "AbortError") {
        return { nftContract, chainId: null, drops: [], fetchedAt: Date.now(), apiKeyUsed: !!apiKey };
      }
      // Network error in REST — fall through to on-chain
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Step 2b: Early return if REST gave nothing and we don't have a slug ─────
  // REST with a raw CA returned nothing — stop, don't waste the on-chain slot.
  if (drops.length === 0 && !slug) {
    return { nftContract, chainId: null, drops: [], fetchedAt: Date.now(), apiKeyUsed: !!apiKey, notFoundReason: lastReason ?? "not_found" };
  }

  // ── Step 3: On-chain SEADROP discovery (if still nothing) ─────────────────
  if (drops.length === 0) {
    try {
      clearTimeout(timer);
      const onChainDrops = await fetchOnChainDrops(nftContract, Math.min(timeoutMs, 15000), chainKey);
      if (onChainDrops.length > 0) {
        drops = onChainDrops;
        // The SeaDrop singleton is deployed on every network, so the chain is
        // whatever we probed — not necessarily Ethereum.
        if (chainId === null) {
          const profile = chainKey ? resolveChain(chainKey) : undefined;
          chainId = profile?.chainId ?? 1;
        }
        // If on-chain found a public drop, mark the reason as resolved
        const hasPublic = onChainDrops.some(d => d.isPublicStage);
        if (hasPublic) lastReason = undefined;
      }
    } catch {
      // On-chain failed — return whatever we have (empty)
    }
  }

  if (drops.length === 0 && lastReason === undefined) {
    lastReason = "no_phases";
  }

  // Sort ONCE, here at the boundary, so every consumer sees the same order.
  // Returning a sorted copy (the previous behaviour) left inventory.drops
  // unsorted while reportInventoryEligibility produced sorted reports, so
  // printDropsInventory paired each phase with another phase's report.
  sortByStartTime(drops);

  return {
    nftContract,
    chainId,
    drops,
    fetchedAt: Date.now(),
    apiKeyUsed: !!apiKey,
    notFoundReason: lastReason,
  };
}

// ── GraphQL drops query (PRIMARY) ──────────────────────────────────────────────
// OpenSea v2 GraphQL: gql.opensea.io/graphql
// Collection drops are exposed via collectionBySlug → stages connection.
// We query both stages.list and the active/next stage shortcuts.
//
// NOTE: The GQL API is aggressively rate-limited (429) as of late 2026.
// We use it as the PRIMARY source (per user requirement: GraphQL first),
// with a short timeout and REST as fallback when GQL fails.

async function fetchGraphqlDrops(
  lookupTarget: string,
  apiKey?: string | null,
  timeoutMs = 10000,
): Promise<DropPhase[]> {
  const gqlUrl = "https://gql.opensea.io/graphql";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    origin: "https://opensea.io",
    referer: `https://opensea.io/collection/${lookupTarget}`,
    "x-app-id": "os2-web",
  };
  if (apiKey && apiKey.trim()) headers["X-API-KEY"] = apiKey.trim();

  let slug = lookupTarget;
  // If the target is a CA, try on-chain discovery instead of slug resolution
  // for the GQL query. GQL collectionBySlug needs a slug, but if we can't
  // resolve one without an API key the CA is used directly as fallback.
  if (lookupTarget.toLowerCase().startsWith("0x")) {
    slug = lookupTarget; // use CA as slug — GQL may still return results
  }

  // Live-verified against the OpenSea schema (collectr, 2026-11-05; re-checked
  // 2026-11-08). `collectionBySlug` DOES answer collection metadata
  // (`... on Collection { slug address chain { identifier networkId } }`) — that
  // is what slug-resolver.ts uses — but it does not expose drop stages, and the
  // older `CollectionDropStage` inline fragment does not exist. `dropBySlug` is
  // the working root for stages; see GQL_QUERY_TEXTS.CollectionDropsQuery in
  // opensea-gql.ts for the field-by-field verification.
  const query = `
    query CollectionDrops($slug: String!) {
      dropBySlug(slug: $slug) {
        __typename
        collection { slug name address chain { identifier networkId } }
        stages {
          __typename
          uuid
          stageType
          stageIndex
          label
          startTime
          endTime
          maxTotalMintableByWallet
          allowlistMemberCount
          price { token { unit symbol contractAddress chain { identifier } } }
        }
      }
    }
  `;

  const body = JSON.stringify({
    query,
    variables: { slug },
    operationName: "CollectionDrops",
  });

  try {
    const res = await fetch(gqlUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) throw new Error("rate_limited");
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    // Use whatever data OpenSea returned. A non-fatal field error (an
    // unauthorized eligibility field, a deprecated subfield) must not discard a
    // perfectly good inventory — bailing out here made a partial response
    // indistinguishable from "this collection has no drop", which is how a run
    // could report zero phases while the collection plainly had them.
    const drop = json.data?.dropBySlug;
    if (!drop) return [];

    // The collection lives one level up from the stages on dropBySlug.
    const coll = drop.collection ?? {};
    const stageSources: any[] = Array.isArray(drop.stages) ? drop.stages : [];

    const drops: DropPhase[] = [];
    for (const c of stageSources) {
      if (!c || typeof c !== "object") continue;

      // Fields: GQL uses camelCase; REST uses snake_case. Accept both.
      const uuid = c.uuid || c.id || c.drop_id || c.hash || "";
      const contract = (
        coll.address || c.contract_address || c.nftContract || c.contractAddress || c.address || ""
      ).toLowerCase();

      // Only include stages for our target contract (when we can identify it).
      // `lookupTarget` may be a slug OR a contract address, so compare against
      // both. The previous code compared the contract address to the raw
      // lookupTarget, which never matched when a slug was passed — every stage
      // was dropped and the inventory came back empty.
      const target = lookupTarget.toLowerCase();
      if (target.startsWith("0x")) {
        // Address lookup: the stage's collection must be that exact contract.
        if (contract !== target) continue;
      }
      // Slug lookup: dropBySlug is already scoped to the collection, so every
      // stage it returns belongs to the requested drop.

      // GQL returns ISO-8601 strings ("2026-11-01T00:00:00.000Z"); REST returns
      // UNIX seconds. Number() on an ISO string yields NaN, which fell back to
      // 0 — making every stage look like it started at the epoch.
      const startTime = toUnixSeconds(c.start_time ?? c.startTime ?? c.start);
      const endTime = toUnixSeconds(c.end_time ?? c.endTime ?? c.end);
      const stageType = c.stage_type || c.stageType || c.type || c.kind || null;
      const label = c.label || c.name || c.title || c.displayName || null;

      // GQL returns price.token.unit as an ETH float (0.0056); REST returns a
      // wei decimal string ("5600000000000000"). parsePriceToWei handles both
      // and never throws — the previous BigInt(String(...)) threw on floats and
      // silently emptied the whole inventory.
      const mintPrice = parsePriceToWei(
        c.price?.token?.unit ?? c.price ?? c.mintPrice ?? c.mint_price ?? c.mintPriceWei ?? 0
      );
      const maxPerWallet = Number(
        c.max_per_wallet || c.maxPerWallet || c.maxTotalMintableByWallet ||
        c.max_total_mintable_by_wallet || c.max_total || 0
      );
      const maxTotal = Number(
        c.maxTotalMintable || c.max_total_mintable || c.maxTotal || c.max_total ||
        c.capacity || 0
      );
      const totalMinted = Number(
        c.total_minted || c.totalMinted || c.minted || c.mintedCount || c.minted_count || 0
      );

      const mintData = c.mintData || c.mint_data || c.calldata || c.data || null;
      const mintSignature = c.mintSignature || c.mint_signature || c.signature || null;
      const feeRecipient = c.fee_recipient || c.feeRecipient || c.fee_receipient || null;
      const allowlistHash = c.allowlist_hash || c.allowlistHash || c.merkle_root || c.merkleRoot || c.root || null;
      const gasLimit = Number(c.gas_limit || c.gasLimit || c.gas || 0) || null;
      const maxFeePerGas = c.max_fee_per_gas || c.maxFeePerGas || c.maxFee || null;
      const maxPriorityFeePerGas = c.max_priority_fee_per_gas || c.maxPriorityFeePerGas || c.maxPriorityFee || null;

      const eligible = c.eligible != null ? Boolean(c.eligible) : null;
      const eligibleCount = Number(
        c.eligible_count || c.eligibleCount || c.eligibleWallets || c.eligible_wallets || c.eligibleCountTotal || 0
      ) || null;
      const totalAllocated = Number(
        c.total_allocated || c.totalAllocated || c.allocated || c.slotsUsed || c.slots_used || 0
      ) || null;

      const allowlistedAddresses: string[] = [];
      const rawAddrs = c.allowlisted_addresses || c.allowlistedAddresses || c.allowlist || c.allowList || [];
      if (Array.isArray(rawAddrs)) {
        for (const a of rawAddrs) {
          if (typeof a === "string") allowlistedAddresses.push(a);
          else if (a?.address) allowlistedAddresses.push(a.address);
        }
      }

      const feeBpsVal = c.fee_bps != null ? Number(c.fee_bps) : (c.feeBps != null ? Number(c.feeBps) : 0);

      drops.push({
        dropId: uuid,
        nftContract: contract || c.nftContract || c.contractAddress || c.address,
        name: label,
        type: stageType,
        startTime,
        endTime,
        mintPrice,
        maxTotalMintableByWallet: maxPerWallet,
        maxTotalMintable: maxTotal,
        totalMinted,
        feeBps: feeBpsVal,
        feeRecipient: feeRecipient || null,
        mintData,
        mintSignature,
        gasLimit,
        maxFeePerGas: maxFeePerGas ? parsePriceToWei(maxFeePerGas) : null,
        maxPriorityFeePerGas: maxPriorityFeePerGas ? parsePriceToWei(maxPriorityFeePerGas) : null,
        eligible,
        eligibleCount,
        totalAllocated,
        eligiblePrice: c.eligiblePrice != null
        ? parsePriceToWei(c.eligiblePrice?.token?.unit ?? c.eligiblePrice)
        : null,
        allowlistedAddresses,
        allowlistHash,
        // `raw` carries the stage plus the drop-level collection/chain, so
        // callers can recover the chain without a second request.
        raw: { ...c, collection: coll, chain: coll?.chain } as Record<string, any>,
        isPublicStage: classifyStageType(stageType),
      });
    }

    return drops;
  } catch (err: any) {
    // A 429 is a rate-limit, not an empty inventory — the caller must be able
    // to tell "OpenSea throttled us" apart from "this collection has no drop".
    // Rethrow it so fetchAllActiveDrops can record rate_limited; everything
    // else (malformed payload, network blip) still degrades to empty.
    //
    // A timeout is the same kind of "we could not tell", and the caller already
    // knows how to classify it (fetchAllActiveDrops checks for TimeoutError) —
    // but only if this catch does not swallow it first. AbortSignal.timeout
    // rejects with a DOMException named TimeoutError, not a message of
    // "rate_limited", so the old single-condition check never let it through.
    if (err && (err.message === "rate_limited" || err.name === "TimeoutError" || err.name === "AbortError")) {
      throw err;
    }
    return [];
  }
}

// ── catalogueDrops helper ─────────────────────────────────────────────────
// Parses raw OpenSea REST or GQL responses into DropPhase[].
//
// Real OpenSea v2 /api/v2/drops/{slug} returns:
//   { drops: [{ contract_address, collection_slug, chain, stages: [...],
//               active_stage, next_stage, ... }] }
// Each stage: { uuid, stage_type, label, start_time, end_time, price,
//               max_per_wallet, ...optional CollectionDropStage fields }
//
// Also handles GQL shapes (stages.edges[].node, activeStage, nextStage)
// and guessed shapes for backward compat.
function catalogueDrops(json: any, nftContract: string): DropPhase[] {
  const stageObjects: any[] = [];

  // Shape 1 (real v2 REST): { drops: [{ contract_address, stages: [...] }] }
  if (json?.drops && Array.isArray(json.drops)) {
    for (const drop of json.drops) {
      const contract = (
        drop.contract_address ||
        drop.nftContract ||
        drop.address ||
        ""
      ).toLowerCase();
      if (contract && nftContract && contract !== nftContract.toLowerCase()) continue;

      // Collect stages from this drop
      if (drop.stages && Array.isArray(drop.stages)) {
        for (const s of drop.stages) stageObjects.push(s);
      }
      // Also pull active_stage and next_stage if present
      if (drop.active_stage && typeof drop.active_stage === "object") stageObjects.push(drop.active_stage);
      if (drop.next_stage && typeof drop.next_stage === "object") stageObjects.push(drop.next_stage);
    }
  }

  // Shape 2 (GQL collectionBySlug → stages edges): [{ uuid, stageType, ... }]
  if (json?.stages?.edges && Array.isArray(json.stages.edges)) {
    for (const edge of json.stages.edges) {
      if (edge?.node) stageObjects.push(edge.node);
    }
  }
  if (json?.activeStage && typeof json.activeStage === "object") stageObjects.push(json.activeStage);
  if (json?.nextStage && typeof json.nextStage === "object") stageObjects.push(json.nextStage);

  // Shape 3 (direct array — some endpoints return [DropPhase])
  if (Array.isArray(json) && json.length > 0 && typeof json[0] === "object") {
    stageObjects.push(...json);
  }

  const drops: DropPhase[] = [];

  for (const c of stageObjects) {
    if (!c || typeof c !== "object") continue;

    // Fields: real v2 API uses snake_case; older/guessed shapes may use camelCase
    const uuid = c.uuid || c.id || c.drop_id || c.hash || "";
    const contract = (
      c.contract_address || c.nftContract || c.contractAddress || c.address || ""
    ).toLowerCase();

    // Only include stages for our target contract (when we can identify it)
    if (contract && nftContract && contract !== nftContract.toLowerCase()) continue;

    const startTime = toUnixSeconds(c.start_time ?? c.startTime ?? c.start);
    const endTime = toUnixSeconds(c.end_time ?? c.endTime ?? c.end);
    const stageType = c.stage_type || c.stageType || c.type || c.kind || null;
    const label = c.label || c.name || c.title || c.displayName || null;

    // GQL price is an ETH float; REST price is a wei decimal string.
    const mintPrice = parsePriceToWei(
      c.price?.token?.unit ?? c.price ?? c.mintPrice ?? c.mint_price ?? c.mintPriceWei ?? 0
    );
    const maxPerWallet = Number(
      c.max_per_wallet || c.maxPerWallet || c.maxTotalMintableByWallet ||
      c.max_total_mintable_by_wallet || c.max_total || 0
    );
    const maxTotal = Number(
      c.maxTotalMintable || c.max_total_mintable || c.maxTotal || c.max_total ||
      c.capacity || 0
    );
    const totalMinted = Number(
      c.total_minted || c.totalMinted || c.minted || c.mintedCount || c.minted_count || 0
    );

    const mintData = c.mintData || c.mint_data || c.calldata || c.data || null;
    const mintSignature = c.mintSignature || c.mint_signature || c.signature || null;
    const feeRecipient = c.fee_recipient || c.feeRecipient || c.fee_receipient || null;
    const allowlistHash = c.allowlist_hash || c.allowlistHash || c.merkle_root || c.merkleRoot || c.root || null;
    const gasLimit = Number(c.gas_limit || c.gasLimit || c.gas || 0) || null;
    const maxFeePerGas = c.max_fee_per_gas || c.maxFeePerGas || c.maxFee || null;
    const maxPriorityFeePerGas = c.max_priority_fee_per_gas || c.maxPriorityFeePerGas || c.maxPriorityFee || null;

    const eligible = c.eligible != null ? Boolean(c.eligible) : null;
    const eligibleCount = Number(
      c.eligible_count || c.eligibleCount || c.eligibleWallets || c.eligible_wallets || c.eligibleCountTotal || 0
    ) || null;
    const totalAllocated = Number(
      c.total_allocated || c.totalAllocated || c.allocated || c.slotsUsed || c.slots_used || 0
    ) || null;

    const allowlistedAddresses: string[] = [];
    const rawAddrs = c.allowlisted_addresses || c.allowlistedAddresses || c.allowlist || c.allowList || [];
    if (Array.isArray(rawAddrs)) {
      for (const a of rawAddrs) {
        if (typeof a === "string") allowlistedAddresses.push(a);
        else if (a?.address) allowlistedAddresses.push(a.address);
      }
    }

    const feeBpsVal = c.fee_bps != null ? Number(c.fee_bps) : (c.feeBps != null ? Number(c.feeBps) : 0);

    drops.push({
      dropId: uuid,
      nftContract: contract || c.nftContract || c.contractAddress || c.address,
      name: label,
      type: stageType,
      startTime,
      endTime,
      mintPrice,
      maxTotalMintableByWallet: maxPerWallet,
      maxTotalMintable: maxTotal,
      totalMinted,
      feeBps: feeBpsVal,
      feeRecipient: feeRecipient || null,
      mintData,
      mintSignature,
      gasLimit,
      maxFeePerGas: maxFeePerGas ? parsePriceToWei(maxFeePerGas) : null,
      maxPriorityFeePerGas: maxPriorityFeePerGas ? parsePriceToWei(maxPriorityFeePerGas) : null,
      eligible,
      eligibleCount,
      totalAllocated,
      eligiblePrice: c.eligiblePrice != null
        ? parsePriceToWei(c.eligiblePrice?.token?.unit ?? c.eligiblePrice)
        : null,
      allowlistedAddresses,
      allowlistHash,
      raw: c as Record<string, any>,
      // A stage is public only when OpenSea says so via stageType. Do NOT infer
      // it from absent mintData/mintSignature — a signed stage before its
      // payload is published has null signed fields but is not public.
      isPublicStage: classifyStageType(stageType),
    });
  }

  return drops;
}


// ── Per-wallet, per-stage eligibility ────────────────────────────────────────
//
// OpenSea answers eligibility for the WHOLE collection, not for one phase, and
// only when the request carries a wallet JWT — X-API-KEY alone comes back with
// isEligible:null and UNAUTHORIZED. So a per-phase verdict needs a session, a
// slug, and a stage UUID to scope the response to. This is the one place that
// logic lives: the wizard's probe and the FCFS / --eligibility reports both come
// through here. assessDropEligibility below is only the fallback for when no
// session or slug is available.
//
// Cap semantics: max_total_mintable_by_wallet is a RUNNING cap — the summed
// limits of every stage up to and including this one that the wallet is listed
// on, clamped to supply. SeaDrop checks it against the wallet's LIFETIME minted
// count on the contract, so what is left to mint is cap − minted. It is not a
// per-stage limit, and it is not "slots remaining in this phase".

export type EligibilitySource = "gql" | "rest" | "local";

export interface PhaseEligibilityVerdict {
  stageUuid: string | null;
  /** null = unknown. Callers must never treat null as false. */
  eligible: boolean | null;
  reason: string;
  source: EligibilitySource;
  /** Per-wallet quoted price for this stage, in wei. */
  priceWei: bigint | null;
  /** Running cap across every stage up to and including this one. */
  cap: number | null;
  /** What the wallet has already minted on this drop, lifetime. */
  minted: number | null;
  /** cap − minted, clamped at 0. */
  capRemaining: number | null;
  /** Every stage row OpenSea returned, for reporting. */
  stages: DropEligibilityStage[];
}

/**
 * cap − minted. A null cap means unknown. A null minted count is treated as 0 —
 * the cap is still a valid upper bound on what the wallet may mint.
 */
function capRemaining(cap: number | null, minted: number | null): number | null {
  if (cap == null) return null;
  return Math.max(0, cap - (minted ?? 0));
}

/**
 * Narrow a whole-collection stage list to the one phase being asked about.
 *
 * Returns null when the verdict cannot be attributed to this phase. That is the
 * honest answer and must not be replaced by "eligible" off the back of an open
 * public stage elsewhere in the same collection — which is exactly the mistake
 * that made every presale phase look eligible.
 */
function scopeStages<T>(
  stages: T[],
  matchUuid: string | null,
  getUuid: (s: T) => string | null | undefined,
): T[] | null {
  if (matchUuid) {
    const scoped = stages.filter((s) => {
      const u = getUuid(s);
      return u != null && String(u).toLowerCase() === matchUuid;
    });
    return scoped.length > 0 ? scoped : null;
  }
  // The phase carries no OpenSea stage uuid (on-chain phases have none). With a
  // single stage in the collection that stage IS this phase; with several there
  // is nothing to attribute the verdict to.
  return stages.length === 1 ? stages : null;
}

function verdictToReport(drop: DropPhase, v: PhaseEligibilityVerdict): EligibilityReport {
  // 0 means "unknown", never 1970 — an unknown end time must not read as "this
  // phase has already ended".
  const isPast = drop.endTime > 0 && Date.now() >= drop.endTime * 1000;
  const overAllocated =
    drop.totalMinted != null && drop.maxTotalMintable > 0 &&
    drop.totalMinted >= drop.maxTotalMintable;

  let recommendation: EligibilityReport["recommendation"];
  if (isPast) recommendation = "skip";
  else if (v.eligible === true) {
    recommendation = v.capRemaining != null && v.capRemaining <= 0 ? "skip" : "target";
  } else if (v.eligible === false) recommendation = "skip";
  else recommendation = "check-manually";

  return {
    drop,
    ourWalletEligible: v.eligible,
    allocationRemaining: v.capRemaining,
    isOverAllocated: overAllocated,
    recommendation,
    reason: v.reason,
    source: v.source,
    priceWei: v.priceWei,
    cap: v.cap,
    minted: v.minted,
  };
}

/**
 * Ask OpenSea whether `wallet` can mint `drop`, scoped to that one stage.
 *
 * Order: public stages answer locally (no session needed) → GQL → REST → null.
 * Returning null means "no attributable verdict" — callers fall back to
 * assessDropEligibility rather than guessing.
 */
export async function getPhaseEligibility(args: {
  drop: DropPhase;
  wallet: string;
  slug?: string | null;
  cookie?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}): Promise<EligibilityReport | null> {
  const { drop } = args;
  const wallet = args.wallet?.trim().toLowerCase() || "";
  const slug = args.slug?.trim() || null;
  const cookie = args.cookie || null;
  const apiKey = args.apiKey || null;
  const timeoutMs = args.timeoutMs ?? 12000;
  const matchUuid = drop.dropId ? String(drop.dropId).toLowerCase() : null;

  // Public stages are open to everyone and OpenSea leaves their per-wallet
  // fields null — no session, no query. classifyMintMode already marks them
  // fireableLocally, so this is the whole answer.
  if (drop.isPublicStage) {
    return verdictToReport(drop, {
      stageUuid: matchUuid,
      eligible: true,
      reason: "Public stage — open to all, no allowlist required.",
      source: "local",
      priceWei: drop.eligiblePrice ?? drop.mintPrice,
      cap: drop.maxTotalMintableByWallet || null,
      minted: null,
      capRemaining: computeAllocationRemaining(drop),
      stages: [],
    });
  }

  // Both surfaces are wallet-scoped and need the JWT. Without a cookie there is
  // nothing to ask, so go straight to the local fallback.
  if (slug && cookie) {
    let gql: DropEligibilityResult | null = null;
    try {
      gql = await getDropEligibility(slug, wallet, cookie, apiKey, timeoutMs);
    } catch {
      gql = null;
    }

    if (gql && gql.authed) {
      const scoped = scopeStages(gql.stages, matchUuid, (s) => s.uuid);
      if (scoped) {
        // A stage naming a DIFFERENT wallet is not about us. Ignore it — but do
        // not let one foreign stage discard the stages that are about us.
        const foreign = new Set(
          scoped
            .filter((s) => s.eligibleMinterAddress &&
              s.eligibleMinterAddress.toLowerCase() !== wallet)
            .map((s) => s.eligibleMinterAddress as string),
        );
        const trustworthy = scoped.filter(
          (s) => !s.eligibleMinterAddress ||
            s.eligibleMinterAddress.toLowerCase() === wallet,
        );
        const cap = trustworthy.find((s) => s.maxPerWallet != null)?.maxPerWallet ?? null;
        const quoted = trustworthy.find((s) => s.priceUnit != null);

        let eligible: boolean;
        let reason: string;
        if (trustworthy.length === 0) {
          eligible = false;
          reason = `OpenSea returned eligibility only for ${[...foreign].join(", ")}, not ${wallet} — ignoring.`;
        } else if (trustworthy.some((s) => s.isEligible === true)) {
          eligible = true;
          reason = foreign.size > 0
            ? `OpenSea: eligible for this stage (${foreign.size} stage(s) in the response belonged to other wallets).`
            : "OpenSea: wallet is eligible for this stage.";
        } else {
          eligible = false;
          reason = foreign.size > 0
            ? `Not eligible for this stage (${foreign.size} stage(s) belonged to other wallets).`
            : "OpenSea: wallet is authenticated but not eligible for this stage.";
          // accountStageEligibility.wallets[] is the only place OpenSea reports
          // how many OTHER wallets hold eligibility. It is the difference between
          // "not allowlisted" and "competing with 500 allowlisted wallets", so
          // surface it rather than computing it and dropping it on the floor.
          const otherEligible = gql.otherEligibleByStage
            ? Object.values(gql.otherEligibleByStage).reduce((a, b) => a + (b || 0), 0)
            : 0;
          if (otherEligible > 0) {
            reason += ` ${otherEligible} other wallet(s) hold eligibility across this drop's stages.`;
          }
        }

        return verdictToReport(drop, {
          stageUuid: matchUuid,
          eligible,
          reason,
          source: "gql",
          priceWei: quoted?.priceUnit != null ? parsePriceToWei(quoted.priceUnit) : null,
          cap,
          minted: gql.minted,
          capRemaining: capRemaining(cap, gql.minted),
          stages: gql.stages,
        });
      }
    }

    // REST fallback when GQL yielded nothing usable (rate-limited, or the
    // eligibility fields came back UNAUTHORIZED).
    let rest: Awaited<ReturnType<typeof fetchRestEligibility>> = null;
    try {
      rest = await fetchRestEligibility(slug, cookie, apiKey, timeoutMs);
    } catch {
      rest = null;
    }
    if (rest) {
      const scoped = scopeStages(rest.stages, matchUuid, (s) => s.stageUuid);
      if (scoped) {
        const anyEligible = scoped.some((s) => s.isEligible === true);
        const anyUnknown = scoped.some((s) => s.isEligible === null);
        const cap = scoped.find((s) => s.maxTotalMintableByWallet != null)
          ?.maxTotalMintableByWallet ?? null;
        let eligible: boolean | null;
        let reason: string;
        if (anyEligible) {
          eligible = true;
          reason = "REST eligibility: wallet is eligible for this stage.";
        } else if (anyUnknown) {
          // Not a negative verdict — the endpoint could not tell.
          eligible = null;
          reason = "REST eligibility: unknown (no per-wallet verdict).";
        } else {
          eligible = false;
          reason = "REST eligibility: wallet is not eligible for this stage.";
        }
        return verdictToReport(drop, {
          stageUuid: matchUuid,
          eligible,
          reason,
          source: "rest",
          priceWei: scoped.find((s) => s.price != null)?.price ?? null,
          cap,
          minted: null,
          capRemaining: capRemaining(cap, null),
          stages: [],
        });
      }
    }
  }

  return null;
}

// ── Eligibility report for a single drop (local fallback) ────────────────────
//
// Never talks to OpenSea. getPhaseEligibility is the network-backed path; this
// is what callers use when no session or slug is available.

export function assessDropEligibility(
  drop: DropPhase,
  ourWallet: string,
): EligibilityReport {
  const wallet = ourWallet?.trim().toLowerCase() || "";
  const overAllocated =
    drop.totalMinted != null && drop.maxTotalMintable > 0 &&
    drop.totalMinted >= drop.maxTotalMintable;

  // A public stage is open to everyone — no signature, no allowlist — and
  // classifyMintMode already marks it fireableLocally. OpenSea's per-wallet
  // eligibility fields are null for public stages (the inventory query does not
  // fetch them), so without this short-circuit a public phase fell through to
  // "check-manually" and the FCFS branch reported zero targetable phases.
  if (drop.isPublicStage) {
    const remaining = computeAllocationRemaining(drop);
    // 0 means "unknown", never 1970.
    const isPast = drop.endTime > 0 && Date.now() >= drop.endTime * 1000;
    if (isPast) {
      return {
        drop,
        ourWalletEligible: true,
        allocationRemaining: remaining,
        isOverAllocated: overAllocated,
        recommendation: "skip",
        reason: "Public phase has ended.",
      };
    }
    return {
      drop,
      ourWalletEligible: true,
      allocationRemaining: remaining,
      isOverAllocated: overAllocated,
      recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
      reason: "Public phase — open to all, no allowlist required.",
    };
  }

  // An all-zeros allowlistHash is the on-chain "no allowlist configured" stub,
  // not a real allowlist. classifyMintMode already guards against it; this
  // function did not, so a stub hash made an ordinary phase look like an
  // allowlist phase and report "check-manually" instead of its real status.
  const rawHash = drop.allowlistHash || "";
  const hexPart = rawHash.startsWith("0x") ? rawHash.slice(2) : rawHash;
  const hasRealAllowlistHash =
    hexPart.length >= 2 && ![...hexPart].every((c) => c === "0");

  // OVR / allowlist phases — these need per-wallet signed data (mintSignature)
  // fetched from OpenSea. Report them as targetable only if we have a signed
  // payload, otherwise flag for manual check (need session + allowlist tree).
  if (drop.type === "ovr" || hasRealAllowlistHash ||
      drop.allowlistedAddresses.length > 0 ||
      (drop.type && /ovr|allowlist|allow_list/i.test(drop.type))) {
    // When OpenSea returned the actual allowlist, membership is decisive and
    // needs no session. This is the one eligibility question answerable from
    // data already in hand — every other branch needs a per-wallet signed
    // payload, which requires a live session.
    if (drop.allowlistedAddresses.length > 0 && wallet) {
      const onAllowlist = drop.allowlistedAddresses.some(
        (a) => a.toLowerCase() === wallet
      );
      const remaining = computeAllocationRemaining(drop);
      if (onAllowlist) {
        return {
          drop,
          ourWalletEligible: true,
          allocationRemaining: remaining,
          isOverAllocated: overAllocated,
          recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
          reason: `Wallet is in the ${drop.allowlistedAddresses.length}-address allowlist OpenSea returned.`,
        };
      }
      return {
        drop,
        ourWalletEligible: false,
        allocationRemaining: remaining,
        isOverAllocated: overAllocated,
        recommendation: "skip",
        reason: `Wallet is not in the ${drop.allowlistedAddresses.length}-address allowlist OpenSea returned.`,
      };
    }
    if (drop.mintData) {
      // Pre-fetched signed payload — this wallet can target it
      const remaining = computeAllocationRemaining(drop);
      return {
        drop,
        ourWalletEligible: true, // signed payload means we're in the allowlist
        allocationRemaining: remaining,
        isOverAllocated: overAllocated,
        recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
        reason: "OVR/allowlist phase with signed mint data — wallet is allowlisted.",
      };
    }
    // No signed data yet — needs pre-fetch. Mark as check-manually so the
    // caller knows to run the pre-fetch step before this becomes targetable.
    return {
      drop,
      ourWalletEligible: null,
      allocationRemaining: computeAllocationRemaining(drop),
      isOverAllocated: overAllocated,
      recommendation: "check-manually",
      reason: "OVR/allowlist phase detected but no signed mint data available. " +
        "Run pre-fetch (fetchSignedPayload) to get the per-wallet signature.",
    };
  }

  // If OpenSea explicitly says we're not eligible, that's clear
  if (drop.eligible === false) {
    // OpenSea says not eligible. For OVR/allowlist phases specifically,
    // a future-dated phase with signed mint data is still targetable.
    // Only skip if the phase is already past and has no signed data.
    const now = Date.now();
    // 0 means "unknown", never 1970 — an unknown end time must not read as
    // "this phase has already ended".
    const isPast = drop.endTime > 0 && now >= drop.endTime * 1000;

    if (drop.type === "ovr" || drop.allowlistHash ||
        drop.allowlistedAddresses.length > 0 ||
        (drop.type && /ovr|allowlist|allow_list/i.test(drop.type))) {
      // OVR/allowlist: isPast + no signed data → skip; otherwise still targetable
      if (isPast && (!drop.mintData)) {
        return {
          drop,
          ourWalletEligible: false,
          allocationRemaining: null,
          isOverAllocated: null,
          recommendation: "skip",
          reason: "OVR/allowlist phase has ended and OpenSea reports ineligible.",
        };
      }
      if (drop.mintData) {
        const remaining = computeAllocationRemaining(drop);
        return {
          drop,
          ourWalletEligible: null,
          allocationRemaining: remaining,
          isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
            drop.totalMinted >= drop.maxTotalMintable,
          recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
          reason: "OpenSea reports ineligible, but OVR/allowlist phase has signed data — " +
            "targetable with pre-signed payload.",
        };
      }
      return {
        drop,
        ourWalletEligible: null,
        allocationRemaining: computeAllocationRemaining(drop),
        isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
          drop.totalMinted >= drop.maxTotalMintable,
        recommendation: "check-manually",
        reason: "OVR/allowlist phase, OpenSea reports ineligible, no signed data yet. " +
          "Run pre-fetch (fetchSignedPayload) to get the per-wallet signature.",
      };
    }

    // Non-OVR: OpenSea says not eligible — but for a sniper, a future-dated phase
    // with signed mint data is still targetable. Prep now; fire at T-0.
    // Only skip if the phase is already past and has no signed data.
    if (isPast && (!drop.mintData)) {
      return {
        drop,
        ourWalletEligible: false,
        allocationRemaining: null,
        isOverAllocated: null,
        recommendation: "skip",
        reason: "Phase has ended and OpenSea reports ineligible.",
      };
    }
    // Phase may be in the future — still targetable if it has signed data
    if (drop.mintData) {
      const remaining = computeAllocationRemaining(drop);
      return {
        drop,
        ourWalletEligible: null, // recheck eligibility at fire time if possible
        allocationRemaining: remaining,
        isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
          drop.totalMinted >= drop.maxTotalMintable,
        recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
        reason: "OpenSea reports ineligible, but phase has signed data — " +
          "targetable with pre-signed payload. Eligibility rechecked at fire time.",
      };
    }
    // No signed data — can't snipe this way
    return {
      drop,
      ourWalletEligible: false,
      allocationRemaining: computeAllocationRemaining(drop),
      isOverAllocated: null,
      recommendation: "check-manually",
      reason: "OpenSea reports ineligible and no signed mint data available. " +
        "May need a different approach (merkle proof, direct contract call, etc.).",
    };
  }

  // If OpenSea explicitly says we ARE eligible, great
  if (drop.eligible === true) {
    const remaining = computeAllocationRemaining(drop);
    return {
      drop,
      ourWalletEligible: true,
      allocationRemaining: remaining,
      isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
        drop.totalMinted >= drop.maxTotalMintable,
      recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
      reason: remaining !== null && remaining <= 0
        ? "Phase appears fully allocated."
        : "Wallet appears eligible.",
    };
  }

  // If we have mintData + mintSignature, we can at least attempt it.
  // The signature is wallet-specific, so we won't know if it works until
  // we try to get one per wallet. But the phase is targetable.
  if (drop.mintData) {
    const remaining = computeAllocationRemaining(drop);
    return {
      drop,
      ourWalletEligible: null, // can't tell without getting a per-wallet sig
      allocationRemaining: remaining,
      isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
        drop.totalMinted >= drop.maxTotalMintable,
      recommendation: remaining !== null && remaining <= 0 ? "skip" : "target",
      reason: "Phase has signed mint data — targetable, but eligibility "
        + "must be confirmed by fetching a per-wallet signature.",
    };
  }

  // Phase exists but no signed data available — can't snipe, but report it
  if (!drop.mintData) {
    return {
      drop,
      ourWalletEligible: null,
      allocationRemaining: computeAllocationRemaining(drop),
      isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
        drop.totalMinted >= drop.maxTotalMintable,
      recommendation: "check-manually",
      reason: "Phase exists but OpenSea didn't return signed mint data. "
        + "This may require a live session, or the phase isn't signed via OpenSea.",
    };
  }

  // Fallback
  return {
    drop,
    ourWalletEligible: null,
    allocationRemaining: null,
    isOverAllocated: null,
    recommendation: "check-manually",
    reason: "Insufficient data to assess eligibility.",
  };
}

function computeAllocationRemaining(drop: DropPhase): number | null {
  if (drop.maxTotalMintable > 0 && drop.totalMinted != null) {
    return Math.max(0, drop.maxTotalMintable - drop.totalMinted);
  }
  if (drop.maxTotalMintable === -1) return null; // unknown capacity
  // Unlimited per-wallet or no capacity info
  return null;
}

// ── Full inventory eligibility report ────────────────────────────────────────

/**
 * Sort phases by start time (soonest first), keeping the original index so
 * callers can map a report back to `inventory.drops[i]`.
 *
 * OpenSea returns stages in an unspecified order. Every downstream consumer —
 * the wizard's phase picker, the eligibility report, the pre-fetch loop —
 * assumes index alignment with `inventory.drops`, so the sort must happen once
 * here, at the boundary, rather than in each consumer.
 */
export function sortByStartTime(drops: DropPhase[]): DropPhase[] {
  return drops.sort((a, b) => {
    // Soonest-starting first; unknown start times (0) sort last.
    const at = a.startTime || Number.MAX_SAFE_INTEGER;
    const bt = b.startTime || Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    // Array.prototype.sort is stable, so equal keys keep the original order.
    return 0;
  });
}

/** Non-mutating variant: returns a sorted copy. */
export function orderDropsByStartTime(drops: DropPhase[]): DropPhase[] {
  return sortByStartTime([...drops]);
}

/**
 * Eligibility for every phase in the inventory, soonest-stage-first.
 *
 * When `cookie` + `slug` are supplied each phase is asked directly (scoped to
 * its own stage uuid); otherwise — and for any phase that yields no attributable
 * verdict — the local heuristic in assessDropEligibility is used.
 */
export async function reportInventoryEligibility(
  inventory: CollectionDropsInventory,
  ourWallet: string,
  opts: {
    slug?: string | null;
    cookie?: string | null;
    apiKey?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<EligibilityReport[]> {
  // Sort first so the report reads soonest-stage-first, matching what the
  // wizard displays and what the sniper will target.
  const out: EligibilityReport[] = [];
  for (const d of orderDropsByStartTime(inventory.drops)) {
    const v = await getPhaseEligibility({
      drop: d,
      wallet: ourWallet,
      slug: opts.slug,
      cookie: opts.cookie,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
    });
    out.push(v ?? assessDropEligibility(d, ourWallet));
  }
  return out;
}

// ── Print a human-readable inventory report ──────────────────────────────────

export function printDropsInventory(
  inventory: CollectionDropsInventory,
  eligibility: EligibilityReport[],
  ourWallet: string,
  chainName: string,
): void {
  console.log(chalk.bold.white(`\nAll Active Phases for ${inventory.nftContract}`));
  console.log(chalk.gray(`  Chain:      ${chainName}`));
  console.log(chalk.gray(`  Wallet:     ${ourWallet}`));
  console.log(chalk.gray(`  Dropped:    ${inventory.drops.length} active phase(s)`));

  if (inventory.drops.length === 0) {
    console.log(chalk.yellow(`\n  ⚠ No active drops found.`));
    console.log(chalk.gray(`    The collection may not have any OpenSea-managed phases,`));
    console.log(chalk.gray(`    or the API key doesn't have access to them.`));
    console.log(chalk.gray(`    Try the public mint path, or check the collection page manually.\n`));
    return;
  }

  // Group by recommendation
  const targetable = eligibility.filter((e) => e.recommendation === "target");
  const checkManual = eligibility.filter((e) => e.recommendation === "check-manually");
  const skip = eligibility.filter((e) => e.recommendation === "skip");

  for (let i = 0; i < inventory.drops.length; i++) {
    const drop = inventory.drops[i];
    const report = eligibility[i];

    // A 0 timestamp means "unknown" (GQL omits times it does not know), never
    // 1970-01-01. A phase with an unknown end is still treated as active; a
    // phase with an unknown start is not reported as live.
    const now = Date.now();
    const startMs = drop.startTime > 0 ? drop.startTime * 1000 : null;
    const endMs = drop.endTime > 0 ? drop.endTime * 1000 : null;
    const startsAt = startMs != null ? new Date(startMs) : null;
    const endsAt = endMs != null ? new Date(endMs) : null;
    const isLive = startMs != null && endMs != null && now >= startMs && now < endMs;
    const notStarted = startMs != null && now < startMs;
    const isActive = !notStarted && (endMs == null || now < endMs);

    let statusLabel: string;
    let statusColor: typeof chalk.green | typeof chalk.yellow | typeof chalk.red;
    if (isLive) {
      statusLabel = "(LIVE)";
      statusColor = chalk.green;
    } else if (notStarted) {
      const remaining = ((startMs! - now) / 1000 / 60).toFixed(1);
      statusLabel = `opens in ${remaining}min`;
      statusColor = chalk.yellow;
    } else if (endMs != null) {
      statusLabel = "ended";
      statusColor = chalk.gray;
    } else {
      statusLabel = "(LIVE — end time unknown)";
      statusColor = chalk.green;
    }

    // Phase type badge
    let typeBadge = drop.type || "unknown";
    if (typeBadge.toLowerCase().includes("allowlist")) typeBadge = "allowlist";
    if (typeBadge.toLowerCase().includes("fcfs")) typeBadge = "FCFS";
    if (typeBadge.toLowerCase().includes("ovr")) typeBadge = "OVR";
    if (typeBadge.toLowerCase().includes("public")) typeBadge = "public";
    if (typeBadge.toLowerCase().includes("reserved")) typeBadge = "reserved";
    if (typeBadge.toLowerCase().includes("token-gated") || typeBadge.toLowerCase().includes("tokengated"))
      typeBadge = "token-gated";

    // Price line
    const priceEth = formatEther(drop.mintPrice);

    // Per-wallet limit
    const perWallet = drop.maxTotalMintableByWallet > 0
      ? `${drop.maxTotalMintableByWallet} per wallet`
      : "unlimited per wallet";

    // Allocation status
    let allocLine = "";
    if (report.allocationRemaining != null) {
      if (drop.maxTotalMintable > 0) {
        const total = drop.maxTotalMintable;
        const used = drop.totalMinted ?? 0;
        const rem = report.allocationRemaining;
        const pct = total > 0 ? ((used / total) * 100).toFixed(1) : "?";
        allocLine = chalk.gray(`  allocated ${pct}% (${used}/${total}, ${rem} remaining)`);
      } else {
        allocLine = chalk.gray(`  allocation: ${report.allocationRemaining} slots remaining (unknown capacity)`);
      }
    } else if (drop.maxTotalMintable > 0 && drop.totalMinted != null) {
      allocLine = chalk.gray(`  minted: ${drop.totalMinted} (capacity unknown)`);
    }

    // Eligibility line
    let eligLine = "";
    if (report.ourWalletEligible === true) {
      eligLine = chalk.green(`  ✓ wallet eligible`);
    } else if (report.ourWalletEligible === false) {
      eligLine = chalk.red(`  ✗ wallet NOT eligible`);
    } else if (report.recommendation === "check-manually") {
      eligLine = chalk.yellow(`  ? eligibility unknown — check manually`);
    } else {
      eligLine = chalk.gray(`  ? eligibility not reported by OpenSea`);
    }

    // Gas hints
    let gasLine = "";
    if (drop.maxFeePerGas != null && drop.maxPriorityFeePerGas != null) {
      gasLine = chalk.gray(
        `  OpenSea gas: ${drop.gasLimit || "?"} gas, `
          + `${Number(formatEther(drop.maxFeePerGas!)) * 1e9} gwei max, `
          + `${Number(formatEther(drop.maxPriorityFeePerGas!)) * 1e9} gwei priority`
      );
    }

    const sep = "─".repeat(62);
    console.log(chalk.bold.white(`\n  Phase ${i + 1}: ${drop.name || `phase #${i + 1}`}`));
    console.log(chalk.gray(`  ${sep}`));
    console.log(chalk.gray(`    Type:       ${typeBadge}`));
    console.log(chalk.gray(`    Drop ID:    ${drop.dropId}`));
    const windowLabel = `${startsAt ? startsAt.toISOString().slice(0, 16).replace("T", " ") : "unknown"} → ${endsAt ? endsAt.toISOString().slice(0, 16).replace("T", " ") : "unknown"}`;
    console.log(chalk.gray(`    Window:     ${windowLabel}`));
    console.log(statusColor(`    Status:     ${statusLabel}`));
    console.log(chalk.gray(`    Price:      ${priceEth} ETH × ${perWallet}`));
    if (gasLine) console.log(gasLine);
    if (allocLine) console.log(allocLine);
    console.log(eligLine);

    if (report.reason) {
      console.log(chalk.gray(`    Note:       ${report.reason}`));
    }

    // Show mint data availability.
    // The second branch must test mintSignature ALONE: the first branch already
    // caught mintData, so `else if (drop.mintData || ...)` was unreachable and a
    // signature-only payload silently reported "No signed mint data".
    if (drop.mintData && drop.mintSignature) {
      console.log(chalk.green(`    ✓ Signed mint data available — targetable`));
    } else if (drop.mintData) {
      console.log(chalk.green(`    ✓ Signed mint data available — targetable`));
    } else if (drop.mintSignature) {
      console.log(chalk.yellow(`    ⚠ Partial signed data (signature only, no calldata) — may need session`));
    } else {
      console.log(chalk.gray(`    No signed mint data from OpenSea`));
    }

    // Allowlist info if available
    if (drop.allowlistHash) {
      console.log(chalk.gray(`    Allowlist:  hash=${drop.allowlistHash.slice(0, 16)}...`));
    }
    if (drop.allowlistedAddresses && drop.allowlistedAddresses.length > 0) {
      console.log(chalk.gray(`    Allowlist:  ${drop.allowlistedAddresses.length} addresses exposed (showing first 3)`));
      for (const a of drop.allowlistedAddresses.slice(0, 3)) {
        console.log(chalk.gray(`                 ${a}`));
      }
      if (drop.allowlistedAddresses.length > 3) {
        console.log(chalk.gray(`                 ... +${drop.allowlistedAddresses.length - 3} more`));
      }
    }

    console.log();
  }

  // Summary
  console.log(chalk.bold.white("\n  Summary"));
  console.log(chalk.gray(`  ${"─".repeat(62)}`));
  console.log(chalk.green(`  Targetable:     ${targetable.length} phase(s)`));
  console.log(chalk.yellow(`  Check manually: ${checkManual.length} phase(s)`));
  console.log(chalk.red(`  Skip:           ${skip.length} phase(s)`));

  if (targetable.length > 0) {
    console.log();
    console.log(chalk.bold.white(`  Targetable phases:`));
    for (const r of targetable) {
      const d = r.drop;
      console.log(chalk.gray(`    • ${d.name || "unnamed"} [${d.type || "unknown"}] — ${d.dropId}`));
      // A 0 timestamp means "unknown", never 1970-01-01.
      const fmt = (sec: number) =>
        sec > 0 ? new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") : "unknown";
      console.log(chalk.gray(`      ${fmt(d.startTime)} → ${fmt(d.endTime)}`));
      console.log(chalk.gray(`      price: ${formatEther(d.mintPrice)} ETH, ${d.maxTotalMintableByWallet || "unlimited"} per wallet`));
      if (d.gasLimit) console.log(chalk.gray(`      OpenSea gas: ${d.gasLimit} gas`));
    }
  }

  if (skip.length > 0) {
    console.log();
    console.log(chalk.bold.red(`  Skipped phases (not viable):`));
    for (const r of skip) {
      console.log(chalk.red(`    • ${r.drop.name || "unnamed"} — ${r.reason}`));
    }
  }

  if (checkManual.length > 0) {
    console.log();
    console.log(chalk.bold.yellow(`  Phases needing manual check:`));
    for (const r of checkManual) {
      console.log(chalk.yellow(`    • ${r.drop.name || "unnamed"} — ${r.reason}`));
    }
  }

  console.log();
}

// ── Gas state polling ────────────────────────────────────────────────────────

export async function fetchGasState(
  rpcUrls: string[],
  chainId: number,
  timeoutMs = 5000,
): Promise<GasState | null> {
  if (rpcUrls.length === 0) return null;

  // Try the first RPC
  const url = rpcUrls[0];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBlockByNumber",
        params: ["latest", true],
        id: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const json = (await res.json()) as any;
    if (json.error) return null;
    if (!json.result) return null;

    const result = json.result as Record<string, any>;
    const baseFeePerGas = BigInt(result.baseFeePerGas || "0");
    const gasUsed = BigInt(result.gasUsed || "0");
    const gasLimit = BigInt(result.gasLimit || "0");
    const latestBlock = BigInt(result.number || "0");

    // Priority fee suggestion: based on recent blocks, suggest a tip
    // For now: 1-2 gwei for low congestion, 5-10 for moderate, 20+ for high
    const gasUsedPct = gasLimit > 0n ? Number(gasUsed * 100n / gasLimit) : 0;

    let urgency: "low" | "normal" | "high" | "extreme" = "normal";
    let priorityGwei = 2;

    if (gasUsedPct > 95) {
      urgency = "extreme";
      priorityGwei = 50;
    } else if (gasUsedPct > 85) {
      urgency = "high";
      priorityGwei = 20;
    } else if (gasUsedPct > 70) {
      urgency = "normal";
      priorityGwei = 5;
    } else {
      urgency = "low";
      priorityGwei = 1;
    }

    // maxFeePerGas = baseFee × 1.5 + priority (EIP-1559 safe margin)
    const baseFeeGwei = Number(baseFeePerGas) / 1e9;
    const suggestedMaxFee = BigInt(Math.ceil(baseFeeGwei * 1.5 * 1e9 + priorityGwei * 1e9));
    const suggestedPriority = BigInt(priorityGwei * 1e9);

    return {
      chainId,
      baseFeePerGas,
      suggestedMaxFeePerGas: suggestedMaxFee,
      suggestedMaxPriorityFeePerGas: suggestedPriority,
      latestBlockNumber: Number(latestBlock),
      gasUsedPercentage: gasUsedPct,
      timestamp: Date.now(),
      urgency,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Print gas state ──────────────────────────────────────────────────────────

export function printGasState(
  gas: GasState | null,
  chainName: string,
): void {
  if (!gas) {
    console.log(chalk.yellow(`\n  ⚠ Could not read gas state for ${chainName}.`));
    console.log(chalk.gray(`    Will use manually configured gas settings instead.\n`));
    return;
  }

  // These must be chalk FUNCTIONS, not pre-coloured strings: `chalk.green("low")`
  // returns a string, and calling that string (`badge(...)`) throws
  // "badge is not a function" — which is what `--eligibility` did at the gas step.
  const urgencyBadge: Record<string, (s: string) => string> = {
    low: chalk.green,
    normal: chalk.cyan,
    high: chalk.yellow,
    extreme: (s) => chalk.red(String(s).toUpperCase()),
  };
  const badge = urgencyBadge[gas.urgency] || chalk.gray;
  console.log(badge(`    Congestion:        ${gas.urgency}`));
}

// ── Recommend gas settings based on gas state + OpenSea hints ───────────────

export function recommendGasSettings(
  gasState: GasState | null,
  openSeaGas: { gasLimit: number | null; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null } | null,
  defaultGasLimit = 250_000,
): GasRecommendation {
  // If OpenSea provided gas fields, use them as the baseline
  if (openSeaGas?.maxFeePerGas && openSeaGas?.maxPriorityFeePerGas) {
    const baseGwei = gasState ? Number(gasState.baseFeePerGas) / 1e9 : 0;
    const osMaxGwei = Number(formatEther(openSeaGas.maxFeePerGas)) * 1e9;
    const osPriGwei = Number(formatEther(openSeaGas.maxPriorityFeePerGas)) * 1e9;

    // OpenSea's suggestion + a safety margin
    const margin = BigInt(Math.ceil(osMaxGwei * 0.2 * 1e9)); // +20% margin
    const finalMax = openSeaGas.maxFeePerGas + margin;
    const finalPri = openSeaGas.maxPriorityFeePerGas > 0n
      ? openSeaGas.maxPriorityFeePerGas + BigInt(Math.ceil(osPriGwei * 0.2 * 1e9))
      : openSeaGas.maxPriorityFeePerGas;

    return {
      currentBaseFeeGwei: baseGwei,
      currentBaseFeeWei: gasState?.baseFeePerGas || 0n,
      suggestedMaxFeePerGasWei: finalMax,
      suggestedMaxPriorityFeePerGasWei: finalPri,
      suggestedGasLimit: openSeaGas.gasLimit || defaultGasLimit,
      rationale: `Using OpenSea-provided gas fields with 20% safety margin. ` +
        `OpenSea suggested ${osMaxGwei.toFixed(2)} gwei max / ${osPriGwei.toFixed(1)} gwei priority.`,
      urgency: gasState?.urgency || "normal",
    };
  }

  // No OpenSea gas hints — use live gas state
  if (gasState) {
    const baseGwei = Number(gasState.baseFeePerGas) / 1e9;

    // Suggest maxFee = baseFee × 2 + priority (safe margin for EIP-1559)
    // Priority depends on congestion
    let priorityMultiplier = 1;
    switch (gasState.urgency) {
      case "extreme":
        priorityMultiplier = 50;
        break;
      case "high":
        priorityMultiplier = 20;
        break;
      case "normal":
        priorityMultiplier = 5;
        break;
      default:
        priorityMultiplier = 1;
    }

    const suggestedMax = BigInt(Math.ceil((baseGwei * 2 + priorityMultiplier) * 1e9));
    const suggestedPri = BigInt(priorityMultiplier * 1e9);

    const rationale = `No OpenSea gas hints. Using live gas state: ` +
      `${baseGwei.toFixed(2)} gwei base fee, ` +
      `${gasState.gasUsedPercentage.toFixed(1)}% block fullness, ` +
      `suggesting ${priorityMultiplier} gwei priority for ${gasState.urgency} congestion.`;

    return {
      currentBaseFeeGwei: baseGwei,
      currentBaseFeeWei: gasState.baseFeePerGas,
      suggestedMaxFeePerGasWei: suggestedMax,
      suggestedMaxPriorityFeePerGasWei: suggestedPri,
      suggestedGasLimit: defaultGasLimit,
      rationale,
      urgency: gasState.urgency,
    };
  }

  // No gas state and no OpenSea hints — conservative defaults
  return {
    currentBaseFeeGwei: 0,
    currentBaseFeeWei: 0n,
    suggestedMaxFeePerGasWei: BigInt(50 * 1e9),     // 50 gwei
    suggestedMaxPriorityFeePerGasWei: BigInt(5 * 1e9), // 5 gwei
    suggestedGasLimit: defaultGasLimit,
    rationale: `No gas data available. Using conservative defaults: 50 gwei max fee, 5 gwei priority, ${defaultGasLimit} gas limit.`,
    urgency: "normal",
  };
}

// ── Print gas recommendation ─────────────────────────────────────────────────

export function printGasRecommendation(rec: GasRecommendation, chainName: string): void {
  const maxGwei = Number(rec.suggestedMaxFeePerGasWei) / 1e9;
  const priGwei = Number(rec.suggestedMaxPriorityFeePerGasWei) / 1e9;
  const baseGwei = rec.currentBaseFeeGwei.toFixed(2);

  console.log(chalk.bold.white(`\n  Gas Recommendation (${chainName})`));
  console.log(chalk.gray(`  ${"-".repeat(40)}`));
  console.log(chalk.gray(`    Current base fee:    ${baseGwei} gwei`));
  console.log(chalk.green(`    Recommended max fee:  ${maxGwei.toFixed(2)} gwei`));
  console.log(chalk.green(`    Recommended priority: ${priGwei.toFixed(1)} gwei`));
  console.log(chalk.gray(`    Suggested gas limit:  ${rec.suggestedGasLimit}`));
  console.log(chalk.gray(`    Rationale:            ${rec.rationale}`));
  console.log();

  // If the user's manually configured gas is way off, warn
  // (this is called after the user has picked gas, so we compare against their choice)
}

// ── Compare user's gas choice against recommendation ─────────────────────────

export function gasChoiceAssessment(
  userMaxFee: bigint,
  userPriority: bigint,
  recommendation: GasRecommendation,
): { ok: boolean; message: string } {
  const userMaxGwei = Number(userMaxFee) / 1e9;
  const userPriGwei = Number(userPriority) / 1e9;
  const recMaxGwei = Number(recommendation.suggestedMaxFeePerGasWei) / 1e9;
  const recPriGwei = Number(recommendation.suggestedMaxPriorityFeePerGasWei) / 1e9;

  const maxOk = userMaxGwei >= recMaxGwei * 0.8; // within 20% of recommendation
  const priOk = userPriGwei >= recPriGwei * 0.5;   // within 50% of recommendation

  if (maxOk && priOk) {
    return {
      ok: true,
      message: chalk.green(`  ✓ Gas settings look reasonable for current conditions.`),
    };
  }

  const warnings: string[] = [];
  if (!maxOk) {
    warnings.push(
      chalk.yellow(`  ⚠ Your max fee (${userMaxGwei.toFixed(2)} gwei) is below the recommended ${recMaxGwei.toFixed(2)} gwei. ` +
        `Your tx may be stuck if base fee rises.`)
    );
  }
  if (!priOk) {
    warnings.push(
      chalk.yellow(`  ⚠ Your priority fee (${userPriGwei.toFixed(1)} gwei) is below the recommended ${recPriGwei.toFixed(1)} gwei. ` +
        `Your tx may be deprioritized in the mempool.`)
    );
  }

  return {
    ok: false,
    message: warnings.join("\n"),
  };
}
