// ── Allowlist/FCFS/OVR branch (independent) ───────────────────────────────
// Rewritten to:
//   (a) Fetch ALL active phases for the collection, not just the first one
//   (b) Show eligibility + allocation status for each phase
//   (c) Poll current gas state and recommend settings
//   (d) Let the user pick which phase to target (or auto-pick the best targetable one)
//   (e) Handle "no OpenSea key available" gracefully — show what's possible
//       without a key, and what would need a key

import chalk from "chalk";
import { Wallet, formatEther } from "ethers";
import { ChainProfile, resolveChain } from "./chains";
import {
  fetchAllActiveDrops,
  DropPhase,
  printDropsInventory,
  reportInventoryEligibility,
  assessDropEligibility,
  fetchGasState,
  printGasState,
  recommendGasSettings,
  printGasRecommendation,
  gasChoiceAssessment,
  GasRecommendation,
} from "./fcfs-drops";
import {
  fetchFcfsSignedPayloadKeyOnly,
  buildFcfsMintPlan,
  executeFcfsSnipe,
} from "./fcfs-mint";
import { getValidApiKey } from "./opensea-key";
import {
  askText,
  askYesNo,
  closePrompts,
} from "./prompt";
import {
  promptGasGwei,
  promptTiming,
  confirmSnipe,
} from "./wizard-helpers";
import { formatRemaining, toIST } from "./time-format";

// ── Main FCFS branch entry ──────────────────────────────────────────────────

export async function runFcfsBranch(
  walletKeys: string[],
  chainProfile: ChainProfile,
  chainKey: string,
  nftContract: string,
  quantity: number,
  rpcUrls: string[],
  target: { label: string },
): Promise<void> {
  const wallets = walletKeys.map((k) => new Wallet(k));
  const ourWallet = wallets[0].address.toLowerCase();

  // ── Step 0: Get an OpenSea API key (best-effort) ────────────────────────
  // The inventory can be fetched with or without a key. A key gives more data
  // (eligibility, signed mint data). Without a key, we still show what OpenSea
  // knows about the phases, but signed mint data may be absent.
  console.log(chalk.bold.white("\nOpenSea API key"));
  console.log(chalk.gray("  Checking for a usable key..."));

  const keyResult = await getValidApiKey({ timeoutMs: 8000 });
  const apiKey = keyResult?.api_key || undefined;

  if (keyResult) {
    console.log(chalk.green(`  ✓ Key ready: ${keyResult.source}`));
  } else {
    console.log(chalk.yellow(`  ⚠ No usable OpenSea key available.`));
    console.log(chalk.gray(`    The phase inventory will still be fetched, but signed`));
    console.log(chalk.gray(`    mint data may be missing. You'll need a key for the actual`));
    console.log(chalk.gray(`    mint. Public mint path doesn't need a key.\n`));
  }

  // ── Step 1: Fetch ALL active phases for this collection ──────────────────
  console.log(chalk.bold.white("\nCollection phases"));
  console.log(chalk.gray(`  Fetching all active phases for ${nftContract}...`));

  const inventory = await fetchAllActiveDrops(nftContract, apiKey, 12000);

  if (inventory.drops.length === 0) {
    console.log(chalk.yellow(`\n  ⚠ No active phases found for ${nftContract}.`));
    console.log(chalk.gray(`    Possible reasons:`));
    console.log(chalk.gray(`    • The collection has no OpenSea-managed phases`));
    console.log(chalk.gray(`    • The API key doesn't have access (try a different key)`));
    console.log(chalk.gray(`    • The collection isn't on this chain`));
    console.log(chalk.gray(`    • OpenSea rate-limited the request\n`));

    if (!apiKey) {
      console.log(chalk.yellow(`  Try: get an OpenSea free API key and re-run.`));
      console.log(chalk.gray(`    Without a key, OpenSea may not return phase data.\n`));
    }

    throw new Error(
      `No active phases found for ${nftContract}. ` +
        `Either the collection has no OpenSea-managed phases, or the API key doesn't have access.`,
    );
  }

  // ── Step 1b: Try to detect the actual chain from OpenSea's response ──────
  // The public mint tool auto-detects chain by reading the contract on each
  // known RPC. For the FCFS path, OpenSea sometimes tells us the chain in the
  // drop response. If it does, and it disagrees with what the user picked,
  // warn them and offer to switch.
  if (inventory.chainId != null) {
    const reportedChain = resolveChain(inventory.chainId);
    if (reportedChain && reportedChain.chainId !== chainProfile.chainId) {
      console.log(
        chalk.yellow(
          `\n  ⚠ OpenSea reports this collection is on ${reportedChain.name} (chain id ${reportedChain.chainId}), ` +
            `but you selected ${chainProfile.name} (chain id ${chainProfile.chainId}).`,
        ),
      );
      console.log(chalk.gray(`    The phases listed below are from OpenSea's response.`));
      console.log(chalk.gray(`    If the chain is wrong, the mint will fail on-chain.\n`));

      // We don't auto-switch here because the user may have set up RPCs for the
      // chain they picked. But we flag it clearly.
    }
  }

  // ── Step 2: Assess eligibility for each phase ────────────────────────────
  const eligibility = reportInventoryEligibility(inventory, ourWallet);

  // ── Step 3: Poll current gas state ───────────────────────────────────────
  console.log(chalk.gray(`  Polling current gas state on ${chainProfile.name}...`));
  const gasState = await fetchGasState(rpcUrls, chainProfile.chainId, 5000);
  printGasState(gasState, chainProfile.name);

  // ── Step 4: Show the full inventory to the user ──────────────────────────
  printDropsInventory(inventory, eligibility, ourWallet, chainProfile.name);

  // ── Step 5: Check if any phase is targetable ────────────────────────────
  const targetable = eligibility.filter((e) => e.recommendation === "target");
  const needsManualCheck = eligibility.filter((e) => e.recommendation === "check-manually");
  const skip = eligibility.filter((e) => e.recommendation === "skip");

  if (targetable.length === 0) {
    console.log(chalk.yellow(`\n  ⚠ No targetable phases found.`));
    if (needsManualCheck.length > 0) {
      console.log(chalk.gray(`    Some phases exist but need manual investigation:`));
      for (const r of needsManualCheck) {
        console.log(chalk.gray(`      • ${r.drop.name || "unnamed"} — ${r.reason}`));
      }
      console.log();
    }
    if (!apiKey) {
      console.log(chalk.yellow(`  Without an OpenSea API key, signed mint data isn't available.`));
      console.log(chalk.gray(`    Get a free key and re-run to see if phases become targetable.\n`));
    }
    throw new Error(
      `No targetable phases for ${nftContract}. ` +
        `All ${eligibility.length} phase(s) either are skipped or need manual investigation.`,
    );
  }

  // ── Step 6: Let the user pick a phase ────────────────────────────────────
  console.log(chalk.bold.white(`\n  ${targetable.length} targetable phase(s) found.`));
  console.log(chalk.gray(`  Enter the number of the phase to target (or press Enter for the first):`));

  for (let i = 0; i < targetable.length; i++) {
    const r = targetable[i];
    const d = r.drop;
    const startsAt = new Date(d.startTime * 1000);
    const endsAt = new Date(d.endTime * 1000);
    const isLive = Date.now() >= d.startTime * 1000 && Date.now() < d.endTime * 1000;

    const liveMark = isLive ? chalk.green("LIVE") : chalk.gray("waiting");
    console.log(
      chalk.gray(`    [${i + 1}] ${d.name || `phase #${i + 1}`}`)
    );
    console.log(chalk.gray(`        type: ${d.type || "unknown"}`));
    console.log(chalk.gray(`        window: ${toIST(startsAt)} → ${toIST(endsAt)} ${liveMark}`));
    console.log(chalk.gray(`        price: ${formatEther(d.mintPrice)} ETH, ${d.maxTotalMintableByWallet || "unlimited"} per wallet`));
    if (r.allocationRemaining != null) {
      console.log(chalk.gray(`        allocation: ${r.allocationRemaining} slots remaining`));
    }
    console.log();
  }

  const choice = await askText(chalk.gray(`  Phase number (1-${targetable.length}, default 1): `));
  let selectedIndex = 0;
  if (choice && choice.trim().length > 0) {
    const parsed = parseInt(choice.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= targetable.length) {
      selectedIndex = parsed - 1;
    } else {
      console.log(chalk.yellow(`  Invalid number — using first phase.`));
    }
  }

  const selected = targetable[selectedIndex];
  const selectedDrop = selected.drop;

  // ── Step 7: Fetch the signed payload for the selected phase ──────────────
  // The inventory only tells us a phase EXISTS and is targetable. To actually
  // mint, we need the per-wallet signed payload. Fetch it now.

  console.log(chalk.bold.white(`\n  Fetching signed mint data for selected phase...`));
  console.log(chalk.gray(`    Phase: ${selectedDrop.name || `phase #${selectedIndex + 1}`}`));
  console.log(chalk.gray(`    Type:  ${selectedDrop.type || "unknown"}`));
  console.log(chalk.gray(`    Drop ID: ${selectedDrop.dropId}`));

  // The inventory may have told us the mintData/mintSignature exist, but the
  // actual fetchFcfsSignedPayloadKeyOnly call is what gets the wallet-specific
  // signature. The inventory's mintData is the generic template; the real call
  // needs to go through OpenSea's mintSigned flow.

  // Try with the key first
  const payload = await fetchFcfsSignedPayloadKeyOnly(
    nftContract,
    quantity,
    apiKey || undefined,
    { timeoutMs: 12000 },
  );

  if (!payload) {
    console.log(chalk.red(`\n  ✗ Could not fetch signed mint data for this phase.`));
    console.log(chalk.gray(`    Possible reasons:`));
    console.log(chalk.gray(`    • The phase exists but doesn't use OpenSea's signature flow`));
    console.log(chalk.gray(`    • The API key doesn't have access to this specific phase`));
    console.log(chalk.gray(`    • The phase requires a live session, not just an API key`));
    console.log(chalk.gray(`    • The collection isn't actually a SeaDrop collection\n`));

    if (!apiKey) {
      console.log(chalk.yellow(`  Try: get an OpenSea free API key and re-run.`));
      console.log(chalk.gray(`    Without a key, OpenSea won't return signed mint data.\n`));
    }

    // Even without a payload, show what we know about the phase so the user
    // has something useful
    console.log(chalk.bold.white(`\n  What we know about this phase:`));
    console.log(chalk.gray(`    name:       ${selectedDrop.name || "unnamed"}`));
    console.log(chalk.gray(`    type:       ${selectedDrop.type || "unknown"}`));
    console.log(chalk.gray(`    drop ID:    ${selectedDrop.dropId}`));
    console.log(chalk.gray(
      `    window:     ${toIST(new Date(selectedDrop.startTime * 1000))} → ${toIST(new Date(selectedDrop.endTime * 1000))}`,
    ));
    console.log(chalk.gray(`    price:      ${formatEther(selectedDrop.mintPrice)} ETH`));
    console.log(chalk.gray(`    per wallet: ${selectedDrop.maxTotalMintableByWallet || "unlimited"}`));
    if (selectedDrop.gasLimit) {
      console.log(chalk.gray(`    OpenSea gas hint: ${selectedDrop.gasLimit} gas limit`));
    }
    if (selectedDrop.allowlistHash) {
      console.log(chalk.gray(`    allowlist hash: ${selectedDrop.allowlistHash.slice(0, 16)}...`));
    }
    console.log();
    throw new Error(
      `Could not fetch signed mint data for phase "${selectedDrop.name || "unnamed"}". ` +
        `The phase exists but OpenSea didn't return wallet-specific signed data. ` +
        `This may require a live OAuth session, or the phase isn't using OpenSea's signature flow.`,
    );
  }

  // ── Step 8: Show the fetched drop details ────────────────────────────────
  const drop = payload.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = Date.now() >= drop.startTime * 1000 && Date.now() < drop.endTime * 1000;

  console.log(chalk.green(`  ✓ Fetched signed mint data from OpenSea`));
  console.log(chalk.gray(`    SeaDrop:       ${payload.seaDropAddress}`));
  console.log(chalk.gray(`    NFT:           ${nftContract}`));
  console.log(chalk.gray(`    Fee recipient: ${payload.feeRecipient}`));
  console.log(
    chalk.gray(
      `    Price:         ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(payload.value)} per wallet`,
    ),
  );
  console.log(chalk.gray(`    Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`));
  console.log(chalk.gray(`    Calldata:      ${(payload.mintData.length - 2) / 2} bytes (per-wallet signed)`));
  console.log(
    chalk.gray(
      `    Window:        ${toIST(startsAt)} → ${toIST(endsAt)} ` +
        `${live ? chalk.green("(live)") : chalk.yellow(`(opens in ${formatRemaining(startsAt.getTime() - Date.now())})`)}`,
    ),
  );

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    console.log(
      chalk.yellow(`  ⚠ This drop allows only ${drop.maxTotalMintableByWallet} per wallet — ${quantity} will revert.`),
    );
  }
  if (Date.now() >= endsAt.getTime()) {
    console.log(chalk.yellow(`  ⚠ This stage has already ended on-chain.`));
  }

  // ── Step 9: Gas recommendation ───────────────────────────────────────────
  // Combine OpenSea-provided gas hints with live gas state for a recommendation
  const openSeaGas = selectedDrop.gasLimit
    ? {
        gasLimit: selectedDrop.gasLimit,
        maxFeePerGas: selectedDrop.maxFeePerGas,
        maxPriorityFeePerGas: selectedDrop.maxPriorityFeePerGas,
      }
    : null;

  const recommendation = recommendGasSettings(gasState, openSeaGas, payload.gasData?.gasLimit || 250_000);
  printGasRecommendation(recommendation, chainProfile.name);

  // ── Step 10: Gas selection ───────────────────────────────────────────────
  let gasLimit = recommendation.suggestedGasLimit;
  let maxFeePerGas = recommendation.suggestedMaxFeePerGasWei;
  let maxPriorityFeePerGas = recommendation.suggestedMaxPriorityFeePerGasWei;

  if (payload.gasData?.maxFeePerGas) {
    // OpenSea provided gas — use it as the baseline, but show the recommendation
    gasLimit = payload.gasData.gasLimit || gasLimit;
    maxFeePerGas = payload.gasData.maxFeePerGas;
    maxPriorityFeePerGas = payload.gasData.maxPriorityFeePerGas || BigInt(0);
    console.log(chalk.gray(`  Using OpenSea gas fields as baseline`));
  } else {
    // Prompt the user with the recommendation pre-filled
    console.log(chalk.bold.white(`\n  Gas settings`));
    console.log(chalk.gray(`  Recommended for current conditions:`));
    console.log(chalk.gray(`    max fee:  ${Number(maxFeePerGas) / 1e9} gwei`));
    console.log(chalk.gray(`    priority: ${Number(maxPriorityFeePerGas) / 1e9} gwei`));
    console.log(chalk.gray(`    gas limit: ${gasLimit}`));
    console.log();

    const useRecommended = await askYesNo(`Use recommended gas settings?`, true);
    if (!useRecommended) {
      const gas = await promptGasGwei(chainProfile, rpcUrls);
      maxFeePerGas = gas.maxFeePerGasWei;
      maxPriorityFeePerGas = gas.maxPriorityFeePerGasWei;
      gasLimit = gas.defaultGasLimit || 250_000;
    }
  }

  // Assess the user's choice against the recommendation
  const assessment = gasChoiceAssessment(maxFeePerGas, maxPriorityFeePerGas, recommendation);
  console.log(`\n${assessment.message}\n`);

  // ── Step 11: Timing ──────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(startsAt);

  // ── Step 12: Balances + affordability ────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const provider = new (await import("ethers")).JsonRpcProvider(rpcUrls[0]);
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null)),
  );

  const required = BigInt(gasLimit) * maxFeePerGas + payload.value;

  console.log(chalk.gray(`  Each wallet needs: ${formatEther(required)} ETH (gas reservation + mint value)`));
  const shortCount = wallets.filter(
    (_, i) => balances[i] !== null && (balances[i] as bigint) < required,
  ).length;
  if (shortCount > 0) {
    const shortAddresses = wallets
      .filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required)
      .map((w) => w.address);
    console.log(chalk.yellow(`  ⚠ ${shortCount} wallet(s) underfunded: ${shortAddresses.join(", ")}`));
    if (shortCount === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    console.log(chalk.yellow(`  The remaining wallet(s) can still fire.`));
  }

  // ── Step 13: Confirm ─────────────────────────────────────────────────────
  const didConfirm = await confirmSnipe({
    chainProfile,
    rpcUrls,
    wallets,
    balances,
    nftContract,
    quantity,
    valuePerWallet: payload.value,
    required,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    targetStart,
    timingLabel,
    modeLabel: `Allowlist / FCFS / OVR — ${selectedDrop.name || "selected phase"}`,
    targetLabel: target.label,
    promptForGas: false,
  });
  if (!didConfirm) {
    closePrompts();
    return;
  }

  closePrompts();

  const mintPlan = buildFcfsMintPlan(payload, gasLimit, maxFeePerGas, maxPriorityFeePerGas);

  await executeFcfsSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    targetStart,
    plan: mintPlan,
    openSeaApiKey: apiKey || undefined,
  });
}
