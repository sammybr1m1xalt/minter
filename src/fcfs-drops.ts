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
import { fetchOnChainDrops, fetchSingleOnChainDrop } from "./seadrop-onchain";

const OPENSEA_BASE = "https://api.opensea.io";

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
  apiKey: string | undefined,
  timeoutMs = 15000,
  slug?: string,
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

  // ── Step 1: REST v2 /api/v2/drops/{slug} ─────────────────────────────────
  try {
    const res = await fetch(
      `${OPENSEA_BASE}/api/v2/drops/${lookupTarget}`,
      { signal: controller.signal, headers },
    );
    clearTimeout(timer);

      if (res.status === 429) {
        lastReason = "rate_limited";
        // Don't abort the whole flow for rate limiting — fall through to on-chain
      } else if (res.status === 401 || res.status === 403) {
        // REST requires an API key. Without one we get 401. Fall through to GQL + on-chain.
      } else if (res.status !== 200) {
        // Other non-200 — fall through to GQL + on-chain
      } else {
        const json = (await res.json()) as any;
        drops = catalogueDrops(json, nftContract);

        for (const d of drops) {
          if (d.raw.chain_id != null) { chainId = Number(d.raw.chain_id); break; }
          if (d.raw.chainId != null) { chainId = Number(d.raw.chainId); break; }
        }

        // REST with a raw CA returned nothing — stop, don't waste the GQL
        // slot on the same lookup. Only fall through to GQL when we have a
        // slug (different path) or REST errored/outage.
        if (drops.length === 0 && !slug) {
          return { nftContract, chainId: null, drops: [], fetchedAt: Date.now(), apiKeyUsed: !!apiKey, notFoundReason: "not_found" };
        }
      }
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      return { nftContract, chainId: null, drops: [], fetchedAt: Date.now(), apiKeyUsed: !!apiKey };
    }
    // Network error in REST — fall through to on-chain
  }

  // ── Step 2: GraphQL fallback (if REST gave nothing) ───────────────────────
  if (drops.length === 0) {
    try {
      const gqlDrops = await fetchGraphqlDrops(lookupTarget, apiKey || null, Math.min(timeoutMs, 8000));
      if (gqlDrops.length > 0) {
        drops = gqlDrops;
        // Try to infer chainId from GQL response
        for (const d of drops) {
          if (d.raw?.chain?.identifier) {
            if (d.raw.chain.identifier === "ethereum") chainId = 1;
            else if (typeof d.raw.chain.networkId === "number") chainId = d.raw.chain.networkId;
            break;
          }
        }
      }
    } catch {
      // GQL failed — fall through to on-chain
    }
  }

  // ── Step 3: On-chain SEADROP discovery (if still nothing) ─────────────────
  if (drops.length === 0) {
    try {
      clearTimeout(timer);
      const onChainDrops = await fetchOnChainDrops(nftContract, Math.min(timeoutMs, 15000));
      if (onChainDrops.length > 0) {
        drops = onChainDrops;
        // On-chain drops are for ethereum by definition (SEADROP is on mainnet)
        if (chainId === null) chainId = 1;
        // If on-chain found a public drop, mark the reason as resolved
        const hasPublic = onChainDrops.some(d => d.isPublicStage && d.mintPrice > 0n);
        if (hasPublic) lastReason = undefined;
      }
    } catch {
      // On-chain failed — return whatever we have (empty)
    }
  }

  if (drops.length === 0 && lastReason === undefined) {
    lastReason = "no_phases";
  }

  return {
    nftContract,
    chainId,
    drops,
    fetchedAt: Date.now(),
    apiKeyUsed: !!apiKey,
    notFoundReason: lastReason,
  };
}

// ── GraphQL fallback ─────────────────────────────────────────────────────────
// OpenSea v2 GraphQL: gql.opensea.io/graphql
// Collection drops are exposed via collectionBySlug → stages connection.
// We query both stages.list and the active/next stage shortcuts.
//
// NOTE: The GQL API is aggressively rate-limited (429) as of late 2026.
// We use it as a secondary source after REST, with a short timeout.

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let slug = lookupTarget;
  // If the target is a CA, try on-chain discovery instead of slug resolution
  // for the GQL query. GQL collectionBySlug needs a slug, but if we can't
  // resolve one without an API key the CA is used directly as fallback.
  if (lookupTarget.toLowerCase().startsWith("0x")) {
    slug = lookupTarget; // use CA as slug — GQL may still return results
  }

  const query = `
    query CollectionDrops($slug: String!) {
      collectionBySlug(slug: $slug) {
        slug
        name
        address
        chain { identifier networkId }
        stages(first: 50) {
          edges {
            node {
              uuid
              stageType
              label
              startTime
              endTime
              price
              maxPerWallet
              allowlistWalletCount
              ... on CollectionDropStage {
                mintData
                mintSignature
                gasLimit
                maxFeePerGas
                maxPriorityFeePerGas
                eligible
                eligibleCount
                totalAllocated
                allowlistedAddresses { address }
                allowlistHash
                feeRecipient
              }
            }
          }
        }
        activeStage {
          uuid
          stageType
          label
          startTime
          endTime
          price
          maxPerWallet
          allowlistWalletCount
          ... on CollectionDropStage {
            mintData
            mintSignature
            gasLimit
            maxFeePerGas
            maxPriorityFeePerGas
            eligible
            eligibleCount
            totalAllocated
            allowlistedAddresses { address }
            allowlistHash
            feeRecipient
          }
        }
        nextStage {
          uuid
          stageType
          label
          startTime
          endTime
          price
          maxPerWallet
          allowlistWalletCount
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

    if (!res.ok) return [];

    const json = (await res.json()) as any;
    if (json.errors && json.errors.length > 0) return [];
    if (!json.data?.collectionBySlug) return [];

    const coll = json.data.collectionBySlug;
    // Collect stages from three possible shapes: stages edges, activeStage, nextStage
    const stageSources: any[] = [];

    // 1. stages connection (all stages)
    if (coll.stages?.edges) {
      for (const edge of coll.stages.edges) {
        if (edge?.node) stageSources.push(edge.node);
      }
    }
    // 2. activeStage
    if (coll.activeStage) {
      stageSources.push(coll.activeStage);
    }
    // 3. nextStage
    if (coll.nextStage) {
      stageSources.push(coll.nextStage);
    }

    const drops: DropPhase[] = [];
    for (const c of stageSources) {
      if (!c || typeof c !== "object") continue;

      // Fields: real v2 API uses snake_case; older/guessed shapes may use camelCase
      const uuid = c.uuid || c.id || c.drop_id || c.hash || "";
      const contract = (
        c.contract_address || c.nftContract || c.contractAddress || c.address || ""
      ).toLowerCase();

      // Only include stages for our target contract (when we can identify it)
      if (contract && contract !== lookupTarget.toLowerCase() && lookupTarget.toLowerCase() !== "") {
        // If we can't match the contract, include anyway — the caller may have
        // passed a slug that covers exactly one collection
        if (contract !== "") continue;
      }

      const startTime = Number(c.start_time || c.startTime || c.start || 0);
      const endTime = Number(c.end_time || c.endTime || c.end || 0);
      const stageType = c.stage_type || c.stageType || c.type || c.kind || null;
      const label = c.label || c.name || c.title || c.displayName || null;

      const mintPrice = BigInt(String(c.price || c.mintPrice || c.mint_price || c.mintPriceWei || "0"));
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
      const feeBps = Number(c.fee_bps || c.feeBps || c.fee || 0);

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
        maxFeePerGas: maxFeePerGas ? BigInt(String(maxFeePerGas)) : null,
        maxPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(String(maxPriorityFeePerGas)) : null,
        eligible,
        eligibleCount,
        totalAllocated,
        allowlistedAddresses,
        allowlistHash,
        raw: c as Record<string, any>,
        isPublicStage:
          stageType === "public_sale" ||
          stageType === "public",
      });
    }

    return drops;
  } catch {
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

    const startTime = Number(c.start_time || c.startTime || c.start || 0);
    const endTime = Number(c.end_time || c.endTime || c.end || 0);
    const stageType = c.stage_type || c.stageType || c.type || c.kind || null;
    const label = c.label || c.name || c.title || c.displayName || null;

    const mintPrice = BigInt(String(c.price || c.mintPrice || c.mint_price || c.mintPriceWei || "0"));
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
    const feeBps = Number(c.fee_bps || c.feeBps || c.fee || 0);

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
      maxFeePerGas: maxFeePerGas ? BigInt(String(maxFeePerGas)) : null,
      maxPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(String(maxPriorityFeePerGas)) : null,
      eligible,
      eligibleCount,
      totalAllocated,
      allowlistedAddresses,
      allowlistHash,
      raw: c as Record<string, any>,
      isPublicStage:
        stageType === "public_sale" ||
        stageType === "public" ||
        (mintData == null && mintSignature == null),
    });
  }

  return drops;
}


// ── Eligibility report for a single drop ────────────────────────────────────

export function assessDropEligibility(
  drop: DropPhase,
  ourWallet: string,
): EligibilityReport {
  // OVR / allowlist phases — these need per-wallet signed data (mintSignature)
  // fetched from OpenSea. Report them as targetable only if we have a signed
  // payload, otherwise flag for manual check (need session + allowlist tree).
  if (drop.type === "ovr" || drop.allowlistHash ||
      drop.allowlistedAddresses.length > 0 ||
      (drop.type && /ovr|allowlist|allow_list/i.test(drop.type))) {
    if (drop.mintData && drop.mintSignature) {
      // Pre-fetched signed payload — this wallet can target it
      const remaining = computeAllocationRemaining(drop);
      return {
        drop,
        ourWalletEligible: true, // signed payload means we're in the allowlist
        allocationRemaining: remaining,
        isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
          drop.totalMinted >= drop.maxTotalMintable,
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
      isOverAllocated: drop.totalMinted != null && drop.maxTotalMintable > 0 &&
        drop.totalMinted >= drop.maxTotalMintable,
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
    const isPast = now >= drop.endTime * 1000;

    if (drop.type === "ovr" || drop.allowlistHash ||
        drop.allowlistedAddresses.length > 0 ||
        (drop.type && /ovr|allowlist|allow_list/i.test(drop.type))) {
      // OVR/allowlist: isPast + no signed data → skip; otherwise still targetable
      if (isPast && (!drop.mintData || !drop.mintSignature)) {
        return {
          drop,
          ourWalletEligible: false,
          allocationRemaining: null,
          isOverAllocated: null,
          recommendation: "skip",
          reason: "OVR/allowlist phase has ended and OpenSea reports ineligible.",
        };
      }
      if (drop.mintData && drop.mintSignature) {
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
    if (isPast && (!drop.mintData || !drop.mintSignature)) {
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
    if (drop.mintData && drop.mintSignature) {
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
  if (drop.mintData && drop.mintSignature) {
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
  if (!drop.mintData || !drop.mintSignature) {
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

export function reportInventoryEligibility(
  inventory: CollectionDropsInventory,
  ourWallet: string,
): EligibilityReport[] {
  return inventory.drops.map((d) => assessDropEligibility(d, ourWallet));
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

    const startsAt = new Date(drop.startTime * 1000);
    const endsAt = new Date(drop.endTime * 1000);
    const now = Date.now();
    const isLive = now >= drop.startTime * 1000 && now < drop.endTime * 1000;
    const isActive = now < drop.endTime * 1000;
    const isPast = now >= drop.endTime * 1000;

    let statusLabel: string;
    let statusColor: typeof chalk.green | typeof chalk.yellow | typeof chalk.red;
    if (isLive) {
      statusLabel = "(LIVE)";
      statusColor = chalk.green;
    } else if (isActive) {
      const remaining = ((drop.startTime * 1000 - now) / 1000 / 60).toFixed(1);
      statusLabel = `opens in ${remaining}min`;
      statusColor = chalk.yellow;
    } else {
      statusLabel = "ended";
      statusColor = chalk.gray;
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
    const totalNeeded = formatEther(drop.mintPrice * BigInt(drop.maxTotalMintableByWallet || 1));

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
    console.log(chalk.gray(`    Window:     ${startsAt.toISOString().slice(0, 16).replace("T", " ")} → ${endsAt.toISOString().slice(0, 16).replace("T", " ")}`));
    console.log(statusColor(`    Status:     ${statusLabel}`));
    console.log(chalk.gray(`    Price:      ${priceEth} ETH × ${perWallet}`));
    if (gasLine) console.log(gasLine);
    if (allocLine) console.log(allocLine);
    console.log(eligLine);

    if (report.reason) {
      console.log(chalk.gray(`    Note:       ${report.reason}`));
    }

    // Show mint data availability
    if (drop.mintData && drop.mintSignature) {
      console.log(chalk.green(`    ✓ Signed mint data available — targetable`));
    } else if (drop.mintData || drop.mintSignature) {
      console.log(chalk.yellow(`    ⚠ Partial signed data (${!!drop.mintData ? "calldata" : ""}${!!drop.mintData && !!drop.mintSignature ? " + " : ""}${!!drop.mintSignature ? "signature" : ""}) — may need session`));
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
      const startsAt = new Date(d.startTime * 1000);
      const endsAt = new Date(d.endTime * 1000);
      console.log(chalk.gray(`      ${startsAt.toISOString().slice(0, 16).replace("T", " ")} → ${endsAt.toISOString().slice(0, 16).replace("T", " ")}`));
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

  const baseGwei = Number(gas.baseFeePerGas) / 1e9;
  const maxGwei = Number(gas.suggestedMaxFeePerGas) / 1e9;
  const priGwei = Number(gas.suggestedMaxPriorityFeePerGas) / 1e9;

  const urgencyBadge: Record<string, any> = {
    low: chalk.green("low"),
    normal: chalk.cyan("normal"),
    high: chalk.yellow("high"),
    extreme: chalk.red("EXTREME"),
  };
  const badge = urgencyBadge[gas.urgency] || chalk.gray(gas.urgency);
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
      ? openSeaGas.maxPriorityFeePerGas + BigInt(Math.ceil(osPriGwei * 0.2))
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
