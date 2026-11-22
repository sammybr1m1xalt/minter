// `--reveal-scan <contract>` — is this drop's id -> artwork mapping actually
// private, or is it already readable?
//
// Read-only and public-data-only. It reads the contract and resolves whatever
// CIDs the contract already publishes. See reveal-scan.ts for the reasoning and
// for what it deliberately does not do.
import chalk from "chalk";
import { getValidApiKey } from "./opensea-key";
import { inspectPublicCid, scanReveal } from "./reveal-scan";
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
} {
  let contract: string | null = null;
  let chainKey = "ethereum";
  let rpcs: string[] = [];
  let blocks = 0;
  let ids: number[] = [];
  let gateway: string | null = null;
  let opensea = false;
  let ipfsLink: string | null = null;
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
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: minter --reveal-scan <contract> [options]

  --chain <key>      chain key or id (default ethereum)
  --rpc <url>        add an RPC endpoint (repeatable)
  --blocks <n>       sweep the last n blocks for metadata-like logs (default off)
  --ids 1,2,3        token ids to sample (default 1..5)
  --gateway <url>    pin a single IPFS gateway
  --opensea          also ask OpenSea's public token endpoint and compare
  --ipfs <link>      view an ipfs:// link, a CID, or a gateway URL (no contract)

Reads only public data: the contract's baseURI / contractURI / tokenURI and
whatever IPFS or Arweave CIDs those already point at.`);
      process.exit(0);
    } else if (!a.startsWith("--")) {
      if (!contract) contract = a;
    }
  }
  return { contract, chainKey, rpcs: rpcs.filter(Boolean), blocks, ids, gateway, opensea, ipfsLink };
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
    console.log(chalk.yellow("  so this is \"could not fetch\", not \"does not exist\"."));
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
