// Interactive public-mint wizard.
//
// Every transaction here is built from on-chain SeaDrop state — price, fee
// recipient and per-wallet cap all come from the contract — so no OpenSea
// account, token or API key is involved in the mint itself.
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
import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, ChainProfile, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug, resolveContractToSlug } from "./slug-resolver";
import {
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
  toRpcUrl,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import { DropPhase, fetchAllActiveDrops } from "./fcfs-drops";
import { buildLocalMintPlan, LocalMintPlan } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { istTimeToDate, toIST } from "./time-format";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";

export async function runWizard(): Promise<void> {
  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  const walletKeys = await promptKeys();

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "Which chain?",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(
      0,
      CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())
    )
  );

  // ── 3. Quantity ───────────────────────────────────────────────────────
  const quantity = await promptQuantity(walletKeys.length);

  // ── 4. NFT link ───────────────────────────────────────────────────────
  const target = await promptTarget(chainKey);
  const nftContract = target.contract;
  chainKey = target.chainKey;
  const chainProfile = resolveChain(chainKey)!;

  // ── 5. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
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

  // ── 6. Read the public drop from chain ────────────────────────────────
  console.log(chalk.bold.white("\nDrop"));
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!mintPlan) {
    throw new Error(
      `No SeaDrop public drop readable for ${nftContract} on ${chainProfile.name}.\n` +
        "  Either it isn't a SeaDrop collection, or it keeps its drop config on the token contract."
    );
  }

  const drop = mintPlan.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = Date.now() >= startsAt.getTime() && Date.now() < endsAt.getTime();

  console.log(chalk.green("  ✓ Built calldata from on-chain SeaDrop — no OpenSea token needed"));
  console.log(chalk.gray(`    Fee recipient: ${mintPlan.feeRecipient}`));
  console.log(
    chalk.gray(
      `    Price:         ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(mintPlan.value)} per wallet`
    )
  );
  console.log(chalk.gray(`    Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`));
  console.log(
    chalk.gray(
      `    Window:        ${toIST(startsAt)} → ${toIST(endsAt)} IST  ${live ? chalk.green("(live)") : chalk.yellow(`(opens in ${formatRemaining(startsAt.getTime() - Date.now())})`)}`
    )
  );

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    console.log(
      chalk.yellow(`  ⚠ This drop allows only ${drop.maxTotalMintableByWallet} per wallet — ${quantity} will revert.`)
    );
  }
  if (Date.now() >= endsAt.getTime()) {
    console.log(chalk.yellow("  ⚠ This public stage has already ended on-chain."));
  }

  // ── 6b. Phase discovery (public + allowlist/FCFS/OVR) ──────────────────
  // Fetch all OpenSea-managed stages for this collection without a key for the
  // metadata query. Classify each: public (on-chain, no key needed) vs private
  // (needs signed payload). Pattern from osnm-z.
  console.log(chalk.bold.white("\nPhases"));
  let allDrops: DropPhase[] = [];
  let discoverySource = "on-chain SeaDrop check only";
  let resolvedSlug: string | null = null;

  // Try OpenSea REST metadata query (no key needed for discovery)
  try {
    const inv = await fetchAllActiveDrops(nftContract, undefined, 10000);
    if (inv.drops.length > 0) {
      allDrops = inv.drops;
      discoverySource = inv.apiKeyUsed
        ? "OpenSea (with key)"
        : "OpenSea (no key)";
    } else if (inv.notFoundReason === "not_found") {
      discoverySource = "OpenSea: collection not found";
    } else if (inv.notFoundReason === "key_required") {
      discoverySource = "OpenSea: key required for this collection";
    }
  } catch (_err) {
    discoverySource = "OpenSea: unavailable — on-chain only";
  }

  // If OpenSea didn't find anything but we have a contract address, try
  // resolving CA → slug and re-query with the slug
  if (nftContract.startsWith("0x") && allDrops.length === 0) {
    const slug = await resolveContractToSlug(nftContract, undefined, 10000);
    if (slug) {
      console.log(chalk.gray(`  ↳ Resolved CA → slug "${slug}"`));
      resolvedSlug = slug;
      try {
        const inv2 = await fetchAllActiveDrops(nftContract, undefined, 10000, slug);
        if (inv2.drops.length > 0) {
          allDrops = inv2.drops;
          discoverySource = inv2.apiKeyUsed
            ? "OpenSea (with key)"
            : "OpenSea (no key)";
        } else {
          console.log(chalk.yellow(`  OpenSea knows this collection ("${slug}") but found no active drops.`));
          discoverySource = `OpenSea: known collection "${slug}", no active drops`;
        }
      } catch (_) {}
    } else {
      console.log(chalk.yellow(`  Could not resolve CA → slug (OpenSea may need a key for this collection).`));
      discoverySource = "OpenSea: CA → slug resolution failed (may need API key)";
    }
  }

  // Merge: OpenSea-discovered phases + on-chain public drop info
  const publicPhases = allDrops.filter((d) => d.isPublicStage);
  const privatePhases = allDrops.filter((d) => !d.isPublicStage);

  // If OpenSea didn't find anything but on-chain has a public drop, create
  // a synthetic phase for it
  if (allDrops.length === 0 && mintPlan) {
    allDrops.push({
      dropId: "on-chain-public",
      nftContract,
      name: "Public mint (on-chain)",
      type: "public",
      startTime: mintPlan.drop.startTime,
      endTime: mintPlan.drop.endTime,
      mintPrice: mintPlan.drop.mintPrice,
      maxTotalMintableByWallet: mintPlan.drop.maxTotalMintableByWallet,
      maxTotalMintable: -1,
      totalMinted: 0,
      feeBps: mintPlan.drop.feeBps,
      feeRecipient: mintPlan.feeRecipient,
      mintData: null,
      mintSignature: null,
      gasLimit: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      eligible: true,
      eligibleCount: null,
      totalAllocated: null,
      allowlistedAddresses: [],
      allowlistHash: null,
      raw: {},
      isPublicStage: true,
    });
    publicPhases.push(allDrops[0]);
  }

  if (allDrops.length === 0) {
    console.log(chalk.gray(`  Source: ${discoverySource}`));
    if (!mintPlan) {
      throw new Error(
        `No mint phases found for ${nftContract}.\n` +
          `  Tried: OpenSea metadata (no key) + on-chain SeaDrop.\n` +
          `  This may not be a SeaDrop collection, or it may need an OpenSea API key for discovery.\n` +
          `  Try: paste the contract address directly, or get a free OpenSea key.\n` +
          `  If it has an allowlist/FCFS phase, switch to Allowlist/FCFS mode and provide a key.`
      );
    }
  }

  // Display discovered phases
  console.log(chalk.gray(`  Source: ${discoverySource}`));
  console.log(chalk.gray(`  Found ${allDrops.length} phase(s): ${publicPhases.length} public, ${privatePhases.length} private`));

  if (privatePhases.length > 0) {
    console.log(chalk.yellow(`  ⚠ ${privatePhases.length} private phase(s) need an OpenSea API key for eligibility + signed payload.`));
    console.log(chalk.gray(`    Get a free key: https://docs.opensea.io/reference/api-keys`));
  }

  for (let i = 0; i < allDrops.length; i++) {
    const d = allDrops[i];
    const startsAt = new Date(d.startTime * 1000);
    const endsAt = new Date(d.endTime * 1000);
    const now = Date.now();
    const live = now >= startsAt.getTime() && now < endsAt.getTime();
    const label = d.isPublicStage
      ? chalk.green(`[PUBLIC] ${d.name || "unnamed"}`)
      : chalk.yellow(`[PRIVATE] ${d.name || "unnamed"}`);
    console.log(chalk.gray(`  ${i + 1}. ${label}`));
    console.log(chalk.gray(`     type:     ${d.type || d.raw.stage_type || "unknown"}`));
    console.log(chalk.gray(`     window:   ${toIST(startsAt)} → ${toIST(endsAt)} IST ${live ? chalk.green("(live)") : ""}`));
    console.log(chalk.gray(`     price:    ${formatEther(d.mintPrice)} ETH`));
    console.log(chalk.gray(`     per wall: ${d.maxTotalMintableByWallet || "unlimited"}${d.maxTotalMintable > 0 ? `, ${d.maxTotalMintable} total` : ""}`));
    if (d.isPublicStage) {
      console.log(chalk.green(`     On-chain targetable — no OpenSea key needed`));
    } else {
      console.log(chalk.yellow(`     Needs OpenSea signed payload — key required to mint`));
    }
    console.log();
  }

  // Pick: auto-select if exactly one live public phase, else let user choose
  const selectable = allDrops
    .map((d, i) => ({ drop: d, index: i, live: Date.now() >= d.startTime * 1000 && Date.now() < d.endTime * 1000 }))
    .filter((p) => p.drop.isPublicStage || (p.drop.mintData && p.drop.mintSignature))
    .filter((p) => p.live || p.drop.startTime * 1000 > Date.now());

  let selectedDrop: DropPhase;
  if (selectable.length === 1 && selectable[0].drop.isPublicStage) {
    selectedDrop = selectable[0].drop;
    console.log(chalk.green(`  ✓ Auto-selected: ${selectedDrop.name || "public phase"} (only public option)`));
  } else if (selectable.length > 0) {
    const pick = await askChoice<number>(
      "Select a phase to mint",
      selectable.map((p, i) => ({
        label: `${i + 1}. ${p.drop.name || "unnamed"} [${p.drop.isPublicStage ? "PUBLIC" : "PRIVATE"}]`,
        value: p.index,
        hint: p.drop.isPublicStage
          ? "on-chain, no key needed"
          : "needs OpenSea key + signed payload",
      })),
      0
    );
    selectedDrop = allDrops[pick];
  } else {
    throw new Error("No selectable phase found for this collection.");
  }

  // ── 7. Gas ────────────────────────────────────────────────────────────
  const provider = new JsonRpcProvider(rpcUrls[0]);
  console.log(chalk.bold.white("\nGas"));
  const baseFeeGwei = await currentBaseFeeGwei(provider);
  if (baseFeeGwei !== null) {
    console.log(chalk.gray(`  Network base fee right now: ${baseFeeGwei.toFixed(6)} gwei`));
  }

  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));

  // A ceiling under the base fee is rejected outright by every node, so it must
  // not be enterable at all.
  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    console.log(chalk.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`));
  }

  const maxFeeGwei = await askNumber("Max fee per gas (gwei) — your ceiling", defaultMaxFee, {
    min: baseFeeGwei ?? 0,
  });

  // EIP-1559 caps the tip at the ceiling; ethers refuses to sign otherwise.
  const priorityDefault = Math.min(envPriority, maxFeeGwei);
  const priorityGwei = await askNumber("Priority fee / tip (gwei)", priorityDefault, {
    min: 0,
    max: maxFeeGwei,
  });

  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── 8. Timing ─────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(drop.startTime);

  // ── 9. Balances + affordability ───────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const wallets = walletKeys.map((k) => new Wallet(k));
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
  const symbol = chainProfile.nativeSymbol;

  // Nodes reserve gasLimit × maxFee + value upfront and reject if the balance
  // falls short, regardless of the far smaller amount actually spent.
  const required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;

  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unavailable" : `${Number(formatEther(bal)).toFixed(6)} ${symbol}`;
    const short = bal !== null && bal < required;
    const line = `  [W${i}] ${w.address}  ${text}`;
    console.log(short ? chalk.red(`${line}  ✗ needs ${formatEther(required)}`) : chalk.gray(line));
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required);
  if (shortWallets.length > 0) {
    console.log(
      chalk.gray(
        `\n  Nodes require gasLimit × maxFee${mintPlan.value > 0n ? " + mint price" : ""} = ${formatEther(required)} ${symbol} held per wallet.`
      )
    );
    const poorest = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a < b ? a : b));
    const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
    if (affordable > 0) {
      console.log(
        chalk.yellow(`  Either fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`)
      );
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    console.log(chalk.yellow("  The remaining wallet(s) can still fire."));
  }

  // ── 10. Confirm ───────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n──────── READY ────────"));
  line("Chain", `${chainProfile.name} (${chainProfile.chainId})`);
  line("RPC", `${labelOf(rpcUrls[0])} + ${rpcUrls.length - 1} more`);
  line("Target", target.label);
  line("Contract", nftContract);
  line("Wallets", `${wallets.length}`);
  line("Quantity", `${quantity} per wallet → ${quantity * wallets.length} total`);
  line(
    "Mint cost",
    `${formatEther(mintPlan.value)} per wallet → ${formatEther(mintPlan.value * BigInt(wallets.length))} total (+ gas)`
  );
  line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
  line("Timing", timingLabel);
  console.log(chalk.bold.white("───────────────────────"));

  if (!(await askYesNo(chalk.bold("Fire?"), false))) {
    console.log(chalk.yellow("\n  Aborted — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  await localPublicSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

// ── Steps ───────────────────────────────────────────────────────────────

async function promptKeys(): Promise<string[]> {
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
      console.log(chalk.yellow(`  ⚠ Duplicate of ${short(wallet.address)} — skipped.`));
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
  }

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
  chainKey: string
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
      const normalized = normalizeAddress(parsed.value);
      if (!normalized) {
        console.log(chalk.red(`  ✗ "${parsed.value}" is not a 20-byte address.`));
        continue;
      }
      if (normalized.checksumWarning) {
        console.log(chalk.yellow("  ⚠ Mixed-case address whose EIP-55 checksum doesn't match — likely a typo."));
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      console.log(chalk.green(`  ✓ Contract ${normalized.address}`));
      return { contract: normalized.address, label: short(normalized.address), chainKey: activeChain };
    }

    // Slug → address is a plain OpenSea REST lookup, which often answers without
    // a key. Always try; a key only makes it reliable. The mint itself never
    // touches OpenSea either way.
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();

    try {
      console.log(chalk.gray(`  Resolving slug "${parsed.value}"${apiKey ? "" : " (no API key — may be refused)"}...`));
      const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
      const resolved = normalizeAddress(info.contractAddress);
      if (!resolved) {
        console.log(chalk.red(`  ✗ Unusable address returned: ${info.contractAddress}`));
        continue;
      }
      console.log(chalk.green(`  ✓ ${info.name} → ${resolved.address}`));
      if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
        console.log(chalk.yellow(`  ⚠ Listed on "${info.chain}", not "${activeChain}".`));
        if (await askYesNo(`Switch to ${resolveChain(info.chain)!.name}?`, true)) {
          activeChain = resolveChain(info.chain)!.key;
        }
      }
      return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      console.log(
        chalk.gray("    Paste the contract address (0x…) instead — that always works, no key needed.")
      );
      console.log(
        chalk.gray("    Find it on the collection page under Details, or click any item: the address is in that URL.")
      );
    }
  }
}

async function promptRpc(profile: ChainProfile): Promise<string[]> {
  console.log(chalk.bold.white("\nRPC endpoints"));
  console.log(chalk.gray("  A private RPC (Alchemy / QuickNode / Infura) is what wins a contested mint."));
  if (profile.rpc.alchemyHost) {
    console.log(chalk.gray(`  Paste a full URL, or just your Alchemy key → https://${profile.rpc.alchemyHost}/v2/<key>`));
  }
  console.log(chalk.gray("  Comma-separate several to blast to all of them."));

  const fromEnv = privateRpcsFromEnv(profile.key);
  if (fromEnv.length > 0) {
    console.log(chalk.gray(`  .env has: ${fromEnv.map(maskRpc).join(", ")}`));
    console.log(chalk.gray("  Auto-using .env values."));
    return fromEnv;
  }

  console.log(chalk.yellow(`  Nothing in .env for ${profile.name}.`));
  console.log(chalk.gray("  Paste a URL or key, or leave blank for public nodes."));

  for (;;) {
    const raw = await askText(`RPC for ${profile.name} (blank = public nodes only)`);
    if (!raw) return [];

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const urls: string[] = [];
    let bad = false;
    for (const part of parts) {
      const url = toRpcUrl(part, profile.key);
      if (!url) {
        console.log(chalk.red(`  ✗ "${part}" is not a URL or a usable API key.`));
        bad = true;
        break;
      }
      urls.push(url);
    }
    if (bad || urls.length === 0) continue;

    for (const u of urls) console.log(chalk.green(`  ✓ ${maskRpc(u)}`));
    return urls;
  }
}

async function promptTiming(
  startTime: number
): Promise<{ targetStart: Date | null; timingLabel: string }> {
  const startsInFuture = startTime * 1000 > Date.now();
  const at = new Date(startTime * 1000);

  const choices: { label: string; value: "wait" | "now" | "custom"; hint?: string }[] = [];
  if (startsInFuture) {
    // Firing before the on-chain start reverts with NotActive, so it isn't
    // offered at all once a future start time is known.
    choices.push({
      label: "Wait for the stage",
      value: "wait",
      hint: `${toIST(at)} IST · in ${formatRemaining(at.getTime() - Date.now())} · fires at T-0`,
    });
  } else {
    choices.push({ label: "Fire now", value: "now", hint: "stage is already live" });
  }
  choices.push({ label: "Custom time", value: "custom", hint: "HH:MM, 24-hour IST, today" });

  const pick = await askChoice("When should it fire?", choices, 0);

  if (pick === "wait") return { targetStart: at, timingLabel: `wait for stage — ${toIST(at)} IST` };
  if (pick === "now") return { targetStart: null, timingLabel: "fire immediately" };

  for (;;) {
    const raw = await askText("Time (HH:MM, 24-hour IST)");
    try {
      const custom = istTimeToDate(raw);
      if (custom.getTime() < startTime * 1000) {
        console.log(chalk.bold.red(`  ✗ That is before the stage opens (${toIST(at)} IST) — it will revert.`));
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      return { targetStart: custom, timingLabel: `custom — ${toIST(custom)} IST` };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Accept an address in any case — explorer copy-pastes arrive case-mangled and
// hard-failing is worse. A mixed-case string failing EIP-55 is the typo signal.
function normalizeAddress(raw: string): { address: string; checksumWarning: boolean } | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei === null || wei === undefined ? null : Number(wei) / 1e9;
  } catch {
    return null;
  }
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function labelOf(url: string): string {
  return parseRpcEndpoints([url])[0].label;
}

function line(label: string, value: string): void {
  console.log(`  ${chalk.gray(label.padEnd(10))} ${chalk.white(value)}`);
}

function printBanner(): void {
  console.log(
    chalk.bold.cyan(`
╔═══════════════════════════════════════╗
║        NFT PUBLIC MINT SNIPER         ║
║   On-chain calldata · no OpenSea      ║
╚═══════════════════════════════════════╝`)
  );
  console.log(chalk.gray("  Public SeaDrop stages only. Ctrl+C to quit at any point.\n"));
}
