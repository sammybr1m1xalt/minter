// `--reveal-scan <contract>` — is this drop's id -> artwork mapping actually
// private, or is it already readable?
//
// Read-only and public-data-only. It reads the contract and resolves whatever
// CIDs the contract already publishes. See reveal-scan.ts for the reasoning and
// for what it deliberately does not do.
import chalk from "chalk";
import { getValidApiKey } from "./opensea-key";
import { inspectPublicCid, scanReveal, type RevealScanResult } from "./reveal-scan";
import { computeRarity, crawlTraits, crawlOnchainTraits, saveRarityCache, type CrawlResult } from "./rarity";
import { fetchBestListing, fetchCollectionListings, printListingLine, formatRarityListing, type ListingSummary } from "./buy-listings";
import { resolveContractToSlug } from "./slug-resolver";
import { executeListingBuy } from "./buy-listings";
import { loadEnvKeys, promptWalletPassphrase } from "./wizard";
import { askText, askYesNo } from "./prompt";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";

function parseArgs(args: string[]): {
  contract: string | null;
  chainKey: string;
  rpcs: string[];
  blocks: number;
  deep: boolean;
  ids: number[];
  gateway: string | null;
  opensea: boolean;
  ipfsLink: string | null;
  rarity: boolean;
  limit: number | null;
  concurrency: number;
  top: number;
  pick: number;
  listings: boolean;
  snipe: boolean;
  noSnipe: boolean;
  buy: string | null;
  yes: boolean;
  slug: string | null;
} {
  let contract: string | null = null;
  let chainKey = "ethereum";
  let rpcs: string[] = [];
  let blocks = 2000;
  let ids: number[] = [];
  let gateway: string | null = null;
  let noDeep = false;
  let opensea = false;
  let ipfsLink: string | null = null;
  let rarity = false;
  let limit: number | null = null;
  let concurrency = 8;
  let top = 20;
  let pick = 0;
  let listings = false;
  let snipe = false;
  let noSnipe = false;
  let buy: string | null = null;
  let yes = false;
  let slug: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-deep") noDeep = true;
    else if (a === "--chain") chainKey = args[++i] ?? chainKey;
    else if (a === "--rpc") rpcs.push(args[++i] ?? "");
    else if (a === "--blocks") blocks = Number(args[++i] ?? 0) || 0;
    else if (a === "--ids") {
      const raw = args[++i] ?? "";
      ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    } else if (a === "--gateway") gateway = args[++i] ?? null;
    else if (a === "--opensea") opensea = true;
    else if (a === "--ipfs") ipfsLink = args[++i] ?? null;
    else if (a === "--rarity") rarity = true;
    else if (a === "--limit") limit = Number(args[++i] ?? 0) || null;
    else if (a === "--concurrency") concurrency = Number(args[++i] ?? 6) || 6;
    else if (a === "--top") top = Number(args[++i] ?? 20) || 20;
    else if (a === "--pick") pick = Number(args[++i] ?? 0) || 0;
    else if (a === "--listings") listings = true;
    else if (a === "--snipe") snipe = true;
    else if (a === "--no-snipe") noSnipe = true;
    else if (a === "--buy") buy = args[++i] ?? null;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--slug") slug = args[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --reveal-scan <contract> [options]

  --chain <key>      chain key or id (default ethereum)
  --rpc <url>        add an RPC endpoint (repeatable)
  --blocks <n>       sweep the last n blocks for metadata-like logs (default 2000)
  --no-deep          disable ABI getters / address hops / event decoding
  --ids 1,2,3        token ids to sample (default 1..5)
  --gateway <url>    pin a single IPFS gateway
  --opensea          also ask OpenSea's public token endpoint and compare
  --ipfs <link>      view an ipfs:// link, a CID, or a gateway URL (no contract)
  --rarity           score the mapping: trait rarities + the rarest token ids
  --limit <n>        with --rarity, stop after n tokens
  --concurrency <n>  with --rarity, parallel metadata fetches (default 8)
  --top <n>          with --rarity, how many rarest ids to list (default 20)
  --pick <n>         with --rarity, print a ready --token-id command for the nth
                     rarest token (scanner -> rarity -> position -> fire)
  --listings         with --rarity, also check whether the rarest ids are listed,
                     where, and for how much
  --no-snipe         with --listings, do not offer the snipe prompt
  --snipe            with --rarity, ask which reported token to buy, using the
                     same wallet file and prompt as the wizard
  --buy <tokenId>    with --rarity, buy one listed token without asking which
                     (the same encrypted wallets.json the wizard uses)
  --yes, -y          with --buy, send without asking
  --slug <slug>      override the collection slug (an address can resolve to
                     several OpenSea collections; the resolver refuses to guess)
                     (--limit defaults to 100; --limit 0 scores everything)

Reads only public data: the contract's baseURI / contractURI / tokenURI and
whatever IPFS or Arweave CIDs those already point at.`);
      process.exit(0);
    } else if (!a.startsWith("--")) {
      if (!contract) contract = a;
    }
  }
  return { contract, chainKey, rpcs: rpcs.filter(Boolean), blocks, deep: !noDeep, ids, gateway, opensea, ipfsLink, rarity, limit, concurrency, top, pick, listings, snipe, noSnipe, buy, yes, slug };
}

// ── OpenSea comparison (opt-in) ─────────────────────────────────────────────
// The window this looks for: the metadata has gone public, but OpenSea's index
// has not caught up with the contract yet — or has run ahead of it.
//
// Deliberately a REPORT, not a verdict. The endpoint below is the one verified
// against the live API (200 in range, 404 out of range, shape name/description/
// image/traits) — NOT /api/v2/chain/{chain}/token/{addr}/{id}, which 404s.
// The mode prints what OpenSea actually returned and only compares when both
// sides yielded a readable name.
interface OpenseaProbe {
  tokenId: number;
  status: number | null;
  error: string | null;
  name: string | null;
  image: string | null;
  traitCount: number | null;
  rawKeys: string[];
}

async function probeOpenseaToken(
  chain: string,
  contract: string,
  tokenId: number,
  apiKey: string,
  timeoutMs = 15_000
): Promise<OpenseaProbe> {
  const out: OpenseaProbe = { tokenId, status: null, error: null, name: null, image: null, traitCount: null, rawKeys: [] };
  // Verified live: /api/v2/metadata/{chain}/{contract}/{tokenId}.
  // 200 = OpenSea is serving metadata for this id; 404 = it has none indexed.
  const url = `https://api.opensea.io/api/v2/metadata/${encodeURIComponent(chain)}/${contract}/${tokenId}`;
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    out.status = r.status;
    if (r.status === 404) {
      out.error = "not indexed (404)";
      return out;
    }
    const text = await r.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      out.error = `HTTP ${r.status}, non-JSON body (${text.slice(0, 80)})`;
      return out;
    }
    if (body && typeof body === "object") {
      out.rawKeys = Object.keys(body).slice(0, 12);
      // An empty name is NOT "no metadata" — OpenSea serves "" for most ids of
      // a collection whose name lives on the image. Only a non-empty string is
      // a usable name signal.
      out.name = typeof body.name === "string" && body.name.trim() !== "" ? body.name : null;
      out.image = typeof body.image === "string" ? body.image : null;
      out.traitCount = Array.isArray(body.traits) ? body.traits.length : null;
      if (body?.error) out.error = String(body.error);
    } else {
      out.error = `HTTP ${r.status}, empty body`;
    }
  } catch (e: any) {
    out.error = e?.message ?? String(e);
  }
  return out;
}

/** Read the JSON a tokenURI points at, when it is reachable. */
async function readTokenUriJson(uri: string | null, timeoutMs = 15_000): Promise<any | null> {
  if (!uri) return null;
  const bare = uri.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "");
  const candidates = bare.includes("/")
    ? [`https://gateway.pinata.cloud/ipfs/${bare}`, `https://ipfs.io/ipfs/${bare}`]
    : [`https://gateway.pinata.cloud/ipfs/${bare}`, `https://ipfs.io/ipfs/${bare}`];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (!r.ok) continue;
      return JSON.parse(await r.text());
    } catch {
      // Next gateway.
    }
  }
  return null;
}

// A CIDv0 (Qm…, 46 chars) or a CIDv1 (base32, starts b). Accepts ipfs://,
// ar://, a bare CID, or a full gateway URL.
function normalizeIpfsLink(link: string): string | null {
  const raw = link.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    // Keep everything after /ipfs/, not just the CID: .../ipfs/<cid>/2 is token
    // 2's file, and reducing it to the CID would show the directory instead.
    const m = raw.match(/\/ipfs\/([^?#]+)/i);
    if (!m) return null;
    const parts = m[1].replace(/\/+$/, "").split("/");
    return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{20,})$/.test(parts[0])
      ? parts.join("/")
      : null;
  }
  // Keep any /path after the CID: ipfs://<cid>/1 is token 1's JSON, and dropping
  // the path would silently show the directory instead of the file.
  const bare = raw.replace(/^ipfs:\/\//i, "").replace(/^ar:\/\//i, "").split("?")[0].split("#")[0];
  const cid = bare.split("/")[0];
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{20,})$/.test(cid) ? bare.replace(/\/+$/, "") : null;
}

/**
 * Rarity over a published mapping.
 *
 * With --ipfs the CID is given directly. With a contract, the reveal scan runs
 * first and the CID is whatever directory it resolved — so this never reads
 * anything the contract does not already publish.
 */
function emptyListing(tokenId: string, error: string): ListingSummary {
  return {
    tokenId, orderHash: null, protocolAddress: null, chain: null, maker: null,
    currency: null, value: null, decimals: null, price: null, error,
  };
}

/**
 * One collection-level listing page covers every token in the rarity table.
 * The old code issued one GET per row, which was slow AND only looked at the
 * top few ids — so a rare token listed further down showed no price at all.
 */
export async function fetchListingPrices(
  slug: string,
  apiKey: string,
  ids: string[]
): Promise<{ byToken: Map<string, ListingSummary>; source: string }> {
  const byToken = new Map<string, ListingSummary>();
  try {
    const all = await fetchCollectionListings(slug, apiKey, { limit: 200, timeoutMs: 15_000 });
    for (const l of all) {
      const cur = byToken.get(l.tokenId);
      if (!cur || (l.price ?? Infinity) < (cur.price ?? Infinity)) byToken.set(l.tokenId, l);
    }
    if (byToken.size > 0) {
      for (const id of ids) if (!byToken.has(id)) byToken.set(id, emptyListing(id, "not listed"));
      return { byToken, source: "collection" };
    }
  } catch {
    // A refused collection read is not evidence that nothing is listed.
  }
  await Promise.all(
    ids.map(async (id) => {
      byToken.set(
        id,
        await fetchBestListing(slug, id, apiKey).catch((e: any) =>
          emptyListing(id, e?.message ?? "could not read")
        )
      );
    })
  );
  return { byToken, source: "per-token" };
}

/** Buy one listed token with the wizard's wallet loader, not a copy of it. */
export async function buyListedToken(o: {
  tokenId: string;
  slug: string;
  apiKey: string;
  chainKey: string;
  rpcs: string[];
  yes: boolean;
}): Promise<void> {
  await promptWalletPassphrase();
  const wallets = loadEnvKeys();
  if (!wallets.length) {
    console.log(chalk.yellow("  No usable wallet: set PRIVATE_KEY/PRIVATE_KEYS, or WALLETS_FILE with WALLETS_PASSPHRASE."));
    console.log(chalk.gray("  Nothing was sent."));
    return;
  }
  const listing = await fetchBestListing(o.slug, o.tokenId, o.apiKey).catch((e: any) => ({
    tokenId: o.tokenId, orderHash: null, protocolAddress: null, chain: null, maker: null,
    currency: null, value: null, decimals: null, price: null,
    error: e?.message ?? "fetch failed",
  }));
  if (listing.error || listing.price == null) {
    console.log(chalk.yellow(`  token ${o.tokenId}: cannot buy — ${listing.error ?? "price unknown"}`));
    return;
  }
  // Do not pin [0]: a dead first endpoint would disable the whole buy.
  let rpcUrl = "";
  for (const url of o.rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(4000),
      });
      const body: any = await res.json();
      if (body?.result) {
        rpcUrl = url;
        break;
      }
    } catch {
      // Next endpoint.
    }
  }
  if (!rpcUrl) {
    console.log(chalk.yellow("  No RPC answered eth_chainId — nothing was sent."));
    return;
  }
  const out = await executeListingBuy({
    listing,
    buyerKey: wallets[0].privateKey,
    apiKey: o.apiKey,
    rpcUrl,
    chainId: resolveChain(o.chainKey)?.chainId ?? 1,
    yes: o.yes,
    ask: askYesNo,
  });
  if (out.sent) console.log(chalk.green(`  sent: ${out.txHash}`));
  else console.log(chalk.yellow(`  not sent: ${out.reason}`));
}

async function runRarity(o: {
  cid: string | null;
  gateway: string | null;
  limit: number | null;
  concurrency: number;
  top: number;
  pick: number;
  listings: boolean;
  snipe: boolean;
  noSnipe: boolean;
  buy: string | null;
  yes: boolean;
  slug: string | null;
  contract: string | null;
  chainKey: string;
  rpcs: string[];
  blocks: number;
  deep: boolean;
  ids: number[];
}): Promise<number> {
  let cid = o.cid ? normalizeIpfsLink(o.cid) : null;
  let onchain: RevealScanResult | null = null;
  let rpcs: string[] = o.rpcs;
  let listingByToken = new Map<string, ListingSummary>();
  let listingsCtx: { apiKey: string; slug: string; source: string } | null = null;

  if (!cid && o.contract) {
    const profile = resolveChain(o.chainKey);
    if (!profile) {
      console.error(chalk.red(`\n❌ unknown chain: ${o.chainKey}\n`));
      return 2;
    }
    rpcs = o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(profile.key, []).urls;
    const r = await scanReveal({
      rpcUrls: rpcs,
      chainId: profile.chainId,
      contract: o.contract,
      sampleTokenIds: o.ids.length > 0 ? o.ids : undefined,
      logScanBlocks: o.blocks,
      ipfsGateways: o.gateway ? [o.gateway] : undefined,
      deep: o.deep,
      etherscanKey: process.env.ETHERSCAN_API_KEY,
    });
    const dir = r.inspections.find((i) => i.kind === "directory");
    // A single metadata FILE is also usable: rarity reads it as an aggregate.
    const file = r.inspections.find((i) => i.kind === "file");
    if (!dir && !file) {
      if (r.inspections.some((i) => i.kind === "unfetchable")) {
        // Could not tell is not the same as "there is none", and it must not
        // exit 0 — a scanner that cannot reach the data has found nothing.
        console.log(chalk.yellow("\n  Could not read the published metadata from any gateway — nothing to score."));
        console.log(chalk.gray("  That is UNKNOWN, not \"no metadata\": every gateway refused the request."));
        console.log(chalk.gray("  Retry, or pass --gateway <url> / --ipfs <link>."));
        console.log();
        return 2;
      }
      const dataUris = [
        ...(r.deepPointers?.uris ?? []),
        ...r.sampledTokenUris.map((s) => s.uri ?? ""),
      ].filter((u) => u.startsWith("data:application/json"));
      if (dataUris.length > 0 && r.totalSupply) {
        console.log(chalk.gray("\n  On-chain metadata: tokenURI(id) embeds JSON; scoring from the contract."));
        onchain = r;
      } else {
        console.log(chalk.yellow("\n  No published metadata directory for this contract — nothing to score."));
        console.log(chalk.gray("  Rarity needs the full id -> metadata mapping, not a single placeholder file."));
        console.log();
        return 0;
      }
    }
    cid = dir?.cid ?? file?.cid ?? null;
    if (!dir && file) {
      console.log(chalk.gray("  a single metadata file was found; rarity will try it as an aggregate"));
    }
    if (r.verdict !== "PUBLIC") {
      console.log(chalk.yellow(`\n  note: the reveal scan verdict is ${r.verdict}, not PUBLIC.`));
    }
  }

  if (!cid && !onchain) {
    console.error(chalk.red("\n❌ --rarity needs a published metadata directory: pass --ipfs <link> or a contract.\n"));
    return 2;
  }

  // Listing prices belong IN the rarity table, not in a detached second list.
  if ((o.listings || o.snipe || o.buy) && o.contract) {
    const key = (await getValidApiKey({ timeoutMs: 8000 }).catch(() => null))?.api_key ?? "";
    if (!key) {
      console.log(chalk.yellow("\n  Listings: no usable OpenSea key — prices stay unknown."));
    } else {
      const slug =
        o.slug ?? (await resolveContractToSlug(o.contract, key, 10000).catch(() => null));
      if (!slug) {
        console.log(chalk.yellow(`\n  Listings: could not resolve a slug for ${o.contract} — prices stay unknown.`));
      } else {
        // The collection page carries every listed id; join it against the
        // rarity rows after those rows exist. No per-token GETs needed here.
        const ids: string[] = o.buy ? [o.buy] : [];
        const prices = await fetchListingPrices(slug, key, ids);
        listingByToken = prices.byToken;
        listingsCtx = { apiKey: key, slug, source: prices.source };
      }
    }
  }

  console.log(chalk.gray(`\n  rarity: ${cid ?? "on-chain tokenURI"}\n`));
  const progress = (done: number, ok: number) => {
    if (done % 200 === 0 || done === ok) {
      process.stdout.write(chalk.gray(`\r    fetched ${done} entries, ${ok} scored...`));
    }
  };
  // Listed ids are crawled in the SAME pass as the rarity sample: a second
  // crawl re-walks providers and re-detects tokenURI, costing more than the
  // extra reads themselves.
  const listedIds = [...listingByToken.values()]
    .filter((l) => !l.error && Number.isFinite(Number(l.tokenId)))
    .map((l) => Number(l.tokenId))
    .filter((id, i, all) => all.indexOf(id) === i)
    .slice(0, 10);
  let crawl: CrawlResult;
  if (onchain) {
    crawl = await crawlOnchainTraits({
      contract: onchain.contract,
      rpcUrls: rpcs,
      chainId: onchain.chainId,
      totalSupply: Number(onchain.totalSupply),
      probeTokenId: onchain.sampledTokenUris.find((s) => s.uri?.startsWith("data:"))?.tokenId,
      extraIds: listingsCtx ? listedIds : [],
      limit: o.limit ?? 100,
      concurrency: o.concurrency,
      timeoutMs: 600_000,
      onProgress: progress,
    });
  } else {
    crawl = await crawlTraits({
      cid: cid!,
      gateways: o.gateway ? [o.gateway] : undefined,
      concurrency: o.concurrency,
      limit: o.limit ?? 100,
      timeoutMs: 600_000,
      onProgress: progress,
    });
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  // Persist what was scored so a throttled run resumes instead of refetching.
  if (cid && crawl.tokens.length > crawl.fromCache) saveRarityCache(cid, crawl.tokens);

  let report = computeRarity(crawl.tokens);

  // Absence from a SUCCESSFUL collection listing page is a real "not listed".
  if (listingsCtx) {
    for (const row of report.rows) {
      const id = String(row.tokenId);
      if (!listingByToken.has(id)) listingByToken.set(id, emptyListing(id, "not listed"));
    }
  }

  const listed = crawl.listed;
  const pct = listed > 0 ? (report.scored / listed) * 100 : 0;

  console.log(
    `  listed:    ${listed} entries${crawl.truncated ? ` (sampled ${o.limit ?? 100} spread across the range)` : ""}`
  );
  // Say how much was ATTEMPTED, not just how much exists: "scored 38 / 10000"
  // reads as though 10000 were tried.
  console.log(
    `  attempted: ${crawl.tokens.length} id(s)  (${crawl.fromCache} cached, ${crawl.tokens.length - crawl.fromCache} fetched this run)`
  );
  if (listed > 0) {
    console.log(
      `  scored:    ${report.scored} / ${listed} collection entries (${pct.toFixed(1)}%) in ${(crawl.elapsedMs / 1000).toFixed(1)}s`
    );
  } else {
    // The index could not be read, so there is no denominator. Scored tokens are
    // still reported — from the cache — but coverage is unknown, not zero.
    console.log(
      `  scored:    ${report.scored} from cache in ${(crawl.elapsedMs / 1000).toFixed(1)}s (directory index unavailable — coverage unknown)`
    );
  }
  if (crawl.failed > 0) console.log(chalk.yellow(`  failed:    ${crawl.failed} entries could not be read`));
  if (crawl.skipped > 0) console.log(chalk.gray(`  skipped:   ${crawl.skipped} non-token entries`));
  if (crawl.fromCache > 0) console.log(chalk.gray(`  cache:     ${crawl.fromCache} token(s) reused from .minter-cache/rarity`));
  if (crawl.indexFromCache) console.log(chalk.gray("  index:     reused from .minter-cache/rarity (no gateway fetch)"));
  if (crawl.source === "aggregate") {
    console.log(chalk.gray(`  source:    single aggregate file ${crawl.aggregateFile} (no per-token files)`));
  }
  if (crawl.ignoredTraits > 0) {
    console.log(
      chalk.gray(
        `  ignored:   ${crawl.ignoredTraits} attribute entr${crawl.ignoredTraits === 1 ? "y" : "ies"} (no usable value, or an unknown display_type)`
      )
    );
  }
  console.log();

  if (report.scored === 0) {
    console.log(chalk.yellow("  Nothing could be scored — every gateway refused or timed out."));
    console.log(chalk.yellow("  That is a network result, not a property of the collection."));
    console.log();
    return 2;
  }

  if (listed > 0 && pct < 100) {
    console.log(chalk.yellow(`  ⚠ Only ${pct.toFixed(1)}% of the mapping was read. "Rarest" below means rarest`));
    console.log(chalk.yellow("    among the tokens that were actually scored — a lower bound, not the full table."));
    console.log();
  }

  const types = Object.keys(report.frequencies);
  console.log(chalk.gray(`  trait types: ${types.join(", ") || "(none)"}`));
  console.log();
  console.log("  rarest tokens:");
  report.rows.slice(0, o.top).forEach((row, i) => {
    const traitText = row.traits
      .slice()
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3)
      .map((t) => `${t.type}=${t.value} (${t.pct.toFixed(1)}%)`)
      .join(", ");
    const listed = listingByToken.get(String(row.tokenId));
    const priceText = listed ? `  ${formatRarityListing(listed)}` : "";
    console.log(
      `  ${String(i + 1).padStart(2)}. token ${String(row.tokenId).padStart(6)}  score ${row.score.toFixed(1).padStart(8)}  ${traitText}${priceText}`
    );
  });
  if (report.rows.length > o.top) {
    console.log(chalk.gray(`\n  …and ${report.rows.length - o.top} more`));
  }
  const listedRows = report.rows.filter((r) => {
    const l = listingByToken.get(String(r.tokenId));
    return l != null && !l.error;
  });
  if (listedRows.length) {
    console.log();
    console.log(chalk.bold.white("  rare + listed:"));
    for (const r of listedRows) {
      const l = listingByToken.get(String(r.tokenId))!;
      console.log(
        `    token ${String(r.tokenId).padStart(6)}  score ${r.score.toFixed(1).padStart(8)}  ${formatRarityListing(l)}`
      );
    }
  }

  if (o.pick > 0 && report.rows.length > 0) {
    const row = report.rows[Math.min(o.pick, report.rows.length) - 1];
    const qty = 1;
    console.log();
    console.log(chalk.bold.white(`  pick #${o.pick}: token ${row.tokenId}`));
    console.log(chalk.gray(`  fire on that position with:`));
    console.log(chalk.white(`    minter --fcfs <target> --token-id ${row.tokenId} --quantity ${qty}`));
    console.log(chalk.gray(`  (the mint starts at tokenId - quantity + 1, so quantity shifts the range)`));
  }
  // ── Listings / snipe ─────────────────────────────────────────────────
  if (listingsCtx) {
    console.log();
    console.log(chalk.bold.white("  Listings"));
    console.log(chalk.gray(`  collection: ${listingsCtx.slug}  (prices from ${listingsCtx.source} listings)`));
    for (const [id, l] of listingByToken) console.log(printListingLine(l));
    console.log();
    console.log(chalk.gray("  Only OpenSea is checked. Reservoir — the aggregator that would have"));
    console.log(chalk.gray("  covered Blur/LooksRare/X2Y2 — was sunset on 2025-10-15."));
  }

  const wantsSnipe = o.snipe || (o.listings && process.stdin.isTTY && !o.noSnipe);
  if (wantsSnipe && !process.stdin.isTTY && !o.buy) {
    console.log(chalk.yellow("\n  --snipe needs a TTY to ask which token; headless runs use --buy <tokenId>."));
  } else if (listingsCtx && (o.buy || wantsSnipe)) {
    const answer = o.buy
      ? o.buy
      : (await askText("Snipe a listed token? (token id, blank to skip)", "")).trim();
    if (answer) {
      if (!report.rows.some((r) => String(r.tokenId) === answer)) {
        console.log(chalk.yellow(`  token ${answer} is not among the rarity rows — nothing was sent.`));
      } else {
        console.log();
        await buyListedToken({
          tokenId: answer,
          slug: listingsCtx.slug,
          apiKey: listingsCtx.apiKey,
          chainKey: o.chainKey,
          rpcs: rpcs,
          yes: o.yes,
        });
      }
    }
  }

  console.log();
  console.log(chalk.gray("  Rarity is a property of the metadata, not a market value."));
  console.log(chalk.gray("  Token ids are sequential — pair a target id with --token-id."));
  console.log();
  return 0;
}

async function runIpfsView(link: string, gateway: string | null): Promise<number> {
  const cid = normalizeIpfsLink(link);
  if (!cid) {
    console.error(chalk.red(`\n❌ not an IPFS link or CID: ${link}\n`));
    return 2;
  }
  console.log(chalk.gray(`\n  ipfs: ${link}\n`));
  const r = await inspectPublicCid(cid, gateway ? [gateway] : undefined);
  console.log(`  kind:      ${r.kind}  files=${r.fileCount}`);
  if (r.url) console.log(`  url:       ${r.url}`);
  if (r.note) console.log(`  note:      ${r.note}`);
  if (r.sample.length > 0) console.log(`  sample:    ${r.sample.slice(0, 8).join(", ")}`);
  console.log();
  if (r.kind === "unfetchable") {
    console.log(chalk.yellow("  No gateway answered. A bot wall or rate limit still returns HTML,"));
    console.log(chalk.yellow('  so this is "could not fetch", not "does not exist".'));
    console.log();
    return 2;
  }
  if (r.kind === "file") {
    // One JSON is not automatically the placeholder: it is the placeholder only
    // when it is the SAME document for every id. Say what it is, not what it
    // implies.
    console.log(chalk.gray("  A single file. Whether that is the placeholder depends on whether every"));
    console.log(chalk.gray("  id returns this same document — compare it against another id."));
    console.log();
  } else {
    console.log(chalk.gray("  A directory of per-token files: the full id -> metadata mapping."));
    console.log();
  }
  return 0;
}

export async function runRevealScanCli(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  // --rarity wins over a plain --ipfs view: scoring the directory subsumes it.
  if (parsed.rarity) {
    return runRarity({
      cid: parsed.ipfsLink,
      gateway: parsed.gateway,
      limit: parsed.limit,
      concurrency: parsed.concurrency,
      top: parsed.top,
      pick: parsed.pick,
      listings: parsed.listings,
      snipe: parsed.snipe,
      noSnipe: parsed.noSnipe,
      buy: parsed.buy,
      yes: parsed.yes,
      slug: parsed.slug,
      contract: parsed.contract,
      chainKey: parsed.chainKey,
      rpcs: parsed.rpcs,
      ids: parsed.ids,
      blocks: parsed.blocks,
      deep: parsed.deep,
    });
  }
  if (parsed.ipfsLink) {
    return runIpfsView(parsed.ipfsLink, parsed.gateway);
  }
  if (!parsed.contract) {
    console.error(chalk.red("\n❌ reveal-scan needs a contract address: minter --reveal-scan <contract>\n"));
    return 2;
  }
  const profile = resolveChain(parsed.chainKey);
  if (!profile) {
    console.error(chalk.red(`\n❌ unknown chain: ${parsed.chainKey}\n`));
    return 2;
  }

  const rpcs =
    parsed.rpcs.length > 0 ? parsed.rpcs : resolveRpcsForChain(profile.key, []).urls;
  if (rpcs.length === 0) {
    console.error(chalk.red(`\n❌ no RPC endpoints for ${profile.key}. Pass --rpc <url>.\n`));
    return 2;
  }

  console.log(
    chalk.gray(`\n  reveal scan: ${parsed.contract} on ${profile.key} via ${rpcs.length} endpoint(s)\n`)
  );

  const r = await scanReveal({
    rpcUrls: rpcs,
    chainId: profile.chainId,
    contract: parsed.contract,
    sampleTokenIds: parsed.ids.length > 0 ? parsed.ids : undefined,
    logScanBlocks: parsed.blocks,
    ipfsGateways: parsed.gateway ? [parsed.gateway] : undefined,
    deep: parsed.deep,
    etherscanKey: process.env.ETHERSCAN_API_KEY,
  });

  const colour =
    r.verdict === "PUBLIC" ? chalk.red : r.verdict === "PARTIAL" ? chalk.yellow : r.verdict === "HIDDEN" ? chalk.green : chalk.gray;
  console.log(`  verdict:   ${colour(r.verdict)}`);
  console.log(`  standard:  ${r.standard}`);
  console.log(`  baseURI:   ${r.baseURI ?? "(none)"}`);
  console.log(`  revealed:  ${r.revealedBySlash == null ? "unknown" : r.revealedBySlash ? "yes (trailing slash)" : "no"}`);
  if (r.contractURI) console.log(`  contractURI: ${r.contractURI}`);
  if (r.totalSupply != null) console.log(`  supply:    ${r.totalSupply}`);

  if (r.sampledTokenUris.length > 0) {
    console.log(`  tokenURIs: ${r.distinctTokenUris} distinct across ${r.sampledTokenUris.length} sampled`);
    for (const s of r.sampledTokenUris) {
      const shown = s.uri ? s.uri : s.error ? `(reverted: ${String(s.error).slice(0, 60)})` : "(null)";
      console.log(`    ${String(s.tokenId).padStart(6)}  ${shown}`);
    }
  }

  for (const i of r.inspections) {
    console.log(`  cid:       ${i.cid}`);
    console.log(`    ${i.kind}  files=${i.fileCount}  ${i.note ?? ""}`);
    if (i.url) console.log(chalk.gray(`    view: ${i.url}`));
    if (i.sample.length > 0) console.log(`    sample: ${i.sample.join(", ")}`);
  }

  if (r.deepPointers?.sources.length) {
    console.log(`  pointers:  ${r.deepPointers.sources.length} from the ABI / events`);
    for (const p of r.deepPointers.sources.slice(0, 5)) console.log(chalk.gray(`    ${p}`));
  }

  if (r.deepPointers?.sources.length) {
    console.log(`  pointers:  ${r.deepPointers.sources.length} from the ABI / events`);
    for (const p of r.deepPointers.sources.slice(0, 5)) console.log(chalk.gray(`    ${p}`));
  }

  if (r.logHits.length > 0) {
    console.log(`  log hits:  ${r.logHits.length}`);
    for (const h of r.logHits.slice(0, 5)) {
      console.log(`    block ${h.blockNumber}  ${h.metadataLike.join(", ")}`);
    }
  }

  console.log();
  for (const f of r.findings) {
    // Provenance is printed in the dedicated pointers block above.
    if (f.startsWith("pointer: ") && r.deepPointers?.sources.length) continue;
    console.log(`  ${f}`);
  }
  if (r.error) console.log(chalk.red(`\n  error: ${r.error}\n`));
  // ── OpenSea comparison (opt-in) ───────────────────────────────────────────
  if (parsed.opensea) {
    console.log(chalk.bold.white("\nOpenSea comparison"));
    const resolved = await getValidApiKey({ timeoutMs: 8000 }).catch(() => null);
    if (!resolved) {
      console.log(chalk.yellow("  No usable OpenSea key — skipping. Nothing was concluded."));
    } else {
      const idsToProbe = (parsed.ids.length > 0 ? parsed.ids : r.sampledTokenUris.map((s) => s.tokenId)).slice(0, 3);
      console.log(chalk.gray(`  key source: ${resolved.source}`));
      for (const id of idsToProbe) {
        const probe = await probeOpenseaToken(profile.key, parsed.contract, id, resolved.api_key);
        const onChain = r.sampledTokenUris.find((s) => s.tokenId === id);
        const onChainJson = await readTokenUriJson(onChain?.uri ?? null);
        const onChainName = typeof onChainJson?.name === "string" ? onChainJson.name : null;
        const osName = probe.status === 200 ? probe.name : null;
        console.log(`  token ${id}:`);
        console.log(
          `    opensea:  http ${probe.status ?? "-"}${probe.error ? "  " + probe.error : ""}${osName ? `  name "${osName.slice(0, 60)}"` : ""}${probe.traitCount != null ? `  traits ${probe.traitCount}` : ""}${probe.image ? "  image yes" : ""}`
        );
        console.log(
          `    onchain:  ${onChainName ? `name "${onChainName.slice(0, 60)}"` : onChain?.uri ? onChain.uri.slice(0, 70) : "(no tokenURI)"}`
        );
        if (osName && onChainName && osName !== onChainName) {
          console.log(chalk.yellow("    → the two differ: OpenSea is serving metadata the chain does not."));
        } else if (osName && onChainName) {
          console.log(chalk.gray("    → identical."));
        } else if (probe.status === 404 && onChainName) {
          console.log(chalk.gray("    → OpenSea has not indexed this id; the chain does have metadata."));
        }
      }
    }
    console.log();
  }

  console.log();

  // Exit codes are a scanner's contract: 0 = nothing leaked, 1 = leaked,
  // 2 = could not tell. "Could not tell" must not read as "clean" — an
  // unreachable RPC is not evidence that a drop is hidden.
  if (r.verdict === "PUBLIC") return 1;
  if (r.verdict === "UNKNOWN") return 2;
  return 0;
}
