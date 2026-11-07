import chalk from "chalk";
import { Wallet, formatEther } from "ethers";
import { ChainProfile, resolveChain } from "./chains";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { RunLogger } from "./logger";
import {
  fetchAllActiveDrops,
  printDropsInventory,
  reportInventoryEligibility,
  fetchGasState,
  printGasState,
  recommendGasSettings,
  printGasRecommendation,
  gasChoiceAssessment,
} from "./fcfs-drops";
import {
  fetchOnChainDrops,
  fetchSingleOnChainDrop,
} from "./seadrop-onchain";
import {
  fetchSignedPayload,
  fetchSignedPayloadForWallet,
  classifyMintMode,
  buildFcfsMintPlan,
  executeFcfsSnipe,
  FcfsSignedPayload,
} from "./fcfs-mint";
import { getValidApiKey } from "./opensea-key";
import {
  askText,
  askHidden,
  askYesNo,
  closePrompts,
} from "./prompt";
import { parseNftLink } from "./nft-link";
import { resolveContractToSlug } from "./slug-resolver";
import { parseTarget, resolveTarget } from "./target-resolver";
import { parseWhen } from "./schedule";
import { loadEnvKeys, selectFromLoaded } from "./wizard";
import {
  promptGasGwei,
  promptTiming,
  confirmSnipe,
} from "./wizard-helpers";
import { formatRemaining, toIST } from "./time-format";

// ── Main FCFS branch entry ──────────────────────────────────────────────────

export async function runFcfsBranch(
  log: RunLogger,
  walletKeys: string[],
  chainProfile: ChainProfile,
  chainKey: string,
  nftContract: string,
  quantity: number,
  rpcUrls: string[],
  target: { label: string; at?: string | null; whenOpen?: boolean; maxPrice?: string | null },
): Promise<void> {
  log.info("FCFS branch: started");
  log.field("nftContract", nftContract);
  log.field("chain", chainKey);
  log.field("chainProfile", chainProfile.name);
  log.field("quantity", quantity);
  log.field("wallet_count", walletKeys.length);
  log.field("rpc_count", rpcUrls.length);
  log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));

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

    // When OpenSea REST/GraphQL drops aren't available, fall through to the
    // on-chain SEADROP check. Some collections (like de-bots) register their
    // phases on-chain rather than through OpenSea's drops API.
    console.log(chalk.gray(`    OpenSea REST drops 404'd — trying on-chain SEADROP fallback...`));

    const onChainDrops = await fetchOnChainDrops(nftContract, 12000, chainKey);
    if (onChainDrops.length > 0) {
      console.log(chalk.green(`  ✓ Found ${onChainDrops.length} on-chain phase(s).`));
      // Create a synthetic inventory from on-chain data
      inventory.drops = onChainDrops;
      inventory.fetchedAt = Date.now();
      inventory.apiKeyUsed = false;
    } else {
      console.log(chalk.yellow(`\n  ⚠ No on-chain phases found either.`));

      if (!apiKey) {
        console.log(chalk.yellow(`  Try: get an OpenSea free API key and re-run.`));

        // For collections like de-bots that use signed minting, also check
        // the on-chain singleton directly for this specific contract
        console.log(chalk.gray(`    Also checking single-contract on-chain drop...`));
        const singleDrop = await fetchSingleOnChainDrop(nftContract, 8000, chainKey);
        if (singleDrop) {
          console.log(chalk.green(`  ✓ Found on-chain drop for this contract.`));
          inventory.drops = [singleDrop];
          inventory.fetchedAt = Date.now();
          inventory.apiKeyUsed = false;
        }
      }

      if (inventory.drops.length === 0) {
        console.log(chalk.gray(`    The collection may not have any OpenSea-managed phases,`));
        console.log(chalk.gray(`    or the API key doesn't have access to them.`));
        console.log(chalk.gray(`    Try the public mint path, or check the collection page manually.\n`));

        // Don't throw — fall through to let the user proceed to public mint
        // or other paths. The FCFS wizard is one option; public mint is another.
        console.log(chalk.yellow(`  ⚠ No targetable phases. Falling through to public mint path...\n`));
        return; // exit the wizard function gracefully
      }
    }
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
        `All ${eligibility.length} phase(s) either are skipped (${skip.length}) or need manual investigation.`,
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
  //
  // This step is OPTIONAL: if the signed payload can't be fetched (no key,
  // rate-limited, etc.), we show what we know and let the user decide whether
  // to skip this phase and try another, or abort.

  console.log(chalk.bold.white(`\n  Fetching signed mint data for selected phase...`));
  console.log(chalk.gray(`    Phase: ${selectedDrop.name || `phase #${selectedIndex + 1}`}`));
  console.log(chalk.gray(`    Type:  ${selectedDrop.type || "unknown"}`));
  console.log(chalk.gray(`    Drop ID: ${selectedDrop.dropId}`));

  // The inventory may have told us the mintData/mintSignature exist, but the
  // actual fetchSignedPayload call is what gets the wallet-specific
  // signature. The inventory's mintData is the generic template; the real call
  // needs to go through OpenSea's mintSigned flow.

  // Try with the key first.
  // Both slug and walletAddress are REQUIRED: fetchSignedPayload's GraphQL and
  // REST branches are gated on `slug && walletAddress`, so omitting them makes
  // both unreachable and the function falls through to the on-chain branch,
  // which only ever returns PUBLIC drops. A signed/allowlist phase therefore
  // returned null on every run — the FCFS wizard could never obtain a payload.
  // The slug is resolved from the contract when we don't already have one.
  // runFcfsBranch does not receive a slug — only a contract address — so the
  // slug must be resolved here. Without it fetchSignedPayload's GraphQL and
  // REST branches are both unreachable.
  let effectiveSlug: string | undefined;
  try {
    effectiveSlug = (await resolveContractToSlug(nftContract, apiKey || "")) || undefined;
    if (effectiveSlug) {
      console.log(chalk.gray(`    Resolved slug: ${effectiveSlug}`));
    }
  } catch {
    effectiveSlug = undefined;
  }

  const primaryWallet = wallets[0].address;

  const payload = await fetchSignedPayload(
    nftContract,
    quantity,
    apiKey || undefined,
    {
      timeoutMs: 12000,
      walletAddress: primaryWallet,
      slug: effectiveSlug,
      chainKey,
    },
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

    // ── Optional: allow the user to skip this phase and try the next one ─────
    // Instead of throwing, offer to pick a different phase. This is important
    // for allowlist/OVR phases where the signed payload may not be available
    // without a valid key, but public mint phases might still be fireable.
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

    // Check if there are other targetable phases we could fall back to
    const otherTargetable = eligibility.filter(
      (e) => e.recommendation === "target" && e.drop.dropId !== selectedDrop.dropId,
    );
    if (otherTargetable.length > 0) {
      console.log(chalk.yellow(`  Other targetable phase(s) are available — want to try one instead?`));
      const tryOther = await askYesNo(`  Switch to another phase?`, false);
      if (tryOther) {
        // Re-open the phase selection (jump back to Step 6 logic)
        console.log(chalk.gray(`  Re-selecting phase...\n`));
        // Recursively call the selection logic by throwing a special sentinel
        throw new Error("[SELECT_DIFFERENT_PHASE]");
      }
    }

    // No other phases to fall back to — throw the original error
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
    throw new Error(
      `Requested quantity ${quantity} exceeds the per-wallet cap of ${drop.maxTotalMintableByWallet} for this phase. Reduce quantity.`
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

  const mintPlan = buildFcfsMintPlan(payload, gasLimit, maxFeePerGas, maxPriorityFeePerGas, quantity);

  // Pre-fetch a per-wallet payload for every wallet while the drop is still
  // future, so the T-0 path makes no API calls. Falls back to a live fetch at
  // T-0 for any wallet that returns null here.
  console.log(chalk.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
  const preFetched: (FcfsSignedPayload | null)[] = [];
  for (let i = 0; i < walletKeys.length; i++) {
    const w = new Wallet(walletKeys[i]);
    try {
      const p = await fetchSignedPayloadForWallet(
        nftContract,
        quantity,
        w.address,
        apiKey || undefined,
        { timeoutMs: 15000 },
      );
      preFetched.push(p);
      if (!p) console.log(chalk.yellow(`    ${w.address} — no payload (will retry at T-0)`));
    } catch (err: any) {
      console.log(chalk.yellow(`    ${w.address} — pre-fetch failed: ${err.message}`));
      preFetched.push(null);
    }
  }

  await executeFcfsSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    targetStart: targetStart || startsAt,
    plan: mintPlan,
    payloads: preFetched,
  });
}


// ── CLI entry: eligibility + gas check, no mint ──────────────────────────────
// Polls all phases for a contract, shows eligibility + gas state, exits.

export async function runEligibilityCheck(_log: RunLogger, nftContract: string): Promise<void> {
  const { resolveChain } = require("./chains");
  const { fetchAllActiveDrops, reportInventoryEligibility, printDropsInventory, fetchGasState, printGasState } = require("./fcfs-drops");
  const { parseNftLink } = require("./nft-link");
  const chalk = require("chalk");

  const chainKey = (process.env.CHAIN || "base").toLowerCase();
  const chainProfile = resolveChain(chainKey);
  if (!chainProfile) throw new Error(`Unknown chain "${chainKey}"`);

  const envRpcs = (process.env[`RPC_URL_${chainKey.toUpperCase()}`] || "").split(",").filter(Boolean);
  const { urls: candidateRpcs } = await require("./rpc-resolver").resolveRpcsForChain(chainKey, envRpcs);
  // rpcUrls[0] is used as the read provider below, so it must be an endpoint
  // that answers eth_call. planRpcs drops wrong-chain endpoints and puts a
  // verified query-capable one first; without it a send-only sequencer can
  // land at index 0 and every read fails.
  const plan = await require("./rpc-resolver").planRpcs(candidateRpcs, chainProfile.chainId);
  const rpcUrls = plan.urls;
  if (rpcUrls.length === 0) throw new Error(`No usable RPC endpoints for ${chainProfile.name}`);

  const parsed = parseNftLink(nftContract);
  const lookupTarget = parsed.value;

  console.log(chalk.bold.white(`\nEligibility check for ${lookupTarget}`));
  console.log(chalk.gray(`  Chain: ${chainProfile.name} | RPC: ${rpcUrls.length} endpoint(s)`));

  const apiKey = process.env.OPENSEA_API_KEY || undefined;
  const inventory = await fetchAllActiveDrops(lookupTarget, apiKey, 12000);

  if (inventory.drops.length === 0) {
    console.log(chalk.yellow(`\n  ⚠ No active phases found for ${lookupTarget}.`));
    console.log(chalk.gray(`  Try: get an OpenSea API key, or check the collection page manually.\n`));
    return;
  }

  const ourWallet = "0x".padEnd(42, "0"); // placeholder — real wallet would be prompted
  const eligibility = reportInventoryEligibility(inventory, ourWallet);
  console.log(chalk.gray(`  Wallet: placeholder (pass keys for real check)`));
  printDropsInventory(inventory, eligibility, ourWallet, chainProfile.name);

  console.log(chalk.gray(`\n  Polling gas state on ${chainProfile.name}...`));
  const gasState = await fetchGasState(rpcUrls, chainProfile.chainId, 5000);
  printGasState(gasState, chainProfile.name);

  const targetable = eligibility.filter((e: any) => e.recommendation === "target");
  console.log(chalk.bold.white(`\n  Summary: ${inventory.drops.length} phase(s), ${targetable.length} targetable.`));
  if (targetable.length === 0) {
    console.log(chalk.yellow(`  ⚠ No targetable phases — nothing to mint right now.\\n`));
  }
}

// ── CLI entry: 1-arg wrapper for `index.ts --fcfs <slug|ca>` ────────────────
// Resolves chain + RPC from env, prompts for wallet keys, then calls the
// 7-arg runFcfsBranch executor defined above.

export interface FcfsCliOptions {
  at?: string | null;
  whenOpen?: boolean;
  maxPrice?: string | null;
  wallets?: string | null;
  chain?: string | null;
  quantity?: number | null;
}

export async function runFcfsBranchCli(
  log: RunLogger,
  targetArg: string,
  opts: FcfsCliOptions = {}
): Promise<void> {
  const chainKey = (opts.chain || process.env.CHAIN || "base").toLowerCase();
  const chainProfile = resolveChain(chainKey);
  if (!chainProfile) throw new Error(`Unknown chain "${chainKey}"`);

  const envRpcs = (process.env[`RPC_URL_${chainKey.toUpperCase()}`] || "").split(",").filter(Boolean);
  const { urls: candidateRpcs } = await resolveRpcsForChain(chainKey, envRpcs);
  // rpcUrls[0] is used as the read provider for balances/eth_call, so it must be
  // an endpoint that answers those. planRpcs drops wrong-chain endpoints and
  // puts a verified query-capable one first — without it a send-only sequencer
  // can land at index 0 and every read fails. runEligibilityCheck already does
  // this; the CLI path did not, which is how a mis-ordered endpoint survived.
  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);
  const rpcUrls = plan.urls;
  if (rpcUrls.length === 0) throw new Error(`No usable RPC endpoints for ${chainProfile.name}`);

  // Parse the target with the unified resolver so Scatter/Zora/direct addresses
  // work here too, not just OpenSea links.
  const parsed = parseTarget(targetArg);
  const resolvedTarget = await resolveTarget(parsed, process.env.OPENSEA_API_KEY || "", chainKey);
  if (!resolvedTarget) {
    throw new Error(
      parsed.platform === "manifold"
        ? `Manifold claim "${parsed.claimId}" cannot be resolved automatically — paste the 0x… claim contract instead.`
        : `Could not resolve "${targetArg}".`
    );
  }
  const nftContract = resolvedTarget.contract;
  const targetLabel = resolvedTarget.slug ?? resolvedTarget.contract;
  const targetChainKey = resolvedTarget.chainKey;
  const quantity = opts.quantity ?? 1;

  // ── Wallets ──────────────────────────────────────────────────────────────
  // A --wallets spec with keys in the environment means the run is headless.
  // Load them rather than prompting, which would hang forever.
  const envKeys = loadEnvKeys();
  let keys: string[] = [];
  if (envKeys.length > 0 && (opts.wallets || !process.stdin.isTTY)) {
    const selected = opts.wallets ? selectFromLoaded(envKeys, opts.wallets) : envKeys;
    keys = selected.map((w) => w.privateKey);
    console.log(chalk.bold.white("\nPrivate keys"));
    console.log(chalk.gray(`  ${keys.length} wallet(s) from environment${opts.wallets ? ` (${opts.wallets})` : ""}.`));
    for (const w of selected) console.log(chalk.green(`  ✓ ${w.address}`));
  } else {
    console.log(chalk.bold.white("\nPrivate keys"));
    console.log(chalk.gray("  Paste one key per line — typing is hidden. Blank line when done."));
    log.info("FCFS CLI: prompting for wallet keys");
    const seen = new Set<string>();
    for (;;) {
      const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
      if (!raw) {
        if (keys.length === 0) { console.log(chalk.red("  ✗ Need at least one key.")); continue; }
        break;
      }
      const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
      let wallet: Wallet;
      try { wallet = new Wallet(normalized); } catch { console.log(chalk.red("  ✗ Not a valid private key — try again.")); continue; }
      if (seen.has(wallet.address.toLowerCase())) { console.log(chalk.yellow(`  ⚠ Duplicate of ${wallet.address.slice(0,6)}…${wallet.address.slice(-4)} — skipped.`)); continue; }
      seen.add(wallet.address.toLowerCase());
      keys.push(normalized);
      console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
    }
  }
  if (keys.length === 0) throw new Error("No wallet keys provided.");
  console.log(chalk.gray(`  ${keys.length} wallet(s) loaded.\n`));
  log.field("wallet_count", keys.length);
  log.field("rpc_urls", rpcUrls.length);
  log.field("rpc_source", envRpcs.length > 0 ? "env" : "public");
  if (opts.at) log.field("scheduled_at", String(parseWhen(opts.at)));
  if (opts.maxPrice) log.field("max_price", opts.maxPrice);
  log.info("FCFS CLI: keys loaded, calling runFcfsBranch");

  await runFcfsBranch(log, keys, chainProfile, targetChainKey, nftContract, quantity, rpcUrls, {
    label: targetLabel,
    at: opts.at,
    whenOpen: opts.whenOpen,
    maxPrice: opts.maxPrice,
  });
}
