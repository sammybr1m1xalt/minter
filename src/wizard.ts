// Interactive universal mint wizard — handles ALL mint types from one entry:
// allowlisted phases (signed payload), public phases (on-chain), OVR, token-gated.
//
// Flow:
//   1. Load wallet keys
//   2. Resolve NFT target (OpenSea link / slug / contract address)
//   3. Warm SIWE sessions for ALL loaded wallets in parallel
//   4. Discover ALL phases (OpenSea REST/GraphQL + on-chain SeaDrop fallback)
//   5. Probe eligibility for EACH wallet against EACH phase
//   6. Report a per-wallet × per-phase eligibility matrix
//   7. Prompt user: pick which wallet + which phase to use (or auto-select)
//   8. Route to public (on-chain) or signed (OpenSea) mint execution
//
// Nothing is written to disk: pasted keys live in memory for the run only.

import chalk from "chalk";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load .env so process.env has RPC_URL_*, OPENSEA_API_KEY, etc.
// Must happen before any imported module reads process.env.
// Resolve relative to THIS file's directory (dist/), not CWD — user may run
// `minter` from anywhere and the .env lives next to the project.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { RunLogger } from "./logger";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { CHAINS, ChainProfile, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug, resolveContractToSlug, isSlug } from "./slug-resolver";
import {
  isBenignProbeError,
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import {
  DropPhase,
  CollectionDropsInventory,
  fetchAllActiveDrops,
  assessDropEligibility,
  getPhaseEligibility,
  sortByStartTime,
} from "./fcfs-drops";
import {
  fetchOnChainDrops,
  fetchSingleOnChainDrop,
} from "./seadrop-onchain";
import { buildLocalMintPlan } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";
import {
  promptGasGwei,
  promptTiming,
  confirmSnipe,
  displayBalances,
  planSellAfterMint,
  runSellAfterMint,
  SellPlan,
  SnipeReadyInput,
} from "./wizard-helpers";
import { getValidApiKey } from "./opensea-key";
import { getSessionCookies } from "./opensea-session";
import { parseTarget, resolveTarget, chainSlug, ResolvedTarget } from "./target-resolver";
import { parseWhen } from "./schedule";
import { parsePriceSpec } from "./price-protection";
import { findUniversalMint, findAllUniversalMints, explainFailure, UniversalMintPlan } from "./universal-mint";
import { getMintMechanisms } from "./seadrop-public";
import { verifyContract } from "./contract-verify";
import { simulateTx, classifyRevert, type SimulateResult } from "./simulate";
import { formatRemaining } from "./time-format";
import { blastToAll } from "./rpc-blast";
import { parsePriceToWei } from "./opensea-gql";
import {
  fetchSignedPayload,
  fetchSignedPayloadWithSession,
  fetchSignedPayloadForWallet,
  buildFcfsMintPlan,
  executeFcfsSnipe,
  classifyMintMode,
  FcfsSignedPayload,
  StoredSession,
  sessionToStoredSessionCookie,
} from "./fcfs-mint";

export { runFcfsBranch, runFcfsBranchCli, runEligibilityCheck } from "./wizard-fcfs-new";

// ── Per-wallet eligibility probe result ─────────────────────────────────────

interface WalletEligibility {
  walletIndex: number;
  walletAddress: string;
  phaseReports: PhaseEligibility[];
}

interface PhaseEligibility {
  drop: DropPhase;
  // Per-wallet signed payload (if fetchable)
  signedPayload: FcfsSignedPayload | null;
  signedPayloadError: string | null;
  /** Per-wallet price OpenSea quoted for this stage, in wei. */
  priceWei?: bigint | null;
  // Eligibility verdict
  eligible: boolean;
  reason: string;
  // Mode for this wallet+phase combo
  mode: "public" | "signed" | "allowlist" | "token-gated" | "unknown";
  fireableLocally: boolean;
  preFetchNeeded: boolean;
}

// ── Main wizard entry point ──────────────────────────────────────────────────

export interface WizardOptions {
  /** Schedule the mint for a specific time instead of asking. */
  at?: string | null;
  /** Poll the on-chain open time and mint the instant it opens. */
  whenOpen?: boolean;
  /** Max total price in ETH, "free", or "any". */
  maxPrice?: string | null;
  /** Wallet selection: all | N | 1,3,4. */
  wallets?: string | null;
  /** Chain key override. */
  chain?: string | null;
  /** Quantity per wallet. */
  quantity?: number | null;
  /** Pre-filled mint target, skipping the prompt. */
  target?: string | null;
}

export async function runWizard(log: RunLogger, opts: WizardOptions = {}): Promise<void> {
  log.info("Wizard: started");
  log.field("startup_mode", "interactive");
  log.field("chain_env", process.env.CHAIN || "<unset>");
  log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
  log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");
  if (opts.at) log.field("scheduled_at", String(parseWhen(opts.at)));
  if (opts.maxPrice) log.field("max_price", opts.maxPrice);

  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  log.info("Wizard: prompting for keys");
  const walletKeys = await promptKeys(log, opts.wallets);
  log.field("wallet_count", walletKeys.length);
  if (walletKeys.length === 0) {
    throw new Error("No wallet keys provided.");
  }
  const wallets = walletKeys.map((k) => new Wallet(k));

  // ── 2. Chain ──────────────────────────────────────────────────────────
  // Precedence: explicit --chain flag > interactive prompt.
  //
  // CHAIN from .env is a DEFAULT for the prompt, never a bypass. Previously a
  // valid CHAIN skipped the prompt entirely, so switching chains meant editing
  // .env by hand — the single most common runtime change and the most awkward
  // one to make. The user is always asked, and their answer always wins.
  const envChain = process.env.CHAIN?.trim().toLowerCase() || undefined;
  let chainKey: string;
  if (opts.chain) {
    chainKey = chainSlug(opts.chain);
    console.log(chalk.gray(`  Chain: ${chainKey} (--chain)`));
  } else {
    // Default to CHAIN when it names a chain we support, else ethereum.
    const envIndex = envChain
      ? CHAINS.findIndex((c) => c.key === chainSlug(envChain))
      : -1;
    const defaultIndex = envIndex >= 0 ? envIndex : 0;
    chainKey = await askChoice<string>(
      "Which chain?",
      CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
      defaultIndex
    );
    if (envChain && chainSlug(envChain) === chainKey) {
      console.log(chalk.gray(`  (default from CHAIN in .env)`));
    }
  }
  if (!resolveChain(chainKey)) {
    // Derived from CHAINS so this can never list a chain the tool cannot
    // serve — it previously advertised polygon/arbitrum/optimism and omitted
    // arc and soneium.
    throw new Error(
      `Unknown chain "${chainKey}". Supported chains: ${CHAINS.map((c) => c.key).join(", ")}.`
    );
  }
  log.field("chain", chainKey);
  let chainProfile = resolveChain(chainKey)!;

  // ── 3. Quantity ───────────────────────────────────────────────────────
  const quantity = opts.quantity ?? (await promptQuantity(walletKeys.length));
  log.field("quantity", quantity);
  if (quantity <= 0) {
    throw new Error("Quantity must be at least 1. Aborting.");
  }

  // ── 3b. OpenSea API key ─────────────────────────────────────────────────
  // Resolved BEFORE the target. promptTarget needs a key to resolve a slug —
  // OpenSea gates collection lookups, so a keyless resolve returns null for any
  // slug that is not scrapeable, and the user sees "could not resolve" with no
  // indication that the fix is a key. Fetching it after the target meant every
  // slug resolution ran keyless.
  console.log(chalk.bold.white("\nOpenSea API key"));
  console.log(chalk.gray("  Checking for a usable key..."));

  const keyResult = await getValidApiKey({ timeoutMs: 8000 });
  const apiKey = keyResult?.api_key || undefined;
  console.log(chalk.gray(`  Key source: ${keyResult?.source || "none"}`));

  if (keyResult) {
    console.log(chalk.green(`  ✓ Key ready: ${keyResult.source}`));
  } else {
    console.log(chalk.yellow(`  ⚠ No usable OpenSea key available.`));
    console.log(chalk.gray(`    Public mints still work; signed/allowlist phases and`));
    console.log(chalk.gray(`    slug resolution may not.\n`));
  }

  // ── 4. NFT target ──────────────────────────────────────────────────────
  const target = opts.target
    ? await promptTarget(log, chainKey, opts.target, apiKey)
    : await promptTarget(log, chainKey, null, apiKey);
  const nftInput = target.contract;
  chainKey = target.chainKey;
  // The target can name a different chain than the one prompted for (a
  // chain-bearing link, or a slug that lives on another network). The profile
  // must follow, or promptRpc loads the old chain's endpoints and planRpcs
  // verifies them against the old chain id — a guaranteed wrong-chain mint.
  // The FCFS CLI branch carries the same guard (wizard-fcfs-new.ts).
  const targetProfile = resolveChain(chainKey);
  if (!targetProfile) {
    throw new Error(
      `Target "${target.label}" is on unknown chain "${chainKey}". Supported chains: ${CHAINS.map((c) => c.key).join(", ")}.`
    );
  }
  if (targetProfile.key !== chainProfile.key) {
    console.log(
      chalk.yellow(
        `\n  ⚠ Target resolves to ${targetProfile.name} (chain ${targetProfile.chainId}), not ${chainProfile.name}. ` +
          `Switching chains and re-resolving endpoints.`
      )
    );
    log.field("chain_override", `${chainProfile.key} -> ${targetProfile.key}`);
  }
  chainProfile = targetProfile;
  log.field("nft_input", nftInput);
  log.field("label", target.label);
  log.field("platform", target.resolved?.platform ?? "unknown");

  // ── 5. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
  if (manualRpcs.length === 0) {
    throw new Error(
      `No RPC endpoints for ${chainProfile.name}. Set RPC_URL_${chainProfile.key.toUpperCase()} in .env, or pass one interactively.`
    );
  }
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chainKey, manualRpcs);
  console.log(chalk.gray(`  Source: ${source}`));
  console.log(chalk.gray(`  Checking ${candidateRpcs.length} endpoint(s)...`));

  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);

  for (const bad of plan.dropped) {
    const wrong = resolveChain(bad.chainId);
    console.log(
      chalk.red(`    ✗ ${labelOf(bad.url)} is chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`)
    );
  }
  for (const ep of parseRpcEndpoints(plan.urls)) {
    const failure = plan.failures.find((f) => f.url === ep.url);
    if (failure) {
      const benign = isBenignProbeError(failure.message);
      console.log(
        benign
          ? chalk.gray(`    • ${ep.label}  (send-only)`)
          : chalk.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`)
      );
    } else {
      console.log(chalk.green(`    ✓ ${ep.label}`));
    }
  }

  if (plan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  }
  if (!plan.verified) {
    console.log(chalk.yellow(`  ⚠ No endpoint confirmed chain id ${chainProfile.chainId}.`));
    if (!(await askYesNo("Continue anyway?", false))) {
      throw new Error("Aborted — could not verify the RPC chain");
    }
  } else {
    console.log(chalk.green(`  ✓ Confirmed chain id ${chainProfile.chainId} (${chainProfile.name})`));
  }
  const rpcUrls = plan.urls;
  // The chain id is already known here — pass it so ethers never has to detect
  // the network. Detection costs a round trip and, on a slow endpoint, times out
  // before the first read. staticNetwork also stops ethers from re-detecting if
  // the endpoint ever reports a different chain.
  const provider = new JsonRpcProvider(rpcUrls[0], chainProfile.chainId, {
    staticNetwork: true,
  });
  try {

    // ── 6. Verify the target is a contract ──────────────────────────────────
    // A scraped or mistyped address is untrusted input, and every later step
    // (OpenSea lookup, drops query, SIWE login) is wasted on an address with no
    // code. One eth_call here turns a confusing multi-step failure into an
    // instant, explanatory one.
    //
    // The selector query stays LAST — it is the expensive probe and should only
    // run when no platform has claimed the contract.
    if (!isSlug(nftInput)) {
      const verification = await verifyContract(nftInput, chainProfile.chainId);
      if (!verification.isContract) {
        console.log(
          chalk.yellow(
            `\n  ⚠ ${nftInput} is not a contract on ${chainProfile.name} (${verification.reason}).`
          )
        );
        console.log(
          chalk.gray(`    Nothing will be minted. Check the address and chain, then re-run.`)
        );
        closePrompts();
        return;
      }
      console.log(
        chalk.green(`  ✓ Verified contract on ${chainProfile.name} (${verification.reason})`)
      );
      log.field("contract_verified", "true");
    }

    // ── 6b. Resolve slug ───────────────────────────────────────────────────
    // Need the slug for OpenSea drops endpoint access. If user gave a CA, resolve it.
    // The API key was resolved in step 3b, before the target.

    // Resolve slug — needed for OpenSea drops endpoint
    let slug: string | null = null;
    if (!isSlug(nftInput)) {
      console.log(chalk.gray(`  Resolving contract → slug for OpenSea drops endpoint...`));
      slug = await resolveContractToSlug(nftInput, apiKey || "", 12000);
      if (!slug) {
        console.log(chalk.gray(`  Could not resolve slug for ${nftInput}.`));
        console.log(chalk.gray(`  Will use contract address directly where possible.`));
      } else {
        console.log(chalk.green(`  ✓ Slug: ${slug}`));
      }
    } else {
      // User gave a slug directly — resolve to CA for on-chain reads
      console.log(chalk.gray(`  Resolving slug → contract address...`));
      try {
        const info = await resolveSlug(nftInput, apiKey || "", chainKey);
        log.field("resolved_contract", info.contractAddress);
      } catch (err: any) {
        log.warn(`Slug resolution failed: ${err.message}`);
      }
      slug = nftInput;
    }
    log.field("slug", slug || "unknown");

    // ── 7. Discover ALL phases ─────────────────────────────────────────────
    // Fetch from OpenSea GraphQL first (primary), then REST, then on-chain SeaDrop
    // discovery for collections not registered on OpenSea.
    console.log(chalk.gray(`  Fetching all active phases for ${target.label}...`));

    const inventory = await discoverAllPhases(nftInput, slug, apiKey, chainKey, 12000);
    log.field("phases_found", inventory.drops.length);

    // ── 8a. Gas (needed by both the phase path and the universal fallback) ──
   
    const gas = await promptGasGwei(chainProfile, rpcUrls);

    // ── 8b. Universal probe ─────────────────────────────────────────────────
    // OpenSea only knows about drops it hosts. A plain ERC721 with its own
    // mint(), a Manifold claim, a Zora collect, or any contract using a bespoke
    // mint function is invisible to the drops endpoint.
    //
    // This runs even when OpenSea DID find phases. A contract can have a SeaDrop
    // stage AND its own mint(), and the native one is frequently cheaper because
    // it bypasses OpenSea's fee recipient. Probing only as a fallback hid that.
    // Every candidate is simulation-gated, so a closed sale or a missing proof
    // is reported as a reason rather than silently minted.
    // A transient RPC failure here must not be mistaken for "no mint" — the
    // throw is caught and reported, and the OpenSea phases still proceed.
    let universalPlans: UniversalMintPlan[] = [];
    try {
      universalPlans = await findAllUniversalMints(
        nftInput, provider, wallets[0].address, BigInt(quantity), { rpcUrl: rpcUrls[0] }
      );
    } catch (e: any) {
      console.log(chalk.yellow(`  ⚠ On-chain probe failed: ${e?.message ?? e}`));
    }
    log.field("universal_candidates", universalPlans.length);

    if (inventory.drops.length === 0) {
      console.log(chalk.bold.white("\nUniversal mint probe"));
      console.log(
        chalk.gray("  OpenSea reports no phases — probing the contract directly...")
      );

      if (universalPlans.length > 0) {
        const plan = universalPlans[0];
        console.log(chalk.green(`  ✓ ${plan.description}`));
        console.log(chalk.gray(`    via ${plan.adapter}`));

        // A universal plan is a single-wallet, single-contract mint. Confirm and
        // execute it directly — there is no phase matrix to pick from.
        const didConfirm = await askYesNo(
          `Mint ${quantity} × ${plan.description}?`,
          true
        );
        if (!didConfirm) {
          console.log(chalk.yellow("\n  Aborted — nothing was sent.\n"));
          closePrompts();
          return;
        }

        await executeUniversalMint(plan, walletKeys, rpcUrls, chainProfile, gas, quantity);
        closePrompts();
        return;
      }

      console.log(chalk.yellow("  ✗ No mintable mechanism found on this contract."));
      // explainFailure wants the attempts array, which findAllUniversalMints
      // does not return — run the single-plan variant purely for its diagnostics.
      const diagnostic = await findUniversalMint(
        nftInput, provider, wallets[0].address, BigInt(quantity), { rpcUrl: rpcUrls[0] }
      );
      console.log(chalk.gray(explainFailure(diagnostic)));

      // Explain WHY, when the contract is a SeaDrop drop with non-public
      // mechanisms. Reads getMintMechanisms() to warn
      // that a public fallback does not cover the wallet's spot. Without this the
      // user is left guessing whether the failure is a closed sale, a missing
      // allowlist spot, or a token gate.
      try {
        const mech = await getMintMechanisms(rpcUrls[0], nftInput);
        if (mech.signers.length > 0 || mech.tokenGated.length > 0) {
          const kinds: string[] = [];
          if (mech.signers.length > 0) kinds.push("signed (needs an OpenSea signature)");
          if (mech.tokenGated.length > 0) kinds.push("token-gated (needs a held NFT)");
          console.log(
            chalk.yellow(
              `\n  This drop uses ${kinds.join(" and ")} — a public mint will not cover your wallet.`
            )
          );
          console.log(
            chalk.gray(
              `  You need to be on its allowlist, or hold its token, before it opens.`
            )
          );
        }
      } catch {
        // Best-effort diagnostic — never block the refusal on it.
      }

      console.log(
        chalk.gray(
          "\n  This may not be a mintable contract, the sale may be closed, or it may\n" +
            "  need an allowlist proof / signature this tool cannot obtain."
        )
      );
      closePrompts();
      return;
    }

    // ── 8c. Report any on-chain candidate OpenSea did not surface ──────────
    // When OpenSea found phases AND the on-chain probe found a different,
    // cheaper route, say so. Silently preferring OpenSea would mint at the
    // higher price with no explanation.
    if (inventory.drops.length > 0 && universalPlans.length > 0) {
      const best = universalPlans[0];
      console.log(
        chalk.gray(
          `\n  On-chain probe also found: ${best.description} via ${best.adapter}` +
            ` — compare against the OpenSea phase price before choosing.`
        )
      );
    }

    // ── 8d. Warm SIWE sessions ──────────────────────────────────────────────
    // Only now, after a platform has actually claimed the contract and phases
    // exist. Warming earlier meant paying a login round trip per wallet for
    // targets that need no session at all (a plain ERC721 with its own mint()),
    // and a SIWE failure was reported as a warning on runs where it made no
    // difference. A session is only required for the signed/allowlist path.
    //
    // A failure here is non-fatal: public phases mint on-chain and never touch
    // OpenSea. The eligibility probe reports per-wallet session state.
    console.log(chalk.bold.white("\nOpenSea sessions"));
    console.log(chalk.gray(`  Warming SIWE sessions for ${wallets.length} wallet(s)...`));

    const sessionResults = await warmAllSessions(wallets, apiKey);
    log.field("sessions_ready", sessionResults.filter((s) => s.session).length);
    log.field("sessions_failed", sessionResults.filter((s) => !s.session).length);

    for (const result of sessionResults) {
      const label = `${result.wallet.address.slice(0, 6)}…${result.wallet.address.slice(-4)}`;
      if (result.session) {
        console.log(chalk.green(`  ✓ [W${result.walletIndex}] ${label} session ready`));
      } else {
        console.log(chalk.yellow(`  ⚠ [W${result.walletIndex}] ${label} session failed: ${result.error}`));
      }
    }

    // ── 9. Probe eligibility for EACH wallet against EACH phase ──────────────
    console.log(chalk.bold.white("\nEligibility probe"));
    console.log(chalk.gray(`  Probing ${wallets.length} wallet(s) × ${inventory.drops.length} phase(s)...`));

    const walletEligibilities = await probeAllWallets(
      wallets, walletKeys, inventory, sessionResults, apiKey, quantity, slug, chainKey
    );

    // ── 10. Report eligibility matrix ────────────────────────────────────────
    printEligibilityReport(walletEligibilities, inventory);

    // ── 11. Let user pick wallet + phase ────────────────────────────────────
    const selection = await promptWalletAndPhase(walletEligibilities, walletKeys, quantity);
    if (selection === null) {
      console.log(chalk.yellow("\n  Aborted — nothing was sent.\n"));
      closePrompts();
      return;
    }

    const { walletIndex, wallet, phaseIndex } = selection;
    const selectedDrop = inventory.drops[phaseIndex];
    const walletEligibility = walletEligibilities[walletIndex];
    const phaseEligibility = walletEligibility.phaseReports[phaseIndex];

    log.field("selected_wallet", wallet.address);
    log.field("selected_phase", selectedDrop.name || selectedDrop.dropId);
    log.field("mint_mode", phaseEligibility.mode);

    // ── 12. Timing ──────────────────────────────────────────────────────────
    // --at / --when-open skip the prompt; otherwise ask.
    //
    // A zero startTime means "unknown", not 1970. Defaulting to `new Date(0)`
    // made the snipe compute a negative delay and fire immediately — outside the
    // stage window, so the signed tx reverts and costs gas.
    const knownStart = selectedDrop.startTime > 0 ? new Date(selectedDrop.startTime * 1000) : null;
    let targetStart: Date;
    let timingLabel: string;
    if (opts.at) {
      const unix = parseWhen(opts.at);
      targetStart = new Date(unix * 1000);
      timingLabel = `--at ${opts.at}`;
      console.log(chalk.gray(`  Scheduled for ${targetStart.toISOString()} (${timingLabel})`));
    } else if (opts.whenOpen) {
      if (!knownStart) {
        throw new Error("Cannot use --when-open: the opening time is unknown for this phase.");
      }
      targetStart = knownStart;
      timingLabel = "when-open (poll on-chain)";
      console.log(chalk.gray("  Will poll the on-chain open time."));
    } else if (knownStart) {
      const prompted = await promptTiming(knownStart);
      if (!prompted.targetStart) {
        // The user declined to wait for the stage. Abort rather than silently
        // falling back to the stage's start time — that would schedule a mint
        // they just said they did not want.
        console.log(chalk.yellow("\n  Not scheduled — nothing was sent.\n"));
        closePrompts();
        return;
      }
      targetStart = prompted.targetStart;
      timingLabel = prompted.timingLabel;
    } else {
      // Unknown opening time. Never silently default to "now".
      console.log(chalk.yellow(`\n  ⚠ The opening time for this phase is unknown.`));
      const answer = (await askText(
        chalk.gray(`  Fire when? (ISO, "in 5m", "30s", "HH:MM", or "now"): `)
      )).trim();
      if (!answer || answer.toLowerCase() === "now") {
        targetStart = new Date();
        timingLabel = "immediately (opening time unknown)";
      } else {
        targetStart = new Date(parseWhen(answer) * 1000);
        timingLabel = `at ${targetStart.toISOString()}`;
      }
    }
    // ── 12b. Price protection ───────────────────────────────────────────────
    // --max-price sets the cap; otherwise the user is
    // asked. Without it a drop that raised its price between planning and firing
    // would be minted at the new price with no warning.
    let maxPriceWei: bigint | null = null;
    if (opts.maxPrice) {
      const priceSpec = parsePriceSpec(opts.maxPrice, quantity);
      if (priceSpec) {
        maxPriceWei = priceSpec.isUnlimited ? null : priceSpec.maxPriceWei;
        console.log(chalk.gray(`  Price protection: ${priceSpec.display}`));
      }
    }

    // ── 14. Balances + affordability ─────────────────────────────────────────
    console.log(chalk.bold.white("\nWallets"));
    const balances = await Promise.all(
      wallets.map((w) => provider.getBalance(w.address).catch(() => null))
    );
    const symbol = chainProfile.nativeSymbol;
    console.log(chalk.gray(`  Native token: ${symbol}`));

    // Determine required funds based on mint mode
    let valuePerWallet: bigint;
    if (phaseEligibility.mode === "public") {
      // Public mint — price from on-chain
      const localPlan = await buildLocalMintPlan(rpcUrls[0], nftInput, quantity);
      if (!localPlan) throw new Error("Could not build local mint plan for public phase.");
      valuePerWallet = localPlan.value;
    } else {
      // Signed/allowlist mint — price from payload
      valuePerWallet = phaseEligibility.signedPayload?.value || selectedDrop.mintPrice * BigInt(quantity);
    }

    const required = BigInt(gas.defaultGasLimit) * gas.maxFeePerGasWei + valuePerWallet;

    const input: SnipeReadyInput = {
      chainProfile,
      rpcUrls,
      wallets,
      balances,
      nftContract: nftInput,
      quantity,
      valuePerWallet,
      required,
      gasLimit: gas.defaultGasLimit,
      maxFeePerGas: gas.maxFeePerGasWei,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
      targetStart: targetStart,
      timingLabel,
      // promptTiming already asked "Fire when the stage opens?" for a future
      // stage, so the READY screen must not ask "Fire?" a second time.
      timingDecided: knownStart != null,
      modeLabel: `${phaseEligibility.mode === "public" ? "PUBLIC (on-chain)" : "SIGNED (OpenSea)"} — ${selectedDrop.name || "selected phase"}`,
      targetLabel: target.label,
      promptForGas: false,
    };

    const { shortCount } = displayBalances(input);
    if (shortCount === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }

    // ── 15. Confirm ────────────────────────────────────────────────────────
    const didConfirm = await confirmSnipe(input);
    if (!didConfirm) {
      closePrompts();
      return;
    }

    closePrompts();

    // ── 15b. Sell-after-mint scheduling ────────────────────────────────────
    // Scheduled BEFORE the mint, on purpose. An offer book read now is stale by
    // T-0, so nothing is quoted from it here: only the gas cost is estimated.
    // The offers themselves are read after the mint, per wallet, one at a time.
    let sellPlan: SellPlan | null = null;
    if (slug && apiKey) {
      sellPlan = await planSellAfterMint({
        chainKey,
        apiKey,
        symbol,
        mintQuantity: quantity,
        valuePerWallet,
        rpcUrl: rpcUrls[0],
      });
    } else {
      console.log(
        chalk.gray(
          slug
            ? "\n  (no OpenSea API key — sell-after-mint is unavailable)"
            : "\n  (no collection slug — sell-after-mint is unavailable)"
        )
      );
    }

    // ── 16. Execute ──────────────────────────────────────────────────────────
    // Per-wallet mint outcome, kept so the sell step can act on exactly the
    // wallets whose mint succeeded — a failed mint must not sell anything.
    let mintOutcomes: {
      walletIndex: number;
      address: string;
      txHash: string | null;
      status: string;
    }[] = [];

    if (phaseEligibility.mode === "public") {
      // Public phase — on-chain calldata, no OpenSea needed
      const localPlan = await buildLocalMintPlan(rpcUrls[0], nftInput, quantity);
      if (!localPlan) {
        throw new Error("Could not build local mint plan for public phase.");
      }

      mintOutcomes = (await localPublicSnipe({
        nftContract: nftInput,
        quantity,
        walletKeys,
        rpcUrls,
        maxFeePerGas: gas.maxFeePerGasWei,
        maxPriorityFee: gas.maxPriorityFeePerGasWei,
        gasLimit: gas.defaultGasLimit,
        targetStart: targetStart || new Date(selectedDrop.startTime * 1000),
        plan: localPlan,
        maxPriceWei,
      }));
    } else {
      // Signed/allowlist phase — needs OpenSea signed payload.
      //
      // A future phase has no payload yet: OpenSea only signs for a live stage.
      // Throwing here made every future signed phase un-mintable — the run
      // aborted before the timing prompt and before the T-0 fetch that would
      // have produced the payload. The payload is only required when the phase
      // is actually open (or already passed).
      const phaseOpensInFuture =
        selectedDrop.startTime > 0 && selectedDrop.startTime * 1000 > Date.now();

      if (!phaseEligibility.signedPayload && !phaseOpensInFuture) {
        throw new Error(
          `Signed payload unavailable for phase "${selectedDrop.name || "selected"}".\n` +
            `  OpenSea did not return wallet-specific signed data.\n` +
            `  Get an OpenSea API key and ensure your wallet is allowlisted.\n` +
            `  Or switch to a public phase if one is available.`
        );
      }

      const payload = phaseEligibility.signedPayload;
      const mintPlan = payload
        ? buildFcfsMintPlan(
            payload, gas.defaultGasLimit, gas.maxFeePerGasWei, gas.maxPriorityFeePerGasWei, quantity
          )
        : null;

      // Pre-fetch a signed payload for EVERY wallet now, while the drop is still
      // future. mintSignature is wallet-specific, so each wallet needs its own.
      // Passing these in keeps the T-0 path free of API calls.
      //
      // For a future phase the payload does not exist yet, so there is nothing to
      // pre-fetch — every wallet is pushed as null and phase 2 fetches at T-0.
      if (phaseOpensInFuture) {
        console.log(
          chalk.gray(
            `\n  Phase opens ${formatRemaining(selectedDrop.startTime * 1000 - Date.now())} — ` +
              `payloads will be fetched at T-0.`
          )
        );
      } else {
        console.log(chalk.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
      }
      const preFetched: (FcfsSignedPayload | null)[] = [];
      for (let i = 0; i < walletKeys.length; i++) {
        if (phaseOpensInFuture) {
          preFetched.push(null);
          continue;
        }
        const w = new Wallet(walletKeys[i]);
        try {
          const p = await fetchSignedPayloadForWallet(
            nftInput,
            quantity,
            w.address,
            apiKey,
            { timeoutMs: 15000, session: sessionResults[i]?.session ?? null, slug: slug || undefined, chainKey },
          );
          preFetched.push(p);
          if (!p) console.log(chalk.yellow(`    ${w.address} — no payload (will retry at T-0)`));
        } catch (err: any) {
          console.log(chalk.yellow(`    ${w.address} — pre-fetch failed: ${err.message}`));
          preFetched.push(null);
        }
      }

      const snipeResults = await executeFcfsSnipe({
        nftContract: nftInput,
        quantity,
        walletKeys,
        rpcUrls,
        maxFeePerGas: gas.maxFeePerGasWei,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
        gasLimit: gas.defaultGasLimit,
        targetStart: targetStart || new Date(selectedDrop.startTime * 1000),
        plan: mintPlan,
        payloads: preFetched,
        sessions: sessionResults.map((sr) => sr.session),
        slug: slug || undefined,
        chainKey,
        maxPriceWei,
        // OpenSea's per-wallet quote for the selected stage, so a price that
        // rose after the eligibility check is refused before fetching a payload.
        quotedPriceWei: phaseEligibility.priceWei ?? null,
        // A future phase has no payload yet. Phase 1 must not fetch one (it
        // would always come back null and drop the wallet); phase 2 fetches at
        // T-0 instead.
        phaseOpensInFuture,
      });
      mintOutcomes = snipeResults.map((r) => ({
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
      }));
    }

    // ── 17. Sell after mint ──────────────────────────────────────────────────
    if (sellPlan?.enabled) {
      await runSellAfterMint({
        sellPlan,
        walletKeys,
        contract: nftInput,
        slug: slug!,
        chainKey,
        apiKey: apiKey!,
        rpcUrl: rpcUrls[0],
        chainId: chainProfile.chainId,
        mintOutcomes,
      });
    }
  } finally {
    // ethers keeps a polling timer alive on every provider; without an explicit
    // destroy the wizard finishes its work but the process never exits.
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}

// ── Universal mint execution ────────────────────────────────────────────────
//
// Broadcasts a plan produced by findUniversalMint. Unlike the phase paths this
// has no signed payload and no per-wallet variation — the calldata is identical
// for every wallet, so it is encoded once and blasted to every endpoint.

async function executeUniversalMint(
  plan: UniversalMintPlan,
  walletKeys: string[],
  rpcUrls: string[],
  chainProfile: ChainProfile,
  gas: { defaultGasLimit: number; maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint },
  quantity: number
): Promise<void> {
  console.log(chalk.bold.white("\nBroadcasting"));
  console.log(chalk.gray(`  ${walletKeys.length} wallet(s) × ${rpcUrls.length} endpoint(s)`));

  const results: { wallet: string; ok: boolean; hash?: string; error?: string }[] = [];

  // A provider-less Wallet signs exactly what it is given (ethers v6
  // BaseWallet.signTransaction does not populate), so a missing nonce or chain id
  // defaults to 0 — and every node rejects a chainId-0 transaction with
  // "transaction type not supported". One shared provider supplies both.
  const nonceProvider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });

  try {
  for (const key of walletKeys) {
    const wallet = new Wallet(key);
    const txRequest = {
      to: plan.to,
      data: plan.data,
      value: plan.value,
      gasLimit: gas.defaultGasLimit,
      maxFeePerGas: gas.maxFeePerGasWei,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
    };

    // Re-simulate immediately before signing. The plan was simulated during
    // discovery, but a live sale can close between then and now — and a revert
    // costs gas to discover on-chain.
    const simProvider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });
    let sim: SimulateResult;
    try {
      sim = await simulateTx(simProvider, {
        to: plan.to,
        from: wallet.address,
        data: plan.data,
        value: plan.value,
      });
    } finally {
      // ethers keeps a polling timer alive on every provider. Without an
      // explicit destroy the process never exits — the work is done but the
      // event loop stays busy forever.
      try {
        simProvider.destroy();
      } catch {
        // Already destroyed.
      }
    }
    if (!sim.ok && sim.reverted) {
      const classified = classifyRevert(sim.reason);
      results.push({
        wallet: wallet.address,
        ok: false,
        error: `${classified ? `[${classified.label}] ` : ""}${sim.reason ?? "reverted"}`,
      });
      continue;
    }

    try {
      // Read the nonce here, immediately before signing: any intervening wallet
      // activity advances it and every endpoint then rejects the tx as
      // "nonce too low".
      const nonce = await nonceProvider.getTransactionCount(wallet.address, "pending");
      const signed = await wallet.signTransaction({
        ...txRequest,
        nonce,
        chainId: chainProfile.chainId,
      });
      const endpoints = parseRpcEndpoints(rpcUrls);
      const { txHash } = blastToAll(signed, endpoints);
      results.push({ wallet: wallet.address, ok: true, hash: txHash });
      console.log(chalk.green(`  ✓ ${short(wallet.address)} — ${short(txHash)}`));
    } catch (err: any) {
      results.push({ wallet: wallet.address, ok: false, error: err.message });
      console.log(chalk.red(`  ✗ ${short(wallet.address)} — ${err.message}`));
    }
  }
  } finally {
    // ethers keeps a polling timer alive on every provider; without an explicit
    // destroy the process never exits.
    try {
      nonceProvider.destroy();
    } catch {
      // Already destroyed.
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(chalk.bold(`\n  ${okCount}/${results.length} wallet(s) broadcast`));
  if (okCount === 0) {
    throw new Error("Every wallet failed to broadcast — nothing was sent.");
  }
}

// ── Phase discovery: OpenSea REST + on-chain fallback ─────────────────────────

async function discoverAllPhases(
  nftContract: string,
  slug: string | null,
  apiKey: string | null | undefined,
  chainKey: string,
  timeoutMs: number,
): Promise<CollectionDropsInventory> {
  // Try OpenSea first — works with CAs or slugs
  let inventory = await fetchAllActiveDrops(nftContract, apiKey || undefined, timeoutMs, slug || undefined, chainKey);

  // If OpenSea didn't find anything, try on-chain SeaDrop discovery
  if (inventory.drops.length === 0) {
    console.log(chalk.gray(`  OpenSea: no active phases — trying on-chain SeaDrop probe...`));
    const onChainDrops = await fetchOnChainDrops(nftContract, timeoutMs, chainKey);
    if (onChainDrops.length > 0) {
      console.log(chalk.green(`  ✓ Found ${onChainDrops.length} on-chain phase(s).`));
      inventory.drops = onChainDrops;
      inventory.fetchedAt = Date.now();
      inventory.apiKeyUsed = !!apiKey;
    } else {
      // Try single-contract on-chain drop as last resort.
      //
      // This must run regardless of whether an API key is present. Gating it on
      // `!apiKey` meant that with a key configured, a contract that OpenSea
      // simply does not index (or indexes under a slug we failed to resolve) was
      // never probed on-chain at all — the run fell straight through to the
      // universal probe with no SeaDrop phase data. A key is irrelevant to an
      // eth_call against the SeaDrop singleton.
      console.log(chalk.gray(`    OpenSea REST 404'd — checking single-contract on-chain drop...`));
      const singleDrop = await fetchSingleOnChainDrop(nftContract, 8000, chainKey);
      if (singleDrop) {
        console.log(chalk.green(`  ✓ Found on-chain drop for this contract.`));
        inventory.drops = [singleDrop];
        inventory.fetchedAt = Date.now();
        inventory.apiKeyUsed = false;
      }
    }
  }

  return inventory;
}

// ── SIWE session warming for ALL wallets ─────────────────────────────────────

interface SessionResult {
  walletIndex: number;
  wallet: Wallet;
  session: StoredSession | null;
  error: string | null;
}

// Parse a per-wallet cookie string (from getSessionCookies) into a StoredSession.
// Extracts access_token + refresh_token from the cookie jar and decodes JWT exp.
function cookiesToStoredSession(cookies: string): StoredSession | null {
  const accessMatch = cookies.match(/(?:^|;\s*)access_token=([^;]+)/);
  const refreshMatch = cookies.match(/(?:^|;\s*)refresh_token=([^;]+)/);
  const token = accessMatch?.[1]?.trim();
  const refreshToken = refreshMatch?.[1]?.trim();
  if (!token) return null;

  // Decode JWT exp claim (no verification needed — just reading expiry)
  let exp = 0;
  try {
    const parts = token.split(".");
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      exp = (payload.exp || 0) * 1000; // JWT exp is in seconds → ms
    }
  } catch {}

  return {
    accessToken: token,
    refreshToken,
    expiresAt: exp,
  };
}

async function warmAllSessions(
  wallets: Wallet[],
  _apiKey: string | null | undefined,
): Promise<SessionResult[]> {
  const results = await Promise.all(
    wallets.map(async (w, i): Promise<SessionResult> => {
      try {
        // Each wallet gets its own SIWE session via getSessionCookies,
        // which caches per-address internally in opensea-session.ts.
        const cookies = await getSessionCookies(w);
        if (cookies) {
          // Build a per-wallet StoredSession from that wallet's cookies.
          const session = cookiesToStoredSession(cookies);
          return { walletIndex: i, wallet: w, session, error: null };
        }
        return { walletIndex: i, wallet: w, session: null, error: "SIWE login failed" };
      } catch (err: any) {
        // Non-fatal — some collections don't need sessions
        return { walletIndex: i, wallet: w, session: null, error: err.message };
      }
    })
  );

  return results;
}

// ── Eligibility probing for ALL wallets × ALL phases ────────────────────────

async function probeAllWallets(
  wallets: Wallet[],
  walletKeys: string[],
  inventory: CollectionDropsInventory,
  sessionResults: SessionResult[],
  apiKey: string | null | undefined,
  quantity: number,
  collectionSlug: string | null,
  chainKey: string,
): Promise<WalletEligibility[]> {
  const results: WalletEligibility[] = [];
  // Soonest-starting phase first. The wizard's phase picker returns a
  // phaseIndex that the CALLER uses to index inventory.drops, so this MUST sort
  // the inventory in place — sorting a copy made the picker select the wrong
  // phase whenever the inventory was not already in start-time order.
  sortByStartTime(inventory.drops);
  const orderedDrops = inventory.drops;

  for (let wIdx = 0; wIdx < wallets.length; wIdx++) {
    const wallet = wallets[wIdx];
    const walletAddr = wallet.address.toLowerCase();
    const phaseReports: PhaseEligibility[] = [];
    const session = sessionResults[wIdx]?.session ?? null;

    for (const drop of orderedDrops) {
      const report = await probePhaseForWallet(
        wallet, walletAddr, drop, apiKey, quantity, session, collectionSlug, chainKey
      );
      phaseReports.push(report);
    }

    results.push({
      walletIndex: wIdx,
      walletAddress: wallet.address,
      phaseReports,
    });
  }

  return results;
}

async function probePhaseForWallet(
  wallet: Wallet,
  walletAddr: string,
  drop: DropPhase,
  apiKey: string | null | undefined,
  quantity: number,
  session: StoredSession | null,
  collectionSlug: string | null,
  chainKey: string,
): Promise<PhaseEligibility> {
  // 1. Run local classification
  const { mode, fireableLocally, preFetchNeeded } = classifyMintMode(drop);

  // 2. Determine eligibility.
  //
  // One provider answers the verdict. Public stages resolve locally — OpenSea
  // leaves their per-wallet fields null and no session is needed. Every other
  // stage is asked directly, and the whole-collection response is scoped to this
  // phase's stage uuid, so an open public stage elsewhere in the collection
  // cannot make a presale phase look eligible.
  //
  // It returns null when there is no session/slug to ask with, or when OpenSea's
  // answer cannot be attributed to this phase. The inventory heuristic is then
  // the fallback, and for signed stages the signed-payload fetch below is the
  // remaining evidence.
  let eligible = false;
  let reason = "";
  let signedPayload: FcfsSignedPayload | null = null;
  let signedPayloadError: string | null = null;

  const cookie = session ? sessionToStoredSessionCookie(session) : null;
  const baseReport = await getPhaseEligibility({
    drop,
    wallet: walletAddr,
    slug: collectionSlug,
    cookie,
    apiKey,
    timeoutMs: 12000,
  });

  if (baseReport) {
    eligible = baseReport.ourWalletEligible ?? false;
    reason = baseReport.reason;
  } else {
    const fallback = assessDropEligibility(drop, walletAddr);
    eligible = fallback.ourWalletEligible ?? false;
    reason = fallback.reason;
  }

  // 3. Signed stages that are not a confirmed NO are still worth attempting:
  //    OpenSea only issues a per-wallet payload to allowlisted wallets, so a
  //    payload is itself evidence of eligibility. A confirmed NO skips the call.
  const confirmedIneligible = baseReport != null && baseReport.ourWalletEligible === false;
  if (!eligible && !confirmedIneligible && (mode === "signed" || mode === "allowlist")) {
    try {
      // Try with API key first (path A)
      signedPayload = await fetchSignedPayload(
        drop.nftContract,
        quantity,
        apiKey,
        { timeoutMs: 12000, walletAddress: wallet.address, slug: collectionSlug || undefined, chainKey },
      );

      if (signedPayload) {
        // OpenSea quoted a per-wallet price for this stage. A mismatch is worth
        // surfacing, but the units of GQL `eligiblePrice.token.unit` are not
        // documented, so we WARN rather than reject — a false rejection here
        // would silently skip a mint we were eligible for.
        if (baseReport?.priceWei != null) {
          const expectedWei = baseReport.priceWei * BigInt(quantity);
          if (signedPayload.value !== expectedWei) {
            console.warn(
              `    ⚠ Price mismatch for ${wallet.address}: payload value ${signedPayload.value} wei ` +
              `vs OpenSea quoted ${formatEther(baseReport.priceWei)} × ${quantity} = ${expectedWei} wei. Proceeding.`
            );
          }
        }
        eligible = true;
        reason = "Signed payload fetched successfully — wallet is allowlisted.";
      } else if (session) {
        // Use the per-wallet SIWE session from warmAllSessions
        signedPayload = await fetchSignedPayloadWithSession(
          drop.nftContract,
          quantity,
          session,
          apiKey,
          { timeoutMs: 12000, walletAddress: wallet.address, slug: collectionSlug || undefined, chainKey },
        );
        if (signedPayload) {
          eligible = true;
          reason = "Signed payload fetched with SIWE session — wallet is allowlisted.";
        } else {
          eligible = false;
          reason = "No signed payload available. Wallet may not be allowlisted, or needs a live session.";
        }
      } else {
        eligible = false;
        signedPayloadError = "No SIWE session available for wallet.";
        reason = "Signed payload requires OpenSea session (SIWE) — no session available.";
      }
    } catch (err: any) {
      if (err.message?.includes("rate-limited")) {
        signedPayloadError = err.message;
        eligible = false;
        reason = `OpenSea rate-limited the signed payload lookup. Retry in a few seconds.`;
      } else {
        signedPayloadError = err.message;
        eligible = false;
        reason = `Error fetching signed payload: ${err.message}`;
      }
    }
  }

  return {
    drop,
    signedPayload,
    signedPayloadError,
    priceWei: baseReport?.priceWei ?? null,
    eligible,
    reason,
    mode,
    fireableLocally,
    preFetchNeeded,
  };
}

// ── Eligibility report display ────────────────────────────────────────────────

function printEligibilityReport(
  walletEligibilities: WalletEligibility[],
  inventory: CollectionDropsInventory,
): void {
  console.log(chalk.bold.white("\n═══════════════════════════════════════════════════════════════"));
  console.log(chalk.bold.white("  ELIGIBILITY REPORT"));
  console.log(chalk.bold.white("═══════════════════════════════════════════════════════════════"));

  for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
    const we = walletEligibilities[wIdx];
    const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;

    const eligibleCount = we.phaseReports.filter((r) => r.eligible).length;
    const totalCount = we.phaseReports.length;

    console.log(chalk.bold(`\n  Wallet ${wIdx} — ${shortAddr} (${eligibleCount}/${totalCount} eligible)`));

    for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
      const report = we.phaseReports[pIdx];
      const drop = report.drop;
      // 0 means "unknown", never 1970-01-01.
      const startMs = drop.startTime > 0 ? drop.startTime * 1000 : null;
      const endMs = drop.endTime > 0 ? drop.endTime * 1000 : null;
      const now = Date.now();
      const isLive = startMs != null && endMs != null && now >= startMs && now < endMs;
      const notStarted = startMs != null && now < startMs;

      const liveBadge = isLive
        ? chalk.green("(LIVE)")
        : notStarted
          ? chalk.yellow("(future)")
          : endMs == null
            ? chalk.gray("(unknown window)")
            : chalk.gray("(ended)");

      const modeBadge =
        report.mode === "public"
          ? chalk.green("[PUBLIC]")
          : report.mode === "signed"
            ? chalk.blue("[SIGNED]")
            : report.mode === "allowlist"
              ? chalk.magenta("[ALLOWLIST]")
              : chalk.gray(`[${report.mode?.toUpperCase() || "UNKNOWN"}]`);

      // Distinguish "no" from "could not tell". A missing session or an
      // unresolved lookup is UNKNOWN — printing "NOT ELIGIBLE" for it is a
      // false verdict, and it is the difference between "wait" and "give up".
      const eligBadge = report.eligible
        ? chalk.green("✓ ELIGIBLE")
        : report.signedPayload
          ? chalk.green("✓ ELIGIBLE (signed)")
          : report.signedPayloadError?.includes("rate-limit")
            ? chalk.yellow("⚠ RATE-LIMITED")
            : report.signedPayloadError
              ? chalk.yellow("⚠ UNKNOWN — could not verify")
              : chalk.red("✗ NOT ELIGIBLE");

      console.log(chalk.gray(`    └─ Phase ${pIdx}: ${drop.name || "unnamed"} ${modeBadge} ${liveBadge} ${eligBadge}`));
      console.log(chalk.gray(`       type: ${drop.type || "unknown"} | price: ${formatEther(drop.mintPrice)} ETH`));
      console.log(chalk.gray(`       reason: ${report.reason}`));
      if (report.signedPayload && report.mode !== "public") {
        console.log(chalk.gray(`       signed: ✓ ${report.signedPayload.mintData.slice(0, 20)}…`));
      }
    }
  }

  // Summary: which wallet × phase combos are eligible
  console.log(chalk.bold.white("\n───────────────────────────────────────────────────────────────"));
  console.log(chalk.bold.white("  SUMMARY — Eligible targets"));
  console.log(chalk.bold.white("───────────────────────────────────────────────────────────────"));

  let hasEligible = false;
  for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
    const we = walletEligibilities[wIdx];
    const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;

    for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
      const report = we.phaseReports[pIdx];
      // A signed payload is as good as an eligibility verdict — it IS the
      // per-wallet authorisation. The old filter counted only `eligible`, so a
      // phase the badge called "✓ ELIGIBLE (signed)" was absent from the summary.
      if (report.eligible || report.signedPayload) {
        hasEligible = true;
        const drop = report.drop;
        const isLive = Date.now() >= drop.startTime * 1000 && Date.now() < drop.endTime * 1000;
        const liveStr = isLive ? chalk.green("LIVE") : chalk.yellow("waiting");
        console.log(
          chalk.gray(`    W${wIdx} ${shortAddr} → Phase ${pIdx}: ${drop.name || "unnamed"} [${report.mode}] ${liveStr}`)
        );
      }
    }
  }

  if (!hasEligible) {
    console.log(chalk.yellow("  No wallet×phase combinations are eligible right now."));
    console.log(chalk.gray("  Check allowlist status, or wait for a public phase to open."));
  }

  console.log(chalk.bold.white("───────────────────────────────────────────────────────────────\n"));
}

// ── Wallet + phase selection prompt ──────────────────────────────────────────

interface Selection {
  walletIndex: number;
  wallet: Wallet;
  phaseIndex: number;
}

async function promptWalletAndPhase(
  walletEligibilities: WalletEligibility[],
  walletKeys: string[],
  quantity: number,
): Promise<Selection | null> {
  // Build a flat list of all eligible wallet×phase combos
  const eligible: { wIdx: number; pIdx: number; price: bigint; mode: string; live: boolean }[] = [];

  for (let wIdx = 0; wIdx < walletEligibilities.length; wIdx++) {
    const we = walletEligibilities[wIdx];
    for (let pIdx = 0; pIdx < we.phaseReports.length; pIdx++) {
      const report = we.phaseReports[pIdx];
      if (report.eligible) {
        const price = report.mode === "public"
          ? report.drop.mintPrice * BigInt(quantity)
          : report.signedPayload?.value || report.drop.mintPrice * BigInt(quantity);
        const isLive = Date.now() >= report.drop.startTime * 1000 && Date.now() < report.drop.endTime * 1000;
        eligible.push({
          wIdx, pIdx,
          price,
          mode: report.mode,
          live: isLive,
        });
      }
    }
  }

  if (eligible.length === 0) {
    console.log(chalk.yellow("  No eligible wallet×phase combinations found."));
    console.log(chalk.gray("  Options:"));
    console.log(chalk.gray("    • Run the eligibility check with different wallets"));
    console.log(chalk.gray("    • Wait for a public phase to open (no allowlist needed)"));
    console.log(chalk.gray("    • Get an OpenSea API key + ensure wallet is on the allowlist"));
    return null;
  }

  console.log(chalk.bold.white("\nEligible targets:"));
  eligible.forEach((e, i) => {
    const we = walletEligibilities[e.wIdx];
    const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
    const drop = we.phaseReports[e.pIdx].drop;
    const liveStr = e.live ? chalk.green("LIVE") : chalk.gray("waiting");
    console.log(
      chalk.gray(`  [${i + 1}] Wallet ${e.wIdx} ${shortAddr} → ${drop.name || "unnamed"} ` +
        `[${e.mode}] ${liveStr} — ${formatEther(e.price)} ETH`)
    );
  });

  // Auto-select if there's only one eligible option
  if (eligible.length === 1) {
    const e = eligible[0];
    const we = walletEligibilities[e.wIdx];
    const shortAddr = `${we.walletAddress.slice(0, 6)}…${we.walletAddress.slice(-4)}`;
    console.log(chalk.green(`\n  ✓ Auto-selected: Wallet ${e.wIdx} ${shortAddr} → Phase ${e.pIdx}`));
    return {
      walletIndex: e.wIdx,
      wallet: new Wallet(walletKeys[e.wIdx]),
      phaseIndex: e.pIdx,
    };
  }

  // Prompt for selection
  const choice = await askText(
    chalk.gray(`  Select target (1-${eligible.length}, default 1): `)
  );
  let selectedIndex = 0;
  if (choice && choice.trim().length > 0) {
    const parsed = parseInt(choice.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= eligible.length) {
      selectedIndex = parsed - 1;
    } else {
      console.log(chalk.yellow(`  Invalid number — using first eligible target.`));
    }
  }

  const e = eligible[selectedIndex];
  return {
    walletIndex: e.wIdx,
    wallet: new Wallet(walletKeys[e.wIdx]),
    phaseIndex: e.pIdx,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function promptKeys(log: RunLogger, spec?: string | null): Promise<string[]> {
  console.log(chalk.bold.white("Private keys"));

  // A --wallets spec with a PRIVATE_KEY in the environment means the user has
  // already supplied keys non-interactively. Load them rather than prompting,
  // which is what makes a headless run possible.
  const envKeys = loadEnvKeys();
  if (envKeys.length > 0 && spec) {
    const selected = selectFromLoaded(envKeys, spec);
    console.log(chalk.gray(`  ${selected.length} wallet(s) from environment (${spec}).`));
    for (const w of selected) {
      console.log(chalk.green(`  ✓ ${w.address}`));
    }
    return selected.map((w) => w.privateKey);
  }
  if (envKeys.length > 0 && process.env.PRIVATE_KEY && !process.stdin.isTTY) {
    // Non-interactive stdin with a key present: use it rather than hanging on a
    // prompt that can never be answered.
    console.log(chalk.gray(`  ${envKeys.length} wallet(s) from environment.`));
    return envKeys.map((w) => w.privateKey);
  }

  console.log(chalk.gray("  Paste one key per line — typing is hidden. Blank line when done."));
  console.log(chalk.gray("  Each key is confirmed by its wallet address. Nothing is saved to disk."));

  const keys: string[] = [];
  const seen = new Set<string>();

  // A non-TTY stdin with no key in the environment can never be answered.
  // Without this check the loop below asks forever: askHidden returns "" on EOF,
  // keys.length stays 0, and `continue` re-asks — a silent hang that looks like
  // the tool is thinking. Fail with the fix instead.
  if (!process.stdin.isTTY && envKeys.length === 0) {
    throw new Error(
      "No wallet keys available. Set PRIVATE_KEY (or PRIVATE_KEYS) in the environment, " +
        "pass --wallets, or run interactively so keys can be pasted."
    );
  }

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (keys.length === 0) {
        console.log(chalk.red("  ✗ Need at least one key."));
        // A blank line on a non-TTY means EOF, not a user choosing to stop.
        // Re-asking here is the hang described above.
        if (!process.stdin.isTTY) {
          throw new Error(
            "No wallet keys available. Set PRIVATE_KEY (or PRIVATE_KEYS) in the environment, " +
              "pass --wallets, or run interactively so keys can be pasted."
          );
        }
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      console.log(chalk.red("  ✗ Not a valid private key — try again."));
      continue;
    }

    if (seen.has(wallet.address.toLowerCase())) {
      console.log(chalk.yellow(`  ⚠ Duplicate of ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)} — skipped.`));
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
  }

  // Store keys for wallet reconstruction during selection
  console.log(chalk.gray(`  ${keys.length} wallet(s) loaded.`));
  return keys;
}

// ── Environment wallet loading ──────────────────────────────────────────────
// Keys can be supplied non-interactively so a headless run is possible.
// Priority order: PRIVATE_KEY, then PRIVATE_KEYS, then WALLETS_FILE.

export interface LoadedWallet {
  address: string;
  privateKey: string;
}

export function loadEnvKeys(): LoadedWallet[] {
  const list: LoadedWallet[] = [];
  const seen = new Set<string>();
  const add = (pk: string | undefined) => {
    if (!pk || typeof pk !== "string") return;
    let w: Wallet;
    try {
      w = new Wallet(pk.trim());
    } catch {
      return;
    }
    if (seen.has(w.address.toLowerCase())) return;
    seen.add(w.address.toLowerCase());
    list.push({ address: w.address, privateKey: pk.trim() });
  };

  add(process.env.PRIVATE_KEY);
  (process.env.PRIVATE_KEYS || "").split(",").forEach(add);

  const file = process.env.WALLETS_FILE || "wallets.json";
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const arr = Array.isArray(j) ? j : j.wallets || [];
      for (const e of arr) add(typeof e === "string" ? e : e.pk || e.privateKey);
    }
  } catch {
    // A malformed wallets file is not fatal — fall back to the env keys.
  }

  return list;
}

/**
 * Select a subset by spec: all | * | N | 1,3,4 (1-based).
 */
export function selectFromLoaded(all: LoadedWallet[], spec: string): LoadedWallet[] {
  if (!all.length) return [];
  const s = String(spec).trim().toLowerCase();
  if (s === "all" || s === "*") return all;
  if (/^\d+$/.test(s)) return all.slice(0, Math.max(1, Math.min(Number(s), all.length)));
  if (/^[0-9,\s]+$/.test(s)) {
    const idx = s
      .split(",")
      .map((x) => Number(x.trim()) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < all.length);
    if (idx.length) return idx.map((i) => all[i]);
  }
  return [all[0]];
}

async function promptQuantity(walletCount: number): Promise<number> {
  console.log(chalk.bold.white("\nQuantity"));
  const qty = await askNumber("NFTs per wallet", 1, { min: 1, max: 100 });
  if (walletCount > 1) {
    console.log(chalk.gray(`  → ${qty} × ${walletCount} wallets = ${qty * walletCount} total`));
  }
  return Math.floor(qty);
}

async function promptTarget(
  log: RunLogger,
  chainKey: string,
  prefill?: string | null,
  apiKey?: string,
): Promise<{ contract: string; label: string; chainKey: string; resolved: ResolvedTarget | null }> {
  console.log(chalk.bold.white("\nNFT target"));
  console.log(
    chalk.gray(
      "  Paste an OpenSea, Scatter, Zora or Manifold link, a collection slug, or a contract address."
    )
  );
  console.log(chalk.gray("  Chain aliases work too: \"0xabc… on base\", \"slug matic\", \"--chain arb\"."));

  let activeChain = chainKey;

  for (;;) {
    const raw = prefill ?? (await askText("NFT link"));
    // A pre-filled target is tried once; if it fails, fall through to the
    // prompt so the user can correct it rather than the run just dying.
    prefill = null;
    if (!raw) {
      console.log(chalk.red("  ✗ Paste a link, slug, or address."));
      continue;
    }

    let parsed;
    try {
      parsed = parseTarget(raw);
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      continue;
    }

    // A chain named in the input overrides the one chosen at the top — the user
    // typed it, so it is the more specific instruction.
    const namedChain = parsed.chain ? chainSlug(parsed.chain) : undefined;
    if (namedChain && resolveChain(namedChain)) {
      if (namedChain !== activeChain) {
        console.log(chalk.gray(`  ↳ Chain set to ${resolveChain(namedChain)!.name} (from input)`));
        activeChain = namedChain;
      }
    } else if (parsed.chain) {
      console.log(chalk.yellow(`  ⚠ Unknown chain "${parsed.chain}" — using ${resolveChain(activeChain)!.name}.`));
    }

    // Manifold cannot be resolved to a contract from a claim slug. Say so
    // immediately rather than letting the user wait through a failed lookup.
    if (parsed.platform === "manifold") {
      console.log(
        chalk.red(
          `  ✗ Manifold claim "${parsed.claimId}" cannot be resolved automatically — Manifold claims need the claim contract address.`
        )
      );
      console.log(chalk.gray("    Paste the 0x… contract address instead."));
      continue;
    }

    // Resolve to a concrete contract. This is where a bare slug gets disambiguated
    // between OpenSea and Scatter.
    let resolved: ResolvedTarget | null = null;
    try {
      resolved = await resolveTarget(parsed, apiKey || "", activeChain);
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Resolution issue: ${err.message}`));
    }

    // A bare address resolves trivially — resolveTarget returns it unchanged
    // without any lookup. Confirm it is a contract on the selected chain before
    // accepting it, so a wallet address or a dead link is caught here rather
    // than after a full discovery pass.
    if (resolved && parsed.platform === "direct") {
      const v = await verifyContract(resolved.contract, resolveChain(resolved.chainKey)!.chainId);
      if (!v.isContract) {
        console.log(chalk.red(`  ✗ ${resolved.contract} is not a contract on ${resolveChain(resolved.chainKey)?.name} (${v.reason}).`));
        continue;
      }
      console.log(chalk.green(`  ✓ Verified contract on ${resolveChain(resolved.chainKey)?.name} (${v.reason})`));
    }

    if (!resolved) {
      console.log(
        chalk.red(
          `  ✗ Could not resolve "${raw}" — the collection may not exist, or it needs an OpenSea API key.`
        )
      );
      continue;
    }

    const label =
      resolved.platform === "scatter"
        ? `${resolved.scatter?.name ?? resolved.slug} (Scatter)`
        : resolved.platform === "opensea" && resolved.slug
          ? `${resolved.slug} (OpenSea)`
          : resolved.contract;

    console.log(
      chalk.green(
        `  ✓ ${resolved.platform.toUpperCase()} — ${label} on ${resolveChain(resolved.chainKey)?.name ?? resolved.chainKey}`
      )
    );
    if (resolved.resolvedViaFallback) {
      console.log(chalk.gray("    (resolved via fallback — verify the contract before minting)"));
    }

    return { contract: resolved.contract, label, chainKey: resolved.chainKey, resolved };
  }
}

async function promptRpc(chainProfile: ChainProfile): Promise<string[]> {
  const envUrls = privateRpcsFromEnv(chainProfile.key);
  if (envUrls.length > 0) {
    console.log(chalk.gray(`  Using ${envUrls.length} endpoint(s) from .env (RPC_URL_${chainProfile.key.toUpperCase()}):`));
    for (const u of envUrls) console.log(chalk.gray(`    ${maskRpc(u)}`));
    return envUrls;
  }

  // No .env RPCs — use the public endpoints from chains.ts, silently.
  console.log(chalk.gray(`  No .env RPC configured for ${chainProfile.name} — using public endpoints.`));
  return chainProfile.rpc.public;
}

function printBanner(): void {
  console.log(
    chalk.bold.white(`\n╔${"═".repeat(58)}╗\n║  NFT MINT SNIPER — Universal (public + signed + allowlist)  ║\n╚${"═".repeat(58)}╝`),
  );
  console.log(chalk.gray("  Probes wallet eligibility across all phases before minting.\n"));
}

function labelOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
