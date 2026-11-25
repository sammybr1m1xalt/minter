// `--hot` — find contracts with recent mint activity, then optionally target one.
//
// Read-only scanner first, targeting second. The scanner builds its own ranking
// from ranged logs: there is no explorer endpoint that ranks contracts by mint
// activity. Rank by DISTINCT MINTERS, not raw event count — a batch minter or an
// airdrop claim can produce hundreds of events from one address.
//
// Honesty rules that shape this file:
//   - 6h/12h windows are REFUSED, not silently truncated.
//   - a refused log scan is UNKNOWN, never "no hot contracts".
//   - a price that could not be read is `unknown`, never `0` and never `free`.
//   - a hot contract is NOT a safety signal; the full pre-mint screen runs
//     again immediately before any send.
//   - no TTY and no --target means refuse, never block on a picker.
import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, id as keccakId, Interface } from "ethers";
import { CHAINS, explorerTx, resolveChain, type ChainProfile } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { askChoice, askYesNo } from "./prompt";
import { screenMintContract, detectPrice, buildGenericMintTx, isPlanBroadcastable } from "./mint-generic";
import { fetchPublicDrop } from "./seadrop-public";
import { promptWalletPassphrase, walletFilePath } from "./wizard";
import { loadKeysFromFile, readWalletFilePath } from "./wallet-file";

const ZERO_TOPIC = "0x" + "0".repeat(64);
const ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// The ERC-1155 topic0 values are computed from the canonical signatures rather
// than typed from memory: a typo in a literal would silently scan nothing.
const LOG_SHAPES = [
  { sig: ERC721_TRANSFER, label: "erc721", minterTopic: 2, idTopic: 3 },
  {
    sig: keccakId("TransferSingle(address,address,address,uint256,uint256)"),
    label: "erc1155-single",
    minterTopic: 3,
    idTopic: 4,
  },
  {
    sig: keccakId("TransferBatch(address,address,address,uint256[],uint256[])"),
    label: "erc1155-batch",
    minterTopic: 3,
    idTopic: null, // ids live in the non-indexed data; do not guess them
  },
] as const;

const WINDOW_SECONDS: Record<string, number> = {
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
};
const REFUSED_WINDOWS = new Set(["6h", "12h"]);

const CHUNK_BLOCKS = 2000;
const MAX_CHUNKS = 20;
const RPC_TIMEOUT_MS = 8000;
const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

export interface HotArgs {
  windows: string[];
  chains: string[];
  target: number | null;
  top: number;
  newHours: number | null;
  yes: boolean;
  rpc: string[];
}

/** Parse --hot flags. Throws on a malformed numeric value, never coerce to 0. */
export function parseHotArgs(argv: string[]): HotArgs {
  const out: HotArgs = {
    windows: ["15m"],
    chains: [],
    target: null,
    top: 10,
    newHours: null,
    yes: false,
    rpc: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (flag: string): string => {
      const raw = argv[++i];
      if (raw === undefined || raw === "" || raw.startsWith("-")) {
        throw new Error(`${flag} requires a value.`);
      }
      return raw;
    };
    if (a === "--window") out.windows = value(a).split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--chain" || a === "--chains") {
      out.chains = value(a).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (a === "--rpc") out.rpc.push(value(a));
    else if (a === "--top") {
      const n = Number(value(a));
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`--top must be 1..100 (got "${argv[i]}").`);
      out.top = n;
    } else if (a === "--target") {
      const n = Number(value(a));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--target must be a positive rank (got "${argv[i]}").`);
      out.target = n;
    } else if (a === "--new") {
      const h = Number(value(a));
      if (!Number.isFinite(h) || h <= 0) throw new Error(`--new must be a positive number of hours.`);
      out.newHours = h;
    } else if (a === "--yes" || a === "-y") out.yes = true;
    else throw new Error(`Unknown --hot option: ${a}`);
  }
  for (const w of out.windows) {
    if (REFUSED_WINDOWS.has(w)) {
      throw new Error(
        `--window ${w} is not served: a ${w} window needs thousands of 1000-result pages ` +
          `and would be silently truncated. Use 5m, 15m, 30m or 1h.`
      );
    }
    if (!(w in WINDOW_SECONDS)) {
      throw new Error(`Unknown --window "${w}". Use 5m, 15m, 30m or 1h.`);
    }
  }
  return out;
}

// ── JSON-RPC transport (bounded) ────────────────────────────────────────────

let rpcCounter = 0;

async function rpcCall<T = any>(
  url: string,
  method: string,
  params: any[] = [],
  timeoutMs = RPC_TIMEOUT_MS
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcCounter, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body: any = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result as T;
}

const hexNum = (hex: string | undefined): number | null => {
  if (typeof hex !== "string" || !/^0x[0-9a-f]+$/i.test(hex)) return null;
  const n = Number(BigInt(hex));
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * Turn a time window into a block range using the chain's OWN recent block rate.
 * No per-chain block-time constant: a hardcoded 12s is wrong on every L2 here.
 */
export async function deriveBlockRange(
  urls: string[],
  windowSec: number
): Promise<{ from: number; to: number; rate: number }> {
  let to: number | null = null;
  let lastErr: string = "no RPC answered";
  for (const url of urls) {
    try {
      to = hexNum(await rpcCall<string>(url, "eth_blockNumber")) ?? null;
      if (to !== null) break;
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }
  if (to === null) throw new Error(`could not read the latest block: ${lastErr}`);

  const sample = Math.min(100, to);
  let fromSample = to - sample;
  let tTo = 0;
  let tFrom = 0;
  for (const url of urls) {
    try {
      const head = await rpcCall<any>(url, "eth_getBlockByNumber", [`0x${to!.toString(16)}`, false]);
      const older = await rpcCall<any>(url, "eth_getBlockByNumber", [`0x${fromSample.toString(16)}`, false]);
      tTo = hexNum(head?.timestamp) ?? 0;
      tFrom = hexNum(older?.timestamp) ?? 0;
      if (tTo && tFrom) break;
    } catch {
      continue;
    }
  }
  const elapsed = tTo - tFrom;
  const rate = elapsed > 0 ? sample / elapsed : 0;
  let from = rate > 0 ? Math.max(0, to - Math.ceil(windowSec * rate)) : to;
  const target = tTo - windowSec;
  // Correct the estimate against the real timestamp at the derived block.
  for (let i = 0; i < 4 && from < to; i++) {
    let tf = 0;
    for (const url of urls) {
      try {
        const blk = await rpcCall<any>(url, "eth_getBlockByNumber", [`0x${from.toString(16)}`, false]);
        tf = hexNum(blk?.timestamp) ?? 0;
        if (tf) break;
      } catch {
        continue;
      }
    }
    if (!tf) break;
    if (tf <= target) break;
    const jump = Math.max(1, Math.ceil((tf - target) * (rate || sample / Math.max(1, elapsed || 1))));
    const next = Math.max(0, from - jump);
    if (next === from) break;
    from = next;
  }
  return { from, to, rate };
}

export interface RawMintLog {
  address: string;
  topics: string[];
  blockNumber: number;
  shape: string;
}

/** Group mint logs by contract. Distinct minters is the ranking signal. */
export function rankLogs(logs: RawMintLog[]): HotCandidate[] {
  const byAddress = new Map<string, HotCandidate>();
  for (const log of logs) {
    const address = log.address.toLowerCase();
    let c = byAddress.get(address);
    if (!c) {
      c = {
        address,
        mintEvents: 0,
        minters: new Set<string>(),
        tokenIds: new Set<string>(),
        firstBlock: log.blockNumber,
        shapes: new Set<string>(),
      };
      byAddress.set(address, c);
    }
    c.mintEvents++;
    c.firstBlock = Math.min(c.firstBlock, log.blockNumber);
    c.shapes.add(log.shape);
    const shape = LOG_SHAPES.find((s) => s.sig === log.topics[0] || s.label === log.shape);
    if (shape) {
      const minter = log.topics[shape.minterTopic];
      if (minter) c.minters.add(minter.toLowerCase());
      if (shape.idTopic !== null && log.topics[shape.idTopic]) {
        c.tokenIds.add(log.topics[shape.idTopic]);
      }
    }
  }
  return [...byAddress.values()].sort(
    (a, b) => b.minters.size - a.minters.size || b.mintEvents - a.mintEvents || a.firstBlock - b.firstBlock
  );
}

export interface HotCandidate {
  address: string;
  mintEvents: number;
  minters: Set<string>;
  tokenIds: Set<string>;
  firstBlock: number;
  shapes: Set<string>;
}

export interface ScanResult {
  ok: boolean;
  candidates: HotCandidate[];
  detail: string;
  chunks: number;
}

/** Scan one chain's RPCs. A scan that cannot reach logs is UNKNOWN, not empty. */
export async function scanChainRpc(
  urls: string[],
  windowSec: number,
  chainKey: string
): Promise<ScanResult> {
  const { from, to, rate } = await deriveBlockRange(urls, windowSec);
  const chunks = Math.ceil((to - from + 1) / CHUNK_BLOCKS);
  if (chunks > MAX_CHUNKS) {
    return {
      ok: false,
      candidates: [],
      detail:
        `window needs ${chunks} log pages (cap ${MAX_CHUNKS}) at ${rate.toFixed(2)} blocks/s ` +
        `on ${chainKey} — refused rather than truncated; use a shorter window`,
      chunks,
    };
  }
  const raw: RawMintLog[] = [];
  const errors: string[] = [];
  for (let start = from; start <= to; start += CHUNK_BLOCKS) {
    const end = Math.min(to, start + CHUNK_BLOCKS - 1);
    const shape = LOG_SHAPES.find((s) => s.sig === ERC721_TRANSFER)!;
    let got: any[] | null = null;
    let lastErr = "";
    for (const url of urls) {
      try {
        const all = await rpcCall<any[]>(url, "eth_getLogs", [
          {
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
            topics: [shape.sig, null, ZERO_TOPIC],
          },
        ]);
        got = all;
        break;
      } catch (e: any) {
        lastErr = e?.message ?? String(e);
      }
    }
    if (!got) {
      errors.push(`blocks ${start}-${end}: ${lastErr || "no RPC answered"}`);
      continue;
    }
    for (const l of got) {
      const bn = hexNum(l.blockNumber);
      raw.push({
        address: l.address ?? "",
        topics: Array.isArray(l.topics) ? l.topics : [],
        blockNumber: bn ?? 0,
        shape: shape.label,
      });
    }
  }
  // ERC-1155 uses a different indexed position for `from`; scan those too.
  for (const shape of LOG_SHAPES.slice(1)) {
    for (let start = from; start <= to; start += CHUNK_BLOCKS) {
      const end = Math.min(to, start + CHUNK_BLOCKS - 1);
      for (const url of urls) {
        try {
          const all = await rpcCall<any[]>(url, "eth_getLogs", [
            {
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
              topics: [shape.sig, null, ZERO_TOPIC],
            },
          ]);
          for (const l of all) {
            const bn = hexNum(l.blockNumber);
            raw.push({
              address: l.address ?? "",
              topics: Array.isArray(l.topics) ? l.topics : [],
              blockNumber: bn ?? 0,
              shape: shape.label,
            });
          }
          break;
        } catch {
          continue;
        }
      }
    }
  }
  if (errors.length && !raw.length) {
    return { ok: false, candidates: [], detail: `log scan refused: ${errors[0]}`, chunks };
  }
  return {
    ok: true,
    candidates: rankLogs(raw),
    detail: errors.length ? `${errors.length} of ${chunks} pages refused` : "ok",
    chunks,
  };
}

// ── Etherscan V2 fallback (Ethereum only on the free tier) ───────────────────

function etherscanKey(): string | null {
  const key = process.env.ETHERSCAN_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

async function etherscan(params: Record<string, string>): Promise<any> {
  const key = etherscanKey();
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  const q = new URLSearchParams({ ...params, apikey: key });
  let last: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    const res = await fetch(`${ETHERSCAN_BASE}?${q.toString()}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      last = `HTTP ${res.status}`;
      continue;
    }
    last = await res.json();
    if (last?.status === "1") return last.result;
    // Transient throttling and empty error results are both common here; a
    // bounded retry is the only way to tell a bad minute from a real refusal.
    continue;
  }
  // An error result can be an object or an empty string; String() keeps the
  // reason in the message instead of throwing an Error with no text.
  throw new Error(
    `Etherscan refused ${params.module}/${params.action}: ${String(last?.result ?? last?.message ?? last ?? "unknown")}`
  );
}

export async function scanEtherscan(chainId: number, windowSec: number): Promise<ScanResult> {
  const now = Math.floor(Date.now() / 1000);
  const toStr = await etherscan({
    chainid: String(chainId),
    module: "block",
    action: "getblocknobytime",
    timestamp: String(now),
    closest: "before",
  });
  const fromStr = await etherscan({
    chainid: String(chainId),
    module: "block",
    action: "getblocknobytime",
    timestamp: String(now - windowSec),
    closest: "before",
  });
  const to = Number(toStr);
  const from = Number(fromStr);
  if (!Number.isFinite(to) || !Number.isFinite(from)) throw new Error("bad block range from Etherscan");
  const raw: RawMintLog[] = [];
  for (const shape of LOG_SHAPES) {
    const indexedFrom = shape.label === "erc721" ? "topic1" : "topic2";
    const got: any[] = await etherscan({
      chainid: String(chainId),
      module: "logs",
      action: "getLogs",
      fromBlock: String(from),
      toBlock: String(to),
      topic0: shape.sig,
      [indexedFrom]: ZERO_TOPIC,
    });
    for (const l of got) {
      raw.push({
        address: l.address ?? "",
        topics: Array.isArray(l.topics) ? l.topics : [],
        blockNumber: Number(l.blockNumber) || 0,
        shape: shape.label,
      });
    }
  }
  return { ok: true, candidates: rankLogs(raw), detail: "etherscan", chunks: 1 };
}

// ── Deploy-time filter (--new) ───────────────────────────────────────────────

/**
 * Deployment timestamps from Etherscan's contract-creation index. The index
 * gives the creator + tx hash, not a time, so the time is read from the block
 * that mined the creation tx. An unanswered lookup is UNKNOWN, not "old".
 */
export async function creationTimes(addresses: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!unique.length) return out;
  const created: any[] = await etherscan({
    chainid: "1",
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: unique.join(","),
  });
  for (const entry of Array.isArray(created) ? created : [created]) {
    const addr = String(entry?.contractAddress ?? "").toLowerCase();
    if (!addr) continue;
    try {
      const tx: any = await etherscan({
        chainid: "1",
        module: "proxy",
        action: "eth_getTransactionByHash",
        txhash: entry.txHash,
      });
      const blockTag = tx?.blockNumber;
      if (!blockTag) {
        out.set(addr, null);
        continue;
      }
      const blk: any = await etherscan({
        chainid: "1",
        module: "proxy",
        action: "eth_getBlockByNumber",
        tag: blockTag,
        boolean: "false",
      });
      const ts = hexNum(blk?.timestamp);
      out.set(addr, ts ?? null);
    } catch {
      out.set(addr, null);
    }
  }
  return out;
}

// ── Enrichment and display ──────────────────────────────────────────────────

export interface Enriched {
  address: string;
  name: string;
  type: string;
  minters: number;
  mints: number;
  cost: string;
  flags: string[];
  /** Definite non-NFT (an ERC-20 mint) — never offer it as a mint target. */
  exclude: boolean;
  candidate: HotCandidate;
}

/** Walk the RPC list until one actually serves this chain — never pin [0]. */
export async function pickReadableRpc(urls: string[], chainId: number): Promise<string | null> {
  for (const url of urls) {
    try {
      if (hexNum(await rpcCall<string>(url, "eth_chainId")) === chainId) return url;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Most ERC-20s do NOT implement ERC-165, so screenMintContract's interface
 * probe reports them as "unknown". Decimals + balanceOf is the generic read
 * that separates a token mint from an NFT mint in raw Transfer logs.
 */
async function looksErc20(provider: JsonRpcProvider, address: string): Promise<boolean> {
  const iface = new Interface([
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  try {
    const d = await provider.call({ to: address, data: iface.encodeFunctionData("decimals") });
    iface.decodeFunctionResult("decimals", d);
    const b = await provider.call({
      to: address,
      data: iface.encodeFunctionData("balanceOf", [address]),
    });
    iface.decodeFunctionResult("balanceOf", b);
    return true;
  } catch {
    return false;
  }
}

async function encodeName(provider: JsonRpcProvider, address: string): Promise<string | null> {
  try {
    const iface = new Interface(["function name() view returns (string)"]);
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData("name") });
    const v = iface.decodeFunctionResult("name", raw)[0];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null;
  } catch {
    return null;
  }
}

export function formatCost(wei: bigint | null, symbol: string, authoritative: boolean, reader?: string): string {
  if (wei === null) return "unknown";
  if (!authoritative && reader) {
    return `${formatEther(wei)} ${symbol} (guess: ${reader})`;
  }
  if (wei === 0n) return "free";
  return `${formatEther(wei)} ${symbol}`;
}

export async function enrich(
  candidate: HotCandidate,
  chain: ChainProfile,
  rpcUrls: string[]
): Promise<Enriched> {
  const rpc = await pickReadableRpc(rpcUrls, chain.chainId);
  if (!rpc) {
    return {
      address: candidate.address,
      name: "unknown",
      type: "unknown",
      minters: candidate.minters.size,
      mints: candidate.mintEvents,
      cost: "unknown",
      flags: ["enrich-unknown:no RPC served this chain"],
      exclude: false,
      candidate,
    };
  }
  const provider = new JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });
  let name = "unknown";
  let type = "unknown";
  let cost = "unknown";
  let flags: string[] = [];
  let exclude = false;
  try {
    name = (await encodeName(provider, candidate.address)) ?? "unknown";
    const screen = await screenMintContract(candidate.address, provider, { timeoutMs: 8000 });
    type = screen.erc721 ? (screen.erc1155 ? "721/1155" : "erc721")
      : screen.erc1155 ? "erc1155"
      : screen.erc20 ? "erc20-like"
      : screen.erc165Supported ? "unknown-nft"
      : "unknown";
    flags = screen.findings.filter((f) => f.level !== "info").map((f) => `${f.level}:${f.code}`).slice(0, 3);
    if (screen.verdict !== "pass" && screen.verdict !== "warn") flags.unshift(`screen:${screen.verdict}`);
    // An ERC-20 mint is a token mint, not an NFT drop. Exclude it from the
    // targeting list rather than offering the user a contract that cannot mint
    // an NFT — this is the "shared address" failure mode (a stablecoin's
    // Transfer-from-zero events look exactly like an NFT mint in raw logs).
    const tokenLike = !screen.erc721 && !screen.erc1155 && (screen.erc20 || (await looksErc20(provider, candidate.address)));
    exclude = tokenLike;
    if (tokenLike && type === "unknown") {
      type = "erc20-like";
      flags.push("info:erc20-mint-excluded");
    }

    // SeaDrop is the ONLY authoritative cost source. A name-matched getter is
    // a guess and is labelled as such; a missed probe is unknown, never free.
    let price: bigint | null = null;
    let authoritative = false;
    let reader: string | undefined;
    try {
      const drop = await fetchPublicDrop(rpc, candidate.address, 6000);
      if (drop) {
        price = drop.mintPrice;
        authoritative = true;
      }
    } catch {
      // no SeaDrop public drop — fall through to the labelled getter
    }
    if (price === null) {
      const guessed = await detectPrice(candidate.address, provider, 1n);
      if (guessed) {
        price = guessed.price;
        reader = guessed.reader;
      }
    }
    cost = formatCost(price, chain.nativeSymbol, authoritative, reader);
  } catch (e: any) {
    flags.push(`enrich-unknown:${e?.message ?? "error"}`);
  } finally {
    provider.destroy();
  }
  return {
    address: candidate.address,
    name,
    type,
    minters: candidate.minters.size,
    mints: candidate.mintEvents,
    cost,
    flags,
    exclude,
    candidate,
  };
}

function printTable(chainKey: string, window: string, rows: Enriched[]): void {
  console.log(chalk.bold.white(`\n${chainKey} — ${window} — top ${rows.length} by distinct minters`));
  console.log(chalk.gray("  #  contract                                        name                  type       mints  minters  cost"));
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)} ${r.address.padEnd(44)} ${r.name.padEnd(20)} ` +
        `${r.type.padEnd(10)} ${String(r.mints).padStart(5)} ${String(r.minters).padStart(8)}  ${r.cost}`
    );
    if (r.flags.length) console.log(chalk.yellow(`     flags: ${r.flags.join(", ")}`));
  });
}

// ── Targeting ───────────────────────────────────────────────────────────────

async function loadFirstWalletKey(): Promise<{ key: string; address: string } | null> {
  await promptWalletPassphrase();
  const file = walletFilePath();
  const text = readWalletFilePath(file);
  if (text === null) {
    console.error(chalk.red(`\n❌ No wallet file at ${file}. Create one with: minter wallet status\n`));
    return null;
  }
  const loaded = loadKeysFromFile(file, text, process.env.WALLETS_PASSPHRASE ?? null);
  if (loaded.status !== "plain" && loaded.status !== "encrypted") {
    console.error(chalk.red(`\n❌ Could not load ${file}: ${loaded.detail ?? loaded.status}\n`));
    return null;
  }
  if (!loaded.keys.length) {
    console.error(chalk.red(`\n❌ ${file} holds no keys.\n`));
    return null;
  }
  const key = loaded.keys[0]; // one wallet at a time, in file order
  const w = new Wallet(key);
  return { key, address: w.address };
}

async function targetOne(
  row: Enriched,
  chain: ChainProfile,
  rpcUrls: string[],
  args: HotArgs
): Promise<number> {
  const wallet = await loadFirstWalletKey();
  if (!wallet) return 2;
  const rpc = await pickReadableRpc(rpcUrls, chain.chainId);
  if (!rpc) {
    console.error(chalk.red(`\n❌ No RPC served ${chain.name} — cannot screen or send. Nothing was sent.\n`));
    return 2;
  }
  const provider = new JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });

  // The full screen runs AGAIN on the chosen target. Scanner output is not a
  // safety signal; a hot contract is exactly where rugs live.
  const plan = await buildGenericMintTx(row.address, provider, wallet.address, 1n);
  provider.destroy();
  if (!plan) {
    console.error(chalk.red(`\n❌ No buildable mint found on ${row.address}. Nothing was sent.\n`));
    return 2;
  }
  if (!isPlanBroadcastable(plan)) {
    console.error(chalk.red(`\n❌ Pre-mint screen blocked ${row.address}: nothing was sent.`));
    if (plan.screenRefused) {
      for (const f of plan.screen.findings) {
        console.error(chalk.yellow(`   ${f.level}: ${f.code} — ${f.detail}`));
      }
    }
    if (plan.simulationReverted) {
      console.error(chalk.yellow(`   simulation reverted: ${plan.simulationError ?? "unknown"}`));
    }
    console.error("");
    return 2;
  }

  console.log(chalk.bold.white("\nReady to send"));
  console.log(`  recipient : ${plan.to}`);
  console.log(`  from      : ${wallet.address}`);
  console.log(`  chain     : ${chain.name} (${chain.chainId})`);
  console.log(`  value     : ${formatEther(plan.value)} ${chain.nativeSymbol}`);
  console.log(`  selector  : ${plan.selector}`);
  console.log(`  calldata  : ${plan.data.slice(0, 66)}${plan.data.length > 66 ? "…" : ""}`);
  console.log(`  gasLimit  : ${plan.gas.gasLimit.toString()}`);
  console.log(chalk.yellow("  Source: locally built calldata from the contract's own ABI/price reads."));

  const ok = args.yes || (process.stdin.isTTY && (await askYesNo("Broadcast this transaction?", false)));
  if (!ok) {
    console.log(chalk.gray("\nCancelled — nothing was sent."));
    return 0;
  }

  const sendProvider = new JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });
  try {
    const signer = new Wallet(wallet.key, sendProvider);
    const tx = await signer.sendTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      gasLimit: plan.gas.gasLimit,
      ...(plan.gas.maxFeePerGas !== undefined ? { maxFeePerGas: plan.gas.maxFeePerGas } : {}),
      ...(plan.gas.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: plan.gas.maxPriorityFeePerGas }
        : {}),
      ...(plan.gas.gasPrice !== undefined ? { gasPrice: plan.gas.gasPrice } : {}),
    });
    console.log(chalk.green(`\n✓ sent ${tx.hash}`));
    console.log(`  ${explorerTx(chain.chainId, tx.hash)}`);
    const receipt = await tx.wait();
    console.log(`  receipt status: ${receipt?.status === 1 ? "success" : "unknown"}`);
    return receipt?.status === 1 ? 0 : 2;
  } catch (e: any) {
    console.error(chalk.red(`\n❌ send failed: ${e?.shortMessage ?? e?.message ?? e}\n`));
    return 2;
  } finally {
    sendProvider.destroy();
  }
}

export async function runHotCli(args: string[]): Promise<number> {
  const opts = parseHotArgs(args);
  const chainKeys = opts.chains.length
    ? opts.chains
    : [process.env.CHAIN?.trim().toLowerCase() || "ethereum"];
  const resolved: ChainProfile[] = [];
  for (const key of chainKeys) {
    if (key === "all") {
      resolved.push(...CHAINS);
      continue;
    }
    const c = resolveChain(key);
    if (!c) {
      console.error(chalk.red(`❌ Unknown chain "${key}". Known: ${CHAINS.map((x) => x.key).join(", ")}`));
      return 2;
    }
    resolved.push(c);
  }

  if (opts.newHours !== null && resolved.some((c) => c.chainId !== 1)) {
    console.error(
      chalk.red("\n❌ --new is served by Etherscan's contractcreation index, which this key only serves on Ethereum. Refuse rather than report a wrong deployment age.")
    );
    return 2;
  }
  if (opts.newHours !== null && !etherscanKey()) {
    console.error(chalk.red("\n❌ --new needs ETHERSCAN_API_KEY, which is not set."));
    return 2;
  }

  const allRows: Array<{ chain: ChainProfile; rows: Enriched[]; rpc: string[] }> = [];
  for (const window of opts.windows) {
    for (const chain of resolved) {
      const rpcs = resolveRpcsForChain(chain.key, opts.rpc);
      const urls = rpcs.urls;
      if (!urls.length) {
        console.log(chalk.yellow(`\n${chain.key} / ${window}: UNKNOWN — no RPC configured.`));
        continue;
      }
      let result: ScanResult | null = null;
      try {
        result = await scanChainRpc(urls, WINDOW_SECONDS[window], chain.key);
        if (!result.ok && chain.chainId === 1 && etherscanKey()) {
          try {
            const fallback = await scanEtherscan(chain.chainId, WINDOW_SECONDS[window]);
            if (fallback.ok) result = fallback;
          } catch (e: any) {
            console.log(chalk.gray(`  Etherscan fallback also failed: ${e?.message ?? e}`));
          }
        }
      } catch (e: any) {
        console.log(chalk.yellow(`\n${chain.key} / ${window}: UNKNOWN — ${e?.message ?? e}`));
        continue;
      }
      if (!result.ok) {
        console.log(chalk.yellow(`\n${chain.key} / ${window}: UNKNOWN — ${result.detail}`));
        continue;
      }
      if (!result.candidates.length) {
        console.log(chalk.yellow(`\n${chain.key} / ${window}: no mint activity found (scan ok, ${result.chunks} pages).`));
        continue;
      }
      if (result.detail !== "ok" && result.detail !== "etherscan") {
        console.log(chalk.yellow(`\n${chain.key} / ${window}: partial scan — ${result.detail}`));
      }
      let rows = await Promise.all(
        result.candidates.slice(0, opts.top).map((c) => enrich(c, chain, urls))
      );
      const excluded = rows.filter((r) => r.exclude);
      if (excluded.length) {
        console.log(chalk.gray(`  excluded ${excluded.length} definite ERC-20 mint(s) from the NFT target list`));
        rows = rows.filter((r) => !r.exclude);
      }
      if (!rows.length) continue;
      if (opts.newHours !== null) {
        let times: Map<string, number | null>;
        try {
          times = await creationTimes(rows.map((r) => r.address));
        } catch (e: any) {
          console.log(chalk.yellow(`\n${chain.key}: UNKNOWN deploy times — ${e?.message ?? e}`));
          continue;
        }
        const cutoff = Math.floor(Date.now() / 1000) - opts.newHours * 3600;
        const before = rows.length;
        rows = rows.filter((r) => {
          const t = times.get(r.address);
          return t !== undefined && t !== null && t >= cutoff;
        });
        console.log(
          chalk.gray(`  --new ${opts.newHours}h: kept ${rows.length} of ${before} (deploy time unknown is excluded, not guessed)`)
        );
        if (!rows.length) continue;
      }
      printTable(`${chain.key}${resolved.length > 1 ? ` (${chain.chainId})` : ""}`, window, rows);
      allRows.push({ chain, rows, rpc: urls });
    }
  }

  if (!allRows.length) {
    console.log(chalk.yellow("\nNo chain produced a usable ranking. Nothing was targeted."));
    return 2;
  }
  if (!opts.target && !process.stdin.isTTY) {
    console.error(
      chalk.red("\n❌ No TTY: pass --target <rank> to target a contract headlessly. Nothing was sent.")
    );
    return 2;
  }
  const flat = allRows.flatMap((g) => g.rows.map((r) => ({ row: r, chain: g.chain, rpc: g.rpc })));
  if (opts.target && (opts.target < 1 || opts.target > flat.length)) {
    console.error(chalk.red(`\n❌ --target ${opts.target} is outside 1..${flat.length}. Nothing was sent.`));
    return 2;
  }

  let chosen = opts.target ? flat[opts.target - 1] : null;
  if (!chosen) {
    const picked = await askChoice<number>(
      "Target a contract? (the list is NOT a safety signal — the full screen runs before sending)",
      [
        ...flat.map((x, i) => ({
          label: `${i + 1}) ${x.row.address} ${x.row.name} — ${x.row.minters} minters, ${x.row.cost}`,
          value: i + 1,
        })),
        { label: "none — do not send", value: 0 },
      ],
      0
    );
    if (!picked) {
      console.log(chalk.gray("\nNo target selected. Nothing was sent."));
      return 0;
    }
    chosen = flat[picked - 1];
  }
  return targetOne(chosen.row, chosen.chain, chosen.rpc, opts);
}
