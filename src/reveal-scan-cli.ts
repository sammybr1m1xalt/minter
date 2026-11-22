// `--reveal-scan <contract>` — is this drop's id -> artwork mapping actually
// private, or is it already readable?
//
// Read-only and public-data-only. It reads the contract and resolves whatever
// CIDs the contract already publishes. See reveal-scan.ts for the reasoning and
// for what it deliberately does not do.
import chalk from "chalk";
import { getValidApiKey } from "./opensea-key";
import { inspectPublicCid, scanReveal } from "./reveal-scan";
import { computeRarity, crawlTraits, saveRarityCache } from "./rarity";
import { fetchBestListing, printListingLine } from "./buy-listings";
import { resolveContractToSlug } from "./slug-resolver";
import { executeListingBuy } from "./buy-listings";
import { promptWalletPassphrase, walletFilePath } from "./wizard";
import { loadKeysFromFile, readWalletFilePath } from "./wallet-file";
import { askYesNo } from "./prompt";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";

function parseArgs(args: string[]): {
  contract: string | null;
  chainKey: string;
  rpcs: string[];
  blocks: number;
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
  buy: string | null;
  yes: boolean;
  slug: string | null;
} {
  let contract: string | null = null;
  let chainKey = "ethereum";
  let rpcs: string[] = [];
  let blocks = 0;
  let ids: number[] = [];
  let gateway: string | null = null;
  let opensea = false;
  let ipfsLink: string | null = null;
  let rarity = false;
  let limit: number | null = null;
  let concurrency = 6;
  let top = 20;
  let pick = 0;
  let listings = false;
  let buy: string | null = null;
  let yes = false;
  let slug: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chain") chainKey = args[++i] ?? chainKey;
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
    else if (a === "--buy") buy = args[++i] ?? null;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--slug") slug = args[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --reveal-scan <contract> [options]

  --chain <key>      chain key or id (default ethereum)
  --rpc <url>        add an RPC endpoint (repeatable)
  --blocks <n>       sweep the last n blocks for metadata-like logs (default off)
  --ids 1,2,3        token ids to sample (default 1..5)
  --gateway <url>    pin a single IPFS gateway
  --opensea          also ask OpenSea's public token endpoint and compare
  --ipfs <link>      view an ipfs:// link, a CID, or a gateway URL (no contract)
  --rarity           score the mapping: trait rarities + the rarest token ids
  --limit <n>        with --rarity, stop after n tokens
  --concurrency <n>  with --rarity, parallel metadata fetches (default 6)
  --top <n>          with --rarity, how many rarest ids to list (default 20)
  --pick <n>         with --rarity, print a ready --token-id command for the nth
                     rarest token (scanner -> rarity -> position -> fire)
  --listings         with --rarity, also check whether the rarest ids are listed,
                     where, and for how much
  --buy <tokenId>    with --rarity, buy one listed token using the wallet file
                     (the same encrypted wallets.json the wizard uses)
  --yes, -y          with --buy, send without asking
  --slug <slug>      override the collection slug (an address can resolve to
                     several OpenSea collections; the resolver refuses to guess)
                     (--limit defaults to 500; --limit 0 scores everything)

Reads only public data: the contract's baseURI / contractURI / tokenURI and
whatever IPFS or Arweave CIDs those already point at.`);
      process.exit(0);
    } else if (!a.startsWith("--")) {
      if (!contract) contract = a;
    }
  }
  return { contract, chainKey, rpcs: rpcs.filter(Boolean), blocks, ids, gateway, opensea, ipfsLink, rarity, limit, concurrency, top, pick, listings, buy, yes, slug };
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
async function runRarity(o: {
  cid: string | null;
  gateway: string | null;
  limit: number | null;
  concurrency: number;
  top: number;
  pick: number;
  listings: boolean;
  buy: string | null;
  yes: boolean;
  slug: string | null;
  contract: string | null;
  chainKey: string;
  rpcs: string[];
  ids: number[];
  blocks: number;
}): Promise<number> {
  let cid = o.cid ? normalizeIpfsLink(o.cid) : null;

  if (!cid && o.contract) {
    const profile = resolveChain(o.chainKey);
    if (!profile) {
      console.error(chalk.red(`\n❌ unknown chain: ${o.chainKey}\n`));
      return 2;
    }
    const rpcs = o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(profile.key, []).urls;
    const r = await scanReveal({
      rpcUrls: rpcs,
      chainId: profile.chainId,
      contract: o.contract,
      sampleTokenIds: o.ids.length > 0 ? o.ids : undefined,
      logScanBlocks: o.blocks,
      ipfsGateways: o.gateway ? [o.gateway] : undefined,
    });
    const dir = r.inspections.find((i) => i.kind === "directory");
    if (!dir) {
      console.log(chalk.yellow("\n  No published metadata directory for this contract — nothing to score."));
      console.log(chalk.gray("  Rarity needs the full id -> metadata mapping, not a single placeholder file."));
      console.log();
      return 0;
    }
    cid = dir.cid;
    if (r.verdict !== "PUBLIC") {
      console.log(chalk.yellow(`\n  note: the reveal scan verdict is ${r.verdict}, not PUBLIC.`));
    }
  }

  if (!cid) {
    console.error(chalk.red("\n❌ --rarity needs a published metadata directory: pass --ipfs <link> or a contract.\n"));
    return 2;
  }

  console.log(chalk.gray(`\n  rarity: ${cid}\n`));
  const crawl = await crawlTraits({
    cid,
    gateways: o.gateway ? [o.gateway] : undefined,
    concurrency: o.concurrency,
    limit: o.limit ?? 500,
    timeoutMs: 600_000,
    onProgress: (done, ok) => {
      if (done % 200 === 0 || done === ok) {
        process.stdout.write(chalk.gray(`\r    fetched ${done} entries, ${ok} scored...`));
      }
    },
  });
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  // Persist what was scored so a throttled run resumes instead of refetching.
  if (crawl.tokens.length > crawl.fromCache) saveRarityCache(cid, crawl.tokens);

  const report = computeRarity(crawl.tokens);
  const listed = crawl.listed;
  const pct = listed > 0 ? (report.scored / listed) * 100 : 0;

  console.log(
    `  listed:    ${listed} entries${crawl.truncated ? ` (sampled ${o.limit ?? 500} spread across the range)` : ""}`
  );
  // Say how much was ATTEMPTED, not just how much exists: "scored 38 / 10000"
  // reads as though 10000 were tried.
  console.log(
    `  attempted: ${crawl.tokens.length} id(s)  (${crawl.fromCache} cached, ${crawl.tokens.length - crawl.fromCache} fetched this run)`
  );
  console.log(`  scored:    ${report.scored} / ${listed} collection entries (${pct.toFixed(1)}%) in ${(crawl.elapsedMs / 1000).toFixed(1)}s`);
  if (crawl.failed > 0) console.log(chalk.yellow(`  failed:    ${crawl.failed} entries could not be read`));
  if (crawl.skipped > 0) console.log(chalk.gray(`  skipped:   ${crawl.skipped} non-token entries`));
  if (crawl.fromCache > 0) console.log(chalk.gray(`  cache:     ${crawl.fromCache} token(s) reused from .minter-cache/rarity`));
  console.log();

  if (report.scored === 0) {
    console.log(chalk.yellow("  Nothing could be scored — every gateway refused or timed out."));
    console.log(chalk.yellow("  That is a network result, not a property of the collection."));
    console.log();
    return 2;
  }

  if (pct < 100) {
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
    console.log(
      `  ${String(i + 1).padStart(2)}. token ${String(row.tokenId).padStart(6)}  score ${row.score.toFixed(1).padStart(8)}  ${traitText}`
    );
  });
  if (report.rows.length > o.top) {
    console.log(chalk.gray(`\n  …and ${report.rows.length - o.top} more`));
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
  // ── Listings check ───────────────────────────────────────────────────────
  // "Is this rare token already listed, where, and how much?" Only the rarity
  // table makes the question worth asking: before the reveal nobody knows which
  // id is rare, so a seller listing one cheap is the actual edge.
  if ((o.listings || o.buy) && o.contract) {
    const apiKey = (await getValidApiKey({ timeoutMs: 8000 }).catch(() => null))?.api_key ?? "";
    if (!apiKey) {
      console.log(chalk.yellow("\n  Listings: no usable OpenSea key — skipping. Nothing was concluded."));
    } else {
      const slug =
        o.slug ?? (await resolveContractToSlug(o.contract, apiKey, 10000).catch(() => null));
      if (!slug) {
        console.log(chalk.yellow(`\n  Listings: could not resolve a slug for ${o.contract} — skipping.`));
      } else {
        const ids = o.buy
          ? [o.buy]
          : report.rows.slice(0, Math.min(o.top, 10)).map((r) => String(r.tokenId));
        console.log();
        console.log(chalk.bold.white("  Listings"));
        console.log(chalk.gray(`  collection: ${slug}`));
        for (const id of ids) {
          const l = await fetchBestListing(slug, id, apiKey).catch((e: any) => ({
            tokenId: id, orderHash: null, protocolAddress: null, chain: null, maker: null,
            currency: null, value: null, decimals: null, price: null,
            error: e?.message ?? "fetch failed",
          }));
          console.log(printListingLine(l));
        }
        console.log();
        console.log(chalk.gray("  Only OpenSea is checked. Reservoir — the aggregator that would have"));
        console.log(chalk.gray("  covered Blur/LooksRare/X2Y2 — was sunset on 2025-10-15."));
        if (o.buy) {
          console.log();
          // The wallet is loaded exactly the way the wizard loads it, so an
          // encrypted wallets.json works here unchanged.
          await promptWalletPassphrase();
          const file = walletFilePath();
          const text = readWalletFilePath(file);
          // A missing file is not a malformed one — saying "malformed" sends the
          // user hunting for a corruption that is not there.
          const loaded =
            text == null
              ? { keys: [] as string[], status: "absent" as const, detail: `${file} does not exist` }
              : loadKeysFromFile(file, text, process.env.WALLETS_PASSPHRASE ?? null);
          if (loaded.keys.length === 0) {
            console.log(chalk.yellow(`  No usable wallet from ${file} (${loaded.status}${loaded.detail ? ": " + loaded.detail : ""}).`));
            console.log(chalk.yellow("  Set PRIVATE_KEY/PRIVATE_KEYS, or WALLETS_FILE with WALLETS_PASSPHRASE."));
          } else {
            const listing = await fetchBestListing(slug, o.buy, apiKey);
            const out = await executeListingBuy({
              listing,
              buyerKey: loaded.keys[0],
              apiKey,
              rpcUrl: o.rpcs[0] ?? "",
              chainId: resolveChain(o.chainKey)?.chainId ?? 1,
              yes: o.yes,
              ask: askYesNo,
            });
            if (out.sent) {
              console.log(chalk.green(`  sent: ${out.txHash}`));
            } else {
              console.log(chalk.yellow(`  not sent: ${out.reason}`));
            }
          }
        }
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
      buy: parsed.buy,
      yes: parsed.yes,
      slug: parsed.slug,
      contract: parsed.contract,
      chainKey: parsed.chainKey,
      rpcs: parsed.rpcs,
      ids: parsed.ids,
      blocks: parsed.blocks,
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

  if (r.logHits.length > 0) {
    console.log(`  log hits:  ${r.logHits.length}`);
    for (const h of r.logHits.slice(0, 5)) {
      console.log(`    block ${h.blockNumber}  ${h.metadataLike.join(", ")}`);
    }
  }

  console.log();
  for (const f of r.findings) console.log(`  ${f}`);
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
