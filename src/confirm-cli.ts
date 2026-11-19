// ── --confirm: on-chain receipt audit for transactions already sent ────────
//
// The live fire path polls a receipt per wallet and gives up after 60s (plus a
// 10s "mined but no receipt" grace). A mint that lands after that is reported
// UNKNOWN, and the sell step skips any wallet that is not SUCCESS — so minted
// tokens can sit unsold. Nothing ever re-asks.
//
// This command re-asks the chain, by transaction hash ALONE: no accepting
// endpoint and no run state are needed, so it works for a hash copied out of a
// log line or from a run that finished hours ago. It prints the five-way verdict
// (SUCCESS / REVERTED / PENDING / NOT_FOUND / TIMEOUT) and, for a TIMEOUT,
// whether the budget expired or no endpoint answered.

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { sweepOnChain, summarizeOnChain } from "./rpc-health";
import { resolveRpcsForChain } from "./rpc-resolver";
import { newestRunLog } from "./log-reader";

/** A transaction hash is 0x + 64 hex. Anything else is not silently dropped. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Hashes as they appear inside a run log, where they are embedded in prose. */
const TX_HASH_EMBEDDED = /\b(0x[0-9a-fA-F]{64})\b/g;

const HELP = `
Confirm transactions on chain

  npm start -- --confirm <txhash> [<txhash> …]   ask the chain about these txs
  npm start -- --confirm --last                  use the newest run log's txs
  npm start -- --confirm --log <file>            use a specific run log's txs
  npm start -- --confirm --all                   every tx in .minter-logs/

  --chain <key>   chain to read through (default: $CHAIN, else ethereum)
  --budget <ms>   whole-sweep budget (default 60000)

The verdict is one of SUCCESS, REVERTED, PENDING, NOT_FOUND or TIMEOUT. TIMEOUT
is not a failure — it means the sweep could not tell, and the mint may have
landed.
`;

interface ConfirmOpts {
  hashes: string[];
  chainKey: string;
  budgetMs: number;
}

function parseConfirmArgs(args: string[]): { opts?: ConfirmOpts; error?: string; help?: boolean } {
  const hashes: string[] = [];
  let chainKey = (process.env.CHAIN || "ethereum").trim().toLowerCase();
  let budgetMs = 60_000;
  let last = false;
  let all = false;
  let logFile: string | null = null;

  const need = (flag: string, raw: string | undefined): string | null => {
    if (raw === undefined || raw === "" || (raw.startsWith("-") && raw.length > 1)) {
      return null;
    }
    return raw;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--last") { last = true; continue; }
    if (a === "--all") { all = true; continue; }
    if (a === "--chain") {
      const v = need(a, args[++i]);
      if (!v) return { error: "--chain requires a value." };
      chainKey = v.toLowerCase();
      continue;
    }
    if (a === "--budget") {
      const v = need(a, args[++i]);
      const n = v ? Number(v) : NaN;
      if (!Number.isFinite(n) || n <= 0) return { error: `--budget must be a positive number of ms, got "${v}".` };
      budgetMs = n;
      continue;
    }
    if (a === "--log" || a === "--file") {
      const v = need(a, args[++i]);
      if (!v) return { error: `${a} requires a file path.` };
      logFile = v;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) return { error: `Unknown option "${a}".` };
    hashes.push(a);
  }

  if (!last && !all && !logFile && hashes.length === 0) {
    return { error: "Give at least one transaction hash, or --last / --log <file> / --all." };
  }
  return { opts: { hashes, chainKey, budgetMs } };
}

/** Pull every transaction hash out of a run log, de-duplicated, in order. */
function hashesFromLog(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const found = text.match(TX_HASH_EMBEDDED) ?? [];
  return [...new Set(found.map((h) => h.toLowerCase()))];
}

/** Every run log that mentions a transaction, newest first. */
function allRunLogs(): string[] {
  try {
    const root = __dirname.endsWith("dist") ? path.dirname(__dirname) : __dirname;
    const dir = path.resolve(root, ".minter-logs");
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".log"))
      .sort()
      .reverse()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function runConfirmCli(args: string[]): Promise<number> {
  const parsed = parseConfirmArgs(args);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(chalk.red(`\n❌ ${parsed.error}\n`));
    return 1;
  }
  const { chainKey, budgetMs } = parsed.opts!;

  // Gather hashes. An explicit hash that is not shaped like one is refused
  // rather than passed to the RPC, where it would come back "not found" and
  // read as a transaction that never existed.
  const wanted = parsed.opts!.hashes.map((h) => h.trim().toLowerCase());
  const bad = wanted.filter((h) => !TX_HASH.test(h));
  if (bad.length > 0) {
    console.error(chalk.red(`\n❌ not a transaction hash (expected 0x + 64 hex): ${bad.join(", ")}\n`));
    return 1;
  }

  let hashes = [...wanted];
  let sourceNote = "from the command line";
  if (parsed.opts && args.includes("--last")) {
    const file = newestRunLog();
    if (!file) {
      console.error(chalk.red("\n❌ no run logs in .minter-logs/.\n"));
      return 1;
    }
    hashes = [...hashes, ...hashesFromLog(file)];
    sourceNote = `from ${path.basename(file)}`;
  }
  if (args.includes("--log")) {
    const flagIndex = args.indexOf("--log");
    const file = args[flagIndex + 1];
    if (!file || !fs.existsSync(file)) {
      console.error(chalk.red(`\n❌ no such log file: ${file}\n`));
      return 1;
    }
    hashes = [...hashes, ...hashesFromLog(file)];
    sourceNote = `from ${path.basename(file)}`;
  }
  if (args.includes("--all")) {
    const files = allRunLogs();
    if (files.length === 0) {
      console.error(chalk.red("\n❌ no run logs in .minter-logs/.\n"));
      return 1;
    }
    for (const f of files) hashes = [...hashes, ...hashesFromLog(f)];
    sourceNote = `from ${files.length} run log(s)`;
  }

  hashes = [...new Set(hashes)];
  if (hashes.length === 0) {
    console.error(chalk.red(`\n❌ no transaction hashes found ${sourceNote}.\n`));
    return 1;
  }

  let rpc: ReturnType<typeof resolveRpcsForChain>;
  try {
    rpc = resolveRpcsForChain(chainKey);
  } catch (e: any) {
    console.error(chalk.red(`\n❌ ${e?.message ?? e}\n`));
    return 1;
  }
  if (rpc.urls.length === 0) {
    console.error(chalk.red(`\n❌ no RPC endpoint for chain "${chainKey}". Set RPC_URL or RPC_URL_${chainKey.toUpperCase()}.\n`));
    return 1;
  }

  console.log(chalk.gray(`\nConfirming ${hashes.length} transaction(s) ${sourceNote} on ${chainKey} (${rpc.urls.length} RPC endpoint(s))...`));

  // dispatchedAt 0 = unknown. blockTimeMs is then reported as null rather than
  // as a duration measured from an arbitrary moment.
  const confirmed = await sweepOnChain(
    hashes.map((txHash) => ({ address: "(from hash)", txHash, dispatchedAt: 0 })),
    rpc.urls,
    budgetMs
  );

  console.log(summarizeOnChain(confirmed));

  // Exit non-zero only when nothing could be confirmed at all. A PENDING or a
  // TIMEOUT is an honest "not yet / could not tell", not a failure of the
  // command — and scripting this should not read it as an error.
  const answered = confirmed.filter((c) => c.status !== "TIMEOUT").length;
  return answered > 0 ? 0 : 1;
}
