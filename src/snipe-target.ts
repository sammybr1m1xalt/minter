// Single-token scrape for `--snipe --token-id N`.
//
// This deliberately does NOT build a rarity table. Rarity needs the whole
// id -> metadata mapping; with one id the honest answer is "traits known,
// rarity percentile UNKNOWN". The win is that one metadata JSON and one
// listing GET replace a directory crawl plus a 200-order join.
import chalk from "chalk";
import { scanReveal, type RevealScanResult } from "./reveal-scan";
import { DEFAULT_GATEWAYS } from "./reveal-scan";
import { decodeOnchainMetadata, parseTraits } from "./rarity";
import { fetchBestListing, fetchCollectionListings, type ListingSummary } from "./buy-listings";
import { resolveChain } from "./chains";
import { getValidApiKey } from "./opensea-key";
import { resolveContractToSlug } from "./slug-resolver";
import { resolveRpcsForChain } from "./rpc-resolver";

function emptyListing(tokenId: string, error: string): ListingSummary {
  return {
    tokenId, orderHash: null, protocolAddress: null, chain: null, maker: null,
    currency: null, value: null, decimals: null, price: null, error,
  };
}

export interface TargetedScrape {
  tokenId: string;
  source: string;
  traits: { type: string; value: string }[];
  metadataOk: boolean;
  listing: ListingSummary;
}

function gatewayBase(inspection: { gateway?: string | null } | undefined): string {
  return inspection?.gateway ?? DEFAULT_GATEWAYS[0];
}

async function readJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return null;
    }
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  }
}

/** Resolve metadata for exactly one id, from on-chain data or a published file. */
export async function scrapeOne(o: {
  contract: string | null;
  cid: string | null;
  tokenId: string;
  chainKey: string;
  rpcs: string[];
  gateway: string | null;
  slug: string | null;
  apiKey: string;
}): Promise<TargetedScrape> {
  const id = o.tokenId;
  let scan: RevealScanResult | null = null;
  let cid = o.cid;
  let gateways = o.gateway ? [o.gateway] : DEFAULT_GATEWAYS;

  if (o.contract && !cid) {
    const profile = resolveChain(o.chainKey);
    if (!profile) throw new Error(`unknown chain "${o.chainKey}"`);
    const rpcUrls = o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls;
    scan = await scanReveal({
      rpcUrls,
      chainId: profile.chainId,
      contract: o.contract,
      // One id only: no 1..5 sample, no event sweep. This is the speed win.
      sampleTokenIds: [Number(id)],
      logScanBlocks: 0,
      deep: true,
    });
    const hit = scan.sampledTokenUris.find((s) => String(s.tokenId) === id);
    const uri = hit?.uri ?? null;
    const onchain = uri?.startsWith("data:application/json") ? decodeOnchainMetadata(uri) : null;
    if (onchain) {
      const listing = await fetchBestListing(o.slug ?? "", id, o.apiKey).catch(
        (e: any) => ({ tokenId: id, error: e?.message ?? "fetch failed" } as ListingSummary)
      );
      return {
        tokenId: id,
        source: "on-chain tokenURI data URI",
        traits: parseTraits(onchain).traits.map((t) => ({ type: t.type, value: t.value })),
        metadataOk: true,
        listing,
      };
    }
    const dir = scan.inspections.find((i) => i.kind === "directory" || i.kind === "file");
    cid = dir?.cid ?? null;
    if (dir?.gateway) gateways = [dir.gateway, ...gateways.filter((g) => g !== dir.gateway)];
  }

  let doc: any = null;
  let source = "unreadable";
  if (cid) {
    const bare = cid.replace(/^ipfs:\/\//, "").replace(/\/+$/, "");
    for (const gateway of gateways.slice(0, 3)) {
      for (const path of [`${id}`, `${id}.json`]) {
        const candidate = await readJson(`${gateway.replace(/\/+$/, "")}/${bare}/${path}`);
        if (candidate) {
          doc = candidate;
          source = `${gateway} /${path}`;
          break;
        }
      }
      if (doc) break;
    }
  }

  // A confirmed directory page is cheap; a missing listing is still answered
  // by the per-token endpoint, which is the only GET a single id needs.
  const listing = await fetchBestListing(o.slug ?? "", id, o.apiKey).catch(
    (e: any) => ({ tokenId: id, error: e?.message ?? "fetch failed" } as ListingSummary)
  );
  return {
    tokenId: id,
    source,
    traits: doc ? parseTraits(doc).traits.map((t) => ({ type: t.type, value: t.value })) : [],
    metadataOk: doc != null,
    listing,
  };
}

/**
 * Batch form: one reveal scan for ALL requested ids, one collection listing
 * page, and bounded parallel metadata reads. Calling scrapeOnce per id would
 * repeat the whole contract scan N times — the exact latency this path avoids.
 */
export async function scrapeMany(o: {
  contract: string | null;
  cid: string | null;
  tokenIds: string[];
  chainKey: string;
  rpcs: string[];
  gateway: string | null;
  slug: string;
  apiKey: string;
}): Promise<TargetedScrape[]> {
  const ids = [...new Set(o.tokenIds)];
  let cid = o.cid;
  let gateways = o.gateway ? [o.gateway] : DEFAULT_GATEWAYS;
  const docs = new Map<string, { doc: any; source: string }>();

  if (o.contract && !cid) {
    const profile = resolveChain(o.chainKey);
    if (!profile) throw new Error(`unknown chain "${o.chainKey}"`);
    const rpcUrls = o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls;
    const scan = await scanReveal({
      rpcUrls,
      chainId: profile.chainId,
      contract: o.contract,
      sampleTokenIds: ids.map((id) => Number(id)).filter(Number.isFinite),
      logScanBlocks: 0,
      deep: true,
    });
    for (const s of scan.sampledTokenUris) {
      const doc = decodeOnchainMetadata(s.uri);
      if (doc) docs.set(String(s.tokenId), { doc, source: "on-chain tokenURI data URI" });
    }
    const dir = scan.inspections.find((i) => i.kind === "directory" || i.kind === "file");
    cid = dir?.cid ?? null;
    if (dir?.gateway) gateways = [dir.gateway, ...gateways.filter((g) => g !== dir.gateway)];
  } else if (cid) {
    // A bare CID was supplied directly; no contract scan is needed.
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= ids.length) return;
        const id = ids[i];
        if (docs.has(id)) continue;
        if (!cid) continue;
        const bare = cid.replace(/^ipfs:\/\//, "").replace(/\/+$/, "");
        for (const gateway of gateways.slice(0, 3)) {
          for (const path of [`${id}`, `${id}.json`]) {
            const doc = await readJson(`${gateway.replace(/\/+$/, "")}/${bare}/${path}`);
            if (doc) {
              docs.set(id, { doc, source: `${gateway} /${path}` });
              break;
            }
          }
          if (docs.has(id)) break;
        }
      }
    })
  );

  const orders = await fetchCollectionListings(o.slug, o.apiKey, { limit: 200, timeoutMs: 15_000 }).catch(() => []);
  const byToken = new Map<string, ListingSummary>();
  for (const l of orders) if (!byToken.has(l.tokenId)) byToken.set(l.tokenId, l);

  return ids.map((id) => {
    const found = docs.get(id);
    return {
      tokenId: id,
      source: found?.source ?? "unreadable",
      traits: found ? parseTraits(found.doc).traits.map((t) => ({ type: t.type, value: t.value })) : [],
      metadataOk: found != null,
      listing: byToken.get(id) ?? emptyListing(id, "not listed"),
    };
  });
}

export async function resolveListingContext(o: {
  contract: string | null;
  slug: string | null;
}): Promise<{ slug: string; apiKey: string } | null> {
  const apiKey = (await getValidApiKey({ timeoutMs: 8000 }).catch(() => null))?.api_key ?? "";
  if (!apiKey) return null;
  const slug = o.slug ?? (o.contract
    ? await resolveContractToSlug(o.contract, apiKey, 10000).catch(() => null)
    : null);
  return slug ? { slug, apiKey } : null;
}

/** Compact, honest single-token report. There is no rarity percentile here. */
export function printTargetedScrape(s: TargetedScrape): void {
  console.log();
  console.log(chalk.bold.white(`  token ${s.tokenId}`));
  console.log(chalk.gray(`  metadata: ${s.metadataOk ? s.source : "UNREADABLE — traits unknown"}`));
  if (s.traits.length) {
    console.log(`  traits:   ${s.traits.map((t) => `${t.type}=${t.value}`).join(", ").slice(0, 300)}`);
  }
  console.log(chalk.gray("  rarity:   UNKNOWN — one token cannot establish trait frequencies"));
  if (s.listing.error) console.log(chalk.yellow(`  listing:  ${s.listing.error}`));
  else console.log(`  listing:  listed (payload re-read before send)`);
}
