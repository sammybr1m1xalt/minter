// `--snipe` — standalone buy path. Everything that can spend money lives here.
// `--reveal-scan` only reports; it never loads a wallet, estimates gas or sends.
import chalk from "chalk";
import { fetchBestListing, executeListingBuy, type ListingSummary } from "./buy-listings";
import { runRarity, type RarityCapture } from "./reveal-scan-cli";
import { loadEnvKeys, promptWalletPassphrase } from "./wizard";
import { askText, askYesNo, closePrompts } from "./prompt";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { normalizeIpfsLink } from "./reveal-scan-cli";

interface SnipeArgs {
  target: string | null;
  tokenId: string | null;
  slug: string | null;
  chainKey: string;
  rpcs: string[];
  gateway: string | null;
  limit: number | null;
  top: number;
  yes: boolean;
  blocks: number;
  deep: boolean;
}

function parseArgs(args: string[]): SnipeArgs {
  const out: SnipeArgs = {
    target: null, tokenId: null, slug: null, chainKey: "ethereum", rpcs: [],
    gateway: null, limit: 20, top: 20, yes: false, blocks: 2000, deep: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--token-id" || a === "--buy") out.tokenId = args[++i] ?? null;
    else if (a.startsWith("--token-id=")) out.tokenId = a.slice(11);
    else if (a === "--slug") out.slug = args[++i] ?? null;
    else if (a === "--chain") out.chainKey = args[++i] ?? "ethereum";
    else if (a === "--rpc") out.rpcs.push(args[++i] ?? "");
    else if (a === "--gateway") out.gateway = args[++i] ?? null;
    else if (a === "--limit") out.limit = Number(args[++i] ?? 20) || 20;
    else if (a === "--top") out.top = Number(args[++i] ?? 20) || 20;
    else if (a === "--blocks") out.blocks = Number(args[++i] ?? 2000) || 2000;
    else if (a === "--no-deep") out.deep = false;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --snipe [target] [options]

  --token-id <id>    buy one reported id without asking (headless-safe)
  --slug <slug>      override the OpenSea collection slug
  --chain <key>      chain key (default ethereum)
  --rpc <url>        RPC endpoint (repeatable)
  --gateway <url>    pin an IPFS gateway
  --limit <n>        rarity sample size (default 20)
  --top <n>          rows to print (default 20)
  --yes, -y          send without a confirmation prompt
  --no-deep          skip deep reveal discovery
`);
    } else if (!a.startsWith("--")) out.target = a;
  }
  return out;
}

function emptyListing(tokenId: string, error: string): ListingSummary {
  return {
    tokenId, orderHash: null, protocolAddress: null, chain: null, maker: null,
    currency: null, value: null, decimals: null, price: null, error,
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

/** Buy one listed id with the wizard's wallet loader, not a copy of it. */
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
    buyerKey: wallets[0].privateKey,
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
  if (!target) {
    console.log(chalk.yellow("\n  No target — nothing was scanned or sent.\n"));
    return 2;
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
