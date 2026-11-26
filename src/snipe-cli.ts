// `--snipe` — standalone buy path. Everything that can spend money lives here.
// `--reveal-scan` only reports; it never loads a wallet, estimates gas or sends.
import chalk from "chalk";
import { fetchBestListing, executeListingBuy, executeBatchListingBuy, type ListingSummary } from "./buy-listings";
import { runRarity, type RarityCapture } from "./reveal-scan-cli";
import { loadEnvKeys, promptWalletPassphrase } from "./wizard";
import { askText, askYesNo, closePrompts } from "./prompt";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { normalizeIpfsLink } from "./reveal-scan-cli";
import { scrapeOne, scrapeMany, printTargetedScrape, resolveListingContext } from "./snipe-target";

interface SnipeArgs {
  target: string | null;
  tokenId: string | null;
  tokenIds: string[];
  count: number | null;
  slug: string | null;
  chainKey: string;
  rpcs: string[];
  gateway: string | null;
  ipfsLink: string | null;
  rarity: boolean;
  limit: number | null;
  top: number;
  yes: boolean;
  blocks: number;
  deep: boolean;
}

export function parseArgs(args: string[]): SnipeArgs {
  const out: SnipeArgs = {
    target: null, tokenId: null, tokenIds: [], count: null, slug: null, chainKey: "ethereum", rpcs: [],
    gateway: null, ipfsLink: null, rarity: false, limit: 20, top: 20, yes: false, blocks: 2000, deep: true,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--token-id" || a === "--buy") {
      const raw = args[++i] ?? "";
      out.tokenIds.push(...raw.split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)));
    } else if (a.startsWith("--token-id=")) {
      out.tokenIds.push(...a.slice(11).split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)));
    } else if (a === "--count") out.count = Number(args[++i] ?? 0) || null;
    else if (a === "--slug") out.slug = args[++i] ?? null;
    else if (a === "--chain") out.chainKey = args[++i] ?? "ethereum";
    else if (a === "--rpc") out.rpcs.push(args[++i] ?? "");
    else if (a === "--gateway") out.gateway = args[++i] ?? null;
    else if (a === "--ipfs") out.ipfsLink = args[++i] ?? null;
    else if (a === "--rarity") out.rarity = true;
    else if (a === "--limit") out.limit = Number(args[++i] ?? 20) || 20;
    else if (a === "--top") out.top = Number(args[++i] ?? 20) || 20;
    else if (a === "--blocks") out.blocks = Number(args[++i] ?? 2000) || 2000;
    else if (a === "--no-deep") out.deep = false;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --snipe [target] [options]

  --token-id <id>    repeatable or comma-separated; multiple ids enter batch mode
  --count <n>        how many probed tokens to buy (headless batch mode)
  --rarity           accepted for --reveal-scan --rarity --snipe form
  --slug <slug>      override the OpenSea collection slug
  --chain <key>      chain key (default ethereum)
  --rpc <url>        RPC endpoint (repeatable)
  --gateway <url>    pin an IPFS gateway
  --limit <n>        rarity sample size (default 20)
  --top <n>          rows to print (default 20)
  --yes, -y          send without a confirmation prompt
  --no-deep          skip deep reveal discovery
`);
    } else if (!a.startsWith("--")) positional.push(a);
  }
  // `--snipe 3255` is a token id, not a contract address. The contract is the
  // non-numeric positional (it was already given before --rarity/--snipe).
  // An explicit --token-id always wins over a positional number.
  const numbers = positional.filter((p) => /^\d+$/.test(p));
  out.tokenIds.push(...numbers);
  out.tokenIds = [...new Set(out.tokenIds)];
  out.tokenId = out.tokenIds[0] ?? null;
  if (!out.target) out.target = positional.find((p) => !/^\d+$/.test(p)) ?? numbers[1] ?? null;
  return out;
}

function emptyListing(tokenId: string, error: string): ListingSummary {
  return {
    tokenId, orderHash: null, protocolAddress: null, chain: null, maker: null,
    currency: null, value: null, decimals: null, price: null, error,
    collection: null, paymentToken: null,
  };
}

/** Walk RPCs and use one that actually answers for this chain. */
async function pickRpc(urls: string[], chainId: number): Promise<string> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(4000),
      });
      const body: any = await res.json();
      if (Number(body?.result) === chainId) return url;
    } catch {
      // Next endpoint.
    }
  }
  return "";
}

/** The one wallet loader every spend path uses. */
async function loadBuyerWallet(): Promise<string | null> {
  await promptWalletPassphrase();
  const wallets = loadEnvKeys();
  if (!wallets.length) {
    console.log(chalk.yellow("  No usable wallet: set PRIVATE_KEY/PRIVATE_KEYS, or WALLETS_FILE with WALLETS_PASSPHRASE."));
    console.log(chalk.gray("  Nothing was sent."));
    return null;
  }
  return wallets[0].privateKey;
}

/** Buy one listed id with the wizard's wallet loader, not a copy of it. */
export async function buyListedToken(o: {
  tokenId: string;
  slug: string;
  apiKey: string;
  chainKey: string;
  rpcs: string[];
  yes: boolean;
}): Promise<void> {
  const buyerKey = await loadBuyerWallet();
  if (!buyerKey) return;
  // Re-read the listing immediately before send; the reported order may be gone.
  const listing = await fetchBestListing(o.slug, o.tokenId, o.apiKey).catch((e: any) =>
    emptyListing(o.tokenId, e?.message ?? "fetch failed")
  );
  if (listing.error || listing.price == null) {
    console.log(chalk.yellow(`  token ${o.tokenId}: cannot buy — ${listing.error ?? "price unknown"}`));
    return;
  }
  const chainId = resolveChain(o.chainKey)?.chainId ?? 1;
  const rpcUrl = await pickRpc(o.rpcs, chainId);
  if (!rpcUrl) {
    console.log(chalk.yellow("  No RPC answered eth_chainId — nothing was sent."));
    return;
  }
  const out = await executeListingBuy({
    listing,
    buyerKey,
    apiKey: o.apiKey,
    rpcUrl,
    chainId,
    yes: o.yes,
    ask: askYesNo,
  });
  if (out.sent) console.log(chalk.green(`  sent: ${out.txHash}`));
  else console.log(chalk.yellow(`  not sent: ${out.reason}`));
}

export async function runSnipeCli(args: string[]): Promise<number> {
  const o = parseArgs(args);
  let target = o.target;
  if (!target) target = (await askText("Contract address or IPFS link to score", "")).trim();
  if (!target && o.ipfsLink) target = o.ipfsLink;
  if (!target) {
    console.log(chalk.yellow("\n  No target — nothing was scanned or sent.\n"));
    return 2;
  }

  // Batch form: several exact ids, one listing page, one Seaport tx.
  if (o.tokenIds.length > 1) {
    const contract = normalizeIpfsLink(target) ? null : target;
    const ctx = await resolveListingContext({ contract, slug: o.slug });
    if (!ctx) {
      console.log(chalk.yellow("\n  No usable OpenSea key/slug — listings unknown, nothing was sent.\n"));
      return 2;
    }
    const rpcs = o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls;
    const rows = await scrapeMany({
      contract, cid: normalizeIpfsLink(target), tokenIds: o.tokenIds,
      chainKey: o.chainKey, rpcs, gateway: o.gateway, slug: ctx.slug, apiKey: ctx.apiKey,
    });
    console.log();
    console.log(chalk.bold.white("  probed tokens"));
    for (const r of rows) {
      const traits = r.traits.slice(0, 3).map((t) => `${t.type}=${t.value}`).join(", ");
      console.log(
        `    token ${String(r.tokenId).padStart(6)}  ${r.listing.error ? r.listing.error : `listed ${r.listing.price} ${r.listing.currency ?? "ETH"}`}` +
        `${traits ? `  ${traits.slice(0, 100)}` : ""}`
      );
    }
    const listed = rows.filter((r) => !r.listing.error && r.listing.price != null);
    if (!listed.length) {
      console.log(chalk.yellow("\n  None of the probed tokens is listed — nothing was sent.\n"));
      return 2;
    }
    let count = o.count;
    if (count == null) {
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow("\n  Batch snipe needs --count <n> in a headless run.\n"));
        return 2;
      }
      const answer = (await askText(`How many of the ${listed.length} listed tokens to buy? (0 to cancel)`, "0")).trim();
      if (!/^\\d+$/.test(answer)) {
        console.log(chalk.yellow("\n  Invalid count — nothing was sent.\n"));
        return 2;
      }
      count = Number(answer);
    }
    if (!Number.isInteger(count) || count < 0 || count > listed.length) {
      console.log(chalk.yellow(`\n  Count must be 0..${listed.length} — nothing was sent.\n`));
      return 2;
    }
    if (count === 0) {
      console.log(chalk.gray("\n  Cancelled — nothing was sent.\n"));
      return 2;
    }
    // Re-read the chosen orders immediately before vending the batch payload.
    const chosen = await Promise.all(
      listed.slice(0, count).map(async (r) => {
        const fresh = await fetchBestListing(ctx.slug, r.tokenId, ctx.apiKey).catch((e: any) =>
          emptyListing(r.tokenId, e?.message ?? "fetch failed")
        );
        return { ...r, listing: fresh };
      })
    );
    const vanished = chosen.filter((r) => r.listing.error || !r.listing.orderHash);
    if (vanished.length) {
      console.log(chalk.yellow(`\n  ${vanished.map((r) => r.tokenId).join(", ")} no longer listed — nothing was sent.\n`));
      return 2;
    }
    const buyerKey = await loadBuyerWallet();
    if (!buyerKey) return 2;
    const chainId = resolveChain(o.chainKey)?.chainId ?? 1;
    const rpcUrl = await pickRpc(rpcs, chainId);
    if (!rpcUrl) {
      console.log(chalk.yellow("\n  No RPC answered eth_chainId — nothing was sent.\n"));
      return 2;
    }
    const out = await executeBatchListingBuy({
      listings: chosen.map((r) => r.listing),
      buyerKey, apiKey: ctx.apiKey, rpcUrl, chainId, yes: o.yes, ask: askYesNo,
    });
    if (out.sent) console.log(chalk.green(`  sent: ${out.txHash}`));
    else console.log(chalk.yellow(`  not sent: ${out.reason}`));
    return out.sent ? 0 : 2;
  }

  // Targeted form: `--reveal-scan <contract> --rarity --snipe --token-id N`
  // routes here too. One JSON + one listing GET, no full rarity crawl.
  if (o.tokenId) {
    const ctx = await resolveListingContext({ contract: normalizeIpfsLink(target) ? null : target, slug: o.slug });
    if (!ctx) {
      console.log(chalk.yellow("\n  No usable OpenSea key/slug — listing unknown, nothing was sent.\n"));
      return 2;
    }
    const scraped = await scrapeOne({
      contract: normalizeIpfsLink(target) ? null : target,
      cid: normalizeIpfsLink(target),
      tokenId: o.tokenId,
      chainKey: o.chainKey,
      rpcs: o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls,
      gateway: o.gateway,
      slug: ctx.slug,
      apiKey: ctx.apiKey,
    });
    printTargetedScrape(scraped);
    if (scraped.listing.error || scraped.listing.price == null) {
      console.log(chalk.yellow("\n  Token is not listed with a known price — nothing was sent.\n"));
      return 2;
    }
    await buyListedToken({
      tokenId: o.tokenId,
      slug: ctx.slug,
      apiKey: ctx.apiKey,
      chainKey: o.chainKey,
      rpcs: o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls,
      yes: o.yes,
    });
    return 0;
  }

  const cid = normalizeIpfsLink(target);
  let captured: RarityCapture | null = null;
  const code = await runRarity(
    {
      cid,
      gateway: o.gateway,
      limit: o.limit,
      concurrency: 8,
      top: o.top,
      pick: 0,
      listings: true,
      verifyIpfs: false,
      opensea: false,
      yes: false,
      slug: o.slug,
      contract: cid ? null : target,
      chainKey: o.chainKey,
      rpcs: o.rpcs.length > 0 ? o.rpcs : resolveRpcsForChain(o.chainKey, []).urls,
      blocks: o.blocks,
      deep: o.deep,
      ids: [],
    },
    (r) => { captured = r; }
  );
  if (code !== 0 || !captured) {
    console.log(chalk.yellow("\n  No usable rarity report — nothing was sent.\n"));
    return 2;
  }
  const cap: RarityCapture = captured;
  if (!cap.listings) {
    console.log(chalk.yellow("\n  No OpenSea listing data for this collection — nothing was sent.\n"));
    return 2;
  }
  const listed = new Set(cap.listedIds);
  const choices = cap.rows.filter((r) => listed.has(String(r.tokenId))).map((r) => String(r.tokenId));
  if (!choices.length) {
    console.log(chalk.yellow("\n  None of the reported tokens is listed on OpenSea — nothing was sent.\n"));
    return 2;
  }
  let tokenId = o.tokenId;
  if (!tokenId) {
    tokenId = (await askText(`Token id to snipe (${choices.slice(0, 8).join(", ")}…), blank to skip`, "")).trim();
  }
  if (!tokenId) {
    console.log(chalk.gray("\n  Skipped — nothing was sent.\n"));
    return 2;
  }
  if (!choices.includes(tokenId)) {
    console.log(chalk.yellow(`\n  token ${tokenId} was not among the listed rarity rows — nothing was sent.\n`));
    return 2;
  }
  await buyListedToken({
    tokenId,
    slug: cap.listings.slug,
    apiKey: cap.listings.apiKey,
    chainKey: cap.listings.chainKey,
    rpcs: cap.listings.rpcs,
    yes: o.yes,
  });
  return 0;
}
