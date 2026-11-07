// Shared wizard UI helpers — used by both the public and FCFS branches so
// we don't repeat ~80 lines of gas prompts, balance display, and the confirm
// screen in two places.

import chalk from "chalk";
import { formatEther, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { askNumber, askYesNo } from "./prompt";
import { waitForMintTime } from "./timer";
import { toIST } from "./time-format";

export interface SnipeReadyInput {
  chainProfile: ChainProfile;
  rpcUrls: string[];
  wallets: Wallet[];
  balances: (bigint | null)[];
  nftContract: string;
  quantity: number;
  valuePerWallet: bigint;
  required: bigint;            // gasLimit × maxFeePerGas + valuePerWallet  (what each wallet must hold)
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  address?: string;             // wallet address label shown in summary
  slug?: string;                // collection slug / target label shown in summary
  targetStart: Date | null;
  timingLabel: string;
  modeLabel: string;
  targetLabel: string;
  promptForGas?: boolean;
  openSeaGasInfo?: string;
}

// Thin key→value line used in the READY summary screen.
function line(label: string, value: string, color = chalk.gray): void {
  console.log(color(`  ${label.padEnd(10)} ${value}`));
}

// Ask for gas (maxFee + priority) the same way in both branches.
// Returns { maxFeePerGas, maxPriorityFeePerGas } in wei.
export async function promptGasGwei(
  chainProfile: ChainProfile,
  rpcUrls: string[],
  envMaxFeeOverride?: number,
  envPriorityOverride?: number,
): Promise<{ maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint; defaultGasLimit: number }> {
  const provider = new (await import("ethers")).JsonRpcProvider(rpcUrls[0]);

  console.log(chalk.bold.white("\nGas"));

  const envMaxFee = envMaxFeeOverride ?? Number(process.env.MAX_FEE_PER_GAS || (chainProfile.key === "ethereum" ? 80 : 2));
  const envPriority = envPriorityOverride ?? Number(process.env.MAX_PRIORITY_FEE || (chainProfile.key === "ethereum" ? 5 : 0.05));

  let baseFeeGwei: number | null = null;
  try {
    baseFeeGwei = await currentBaseFeeGwei(provider);
  } catch {}

  console.log(chalk.gray(`  Network base fee right now: ${(baseFeeGwei ?? 0).toFixed(6)} gwei`));

  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    console.log(chalk.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`));
  }

  const gf = await askNumber("Max fee per gas (gwei) — your ceiling", defaultMaxFee, { min: baseFeeGwei ?? 0 });
  const pr = await askNumber("Priority fee / tip (gwei)", Math.min(envPriority, gf), { min: 0, max: gf });

  const defaultGasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  return {
    maxFeePerGasWei: gweiToWei(gf),
    maxPriorityFeePerGasWei: gweiToWei(pr),
    defaultGasLimit,
  };
}

// Same base-fee helper, in case callers need it outside promptGasGwei.
async function currentBaseFeeGwei(provider: any): Promise<number | null> {
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas;
  if (!baseFee) return null;
  return Number(baseFee) / 1e9;
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

// Display balances + affordability, same in both branches.
export function displayBalances(input: SnipeReadyInput): { shortCount: number; poorerBalance: bigint | null } {
  const { wallets, balances, required } = input;

  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unavailable" : `${Number(formatEther(bal)).toFixed(6)} ETH`;
    const short = bal !== null && bal < required;
    const lineText = `  [W${i}] ${w.address}  ${text}`;
    console.log(short ? chalk.red(`${lineText}  ✗ needs ${formatEther(input.required)}`) : chalk.gray(lineText));
  });

  const shortWallets = wallets.filter(
    (_, i) => balances[i] !== null && (balances[i] as bigint) < required
  );

  // poorerBalance must be declared outside the if block so it's in scope for the return.
  let poorerBalance: bigint | null = null;
  if (shortWallets.length > 0) {
    const mintNote = input.valuePerWallet > 0n ? " + mint price" : "";
    console.log(
      chalk.gray(
        `\n  Nodes require gasLimit × maxFee${mintNote} = ${formatEther(input.required)} ETH held per wallet.`
      )
    );
    poorerBalance = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a === null || b < a ? b : a), null as bigint | null);

    const requiredWithoutMint = required - input.valuePerWallet;
    const affordable = poorerBalance !== null && requiredWithoutMint > 0n
      ? Number(requiredWithoutMint / BigInt(input.gasLimit)) / 1e9
      : null;

    if (affordable !== null && affordable > 0) {
      console.log(
        chalk.yellow(`  Either fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`)
      );
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    console.log(chalk.yellow("  The remaining wallet(s) can still fire."));
  }

  return { shortCount: shortWallets.length, poorerBalance: poorerBalance };
}

// Print the READY summary and wait for user confirmation.
// Throws / returns false if the user aborts.
export async function confirmSnipe(input: SnipeReadyInput): Promise<boolean> {
  console.log(chalk.bold.white("\n──────── READY ────────"));
  line("Mode", input.modeLabel);
  line("Chain", `${input.chainProfile.name} (${input.chainProfile.chainId})`);
  line("RPC", `${labelOf(input.rpcUrls[0])} + ${input.rpcUrls.length - 1} more`);
  line("Target", input.targetLabel);
  line("Contract", input.nftContract);
  line("Wallets", `${input.wallets.length}`);
  line("Quantity", `${input.quantity} per wallet → ${input.quantity * input.wallets.length} total`);
  line(
    "Mint cost",
    `${formatEther(input.valuePerWallet)} per wallet → ${formatEther(input.valuePerWallet * BigInt(input.wallets.length))} total (+ gas)`
  );
  if (input.promptForGas) {
    line("Gas", `${input.gasLimit} gas · maxFee unknown until prompted`);
  } else {
    line("Gas", `${input.gasLimit} gas · ${formatEther(input.maxFeePerGas)} max · ${formatEther(input.maxPriorityFeePerGas)} tip`);
  }
  line("Timing", input.timingLabel);
  console.log(chalk.bold.white("───────────────────────"));

  if (!(await askYesNo(chalk.bold("Fire?"), false))) {
    console.log(chalk.yellow("\n  Aborted — nothing was sent.\n"));
    return false;
  }
  return true;
}

export async function promptTiming(dropStartTime: Date | null): Promise<{ targetStart: Date | null; timingLabel: string }> {
  // If the drop start time is unknown, skip timing entirely.
  if (!dropStartTime) {
    return { targetStart: null, timingLabel: "No start time known — fire when ready" };
  }
  const delay = dropStartTime.getTime() - Date.now();
  if (delay <= 0) {
    return { targetStart: dropStartTime, timingLabel: "Stage already open" };
  }
  const waitStr = `in ${Math.round(delay / 1000)}s`;
  console.log(chalk.bold.white(`\nTiming`));
  console.log(chalk.gray(`  Stage opens ${toIST(dropStartTime)} (${waitStr} from now)`));
  await waitForMintTime(dropStartTime);
  return { targetStart: dropStartTime, timingLabel: `Fires at ${toIST(dropStartTime)}` };
}

function labelOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
