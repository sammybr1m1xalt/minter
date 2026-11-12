#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

// Load .env from the REPO, not from wherever the user happened to run the
// command. Resolving against process.cwd() meant
// `node /home/anon/minter/dist/index.js` from $HOME silently ignored CHAIN,
// RPC_URL_* and OPENSEA_API_KEY — the run then defaulted to ethereum with
// public RPCs, which is both wrong and slow.
//
// tsc emits CommonJS, so __dirname is available. The repo root is one level
// above dist/ (or the source dir itself under ts-node).
const repoRoot = __dirname.endsWith("dist") ? path.dirname(__dirname) : __dirname;

// Prefer IPv4 for outbound connections.
//
// Node's default DNS order is "verbatim", so it tries the IPv6 records first.
// When IPv6 is blackholed (observed: opensea.io returned UND_ERR_CONNECT_TIMEOUT
// on 6 consecutive attempts while the same endpoint answered over IPv4 in
// 0.3s), undici's connect timeout can fire before the IPv4 fallback completes —
// the request fails with a transport error that looks like a dead host.
//
// IPv4-first removes the dead route from the path entirely. Measured on the
// affected host: 4/4 successes with ipv4first during a window where the default
// order failed 6/6. This is a process-wide default and affects every fetch.
try {
  require("dns").setDefaultResultOrder("ipv4first");
} catch {
  // Older Node without the API: there is no fallback, so a host whose IPv6
  // route is blackholed stays unreachable.
}

// Repo .env first; a .env in the CWD overrides it so a user can point at a
// different config without editing the repo.
dotenv.config({ path: path.resolve(repoRoot, ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

import { createRunLogger } from "./logger";
import { runWizard, runFcfsBranchCli, runEligibilityCheck } from "./wizard";
import { closePrompts } from "./prompt";
import { parseWhen, isValidWhen } from "./schedule";
import { parsePriceSpec, extractMaxPriceSpec } from "./price-protection";
import { parseTarget, resolveTarget } from "./target-resolver";
import { CHAINS } from "./chains";

// Derived from the chain table so the help text can never advertise a chain the
// tool cannot serve (it previously listed polygon/arbitrum/optimism).
const SUPPORTED_CHAINS = CHAINS.map((c) => c.key).join(" | ");

const HELP = `\nNFT Mint Sniper\n\n  Mints public SeaDrop stages AND FCFS/allowlist/OVR stages, plus any\n  contract with a discoverable mint function (ERC721/ERC1155, Manifold,\n  Zora, Scatter, or a bespoke mint).\n  Public mints need no OpenSea account; FCFS stages fetch a signed\n  payload from OpenSea (free API key, auto-managed).\n\nUsage\n  npm start                          run the interactive wizard\n  npm start -- --fcfs <target>       run the FCFS/allowlist/OVR branch directly\n  npm start -- --eligibility <ca>   poll eligibility + gas for a contract (no mint)\n  npm start -- --help                show this message\n\nTarget\n  An OpenSea / Scatter / Zora / Manifold link, a collection slug, or a contract\n  address. Chain aliases work: "0xabc… on base", "slug on arc", "slug eth".\n\nOptions\n  --at <time>           ISO 8601, unix seconds/ms, "in 5m", "30s", or "HH:MM"\n                        (HH:MM is read in IST, matching the times the wizard prints)\n  --when-open           poll the chain and fire the moment the stage opens\n  --max-price <price>   max total price in ETH, "free", "0.05/unit", "0.05total",\n                        or "any" (no cap)\n  --wallets <spec>      all | N | 1,3,4  (default: single primary wallet)\n  --chain <key>         ${SUPPORTED_CHAINS}\n  --quantity <n>        NFTs per wallet (default 1)\n\n  A target may also be given positionally (npm start -- <target>) when it is not\n  passed to --fcfs.\n\nExamples\n  npm start -- --fcfs de-bots\n  npm start -- --fcfs de-bots --at "in 5m" --max-price 0.01\n  npm start -- --eligibility 0x8d80efb61341e4b8459fbb52b213d5c25a1af179\n  npm start -- --fcfs 0xabc… on base --quantity 3 --wallets all\n\nEverything not passed as a flag is asked interactively: keys, chain, quantity,\nNFT link, RPC, gas and timing. Optional defaults can be set in .env.\n`;

interface CliFlags {
  fcfs: string | null;
  eligibility: string | null;
  at: string | null;
  whenOpen: boolean;
  maxPrice: string | null;
  wallets: string | null;
  chain: string | null;
  quantity: number | null;
  rest: string[];
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = {
    fcfs: null,
    eligibility: null,
    at: null,
    whenOpen: false,
    maxPrice: null,
    wallets: null,
    chain: null,
    quantity: null,
    rest: [],
  };

  /** Read the value that must follow a value-taking flag.
   *  Previously a trailing flag read `undefined` and became null, so
   *  `minter --eligibility` silently started the interactive wizard instead of
   *  reporting the missing argument. */
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw === "") throw new Error(`${flag} requires a value.`);
    // A value that is itself a flag means the argument was missing. Consuming
    // the next flag as a value silently set e.g. chain to "--quantity".
    if (raw.startsWith("-") && raw.length > 1) {
      throw new Error(`${flag} requires a value (got "${raw}").`);
    }
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fcfs") out.fcfs = value(a, argv[++i]);
    else if (a === "--eligibility") out.eligibility = value(a, argv[++i]);
    else if (a === "--at") out.at = value(a, argv[++i]);
    else if (a === "--when-open" || a === "--open") out.whenOpen = true;
    else if (a === "--max-price" || a === "--maxprice" || a === "-p") out.maxPrice = value(a, argv[++i]);
    else if (a.startsWith("--max-price=") || a.startsWith("--maxprice=")) {
      out.maxPrice = value("--max-price", a.split("=").slice(1).join("="));
    } else if (a === "--wallets" || a === "-w") out.wallets = value(a, argv[++i]);
    else if (a === "--chain") out.chain = value(a, argv[++i]);
    else if (a === "--quantity" || a === "-q") {
      const raw = value(a, argv[++i]);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${a} must be a positive integer, got "${raw}".`);
      }
      out.quantity = n;
    } else if (a.startsWith("-") && a.length > 1) {
      // An unrecognised flag used to fall into `rest` and become the mint
      // target, so a typo like `--typo` ran a snipe against a target named
      // "--typo". Refuse it instead.
      throw new Error(`Unknown option "${a}". Run with --help for the accepted flags.`);
    } else out.rest.push(a);
  }
  return out;
}

/** Validate the flags that can be checked without touching the network. */
function validateFlags(flags: CliFlags): string | null {
  if (flags.at && !isValidWhen(flags.at)) {
    return `--at "${flags.at}" is not a recognised time. Use ISO 8601, unix seconds/ms, "in 5m", "30s", or "HH:MM".`;
  }
  if (flags.maxPrice) {
    try {
      parsePriceSpec(flags.maxPrice);
    } catch (e: any) {
      return `--max-price "${flags.maxPrice}" is not a recognised price. Use an ETH amount, "free", or "any".`;
    }
  }
  if (flags.quantity != null && flags.quantity < 1) {
    return `--quantity must be at least 1.`;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  let flags: CliFlags;
  try {
    flags = parseFlags(args);
  } catch (e: any) {
    console.error(chalk.red(`\n❌ ${e.message}\n`));
    process.exit(1);
  }

  const err = validateFlags(flags);
  if (err) {
    console.error(chalk.red(`\n❌ ${err}\n`));
    process.exit(1);
  }

  // A target can be given positionally or after --fcfs. Prefer the flag.
  const fcfsTarget = flags.fcfs ?? (flags.rest.length > 0 ? flags.rest.join(" ") : null);

  // ── FCFS branch ──────────────────────────────────────────────────────────
  if (fcfsTarget) {
    const log = createRunLogger({ mode: "fcfs", label: fcfsTarget });
    log.field("target", fcfsTarget);
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
    if (flags.at) log.field("scheduled_at", String(parseWhen(flags.at)));
    if (flags.maxPrice) log.field("max_price", flags.maxPrice);
    if (flags.wallets) log.field("wallets", flags.wallets);
    if (flags.quantity != null) log.field("quantity", flags.quantity);

    try {
      log.info("Calling runFcfsBranchCli...");
      await runFcfsBranchCli(log, fcfsTarget, {
        at: flags.at,
        whenOpen: flags.whenOpen,
        maxPrice: flags.maxPrice,
        wallets: flags.wallets,
        chain: flags.chain,
        quantity: flags.quantity,
      } as any);
      log.info("FCFS branch completed successfully");
      log.end();
      closePrompts();
      process.exit(0);
    } catch (e: any) {
      log.dumpError(e);
      log.end();
      closePrompts();
      console.error(chalk.red(`\n❌ ${e.message}\n`));
      process.exit(1);
    }
  }

  // ── Eligibility check ────────────────────────────────────────────────────
  if (flags.eligibility) {
    const targetArg = flags.eligibility;
    const log = createRunLogger({ mode: "eligibility", label: targetArg });
    log.field("target", targetArg);
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    try {
      log.info("Calling runEligibilityCheck...");
      await runEligibilityCheck(log, targetArg, { chain: flags.chain });
      log.info("Eligibility check completed");
      log.end();
      closePrompts();
      process.exit(0);
    } catch (e: any) {
      log.dumpError(e, { phase: "runEligibilityCheck", target: targetArg });
      log.end();
      closePrompts();
      console.error(chalk.red(`\n❌ ${e.message}\n`));
      process.exit(1);
    }
  }

  // ── Interactive wizard (default) ─────────────────────────────────────────
  const log = createRunLogger({ mode: "wizard", label: "interactive" });
  log.field("chain_env", process.env.CHAIN || "<unset>");
  log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
  log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
  if (flags.at) log.field("scheduled_at", String(parseWhen(flags.at)));
  if (flags.maxPrice) log.field("max_price", flags.maxPrice);
  log.info("Starting interactive wizard");
  try {
    await runWizard(log, {
      at: flags.at,
      whenOpen: flags.whenOpen,
      maxPrice: flags.maxPrice,
      wallets: flags.wallets,
      chain: flags.chain,
      quantity: flags.quantity,
      target: flags.rest.length > 0 ? flags.rest.join(" ") : null,
    });
    log.info("Wizard completed successfully");
    log.end();
    closePrompts();
    process.exit(0);
  } catch (e: any) {
    log.dumpError(e);
    log.end();
    closePrompts();
    console.error(chalk.red(`\n❌ ${e.message}\n`));
    process.exit(1);
  }
}

void main();
