#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { createRunLogger } from "./logger";
import { runWizard, runFcfsBranchCli, runEligibilityCheck } from "./wizard";
import { closePrompts } from "./prompt";

const HELP = `\nNFT Mint Sniper\n\n  Mints public SeaDrop stages AND FCFS/allowlist/OVR stages.\n  Public mints need no OpenSea account; FCFS stages fetch a signed\n  payload from OpenSea (free API key, auto-managed).\n\nUsage\n  npm start                        run the interactive wizard\n  npm start -- --fcfs <slug|ca>   run the FCFS/allowlist/OVR branch directly\n  npm start -- --eligibility <ca> poll eligibility + gas for a contract (no mint)\n  npm start -- --help              show this message\n\nExamples\n  npm start -- --fcfs de-bots\n  npm start -- --eligibility 0x8d80efb61341e4b8459fbb52b213d5c25a1af179\n\nEverything is asked interactively: keys, chain, quantity, NFT link, RPC,\ngas and timing. Optional defaults can be set in .env (see .env.example).\n`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  // ── FCFS branch ──────────────────────────────────────────────────────────
  const fcfsIdx = args.indexOf("--fcfs");
  if (fcfsIdx >= 0) {
    const targetArg = args[fcfsIdx + 1];
    if (!targetArg) {
      console.error(chalk.red("Usage: npm start -- --fcfs <slug|contract_address>"));
      process.exit(1);
    }
    const log = createRunLogger({ mode: "fcfs", label: targetArg });
    log.field("target", targetArg);
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
    try {
      log.info("Calling runFcfsBranchCli...");
      await runFcfsBranchCli(log, targetArg);
      log.info("FCFS branch completed successfully");
      log.end();
      closePrompts();
      process.exit(0);
    } catch (err: any) {
      log.dumpError(err);
      log.end();
      closePrompts();
      console.error(chalk.red(`\n❌ ${err.message}\n`));
      process.exit(1);
    }
  }

  // ── Eligibility check ────────────────────────────────────────────────────
  const eligIdx = args.indexOf("--eligibility");
  if (eligIdx >= 0) {
    const targetArg = args[eligIdx + 1];
    if (!targetArg) {
      console.error(chalk.red("Usage: npm start -- --eligibility <contract_address>"));
      process.exit(1);
    }
    const log = createRunLogger({ mode: "eligibility", label: targetArg });
    log.field("target", targetArg);
    log.field("chain_env", process.env.CHAIN || "<unset>");
    log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
    try {
      log.info("Calling runEligibilityCheck...");
      await runEligibilityCheck(log, targetArg);
      log.info("Eligibility check completed");
      log.end();
      closePrompts();
      process.exit(0);
    } catch (err: any) {
      log.dumpError(err, {
        phase: "runEligibilityCheck",
        target: targetArg,
      });
      log.end();
      closePrompts();
      console.error(chalk.red(`\n❌ ${err.message}\n`));
      process.exit(1);
    }
  }

  // ── Interactive wizard (default) ─────────────────────────────────────────
  const log = createRunLogger({ mode: "wizard", label: "interactive" });
  log.field("chain_env", process.env.CHAIN || "<unset>");
  log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
  log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
  log.info("Starting interactive wizard");
  try {
    await runWizard(log);
    log.info("Wizard completed successfully");
    log.end();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    log.dumpError(err);
    log.end();
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
