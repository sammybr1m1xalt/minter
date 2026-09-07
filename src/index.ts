#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";

const HELP = `
NFT Mint Sniper

  Mints public SeaDrop stages AND FCFS/allowlist stages.
  Public mints need no OpenSea account; FCFS stages fetch a signed
  payload from OpenSea (free API key, auto-managed).

Usage
  npm start              run the interactive wizard
  npm start -- --help    show this message

Everything is asked interactively: keys, chain, quantity, NFT link, RPC,
gas and timing. Optional defaults can be set in .env (see .env.example).
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    await runWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
