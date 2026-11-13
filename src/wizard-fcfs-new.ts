import chalk from "chalk";
import { Wallet, formatEther } from "ethers";
import { ChainProfile, CHAINS, resolveChain } from "./chains";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { RunLogger } from "./logger";
import {
  fetchAllActiveDrops,
  printDropsInventory,
  reportInventoryEligibility,
  getPhaseEligibility,
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
  DropPhase,
  EligibilityReport,
} from "./fcfs-mint";
import { getValidApiKey } from "./opensea-key";
import { getSessionCookies } from "./opensea-session";
import {
  askText,
  askHidden,
  askYesNo,
  askChoice,
  askNumber,
  closePrompts,
} from "./prompt";
import { planSellAfterMint, runSellAfterMint, type SellPlan } from "./wizard-helpers";
import { parseNftLink } from "./nft-link";
import { resolveContractToSlug } from "./slug-resolver";
import { parseTarget, resolveTarget } from "./target-resolver";
import { parsePriceSpec } from "./price-protection";
import { parseWhen } from "./schedule";
import { loadEnvKeys, selectFromLoaded, promptKeys } from "./wizard";
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
  target: { label: string; slug?: string | null; at?: string | null; whenOpen?: boolean; maxPrice?: string | null },
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

  // The drops endpoint is keyed by collection SLUG, not contract address.
  // Passing only the CA makes GraphQL dropBySlug(CA) return null and REST 404,
  // so discovery came back empty for every address target. Resolve it once here
  // and reuse it for discovery and the signed-payload fetch below.
  let effectiveSlug: string | undefined = target.slug || undefined;
  if (!effectiveSlug) {
    try {
      effectiveSlug = (await resolveContractToSlug(nftContract, apiKey || "")) || undefined;
    } catch {
      effectiveSlug = undefined;
    }
  }
  if (effectiveSlug) {
    console.log(chalk.gray(`  Collection slug: ${effectiveSlug}`));
  }

  // Warm a SIWE session per wallet, in parallel with discovery. Eligibility is
  // wallet-scoped and OpenSea answers it only for a request carrying that wallet's
  // JWT — with no session the report below falls back to the local heuristic and
  // cannot see presale/allowlist status at all. Best-effort: a wallet that fails
  // to log in just reports "unknown" rather than aborting the run.
  const sessionCookiePromise = Promise.all(
    wallets.map(async (w) => {
      try {
        return await getSessionCookies(w);
      } catch {
        return null;
      }
    }),
  );

  const inventory = await fetchAllActiveDrops(nftContract, apiKey, 12000, effectiveSlug, chainKey);
  const sessionCookies = await sessionCookiePromise;
  const primaryCookie = sessionCookies[0] || null;
  if (primaryCookie) {
    console.log(chalk.gray("  SIWE session ready — querying per-wallet eligibility."));
  } else {
    console.log(chalk.gray("  No SIWE session — eligibility falls back to the inventory heuristic."));
  }

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
  // Per-wallet, per-stage: each phase is asked directly and the answer is
  // scoped to that phase's stage uuid. Without a session this falls back to the
  // inventory heuristic, which cannot see allowlist status.
  const eligibility = await reportInventoryEligibility(inventory, ourWallet, {
    slug: effectiveSlug,
    cookie: primaryCookie,
    apiKey,
  });

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

  // Selection + payload fetch, retried when the user asks to switch phases.
  // The previous implementation threw a "[SELECT_DIFFERENT_PHASE]" sentinel that
  // nothing caught, so choosing "switch" crashed the wizard instead of re-opening
  // the prompt.
  let sel: EligibilityReport | null = null;
  let drop0: DropPhase | null = null;
  let pay0: FcfsSignedPayload | null = null;
  // True when the selected phase opens in the future and the user accepted
  // waiting for it. The payload is then fetched at T-0, so every payload-derived
  // display and check below is skipped.
  let futurePhaseAccepted = false;

  for (;;) {
    // ── Step 6: Let the user pick a phase ────────────────────────────────────
    console.log(chalk.bold.white(`\n  ${targetable.length} targetable phase(s) found.`));
    console.log(chalk.gray(`  Enter the number of the phase to target (or press Enter for the first):`));

    for (let i = 0; i < targetable.length; i++) {
      const r = targetable[i];
      const d = r.drop;
      // 0 means "unknown", never 1970-01-01.
      const sMs = d.startTime > 0 ? d.startTime * 1000 : null;
      const eMs = d.endTime > 0 ? d.endTime * 1000 : null;
      const isLive = sMs != null && eMs != null && Date.now() >= sMs && Date.now() < eMs;
      const liveMark = isLive ? chalk.green("LIVE") : chalk.gray("waiting");
      const fmt = (ms: number | null) => (ms != null ? toIST(new Date(ms)) : "unknown");
      console.log(
        chalk.gray(`    [${i + 1}] ${d.name || `phase #${i + 1}`}`)
      );
      console.log(chalk.gray(`        type: ${d.type || "unknown"}`));
      console.log(chalk.gray(`        window: ${fmt(sMs)} → ${fmt(eMs)} ${liveMark}`));
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

    sel = targetable[selectedIndex];
    drop0 = sel.drop;

    // ── Step 7: Fetch the signed payload for the selected phase ──────────────
    // The inventory only tells us a phase EXISTS and is targetable. To actually
    // mint, we need the per-wallet signed payload. Fetch it now.
    //
    // This step is OPTIONAL: if the signed payload can't be fetched (no key,
    // rate-limited, etc.), we show what we know and let the user decide whether
    // to skip this phase and try another, or abort.

    console.log(chalk.bold.white(`\n  Fetching signed mint data for selected phase...`));
    console.log(chalk.gray(`    Phase: ${drop0.name || `phase #${selectedIndex + 1}`}`));
    console.log(chalk.gray(`    Type:  ${drop0.type || "unknown"}`));
    console.log(chalk.gray(`    Drop ID: ${drop0.dropId}`));

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
    // `effectiveSlug` was resolved before discovery (Step 1) and is reused here.
    const primaryWallet = wallets[0].address;

    pay0 = await fetchSignedPayload(
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

    if (!pay0) {
      // ── Future phase: no payload can exist yet ────────────────────────────
      // OpenSea signs a mint only for a stage that is live. A phase that opens
      // later therefore returns null here on every run — this is expected, not
      // an error. Ask whether to wait for it instead of throwing.
      const phaseStartMs =
        drop0.startTime > 0 ? drop0.startTime * 1000 : null;
      const opensInFuture = phaseStartMs != null && phaseStartMs > Date.now();

      if (opensInFuture) {
        console.log(chalk.yellow(`\n  This phase is not open yet.`));
        console.log(
          chalk.gray(
            `    It opens ${toIST(new Date(phaseStartMs!))} — OpenSea will not sign a mint\n` +
              `    for a stage that is not live, so no signed payload exists yet.`
          )
        );
        console.log(
          chalk.gray(
            `    The run can wait and fetch the payload at T-0, then mint.`
          )
        );

        const wait = await askYesNo(`  Wait for this phase and fire when it opens?`, true);
        if (!wait) {
          // Offer another phase, then abort.
          const currentDropId = drop0.dropId;
          const otherTargetable = eligibility.filter(
            (e) => e.recommendation === "target" && e.drop.dropId !== currentDropId,
          );
          if (otherTargetable.length > 0) {
            const tryOther = await askYesNo(`  Switch to another phase?`, false);
            if (tryOther) {
              console.log(chalk.gray(`  Re-selecting phase...\n`));
              continue;
            }
          }
          throw new Error(
            `Not scheduled — phase "${drop0.name || "unnamed"}" opens later and no signed payload exists yet.`,
          );
        }

        // Accepted the wait. Carry the phase through with a null payload and
        // let executeFcfsSnipe fetch at T-0.
        console.log(
          chalk.green(`  ✓ Will wait for the phase and fetch signed payloads at T-0.`)
        );
        // Re-select with the payload marked absent; the timing step below will
        // schedule for the phase's start.
        pay0 = null;
        // Fall through to timing with a flag the snipe reads.
        sel = sel; // keep selection
        drop0 = drop0;
        // Mark via a module-level sentinel consumed below.
        futurePhaseAccepted = true;
      } else {
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
      console.log(chalk.gray(`    name:       ${drop0.name || "unnamed"}`));
      console.log(chalk.gray(`    type:       ${drop0.type || "unknown"}`));
      console.log(chalk.gray(`    drop ID:    ${drop0.dropId}`));
      const fmt0 = (sec: number) => (sec > 0 ? toIST(new Date(sec * 1000)) : "unknown");
      console.log(chalk.gray(`    window:     ${fmt0(drop0.startTime)} → ${fmt0(drop0.endTime)}`));
      console.log(chalk.gray(`    price:      ${formatEther(drop0.mintPrice)} ETH`));
      console.log(chalk.gray(`    per wallet: ${drop0.maxTotalMintableByWallet || "unlimited"}`));
      if (drop0.gasLimit) {
        console.log(chalk.gray(`    OpenSea gas hint: ${drop0.gasLimit} gas limit`));
      }
      if (drop0.allowlistHash) {
        console.log(chalk.gray(`    allowlist hash: ${drop0.allowlistHash.slice(0, 16)}...`));
      }
      console.log();

      // Check if there are other targetable phases we could fall back to
      const currentDropId = drop0.dropId;
      const otherTargetable = eligibility.filter(
        (e) => e.recommendation === "target" && e.drop.dropId !== currentDropId,
      );
      if (otherTargetable.length > 0) {
        console.log(chalk.yellow(`  Other targetable phase(s) are available — want to try one instead?`));
        const tryOther = await askYesNo(`  Switch to another phase?`, false);
        if (tryOther) {
          console.log(chalk.gray(`  Re-selecting phase...\n`));
          // Jump back to the selection prompt (the old sentinel was never caught).
          continue;
        }
      }

      // No other phases to fall back to — throw the original error
      throw new Error(
        `Could not fetch signed mint data for phase "${drop0.name || "unnamed"}". ` +
          `The phase exists but OpenSea didn't return wallet-specific signed data. ` +
          `This may require a live OAuth session, or the phase isn't using OpenSea's signature flow.`,
      );
      }
    }
    break;
  }

  if (!sel || !drop0) {
    throw new Error("No phase selected — aborting.");
  }
  // A future phase legitimately has no payload yet. It is fetched at T-0.
  if (!pay0 && !futurePhaseAccepted) {
    throw new Error("No phase selected — aborting.");
  }
  // Narrow once; the rest of the function uses these names.
  const selected = sel;
  const selectedDrop = drop0;
  const payload = pay0;

  // ── Step 8: Show the fetched drop details ────────────────────────────────
  // With no payload (future phase accepted), fall back to the inventory's drop
  // metadata — it carries the window, price and per-wallet cap, which is all we
  // can know before T-0.
  const drop = payload?.drop ?? selectedDrop;
  // The GQL MintActionTimelineQuery response does not carry the stage window, so
  // openseaMintTxToSignedPayload sets startTime/endTime = 0. Reading those
  // literally yields 1970: promptTiming sees a past date, executeFcfsSnipe
  // computes a negative delay and fires immediately — outside the stage, so the
  // signed tx reverts and costs gas. Fall back to the inventory's window, which
  // came from on-chain/GQL stage metadata.
  const windowStart = drop.startTime || selectedDrop.startTime;
  const windowEnd = drop.endTime || selectedDrop.endTime;
  // 0 means "unknown", never 1970-01-01. A stage whose end is unknown is still
  // treated as open; a stage whose start is unknown is not reported as live.
  const startMs = windowStart > 0 ? windowStart * 1000 : null;
  const endMs = windowEnd > 0 ? windowEnd * 1000 : null;
  const startsAt = startMs != null ? new Date(startMs) : null;
  const endsAt = endMs != null ? new Date(endMs) : null;
  const live = startMs != null && endMs != null && Date.now() >= startMs && Date.now() < endMs;

  if (payload) {
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
  } else {
    console.log(chalk.yellow(`  ⟳ No signed payload yet — the phase is not open.`));
    console.log(chalk.gray(`    NFT:           ${nftContract}`));
    console.log(
      chalk.gray(
        `    Price:         ${formatEther(selectedDrop.mintPrice)} × ${quantity} per wallet (from the phase inventory)`,
      ),
    );
    console.log(chalk.gray(`    Max per wallet: ${selectedDrop.maxTotalMintableByWallet || "unlimited"}`));
    console.log(chalk.gray(`    Calldata:      fetched at T-0, per wallet`));
  }
  const fmtWhen = (d: Date | null) => (d ? toIST(d) : "unknown");
  const nowMs = Date.now();
  const timingNote = live
    ? chalk.green("(live)")
    : startMs != null && nowMs < startMs
      ? chalk.yellow(`(opens in ${formatRemaining(startMs - nowMs)})`)
      : endMs == null
        ? chalk.yellow("(open — end time unknown)")
        : chalk.gray("(not yet open)");
  console.log(chalk.gray(`    Window:        ${fmtWhen(startsAt)} → ${fmtWhen(endsAt)} ${timingNote}`));

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    throw new Error(
      `Requested quantity ${quantity} exceeds the per-wallet cap of ${drop.maxTotalMintableByWallet} for this phase. Reduce quantity.`
    );
  }
  if (endMs != null && Date.now() >= endMs) {
    console.log(chalk.yellow(`  ⚠ This stage has already ended on-chain.`));
  }

  // ── Step 9: Gas recommendation ───────────────────────────────────────────
  // Combine OpenSea-provided gas hints with live gas state for a recommendation
  const openSeaGas = drop0.gasLimit
    ? {
        gasLimit: drop0.gasLimit,
        maxFeePerGas: selectedDrop.maxFeePerGas,
        maxPriorityFeePerGas: selectedDrop.maxPriorityFeePerGas,
      }
    : null;

  const recommendation = recommendGasSettings(gasState, openSeaGas, payload?.gasData?.gasLimit || 250_000);
  printGasRecommendation(recommendation, chainProfile.name);

  // ── Step 10: Gas selection ───────────────────────────────────────────────
  let gasLimit = recommendation.suggestedGasLimit;
  let maxFeePerGas = recommendation.suggestedMaxFeePerGasWei;
  let maxPriorityFeePerGas = recommendation.suggestedMaxPriorityFeePerGasWei;

  if (payload?.gasData?.maxFeePerGas) {
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
  // --at / --when-open were previously accepted by the CLI and silently ignored
  // here: timing always came from promptTiming, so `npm start -- --fcfs X --at
  // "in 5m"` minted immediately. Honour them.
  let targetStart: Date;
  let timingLabel: string;
  if (target.at) {
    const unix = parseWhen(target.at);
    targetStart = new Date(unix * 1000);
    timingLabel = `--at ${target.at}`;
    console.log(chalk.gray(`  Scheduled for ${toIST(targetStart)} (${timingLabel})`));
  } else if (target.whenOpen) {
    // An unknown opening time means "fire now" — the stage may already be open.
    targetStart = startsAt ?? new Date();
    timingLabel = "when-open";
    console.log(
      chalk.gray(
        `  Will fire at the stage opening (${startsAt ? toIST(startsAt) : "unknown — firing immediately"}).`
      )
    );
  } else {
    // promptTiming accepts null and returns a null targetStart when the opening
    // time is unknown; fall back to the inventory's window, then to now.
    const prompted = await promptTiming(startsAt);
    if (!prompted.targetStart && startsAt) {
      // The user declined to wait for this phase. Abort rather than falling
      // back to the stage's start time, which would schedule a mint they just
      // said they did not want.
      console.log(chalk.yellow("\n  Not scheduled — nothing was sent.\n"));
      closePrompts();
      return;
    }
    targetStart = prompted.targetStart ?? startsAt ?? new Date();
    timingLabel = prompted.timingLabel;
  }

  // ── Step 12: Balances + affordability ────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const provider = new (await import("ethers")).JsonRpcProvider(rpcUrls[0]);
  let balances: (bigint | null)[];
  try {
    balances = await Promise.all(
      wallets.map((w) => provider.getBalance(w.address).catch(() => null)),
    );
  } finally {
    // ethers keeps a polling timer alive on every provider; without an explicit
    // destroy the wizard finishes its work but the process never exits.
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }

  // Without a payload the mint value is unknown until T-0; quote the phase's
  // inventory price instead so the affordability check still means something.
  const mintValue = payload ? payload.value : BigInt(selectedDrop.mintPrice) * BigInt(quantity);
  const required = BigInt(gasLimit) * maxFeePerGas + mintValue;

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
    valuePerWallet: mintValue,
    required,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    targetStart,
    timingLabel,
    // promptTiming already asked "Fire when the stage opens?" for a future
    // stage, so the READY screen must not ask "Fire?" a second time.
    timingDecided: startsAt != null,
    modeLabel: `Allowlist / FCFS / OVR — ${drop0.name || "selected phase"}`,
    targetLabel: target.label,
    promptForGas: false,
  });
  if (!didConfirm) {
    closePrompts();
    return;
  }

  closePrompts();

  // ── Step 13b: Sell-after-mint scheduling ────────────────────────────────
  // Before the mint, on purpose: an offer book read now is stale by T-0, so
  // only the gas cost is quoted. Offers are read after the mint, per wallet.
  let sellPlan: SellPlan | null = null;
  if (effectiveSlug && apiKey) {
    sellPlan = await planSellAfterMint({
      chainKey,
      apiKey,
      symbol: chainProfile.nativeSymbol,
      mintQuantity: quantity,
      valuePerWallet: mintValue,
      rpcUrl: rpcUrls[0],
    });
  } else {
    console.log(
      chalk.gray(
        effectiveSlug
          ? "\n  (no OpenSea API key — sell-after-mint is unavailable)"
          : "\n  (no collection slug — sell-after-mint is unavailable)"
      )
    );
  }

  // Without a payload (future phase) there is no structural template to build —
  // the plan is derived per wallet at T-0. Pass null and let the snipe skip it.
  const mintPlan = payload
    ? buildFcfsMintPlan(payload, gasLimit, maxFeePerGas, maxPriorityFeePerGas, quantity)
    : null;

  // ── Price protection ────────────────────────────────────────────────────
  // Without this a drop that raised its price between planning and firing is
  // minted at the new price with no warning.
  let maxPriceWei: bigint | null = null;
  if (target.maxPrice) {
    const spec = parsePriceSpec(target.maxPrice, quantity);
    if (spec) {
      maxPriceWei = spec.isUnlimited ? null : spec.maxPriceWei;
      console.log(chalk.gray(`  Price protection: ${spec.display}`));
    }
  }

  // Pre-fetch a per-wallet payload for every wallet while the drop is still
  // future, so the T-0 path makes no API calls. Falls back to a live fetch at
  // T-0 for any wallet that returns null here.
  //
  // Skipped entirely for a future phase: OpenSea will not sign for a stage that
  // is not live, so every fetch would return null and waste a round trip per
  // wallet. executeFcfsSnipe fetches at T-0 instead.
  console.log(chalk.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
  const preFetched: (FcfsSignedPayload | null)[] = [];
  if (futurePhaseAccepted) {
    for (let i = 0; i < walletKeys.length; i++) {
      preFetched.push(null);
    }
    console.log(
      chalk.gray(`    Skipped — the phase is not open. Payloads are fetched at T-0.`)
    );
  } else {
    // Parallel, not sequential. Each fetch is an independent network round trip,
    // and the whole point of the pre-fetch is to have payloads in hand well
    // before T-0 — a serial loop costs N round trips, so 8 wallets at ~1s each
    // is 8 seconds of avoidable delay before the timer even starts.
    //
    // This mirrors wizard.ts's pre-fetch exactly. It had been a plain for-loop
    // here while the wizard was already parallel, so the same operation behaved
    // two different ways depending on which branch ran it.
    //
    // Each fetch is independently guarded so one failure cannot reject the
    // batch (Promise.all would reject on the first throw).
    const fetched = await Promise.all(
      walletKeys.map(async (key) => {
        const w = new Wallet(key);
        try {
          const p = await fetchSignedPayloadForWallet(
            nftContract,
            quantity,
            w.address,
            apiKey || undefined,
            // slug + chainKey are REQUIRED: fetchSignedPayload gates both its GraphQL
            // and REST branches on them. Omitting them here made the pre-fetch fall
            // through to the on-chain branch, which only ever returns PUBLIC drops —
            // so the pre-fetch could never populate a signed/allowlist payload.
            { timeoutMs: 15000, slug: effectiveSlug, chainKey },
          );
          if (!p) console.log(chalk.yellow(`    ${w.address} — no payload (will retry at T-0)`));
          return p;
        } catch (err: any) {
          console.log(chalk.yellow(`    ${w.address} — pre-fetch failed: ${err.message}`));
          return null;
        }
      })
    );
    preFetched.push(...fetched);
  }

  const snipeResults = await executeFcfsSnipe({
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
    // The snipe re-fetches a payload per wallet when a pre-fetch came back null.
    // Without slug/chainKey that fetch cannot reach the GraphQL or REST branch
    // and silently falls back to on-chain discovery.
    slug: effectiveSlug,
    chainKey,
    maxPriceWei,
    // The eligibility report quoted a per-wallet price for the selected phase.
    // Threading it in lets the snipe refuse a risen price before fetching a
    // payload, rather than only comparing the payload's own value.
    quotedPriceWei: selected.priceWei ?? null,
    // A future phase has no payload yet — phase 1 must not fetch one, phase 2
    // fetches at T-0.
    phaseOpensInFuture: futurePhaseAccepted,
    // Re-read the per-wallet cap at T-0. The signed calldata binds the quantity,
    // so a cap that dropped while waiting means every payload fetched so far is
    // for the wrong quantity and must be re-fetched rather than broadcast.
    recheckMintable: async (walletAddress: string) => {
      const report = await getPhaseEligibility({
        drop: selectedDrop,
        wallet: walletAddress.toLowerCase(),
        slug: effectiveSlug,
        cookie: sessionCookies[0] || null,
        apiKey,
        timeoutMs: 8000,
      });
      return report?.walletMintable ?? null;
    },
  });

  // ── Step 14: Sell after mint ─────────────────────────────────────────────
  // One wallet at a time, in wallet order; a failed mint sells nothing.
  if (sellPlan) {
    await runSellAfterMint({
      sellPlan,
      walletKeys,
      contract: nftContract,
      slug: effectiveSlug!,
      chainKey,
      apiKey: apiKey!,
      rpcUrl: rpcUrls[0],
      chainId: chainProfile.chainId,
      symbol: chainProfile.nativeSymbol,
      mintOutcomes: snipeResults.map((r) => ({
        walletIndex: r.walletIndex,
        address: r.walletAddress,
        txHash: r.txHash ?? null,
        status:
          // Prefer the confirmed tri-state from the snipe; fall back to the
          // old derivation for results built before the receipt stage.
          r.status ??
          (r.receipt?.status === "REVERTED"
            ? "REVERTED"
            : r.success
              ? "SUCCESS"
              : "FAILED"),
      })),
    });
  }
}


// ── CLI entry: eligibility + gas check, no mint ──────────────────────────────
// Polls all phases for a contract, shows eligibility + gas state, exits.

export async function runEligibilityCheck(
  log: RunLogger,
  nftContract: string,
  opts: { chain?: string | null } = {},
): Promise<void> {
  const { resolveChain } = require("./chains");
  const { fetchAllActiveDrops, reportInventoryEligibility, printDropsInventory, fetchGasState, printGasState } = require("./fcfs-drops");
  const { parseNftLink } = require("./nft-link");
  const chalk = require("chalk");

  // --chain wins over CHAIN. There is no interactive prompt on this path, so a
  // missing value must be an ERROR, not a silent guess: defaulting to "base"
  // meant `--eligibility <slug>` with no chain and no CHAIN env polled Base
  // while the user's collection was almost certainly elsewhere.
  const chainKey = (opts.chain || process.env.CHAIN || "").trim().toLowerCase();
  if (!chainKey) {
    throw new Error(
      "No chain given. Pass --chain <key> or set CHAIN in .env " +
        `(supported: ${require("./chains").CHAINS.map((c: any) => c.key).join(", ")}).`
    );
  }
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

  // Resolve the key through the same pool every other path uses. Reading
  // process.env here meant --eligibility could see a different key than --fcfs.
  const keyResult = await getValidApiKey({ timeoutMs: 8000 });
  const apiKey = keyResult?.api_key || undefined;

  // The drops endpoint is keyed by collection SLUG. Given a contract address,
  // GraphQL dropBySlug(CA) returns null and REST 404s, so this check reported
  // "no active phases" for contracts that do have a live drop. Resolve it first.
  let slug: string | undefined;
  if (/^0x/i.test(lookupTarget)) {
    try {
      slug = (await resolveContractToSlug(lookupTarget, apiKey || "")) || undefined;
    } catch {
      slug = undefined;
    }
    if (slug) console.log(chalk.gray(`  Collection slug: ${slug}`));
  } else {
    slug = lookupTarget;
  }

  const inventory = await fetchAllActiveDrops(lookupTarget, apiKey, 12000, slug, chainKey);

  if (inventory.drops.length === 0) {
    console.log(chalk.yellow(`\n  ⚠ No active phases found for ${lookupTarget}.`));
    console.log(chalk.gray(`  Try: get an OpenSea API key, or check the collection page manually.\n`));
    return;
  }

  // Eligibility is per-wallet. This command used to assess a hardcoded
  // zero-address placeholder and print it as "Wallet: 0x000…000", so it could
  // never answer the only question it exists to answer — and because
  // assessDropEligibility ignored its wallet argument, the placeholder changed
  // nothing. Load real keys and report one block per wallet.
  let envKeys = loadEnvKeys();
  // `--eligibility` is headless, so anyone who keeps their keys out of the
  // environment — the normal way, pasting them at a prompt — got "No wallets
  // loaded" and every phase read as unknown, which looks like a broken checker.
  // Prompt when there is a terminal to answer on. A non-TTY still falls through
  // to the inventory-only report rather than hanging on an answer that can
  // never come.
  if (envKeys.length === 0 && process.stdin.isTTY) {
    const pasted = await promptKeys(log, null);
    envKeys = pasted.map((pk) => ({ address: new Wallet(pk).address, privateKey: pk }));
  }
  const allReports: any[] = [];

  // Eligibility is wallet-scoped, and OpenSea answers it only for a request
  // carrying that wallet's JWT. Warm one SIWE session per wallet (best-effort)
  // so this check can actually ask — otherwise every phase falls back to the
  // inventory heuristic, which cannot see allowlist status.
  const { getSessionCookies: warmSession } = require("./opensea-session");
  const cookieByWallet = new Map<string, string | null>();
  await Promise.all(
    envKeys.map(async (w) => {
      try {
        const wallet = new Wallet(w.privateKey);
        cookieByWallet.set(w.address.toLowerCase(), await warmSession(wallet));
      } catch {
        cookieByWallet.set(w.address.toLowerCase(), null);
      }
    }),
  );

  if (envKeys.length === 0) {
    console.log(chalk.yellow("\n  ⚠ No wallets loaded — per-wallet eligibility cannot be determined."));
    console.log(chalk.gray("  Set PRIVATE_KEY, PRIVATE_KEYS, or WALLETS_FILE, then re-run."));
    console.log(chalk.gray("  Showing the phase inventory with eligibility marked unknown.\n"));
    const reports = await reportInventoryEligibility(inventory, "", { slug, apiKey });
    printDropsInventory(inventory, reports, "(no wallet)", chainProfile.name);
    allReports.push(...reports);
  } else {
    for (const w of envKeys) {
      console.log(chalk.bold.white(`\n  ── Wallet ${w.address} ──`));
      const cookie = cookieByWallet.get(w.address.toLowerCase()) || null;
      const reports = await reportInventoryEligibility(inventory, w.address, { slug, cookie, apiKey });
      printDropsInventory(inventory, reports, w.address, chainProfile.name);
      allReports.push(...reports);
    }
  }

  console.log(chalk.gray(`\n  Polling gas state on ${chainProfile.name}...`));
  const gasState = await fetchGasState(rpcUrls, chainProfile.chainId, 5000);
  printGasState(gasState, chainProfile.name);

  const targetable = allReports.filter((e) => e.recommendation === "target");
  console.log(chalk.bold.white(`\n  Summary: ${inventory.drops.length} phase(s), ${targetable.length} targetable.`));
  if (targetable.length === 0) {
    console.log(chalk.yellow(`  ⚠ No targetable phases — nothing to mint right now.\n`));
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
  // --chain wins over CHAIN. No interactive prompt on this path, so a missing
  // value is an ERROR rather than a silent guess — defaulting to "base" meant
  // `--fcfs <target>` with no chain and no CHAIN env minted on the wrong chain.
  const chainKey = (opts.chain || process.env.CHAIN || "").trim().toLowerCase();
  if (!chainKey) {
    throw new Error(
      "No chain given. Pass --chain <key> or set CHAIN in .env " +
        `(supported: ${CHAINS.map((c) => c.key).join(", ")}).`
    );
  }
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

  // ── Chain mismatch ──────────────────────────────────────────────────────
  // chainProfile comes from --chain/CHAIN and supplies the RPCs and gas; the
  // resolved target may name a different chain (a chain-bearing link, or a slug
  // that lives on another network). Blasting at the chain whose RPCs we have
  // while the drop lives elsewhere is a guaranteed failure, so switch to the
  // target's chain and re-resolve its endpoints.
  let effectiveProfile = chainProfile;
  let effectiveRpcs = rpcUrls;
  if (targetChainKey !== chainKey) {
    const alt = resolveChain(targetChainKey);
    if (!alt) {
      throw new Error(`Target "${targetArg}" is on unknown chain "${targetChainKey}".`);
    }
    const altEnv = (process.env[`RPC_URL_${alt.key.toUpperCase()}`] || "").split(",").filter(Boolean);
    const { urls: altCandidates } = await resolveRpcsForChain(alt.key, altEnv);
    const altPlan = await planRpcs(altCandidates, alt.chainId);
    if (altPlan.urls.length === 0) {
      throw new Error(
        `Target "${targetArg}" is on ${alt.name}, but no RPC endpoints are configured for it. ` +
          `Set RPC_URL_${alt.key.toUpperCase()} or pass --chain ${alt.key}.`,
      );
    }
    console.log(
      chalk.yellow(
        `\n  ⚠ Target resolves to ${alt.name} (chain ${alt.chainId}), not ${chainProfile.name}. ` +
          `Switching chains and re-resolving endpoints.`,
      ),
    );
    effectiveProfile = alt;
    effectiveRpcs = altPlan.urls;
  }

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
  log.field("rpc_urls", effectiveRpcs.length);
  log.field("rpc_source", envRpcs.length > 0 ? "env" : "public");
  log.field("effective_chain", effectiveProfile.key);
  if (opts.at) log.field("scheduled_at", String(parseWhen(opts.at)));
  if (opts.maxPrice) log.field("max_price", opts.maxPrice);
  log.info("FCFS CLI: keys loaded, calling runFcfsBranch");

  await runFcfsBranch(log, keys, effectiveProfile, targetChainKey, nftContract, quantity, effectiveRpcs, {
    label: targetLabel,
    slug: resolvedTarget.slug,
    at: opts.at,
    whenOpen: opts.whenOpen,
    maxPrice: opts.maxPrice,
  });
}
