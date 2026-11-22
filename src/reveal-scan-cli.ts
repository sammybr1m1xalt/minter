// `--reveal-scan <contract>` — is this drop's id -> artwork mapping actually
// private, or is it already readable?
//
// Read-only and public-data-only. It reads the contract and resolves whatever
// CIDs the contract already publishes. See reveal-scan.ts for the reasoning and
// for what it deliberately does not do.
import chalk from "chalk";
import { scanReveal } from "./reveal-scan";
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
} {
  let contract: string | null = null;
  let chainKey = "ethereum";
  let rpcs: string[] = [];
  let blocks = 0;
  let ids: number[] = [];
  let gateway: string | null = null;
  let opensea = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chain") chainKey = args[++i] ?? chainKey;
    else if (a === "--rpc") rpcs.push(args[++i] ?? "");
    else if (a === "--blocks") blocks = Number(args[++i] ?? 0) || 0;
    else if (a === "--ids") {
      const raw = args[++i] ?? "";
      ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    } else if (a === "--gateway") gateway = args[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --reveal-scan <contract> [options]

  --chain <key>      chain key or id (default ethereum)
  --rpc <url>        add an RPC endpoint (repeatable)
  --blocks <n>       sweep the last n blocks for metadata-like logs (default off)
  --ids 1,2,3        token ids to sample (default 1..5)
  --gateway <url>    pin a single IPFS gateway
  --opensea          also ask OpenSea's public token endpoint and compare

Reads only public data: the contract's baseURI / contractURI / tokenURI and
whatever IPFS or Arweave CIDs those already point at.`);
      process.exit(0);
    } else if (!a.startsWith("--")) {
      if (!contract) contract = a;
    }
  }
  return { contract, chainKey, rpcs: rpcs.filter(Boolean), blocks, ids, gateway, opensea };
}

// ── OpenSea comparison (opt-in) ─────────────────────────────────────────────
// The window this looks for: the metadata has gone public, but OpenSea's index
// has not caught up with the contract yet — or has run ahead of it.
//
// Deliberately a REPORT, not a verdict. The response shape is not guessed: the
// mode prints what OpenSea actually returned, and only compares when both sides
// yielded a readable name. A key that is missing or dead is reported as such
// rather than being turned into a conclusion.
interface OpenseaProbe {
  tokenId: number;
  status: number | null;
  error: string | null;
  name: string | null;
  image: string | null;
  rawKeys: string[];
}

async function probeOpenseaToken(
  chain: string,
  contract: string,
  tokenId: number,
  apiKey: string,
  timeoutMs = 15_000
): Promise<OpenseaProbe> {
  const out: OpenseaProbe = { tokenId, status: null, error: null, name: null, image: null, rawKeys: [] };
  const url = `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chain)}/token/${contract}/${tokenId}`;
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    out.status = r.status;
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
      out.name = typeof body.name === "string" ? body.name : null;
      out.image =
        typeof body.image_url === "string"
          ? body.image_url
          : typeof body.image === "string"
            ? body.image
            : null;
      if (!out.name && body.error) out.error = String(body.error);
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

export async function runRevealScanCli(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
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
  console.log();

  // Exit codes are a scanner's contract: 0 = nothing leaked, 1 = leaked,
  // 2 = could not tell. "Could not tell" must not read as "clean" — an
  // unreachable RPC is not evidence that a drop is hidden.
  if (r.verdict === "PUBLIC") return 1;
  if (r.verdict === "UNKNOWN") return 2;
  return 0;
}
