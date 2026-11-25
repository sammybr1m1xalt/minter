// `--drop-uri` — read SeaDrop's DropURIUpdated event history from Etherscan logs.
//
// The setter `updateDropURI(string)` only EMITS; it stores nothing and exposes
// no getter. The metadata pointer therefore exists on-chain ONLY as a log.
// Public RPCs refused the large-range eth_getLogs this needs; Etherscan's
// ranged getLogs serves it, so this tool uses that key directly.
//
// An unanswered scan is UNKNOWN (exit 2), never "no such event".
import chalk from "chalk";
import { AbiCoder, getAddress, id as keccakId } from "ethers";

const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

// Computed from the REAL event declaration in SeaDropErrorsAndEvents.sol:
//   event DropURIUpdated(address indexed nftContract, string newDropURI);
// A typed-from-memory literal could be wrong with no compile-time signal.
export const DROP_URI_TOPIC0 = keccakId("DropURIUpdated(address,string)");

export interface DropUriArgs {
  fromBlock: number | null;
  toBlock: number | null;
  blocks: number;
  top: number;
}

export function parseDropUriArgs(argv: string[]): DropUriArgs {
  const out: DropUriArgs = { fromBlock: null, toBlock: null, blocks: 50_000, top: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const raw = argv[++i];
    const num = (flag: string): number => {
      if (raw === undefined || raw === "" || raw.startsWith("-")) throw new Error(`${flag} requires a value.`);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer.`);
      return n;
    };
    if (a === "--from-block") out.fromBlock = num(a);
    else if (a === "--to-block") out.toBlock = num(a);
    else if (a === "--blocks") out.blocks = num(a);
    else if (a === "--top") out.top = num(a);
    else throw new Error(`Unknown --drop-uri option: ${a}`);
  }
  if (out.fromBlock !== null && out.toBlock !== null && out.fromBlock > out.toBlock) {
    throw new Error("--from-block must not be greater than --to-block.");
  }
  return out;
}

async function etherscan(params: Record<string, string>): Promise<any> {
  const key = process.env.ETHERSCAN_API_KEY?.trim();
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  const q = new URLSearchParams({ ...params, apikey: key });
  let last: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    const res = await fetch(`${ETHERSCAN_BASE}?${q.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      last = `HTTP ${res.status}`;
      continue;
    }
    last = await res.json();
    if (last?.status === "1") return last.result;
  }
  throw new Error(String(last?.result ?? last?.message ?? "unknown refusal"));
}

export interface DropUriEvent {
  nftContract: string;
  uri: string;
  block: number;
  txHash: string;
}

/** Decode the real log shape: indexed nftContract + ABI-encoded string in data. */
export function decodeDropUriLog(log: any): DropUriEvent | null {
  try {
    const topic1 = log?.topics?.[1];
    if (typeof topic1 !== "string" || topic1.length < 42) return null;
    const uri = AbiCoder.defaultAbiCoder().decode(["string"], log.data)[0];
    return {
      nftContract: getAddress("0x" + topic1.slice(-40)),
      uri: String(uri),
      block: Number(log.blockNumber) || 0,
      txHash: String(log.transactionHash ?? ""),
    };
  } catch {
    return null;
  }
}

export interface DropUriPage {
  events: DropUriEvent[];
  /** Etherscan caps getLogs at 1000 results — exactly 1000 means truncated. */
  truncated: boolean;
}

export async function readDropUriEvents(args: DropUriArgs): Promise<DropUriPage> {
  const to = args.toBlock ?? Number(await etherscan({
    chainid: "1",
    module: "block",
    action: "getblocknobytime",
    timestamp: String(Math.floor(Date.now() / 1000)),
    closest: "before",
  }));
  const from = args.fromBlock ?? Math.max(0, to - args.blocks);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("bad block range");
  const logs: any[] = await etherscan({
    chainid: "1",
    module: "logs",
    action: "getLogs",
    fromBlock: String(from),
    toBlock: String(to),
    topic0: DROP_URI_TOPIC0,
  });
  const events = logs.map(decodeDropUriLog).filter((e: DropUriEvent | null): e is DropUriEvent => e !== null);
  return { events, truncated: logs.length >= 1000 };
}

export async function runDropUriCli(argv: string[]): Promise<number> {
  let args: DropUriArgs;
  try {
    args = parseDropUriArgs(argv);
  } catch (e: any) {
    console.error(chalk.red(`\n❌ ${e?.message ?? e}\n`));
    return 2;
  }
  try {
    const page = await readDropUriEvents(args);
    const events = page.events;
    if (!events.length) {
      console.log(chalk.yellow("\nNo DropURIUpdated events in that range (scan succeeded)."));
      return 0;
    }
    if (page.truncated) {
      console.log(chalk.yellow(`  ⚠ truncated at Etherscan's 1000-result cap — use a shorter --from-block/--to-block range.`));
    }
    console.log(chalk.bold.white(`\nDropURIUpdated — ${events.length} event(s) read`));
    console.log(chalk.gray("  contract                                    block      uri"));
    for (const e of events.slice(0, args.top)) {
      console.log(`  ${e.nftContract.padEnd(42)} ${String(e.block).padEnd(10)} ${e.uri}`);
    }
    console.log(chalk.gray("\n  The pointer is all the chain stores — resolve the URI to read the metadata."));
    return 0;
  } catch (e: any) {
    console.log(chalk.yellow(`\nUNKNOWN — could not read DropURIUpdated logs: ${e?.message ?? e}`));
    console.log(chalk.gray("  An unanswered log scan is not evidence that no event exists."));
    return 2;
  }
}
