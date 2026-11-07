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
  orderDropsByStartTime,
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
  SnipeReadyInput,
} from "./wizard-helpers";
import { getValidApiKey } from "./opensea-key";
import { getSessionCookies } from "./opensea-session";
import {
  getDropEligibility,
  fetchRestEligibility,
  DropEligibilityResult,
} from "./opensea-gql";
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
  // GQL DropEligibilityQuery result (authenticated per-stage isEligible)
  dropEligibilityInfo: DropEligibilityResult | null;
  // REST GET /api/v2/drops/{slug}/eligibility result (fallback when GQL is
  // rate-limited or the eligibility fields come back UNAUTHORIZED)
  restEligibility: Awaited<ReturnType<typeof fetchRestEligibility>>;
  // Eligibility verdict
  eligible: boolean;
  reason: string;
  // Mode for this wallet+phase combo
  mode: "public" | "signed" | "allowlist" | "token-gated" | "unknown";
  fireableLocally: boolean;
  preFetchNeeded: boolean;
}

// ── Main wizard entry point ──────────────────────────────────────────────────

export async function runWizard(log: RunLogger): Promise<void> {
  log.info("Wizard: started");
  log.field("startup_mode", "interactive");
  log.field("chain_env", process.env.CHAIN || "<unset>");
  log.field("api_key_set", !!(process.env.OPENSEA_API_KEY));
  log.field("rpc_env", process.env[`RPC_URL_${(process.env.CHAIN || "base").toUpperCase()}`] || "<unset>");

  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  log.info("Wizard: prompting for keys");
  const walletKeys = await promptKeys(log);
  log.field("wallet_count", walletKeys.length);
  if (walletKeys.length === 0) {
    throw new Error("No wallet keys provided.");
  }
  const wallets = walletKeys.map((k) => new Wallet(k));

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "Which chain?",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(
      0,
      CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())
    )
  );
  log.field("chain", chainKey);
  const chainProfile = resolveChain(chainKey)!;

  // ── 3. Quantity ───────────────────────────────────────────────────────
  const quantity = await promptQuantity(walletKeys.length);
  log.field("quantity", quantity);
  if (quantity <= 0) {
    throw new Error("Quantity must be at least 1. Aborting.");
  }

  // ── 4. NFT target ──────────────────────────────────────────────────────
  const target = await promptTarget(log, chainKey);
  const nftInput = target.contract;
  chainKey = target.chainKey;
  log.field("nft_input", nftInput);
  log.field("label", target.label);

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
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
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
  const provider = new JsonRpcProvider(rpcUrls[0]);

  // ── 6. Resolve slug + API key ────────────────────────────────────────────
  // Need the slug for OpenSea drops endpoint access. If user gave a CA, resolve it.
  console.log(chalk.bold.white("\nOpenSea API key + slug resolution"));
  console.log(chalk.gray("  Checking for a usable key..."));

  const keyResult = await getValidApiKey({ timeoutMs: 8000 });
  const apiKey = keyResult?.api_key || undefined;
  const apiKeySource = keyResult?.source || "none";
  console.log(chalk.gray(`  Key source: ${apiKeySource}`));

  if (keyResult) {
    console.log(chalk.green(`  ✓ Key ready: ${keyResult.source}`));
  } else {
    console.log(chalk.yellow(`  ⚠ No usable OpenSea key available.`));
    console.log(chalk.gray(`    Phase inventory will still be fetched, but signed`));
    console.log(chalk.gray(`    mint data may be missing. You'll need a key for`));
    console.log(chalk.gray(`    allowlist/FCFS phases. Public mint doesn't need one.\n`));
  }

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

  // ── 7. Warm SIWE sessions for ALL wallets ──────────────────────────────
  // Each wallet needs its own OpenSea session for eligibility + signed payload
  // fetching. The session warming is parallelizable — do it for all wallets.
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

  // ── 8. Discover ALL phases ─────────────────────────────────────────────
  // Fetch from OpenSea GraphQL first (primary), then REST, then on-chain SeaDrop
  // discovery for collections not registered on OpenSea.
  console.log(chalk.bold.white("\nPhase discovery"));
  console.log(chalk.gray(`  Fetching all active phases for ${target.label}...`));

  const inventory = await discoverAllPhases(nftInput, slug, apiKey, chainKey, 12000);
  log.field("phases_found", inventory.drops.length);

  if (inventory.drops.length === 0) {
    throw new Error(
      `No mint phases found for ${nftInput}.\n` +
        `  Tried: OpenSea REST/GraphQL + on-chain SeaDrop probe.\n` +
        `  This may not be a SeaDrop collection, or it may need an OpenSea API key.\n` +
        `  Try: paste the OpenSea collection page URL directly.`
    );
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

  // ── 12. Gas ──────────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\nGas"));
  const gas = await promptGasGwei(chainProfile, rpcUrls);

  // ── 13. Timing ──────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(
    new Date(selectedDrop.startTime * 1000)
  );

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

  // ── 16. Execute ──────────────────────────────────────────────────────────
  if (phaseEligibility.mode === "public") {
    // Public phase — on-chain calldata, no OpenSea needed
    const localPlan = await buildLocalMintPlan(rpcUrls[0], nftInput, quantity);
    if (!localPlan) {
      throw new Error("Could not build local mint plan for public phase.");
    }

    await localPublicSnipe({
      nftContract: nftInput,
      quantity,
      walletKeys,
      rpcUrls,
      maxFeePerGas: gas.maxFeePerGasWei,
      maxPriorityFee: gas.maxPriorityFeePerGasWei,
      gasLimit: gas.defaultGasLimit,
      targetStart: targetStart || new Date(selectedDrop.startTime * 1000),
      plan: localPlan,
    });
  } else {
    // Signed/allowlist phase — needs OpenSea signed payload
    if (!phaseEligibility.signedPayload) {
      throw new Error(
        `Signed payload unavailable for phase "${selectedDrop.name || "selected"}".\n` +
          `  OpenSea did not return wallet-specific signed data.\n` +
          `  Get an OpenSea API key and ensure your wallet is allowlisted.\n` +
          `  Or switch to a public phase if one is available.`
      );
    }

    const payload = phaseEligibility.signedPayload;
    const mintPlan = buildFcfsMintPlan(
      payload, gas.defaultGasLimit, gas.maxFeePerGasWei, gas.maxPriorityFeePerGasWei, quantity
    );

    // Pre-fetch a signed payload for EVERY wallet now, while the drop is still
    // future. mintSignature is wallet-specific, so each wallet needs its own.
    // Passing these in keeps the T-0 path free of API calls.
    console.log(chalk.gray(`\n  Pre-fetching signed payloads for ${walletKeys.length} wallet(s)...`));
    const preFetched: (FcfsSignedPayload | null)[] = [];
    for (let i = 0; i < walletKeys.length; i++) {
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

    await executeFcfsSnipe({
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
    });
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
    } else if (!apiKey) {
      // Try single-contract on-chain drop as last resort
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
  // Soonest-starting phase first. The wizard's phase picker indexes into this
  // array, and the pre-fetch loop walks it in order — an unsorted inventory
  // means the sniper can target a later phase while an earlier one opens.
  const orderedDrops = orderDropsByStartTime(inventory.drops);

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

  // 2. Determine eligibility
  let eligible = false;
  let reason = "";
  let signedPayload: FcfsSignedPayload | null = null;
  let signedPayloadError: string | null = null;
  let dropEligibilityInfo: DropEligibilityResult | null = null;
  let restEligibility: Awaited<ReturnType<typeof fetchRestEligibility>> = null;

  if (mode === "public") {
    // Public phase — always eligible (on-chain, no allowlist)
    eligible = true;
    reason = "Public phase — open to all, no allowlist required.";
  } else if (mode === "signed" || mode === "allowlist") {
    // Non-public phase — check per-stage eligibility. Two documented paths:
    //   1. GQL DropEligibilityQuery (richer: names the eligible wallet, quotes
    //      a per-wallet price). Requires a wallet JWT.
    //   2. REST GET /api/v2/drops/{slug}/eligibility (the API's own endpoint;
    //      same JWT requirement, simpler response).
    // Try GQL first, then REST, and use whichever answers. Both need a session.
    if (collectionSlug && session) {
      const cookie = sessionToStoredSessionCookie(session);
      try {
        dropEligibilityInfo = await getDropEligibility(
          collectionSlug,
          walletAddr,
          cookie,
          apiKey,
          12000,
        );
      } catch {
        dropEligibilityInfo = null;
      }

      // REST fallback when GQL yielded nothing usable (rate-limited, or the
      // eligibility fields came back UNAUTHORIZED).
      if (!dropEligibilityInfo || !dropEligibilityInfo.authed) {
        const rest = await fetchRestEligibility(collectionSlug, cookie, apiKey, 12000);
        if (rest) {
          restEligibility = rest;
          console.log(
            chalk.gray(`    REST eligibility: ${rest.stages.filter((s) => s.isEligible).length}/${rest.stages.length} stage(s) eligible`)
          );
        }
      }
    }

    // Check if GQL already confirmed the wallet is NOT eligible for any stage.
    if (dropEligibilityInfo && dropEligibilityInfo.authed) {
      // OpenSea names the wallet each stage's eligibility belongs to. If it
      // names a different address, this result is not about our wallet and the
      // isEligible flags must not be trusted.
      const foreignStage = dropEligibilityInfo.stages.find(
        (s) => s.eligibleMinterAddress &&
          s.eligibleMinterAddress.toLowerCase() !== walletAddr.toLowerCase()
      );
      if (foreignStage) {
        eligible = false;
        reason = `GQL DropEligibilityQuery returned eligibility for ${foreignStage.eligibleMinterAddress}, not ${walletAddr} — ignoring.`;
      } else {
        const anyEligible = dropEligibilityInfo.stages.some((s) => s.isEligible === true);
        if (!anyEligible) {
          eligible = false;
          reason = "GQL DropEligibilityQuery: wallet is authenticated but not eligible for any stage.";
          // Skip the signed payload fetch — wallet is confirmed not allowlisted.
        } else {
          eligible = true;
          reason = "GQL DropEligibilityQuery: wallet is eligible for at least one stage.";
        }
      }
    } else if (restEligibility) {
      // GQL gave nothing usable; the REST endpoint answered. It is
      // wallet-scoped (the JWT identifies the wallet), so a positive result
      // is authoritative.
      const anyEligible = restEligibility.stages.some((s) => s.isEligible);
      if (anyEligible) {
        eligible = true;
        reason = "REST eligibility: wallet is eligible for at least one stage.";
      } else {
        eligible = false;
        reason = "REST eligibility: wallet is not eligible for any stage.";
      }
    }

    // If not already resolved by GQL pre-check, try to fetch signed payload
    if (!eligible) {
      // Non-public phase — try to fetch signed payload for this specific wallet
      // Use the slug if available for better slug→CA resolution
      try {
        // Try with API key first (path A)
        signedPayload = await fetchSignedPayload(
          drop.nftContract,
          quantity,
          apiKey,
          { timeoutMs: 12000, walletAddress: wallet.address, slug: collectionSlug || undefined, chainKey },
        );

        if (signedPayload) {
          // OpenSea quoted a per-wallet price for this stage. A mismatch is
          // worth surfacing, but the units of GQL `eligiblePrice.token.unit`
          // are not documented, so we WARN rather than reject — a false
          // rejection here would silently skip a mint we were eligible for.
          // TODO: confirm the unit (wei vs ETH) against a live drop, then
          // promote this to a hard check.
          const quoted = dropEligibilityInfo?.stages.find(
            (s) => s.isEligible === true && s.priceUnit != null
          )?.priceUnit;
          if (quoted != null) {
            const expectedWei = BigInt(quoted) * BigInt(quantity);
            if (signedPayload.value !== expectedWei) {
              console.warn(
                `    ⚠ Price mismatch for ${wallet.address}: payload value ${signedPayload.value} wei ` +
                `vs OpenSea quoted ${quoted} × ${quantity} = ${expectedWei} wei. Proceeding.`
              );
            }
          }
          eligible = true;
          reason = "Signed payload fetched successfully — wallet is allowlisted.";
        } else {
          // Use the per-wallet SIWE session from warmAllSessions
          if (session) {
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
  } else if (mode === "token-gated") {
    // Token-gated — check if wallet holds the gate token
    // On-chain phases don't have gate token info; need OpenSea metadata
    const baseReport = assessDropEligibility(drop, walletAddr);
    eligible = baseReport.ourWalletEligible ?? false;
    reason = baseReport.reason;
  } else {
    // Unknown mode — use base eligibility
    const baseReport = assessDropEligibility(drop, walletAddr);
    eligible = baseReport.ourWalletEligible ?? false;
    reason = baseReport.reason;
  }

  return {
    drop,
    signedPayload,
    signedPayloadError,
    dropEligibilityInfo,
    restEligibility,
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
      const startsAt = new Date(drop.startTime * 1000);
      const endsAt = new Date(drop.endTime * 1000);
      const now = Date.now();
      const isLive = now >= drop.startTime * 1000 && now < drop.endTime * 1000;

      const liveBadge = isLive
        ? chalk.green("(LIVE)")
        : now < drop.startTime * 1000
          ? chalk.yellow("(future)")
          : chalk.gray("(ended)");

      const modeBadge =
        report.mode === "public"
          ? chalk.green("[PUBLIC]")
          : report.mode === "signed"
            ? chalk.blue("[SIGNED]")
            : report.mode === "allowlist"
              ? chalk.magenta("[ALLOWLIST]")
              : chalk.gray(`[${report.mode?.toUpperCase() || "UNKNOWN"}]`);

      const eligBadge = report.eligible
        ? chalk.green("✓ ELIGIBLE")
        : report.signedPayloadError?.includes("rate-limit")
          ? chalk.yellow("⚠ RATE-LIMITED")
          : report.signedPayload
            ? chalk.green("✓ ELIGIBLE (signed)")
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
      if (report.eligible) {
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

async function promptKeys(log: RunLogger): Promise<string[]> {
  console.log(chalk.bold.white("Private keys"));
  console.log(chalk.gray("  Paste one key per line — typing is hidden. Blank line when done."));
  console.log(chalk.gray("  Each key is confirmed by its wallet address. Nothing is saved to disk."));

  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (keys.length === 0) {
        console.log(chalk.red("  ✗ Need at least one key."));
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
): Promise<{ contract: string; label: string; chainKey: string }> {
  console.log(chalk.bold.white("\nNFT target"));
  console.log(chalk.gray("  Paste the OpenSea link (collection or item), a slug, or the contract address."));

  let activeChain = chainKey;

  for (;;) {
    const raw = await askText("NFT link");
    if (!raw) {
      console.log(chalk.red("  ✗ Paste a link, slug, or address."));
      continue;
    }

    let parsed;
    try {
      parsed = parseNftLink(raw);
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      continue;
    }

    if (parsed.chainHint && parsed.chainHint !== activeChain && resolveChain(parsed.chainHint)) {
      const hinted = resolveChain(parsed.chainHint)!;
      console.log(
        chalk.yellow(`  ⚠ This link points at ${hinted.name}, but you selected ${resolveChain(activeChain)!.name}.`)
      );
      if (await askYesNo(`Switch to ${hinted.name}?`, true)) {
        activeChain = hinted.key;
        console.log(chalk.green(`  ✓ Chain switched to ${hinted.name}`));
      }
    }

    if (parsed.kind === "address") {
      return { contract: parsed.value, label: parsed.value, chainKey: activeChain };
    }

    if (parsed.kind === "slug") {
      const slug = parsed.value;
      const chainForSlug = parsed.chainHint || activeChain;
      const chainProfile = resolveChain(chainForSlug);
      if (!chainProfile) {
        console.log(chalk.red(`  ✗ Unknown chain "${parsed.chainHint || '?'}' for slug "${slug}".`));
        continue;
      }
      console.log(chalk.gray(`  ↳ Resolved slug "${slug}" on ${chainProfile.name}`));
      return { contract: slug, label: slug, chainKey: chainForSlug };
    }

    console.log(chalk.red("  ✗ Could not parse that input — paste a link, slug, or address."));
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

function formatRemaining(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  const block = await provider.getBlock("latest");
  if (!block) return null;
  const baseFee = block.baseFeePerGas;
  if (!baseFee) return null;
  return Number(baseFee) / 1e9;
}
