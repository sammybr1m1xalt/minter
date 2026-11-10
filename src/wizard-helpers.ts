// Shared wizard UI helpers — used by both the public and FCFS branches so
// we don't repeat ~80 lines of gas prompts, balance display, and the confirm
// screen in two places.

import chalk from "chalk";
import { formatEther, JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { askChoice, askNumber, askYesNo } from "./prompt";
import { toIST } from "./time-format";
import {
  executeSellAfterMint,
  fetchUsdPrice,
  quoteGasModes,
  SELL_GAS_LIMIT,
  type GasMode,
} from "./sell-after-mint";

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
  // The provider is only needed for that one read. Without an explicit destroy
  // its polling timer keeps the process alive after the wizard finishes.
  try {
    provider.destroy();
  } catch {
    // Already destroyed.
  }

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

/**
 * Report the timing decision and return the instant to fire at.
 *
 * This function deliberately does NOT wait. The wait lives inside the snipe
 * (executeFcfsSnipe / localPublicSnipe), which runs immediately before the
 * blast. Waiting here would block until T-0 and leave the READY screen, the
 * "Fire?" confirmation and the sell prompts to run AFTER the window — the exact
 * moment a snipe exists to hit. Deciding first means all of that preparation
 * completes before T-0 and the fire happens on time.
 */
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

  // A future signed phase has no payload yet — OpenSea signs a mint only for a
  // live stage. Ask whether to wait for it rather than assuming, so the user
  // knows the run will sit idle until T-0 and that the payload is fetched then.
  const fireWhenOpen = await askYesNo(
    `  Fire when the stage opens?`,
    true
  );
  if (!fireWhenOpen) {
    return { targetStart: null, timingLabel: "Declined — not scheduled" };
  }
  return { targetStart: dropStartTime, timingLabel: `Fires at ${toIST(dropStartTime)}` };
}

function labelOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── Sell-after-mint ─────────────────────────────────────────────────────────
//
// Shared by the wizard and the --fcfs branch. Two rules drive the design:
//
//   • Scheduling happens BEFORE the mint, and looks at NO offers. An offer
//     book read now is stale by T-0, so the only thing quoted here is the gas
//     cost — the offers are read after the mint, per wallet, one at a time.
//   • Selling happens one wallet at a time, in wallet order. Parallel would
//     race several wallets into the same criteria offer, and an offer carries
//     `remaining_quantity`, so one fills it and the rest revert.

export interface SellPlan {
  enabled: boolean;
  quantity: number;
  gasMode: GasMode;
  /** Per-token floor: mint unit price + estimated sell gas, in wei. */
  costWeiPerToken: bigint;
}

export interface SellPromptContext {
  chainKey: string;
  apiKey: string;
  symbol: string;
  mintQuantity: number;
  /** Total native value per wallet for the mint. */
  valuePerWallet: bigint;
  rpcUrl: string;
}

/** Prompt for the sell-after-mint plan. Returns null when the user declines. */
export async function planSellAfterMint(ctx: SellPromptContext): Promise<SellPlan | null> {
  const wantsSell = await askYesNo(
    "\nSell the minted tokens into the best OpenSea offer right after the mint?",
    false
  );
  if (!wantsSell) return null;

  const quantity = await askNumber(
    `Tokens to sell per wallet (mint quantity is ${ctx.mintQuantity})`,
    ctx.mintQuantity,
    { min: 1, max: ctx.mintQuantity }
  );
  const gasMode = await askChoice<GasMode>(
    "Sell gas mode?",
    [
      { label: "slow", value: "slow", hint: "cheapest, clears in the next few blocks" },
      { label: "fast", value: "fast", hint: "competes with ordinary traffic" },
      { label: "ultra", value: "ultra", hint: "for an offer that may be front-run" },
    ],
    1
  );

  // Report the estimated gas cost in USD for all three modes at this moment.
  const usd = await fetchUsdPrice(ctx.chainKey, ctx.apiKey).catch(() => null);
  const estProvider = new JsonRpcProvider(ctx.rpcUrl);
  let base = 0n;
  let tip = 0n;
  try {
    const latest = await estProvider.getBlock("latest").catch(() => null);
    const feeData = await estProvider.getFeeData().catch(() => null);
    base = latest?.baseFeePerGas ?? feeData?.maxFeePerGas ?? 0n;
    tip = feeData?.maxPriorityFeePerGas ?? 0n;
  } finally {
    try { estProvider.destroy(); } catch { /* already destroyed */ }
  }

  const quotes = quoteGasModes(
    { baseFeePerGas: base, priorityFeePerGas: tip, gasLimit: SELL_GAS_LIMIT },
    usd
  );
  console.log(chalk.bold.white("\nEstimated sell gas cost"));
  for (const q of quotes) {
    const usdTxt = q.costUsd == null ? "" : `  ($${q.costUsd.toFixed(2)})`;
    console.log(chalk.gray(`  ${q.mode.padEnd(5)} ${formatEther(q.costWei)} ${ctx.symbol}${usdTxt}`));
  }

  const chosen = quotes.find((q) => q.mode === gasMode) ?? quotes[0];
  const unitPrice = ctx.valuePerWallet / BigInt(ctx.mintQuantity);
  const costWeiPerToken = unitPrice + chosen.costWei;
  console.log(
    chalk.gray(
      `  Cost floor per token: ${formatEther(costWeiPerToken)} ${ctx.symbol}` +
        ` (mint ${formatEther(unitPrice)} + gas ${formatEther(chosen.costWei)})`
    )
  );

  return { enabled: true, quantity, gasMode, costWeiPerToken };
}

export interface MintOutcome {
  walletIndex: number;
  address: string;
  txHash: string | null;
  status: string;
}

/** Sell each successful wallet's minted tokens, sequentially. */
export async function runSellAfterMint(params: {
  sellPlan: SellPlan;
  walletKeys: string[];
  contract: string;
  slug: string;
  chainKey: string;
  apiKey: string;
  rpcUrl: string;
  chainId: number;
  mintOutcomes: MintOutcome[];
}): Promise<void> {
  console.log(chalk.bold.white("\nSell after mint"));
  console.log(chalk.gray(`  Offers:     ${params.slug}`));
  console.log(chalk.gray(`  Gas mode:   ${params.sellPlan.gasMode}`));
  console.log(
    chalk.gray(`  Cost floor: ${formatEther(params.sellPlan.costWeiPerToken)} per token`)
  );

  for (const outcome of params.mintOutcomes) {
    // A failed mint must not sell anything, and no approval may be sent.
    if (outcome.status !== "SUCCESS" || !outcome.txHash) {
      console.log(
        chalk.gray(`\n  [W${outcome.walletIndex}] skipped — mint ${outcome.status.toLowerCase()}`)
      );
      continue;
    }

    console.log(
      chalk.gray(
        `\n  [W${outcome.walletIndex}] reading minted tokens from ${outcome.txHash.slice(0, 12)}…`
      )
    );
    const result = await executeSellAfterMint({
      walletKey: params.walletKeys[outcome.walletIndex],
      contract: params.contract,
      slug: params.slug,
      chainKey: params.chainKey,
      apiKey: params.apiKey,
      rpcUrl: params.rpcUrl,
      chainId: params.chainId,
      quantity: params.sellPlan.quantity,
      gasMode: params.sellPlan.gasMode,
      costWeiPerToken: params.sellPlan.costWeiPerToken,
      mintTxHash: outcome.txHash,
    });

    if (result.error) {
      console.log(chalk.red(`    ✗ ${result.error}`));
      continue;
    }
    if (result.skippedReason) {
      console.log(chalk.yellow(`    ⚠ ${result.skippedReason}`));
      continue;
    }
    if (result.approvalTxHash) {
      console.log(chalk.gray(`    Seaport approval sent: ${result.approvalTxHash}`));
    }

    for (const sold of result.sold) {
      if (sold.error) {
        console.log(chalk.yellow(`    [${sold.tokenId}] ${sold.error}`));
      } else {
        console.log(
          chalk.green(
            `    ✓ token ${sold.tokenId} sold for ${formatEther(sold.netWei)} ` +
              `(offer ${sold.offerHash.slice(0, 12)}…)`
          )
        );
        console.log(chalk.gray(`      tx: ${sold.txHash}`));
      }
    }
  }

  console.log(chalk.bold.white("\n===== SELL AFTER MINT COMPLETE ====="));
}
