// ── Unified mint-target parsing and resolution ──────────────────────────────
//
// Ported from nft-minter-bot/src/parse.js + resolve.js, and extended to cover
// every platform the minter can actually reach.
//
// The TS port had parseNftLink (OpenSea only) and resolveSlug (OpenSea only).
// A Scatter or Manifold link was not parseable at all, and a bare slug with no
// chain context could not be resolved. This module is the single entry point:
// parse whatever the user pastes, then resolve it to a concrete
// { contract, chainKey, platform } the rest of the code can act on.
//
// Platforms:
//   opensea   — OpenSea collection/drop/item URL, or a bare slug
//   scatter   — scatter.art collection URL or slug (resolved via the Scatter API)
//   manifold  — manifold.xyz claim URL (needs the claim contract, not the slug)
//   zora      — zora.co collect URL
//   direct    — a bare contract address, optionally with a chain and amount
//
// A bare slug is ambiguous between OpenSea and Scatter. We try OpenSea first
// (it is the primary platform) and fall back to Scatter, because a wrong guess
// here means resolving to a contract on the wrong platform entirely.

import { parseNftLink } from "./nft-link";
import { resolveSlug, isSlug } from "./slug-resolver";
import { getScatterCollection, ScatterCollection } from "./scatter";
import { chainKeyFromId } from "./chains";

const ADDR = "0x[a-fA-F0-9]{40}";

// ── Chain aliases ───────────────────────────────────────────────────────────
// Ported from parse.js chainSlug(). The TS port handled only a handful of
// aliases, so "matic", "arb", "op", "avax", "bnb" all failed on the command
// line. Unknown values pass through lowercased, matching the original.

const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "ethereum", eth: "ethereum", mainnet: "ethereum",
  base: "base",
  matic: "polygon", polygon: "polygon",
  arbitrum: "arbitrum", arb: "arbitrum",
  optimism: "optimism", op: "optimism",
  zora: "zora-network", "zora-network": "zora-network",
  bsc: "bsc", bnb: "bsc",
  avalanche: "avalanche", avax: "avalanche", "avalanche-c": "avalanche",
  bera: "bera", berachain: "bera",
  peaq: "peaq",
  "robinhood-chain": "robinhood", robinhood: "robinhood", rhoc: "robinhood",
  "arc-network": "arc", arc: "arc", circle: "arc",
};

export function chainSlug(s: string | null | undefined): string {
  if (!s) return "ethereum";
  return CHAIN_ALIASES[s.trim().toLowerCase()] ?? s.trim().toLowerCase();
}

// ── Target descriptor ───────────────────────────────────────────────────────

export type TargetPlatform = "opensea" | "scatter" | "manifold" | "zora" | "direct";

export interface ParsedTarget {
  platform: TargetPlatform;
  /** Contract address, when known at parse time. */
  contract?: string;
  /** Collection slug (OpenSea or Scatter). */
  slug?: string;
  /** Manifold claim id. */
  claimId?: string;
  chain?: string;
  tokenId?: string;
  amount: number;
}

export interface ResolvedTarget {
  platform: TargetPlatform;
  contract: string;
  chainKey: string;
  /** OpenSea slug when the platform is opensea. */
  slug?: string;
  /** Scatter collection metadata when the platform is scatter. */
  scatter?: ScatterCollection;
  amount: number;
  tokenId?: string;
  /** True when resolution used a fallback (scrape / Scatter API) rather than
   *  the authoritative REST endpoint. */
  resolvedViaFallback: boolean;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function extractAmount(s: string): number {
  // Explicit "xN" anywhere.
  let m = s.match(/(?:^|\s)x(\d+)(?:\s|$)/i);
  if (m) return Number(m[1]);
  // A standalone integer token that is NOT part of a URL path (avoid tokenId).
  const cleaned = s.replace(/https?:\/\/\S+/g, " ");
  m = cleaned.match(/(?:^|\s)(\d+)(?:\s|$)/);
  if (m) return Number(m[1]);
  return 1;
}

function findChain(s: string): string | undefined {
  for (const tok of s.split(/\s+/)) {
    if (!tok || /^\d/.test(tok) || /^x?\d+$/i.test(tok)) continue;
    const c = chainSlug(tok);
    if (CHAIN_ALIASES[tok.trim().toLowerCase()] || c !== tok.toLowerCase()) return c;
  }
  return undefined;
}

function stripUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/g, " ");
}

/**
 * Parse any mint-target input into a descriptor.
 *
 * Mirrors parse.js, with one extension: a bare slug is tagged `opensea` at
 * parse time (the primary platform) and re-tried as Scatter during resolution
 * if OpenSea cannot resolve it.
 */
export function parseTarget(input: string): ParsedTarget {
  const s = String(input).trim();
  if (!s) throw new Error("No mint target provided");

  // OpenSea assets URL — trailing /N is a tokenId, not an amount.
  let m = s.match(new RegExp(`opensea\\.io/assets/([\\w-]+)/(${ADDR})(?:/(\\d+))?`, "i"));
  if (m) {
    return {
      platform: "opensea",
      contract: m[2],
      chain: chainSlug(m[1]),
      tokenId: m[3],
      amount: extractAmount(s),
    };
  }

  // OpenSea collection URL → slug.
  m = s.match(/opensea\.io\/collection\/([\w-]+)/i);
  if (m) {
    return {
      platform: "opensea",
      slug: m[1].toLowerCase(),
      amount: extractAmount(s),
      chain: findChain(stripUrls(s)),
    };
  }

  // Scatter.art — /collection/<slug>, /c/<slug> (short link), or bare /<slug>.
  m = s.match(/scatter\.art\/(?:collection\/|c\/)?([\w-]+)/i);
  if (m) {
    return { platform: "scatter", slug: m[1].toLowerCase(), amount: extractAmount(s) };
  }

  // Manifold claim. Claim ids are URL slugs, which may contain hyphens — \w+
  // alone would stop at the first one and silently truncate the id.
  m = s.match(/manifold\.xyz\/c\/([\w-]+)/i);
  if (m) {
    return { platform: "manifold", claimId: m[1], amount: extractAmount(s) };
  }

  // Zora collect URL.
  m = s.match(new RegExp(`zora\\.co/collect/(\\w+):(${ADDR})(?:/(\\d+))?`, "i"));
  if (m) {
    return {
      platform: "zora",
      contract: m[2],
      chain: chainSlug(m[1]),
      tokenId: m[3],
      amount: extractAmount(s),
    };
  }

  // Direct: a bare address with chain and amount in any order.
  m = s.match(new RegExp(ADDR, "i"));
  if (m) {
    const contract = m[0];
    // The amount may appear BEFORE the address ("3 0xabc…") as well as after.
    // Check the prefix too — only the "xN" form is unambiguous there, since a
    // bare leading integer is more likely a tokenId or a chain id.
    const prefix = s.slice(0, m.index ?? 0);
    const tail = s.slice((m.index ?? 0) + m[0].length);
    const tokens = tail.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    let chain: string | undefined;
    let amount = 1;
    for (const tok of tokens) {
      if (/^on$/i.test(tok)) continue;
      if (amount === 1 && /^x?\d+$/i.test(tok)) {
        amount = Number(tok.replace(/^x/i, ""));
        continue;
      }
      if (!chain && !/^\d/.test(tok)) chain = chainSlug(tok);
    }
    // "x3 0xabc…" — explicit multiplier before the address.
    const prefixX = prefix.match(/(?:^|\s)x(\d+)(?:\s|$)/i);
    if (prefixX) amount = Number(prefixX[1]);
    // A bare leading integer is ambiguous: it could be a quantity or a tokenId.
    // Treat it as a quantity only when the input has no URL (a URL's trailing
    // integer is a tokenId, which extractAmount already handles).
    if (!prefixX && !/https?:\/\//i.test(s)) {
      const leading = prefix.match(/(?:^|\s)(\d+)(?:\s|$)/);
      if (leading) amount = Number(leading[1]);
    }
    // No chain named anywhere — leave it unset so the caller's preferredChain
    // can apply. Defaulting to "ethereum" here would silently override it.
    return { platform: "direct", contract, chain: chain || undefined, amount };
  }

  // Bare slug, optionally followed by a chain alias and/or a quantity
  // ("de-bots matic", "de-bots on arb", "de-bots base 3"). The "on" filler is
  // ignored, matching parse.js.
  m = s.match(/^([a-zA-Z0-9._-]+)(?:\s+on)?\s+([a-zA-Z][a-zA-Z0-9-]*)(?:\s+x?(\d+))?$/);
  if (m && CHAIN_ALIASES[m[2].toLowerCase()]) {
    return {
      platform: "opensea",
      slug: m[1].toLowerCase(),
      chain: chainSlug(m[2]),
      amount: m[3] ? Number(m[3]) : 1,
    };
  }
  if (/^[a-zA-Z0-9._-]+$/.test(s)) {
    return { platform: "opensea", slug: s.toLowerCase(), amount: 1 };
  }

  throw new Error(
    `Could not parse "${input}" as an OpenSea/Scatter/Manifold/Zora link, a slug, or a contract address`
  );
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a parsed target to a concrete contract + chain.
 *
 * Returns null when the target cannot be resolved — the caller decides whether
 * that is fatal. Manifold is deliberately NOT resolved: a claim slug is not a
 * contract, and guessing one would mean minting against an address we invented.
 */
export async function resolveTarget(
  target: ParsedTarget,
  apiKey = "",
  preferredChain?: string
): Promise<ResolvedTarget | null> {
  switch (target.platform) {
    case "opensea": {
      if (target.contract) {
        return {
          platform: "opensea",
          contract: target.contract,
          chainKey: target.chain || preferredChain || "ethereum",
          amount: target.amount,
          tokenId: target.tokenId,
          resolvedViaFallback: false,
        };
      }
      if (!target.slug) return null;

      // OpenSea first.
      try {
        const info = await resolveSlug(target.slug, apiKey, target.chain || preferredChain);
        return {
          platform: "opensea",
          contract: info.contractAddress,
          chainKey: target.chain || preferredChain || info.chain || "ethereum",
          slug: target.slug,
          amount: target.amount,
          resolvedViaFallback: false,
        };
      } catch {
        // Fall through to Scatter — a bare slug is ambiguous.
      }

      const scatter = await getScatterCollection(target.slug);
      if (scatter) {
        const chainKey = chainKeyFromId(scatter.chainId);
        if (chainKey) {
          return {
            platform: "scatter",
            contract: scatter.address,
            chainKey,
            scatter,
            amount: target.amount,
            resolvedViaFallback: true,
          };
        }
      }
      return null;
    }

    case "scatter": {
      if (!target.slug) return null;
      const scatter = await getScatterCollection(target.slug);
      if (!scatter) return null;
      const chainKey = chainKeyFromId(scatter.chainId);
      if (!chainKey) return null;
      return {
        platform: "scatter",
        contract: scatter.address,
        chainKey,
        scatter,
        amount: target.amount,
        resolvedViaFallback: false,
      };
    }

    case "manifold": {
      // A Manifold claim slug is NOT a contract address. Minting requires the
      // claim contract, which the API does not expose by slug. Refuse rather
      // than invent an address — a guessed contract is a signed transaction to
      // an address we made up.
      return null;
    }

    case "zora": {
      if (!target.contract) return null;
      return {
        platform: "zora",
        contract: target.contract,
        chainKey: target.chain || preferredChain || "ethereum",
        amount: target.amount,
        tokenId: target.tokenId,
        resolvedViaFallback: false,
      };
    }

    case "direct": {
      if (!target.contract) return null;
      // An explicit chain on the target wins; preferredChain is the fallback.
      // Ignoring preferredChain here meant `resolveTarget(t, "", "base")` on a
      // bare address silently returned ethereum.
      const chainKey = target.chain || preferredChain || "ethereum";
      return {
        platform: "direct",
        contract: target.contract,
        chainKey,
        amount: target.amount,
        resolvedViaFallback: false,
      };
    }
  }
}

/**
 * Parse and resolve in one call. Throws with a platform-specific message when
 * the target is unresolvable, so the caller can show something actionable.
 */
export async function parseAndResolve(
  input: string,
  apiKey = "",
  preferredChain?: string
): Promise<ResolvedTarget> {
  const parsed = parseTarget(input);
  const resolved = await resolveTarget(parsed, apiKey, preferredChain);
  if (!resolved) {
    if (parsed.platform === "manifold") {
      throw new Error(
        `Manifold claim "${parsed.claimId}" cannot be resolved automatically — ` +
          `Manifold claims need the claim contract address. Paste the 0x… contract instead.`
      );
    }
    throw new Error(
      `Could not resolve "${input}" — the collection may not exist, or it needs an OpenSea API key.`
    );
  }
  return resolved;
}

export { isSlug };
