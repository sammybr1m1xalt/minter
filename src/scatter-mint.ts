// ── Scatter.art mint execution ─────────────────────────────────────────────
//
// The Scatter API builds the mint transaction (proof and signature included), so
// this module's job is everything AROUND that call: pick a list the wallet is
// eligible for, convert the requested NFT count into the list's quantity units,
// respect the per-wallet and per-list caps, approve the ERC20 the list is priced
// in, and put the transaction on chain through the same blast path the other
// mint modes use.
//
// Verified against the live API and Scatter's reference client
// (github.com/guminc/scatter-api-example): `erc20s` are approvals, the spender is
// the collection contract, and the allowance is read before approving.

import chalk from "chalk";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { CHAINS, chainKeyFromId, resolveChain } from "./chains";
import { rememberChain } from "./env-file";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { RunLogger } from "./logger";
import { parseTarget, ResolvedTarget } from "./target-resolver";
import { promptKeys } from "./wizard";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { rankRpcEndpoints, settleRanking, type RankedEndpoint } from "./connection-warmer";
import { explorerTx } from "./chains";
import { autoGasBounded } from "./auto-gas";
import { isIndeterminateRpcError } from "./simulate";
import {
  buildScatterMint,
  getScatterCollection,
  getEligibleLists,
  isUnlimited,
  isNativeList,
  listPriceBaseUnits,
  listWindow,
  pickBestList,
  unitSizeOf,
  ScatterCollection,
  ScatterList,
  ScatterMintTx,
  ScatterListPayment,
} from "./scatter";
import type { GasMode } from "./sell-after-mint";

/** How many of the fastest endpoints to fire at before escalating to the rest. */
const BLAST_FIRST_WAVE = 2;
/** A Scatter mint costs more than a plain transfer but less than a heavy AMM swap. */
const SCATTER_GAS_FLOOR = 200_000;

const ERC20_ALLOWANCE_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/** Scatter's reference client approves the max amount, not the exact cost. */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Scatter contracts expose `minted(address,bytes32)` and `listSupply(bytes32)` on
 * some versions and not others. A missing getter is not an error — it means "this
 * version does not expose it" — so a failed read is null (unknown), never 0.
 */
const PROGRESS_ABI = [
  "function minted(address minter, bytes32 root) view returns (uint256)",
  "function listSupply(bytes32 root) view returns (uint256)",
];

export interface ScatterProgress {
  walletMinted: number | null;
  listMinted: number | null;
}

export async function readScatterProgress(
  provider: JsonRpcProvider,
  collection: string,
  root: string | null,
  minter: string
): Promise<ScatterProgress> {
  if (!root) return { walletMinted: null, listMinted: null };
  const contract = new Contract(collection, PROGRESS_ABI, provider);
  let walletMinted: number | null = null;
  let listMinted: number | null = null;
  try {
    const n = await contract.minted(minter, root);
    walletMinted = Number(n);
  } catch {
    /* this contract version does not expose it */
  }
  try {
    const n = await contract.listSupply(root);
    listMinted = Number(n);
  } catch {
    /* this contract version does not expose it */
  }
  return { walletMinted, listMinted };
}

export interface ScatterPlan {
  wallet: Wallet;
  list: ScatterList;
  /** Units requested from the API. NFTs received = units × unit_size. */
  units: number;
  /** NFTs this purchase actually yields. */
  nfts: number;
  unitSize: number;
  pricePerUnit: bigint | null;
  /** The API's own quote for the currency part, when it returned one. */
  paymentValue: bigint | null;
  nativeFeeValue: bigint | null;
  /** wei to send with the transaction. */
  value: bigint;
  erc20s: { address: string; amount: bigint }[];
  /** The contract that will pull the tokens — the approval target. */
  spender: string;
  to: string;
  data: string;
  windowOpen: boolean;
  windowReason: string | null;
  currencySymbol: string;
  /** Set when the locally derived quote disagrees with the API's. */
  quoteMismatch: string | null;
}

export interface ScatterPlanArgs {
  slug: string;
  collection: ScatterCollection;
  wallet: Wallet;
  /** NFTs the user asked for. */
  quantity: number;
  affiliate?: string;
  timeoutMs?: number;
  nowMs?: number;
  /**
   * When given, on-chain progress for the SELECTED list is read from it. The
   * root is only known after the list is chosen, so a pre-read cannot supply it.
   */
  provider?: JsonRpcProvider;
  progress?: ScatterProgress | null;
}

/**
 * Build one wallet's mint plan.
 *
 * Returns a reason rather than throwing: every refusal here is a fact about the
 * list or the wallet, and the caller has to show it.
 */
export async function planScatterMint(
  args: ScatterPlanArgs
): Promise<{ plan: ScatterPlan | null; reason: string }> {
  const { slug, collection, wallet, quantity } = args;
  const nowMs = args.nowMs ?? Date.now();

  const lists = await getEligibleLists(slug, wallet.address, args.timeoutMs);
  if (lists.length === 0) {
    // Ambiguous by construction: "no list" and "the API did not answer" are the
    // same empty array. Say which it might be rather than claiming no list exists.
    return {
      plan: null,
      reason:
        `no mint list came back for ${wallet.address}. Either this wallet is not ` +
        `eligible for any list, or the Scatter API did not answer — re-run to tell them apart.`,
    };
  }

  const list = pickBestList(lists, nowMs);
  if (!list) return { plan: null, reason: "no mint list could be selected." };

  const window = listWindow(list, nowMs);
  if (!window.open) {
    return { plan: null, reason: `"${list.name}" is not open — it ${window.reason}.` };
  }

  const unitSize = unitSizeOf(list);
  const units = Math.ceil(quantity / unitSize);
  const nfts = units * unitSize;

  // Caps are in NFTs, not units: Scatter's own docs tell creators to set the
  // wallet limit in multiples of the unit size, which only makes sense if the
  // limit counts NFTs.
  const progress = args.provider
    ? await readScatterProgress(args.provider, collection.address, list.root, wallet.address)
    : (args.progress ?? null);
  if (!isUnlimited(list.wallet_limit)) {
    const used = progress?.walletMinted ?? 0;
    const remaining = Number(list.wallet_limit) - used;
    if (remaining < nfts) {
      const allowedUnits = Math.floor(remaining / unitSize);
      if (allowedUnits <= 0) {
        return {
          plan: null,
          reason: `"${list.name}" has no allowance left for ${wallet.address} ` +
            `(${used}/${list.wallet_limit} used).`,
        };
      }
      return {
        plan: null,
        reason:
          `"${list.name}" allows ${remaining} more NFT(s) to this wallet ` +
          `(${used}/${list.wallet_limit} used), fewer than the ${nfts} requested. ` +
          `Re-run with --quantity ${allowedUnits * unitSize} or less.`,
      };
    }
  }
  if (!isUnlimited(list.list_limit)) {
    const minted = progress?.listMinted ?? 0;
    if (minted + nfts > Number(list.list_limit)) {
      return {
        plan: null,
        reason:
          `"${list.name}" does not have ${nfts} left (list limit ${list.list_limit}, ` +
          `${minted} minted).`,
      };
    }
  }
  if (collection.maxItems != null && collection.numItems != null && collection.numItems >= collection.maxItems) {
    return { plan: null, reason: `${collection.name} is minted out (${collection.numItems}/${collection.maxItems}).` };
  }

  let tx: ScatterMintTx;
  try {
    tx = await buildScatterMint({
      collectionAddress: collection.address,
      chainId: collection.chainId,
      minterAddress: wallet.address,
      lists: [{ id: list.id, quantity: units }],
      affiliate: args.affiliate,
      timeoutMs: args.timeoutMs,
    });
  } catch (e: any) {
    return { plan: null, reason: `Scatter would not build the mint: ${e?.message ?? e}` };
  }

  const payment = tx.listPayments.find((p) => p.id === list.id) ?? tx.listPayments[0] ?? null;
  const pricePerUnit = listPriceBaseUnits(list);
  const paymentValue = payment ? BigInt(payment.paymentValue || 0) : null;
  const nativeFeeValue = payment ? BigInt(payment.nativeFeeValue || 0) : null;

  // Cross-check the API's quote against the list's stated price. The API is
  // authoritative for what will be charged; a mismatch means our model of the
  // price is wrong, which is worth saying out loud rather than silently sending.
  let quoteMismatch: string | null = null;
  if (pricePerUnit != null && paymentValue != null) {
    const expected = pricePerUnit * BigInt(units);
    if (expected !== paymentValue) {
      quoteMismatch =
        `the API quoted ${paymentValue} for ${units} unit(s) but the list price ` +
        `${list.token_price} ${list.currency_symbol || ""} implies ${expected}.`;
    }
  }
  // Sending less native value than the stated fee cannot succeed. Summed over
  // every list payment, not just the first: a multi-list mint carries one fee
  // per list.
  const feeTotal = tx.listPayments.reduce((a, p) => a + BigInt(p.nativeFeeValue || 0), 0n);
  if (tx.value < feeTotal) {
    return {
      plan: null,
      reason:
        `the mint transaction carries ${tx.value} wei but the quoted native fee is ` +
        `${feeTotal}. Refusing — this would revert.`,
    };
  }

  // The minter calls `to`, so `to` is the contract that pulls the tokens. The
  // reference client approves the collection address; for a batch mint the two
  // differ, and the batch contract is the one that needs the allowance.
  const spender =
    tx.to.toLowerCase() !== collection.address.toLowerCase() ? tx.to : collection.address;

  return {
    plan: {
      wallet,
      list,
      units,
      nfts,
      unitSize,
      pricePerUnit,
      paymentValue,
      nativeFeeValue,
      value: tx.value,
      erc20s: tx.erc20s.map((e) => ({ address: e.address, amount: BigInt(e.amount || 0) })),
      spender,
      to: tx.to,
      data: tx.data,
      windowOpen: true,
      windowReason: null,
      currencySymbol: list.currency_symbol || (isNativeList(list) ? "native" : list.currency_address || ""),
      quoteMismatch,
    },
    reason: "",
  };
}

export interface ScatterWalletResult {
  walletIndex: number;
  walletAddress: string;
  plan: ScatterPlan | null;
  txHash: string | null;
  status: "SUCCESS" | "REVERTED" | "REJECTED" | "TIMEOUT" | "REFUSED";
  receipt?: Awaited<ReturnType<typeof waitForReceipt>>;
  approvalTxHash?: string;
  error?: string;
}

export interface ScatterExecArgs {
  plan: ScatterPlan;
  walletIndex: number;
  rpcUrls: string[];
  chainId: number;
  gasMode?: GasMode;
  gasLimit?: number;
  /** Called before anything is sent; return false to skip this wallet. */
  confirm?: (plan: ScatterPlan) => boolean | Promise<boolean>;
  onMessage?: (msg: string) => void;
}

/**
 * Mint one wallet. The plan is already built, so the only unknowns left are the
 * ERC20 allowance, the nonce and the fee market.
 */
export async function executeScatterMint(args: ScatterExecArgs): Promise<ScatterWalletResult> {
  const { plan, rpcUrls, chainId } = args;
  const wallet = plan.wallet;
  const result: ScatterWalletResult = {
    walletIndex: args.walletIndex,
    walletAddress: wallet.address,
    plan,
    txHash: null,
    status: "REFUSED",
  };

  const provider = new JsonRpcProvider(rpcUrls[0], chainId, {
    staticNetwork: true,
    pollingInterval: 1000,
  });
  try {
    // The plan carries a bare Wallet (it was built from a private key, not from
    // a provider). sendTransaction and getNonce both go through wallet.provider,
    // so it must be connected before anything is signed.
    const wallet = plan.wallet.connect(provider);
    if (args.confirm) {
      const ok = await args.confirm(plan);
      if (!ok) {
        result.error = "not confirmed";
        return result;
      }
    }

    // ── ERC20 approvals ────────────────────────────────────────────────────
    // Each entry is a token the mint will pull. Skip the approval only when the
    // allowance already covers the quoted amount.
    for (const erc20 of plan.erc20s) {
      if (erc20.amount <= 0n) continue;
      const token = new Contract(erc20.address, ERC20_ALLOWANCE_ABI, provider);
      let allowed = 0n;
      try {
        allowed = await token.allowance(wallet.address, plan.spender);
      } catch (e: any) {
        result.status = "REFUSED";
        result.error = `could not read the ${erc20.address} allowance: ${e?.message ?? e}`;
        return result;
      }
      if (allowed >= erc20.amount) continue;
      try {
        const tx = await wallet.sendTransaction(
          await token.approve.populateTransaction(plan.spender, MAX_UINT256)
        );
        const receipt = await tx.wait();
        if (receipt?.status === 0) {
          result.status = "REFUSED";
          result.error = `the ${erc20.address} approval reverted on-chain`;
          return result;
        }
        result.approvalTxHash = tx.hash;
        args.onMessage?.(`approval sent: ${tx.hash}`);
      } catch (e: any) {
        result.status = "REFUSED";
        result.error = `the ${erc20.address} approval failed: ${e?.message ?? e}`;
        return result;
      }
    }

    // ── Gas ────────────────────────────────────────────────────────────────
    let gasLimit = args.gasLimit ?? SCATTER_GAS_FLOOR;
    let maxFeePerGas: bigint | undefined;
    let maxPriorityFeePerGas: bigint | undefined;
    try {
      const est = await autoGasBounded(
        provider,
        { to: plan.to, from: wallet.address, data: plan.data, value: plan.value },
        8_000
      );
      if (est) {
        gasLimit = Number(est.gasLimit);
        if (est.maxFeePerGas) maxFeePerGas = est.maxFeePerGas;
        if (est.maxPriorityFeePerGas) maxPriorityFeePerGas = est.maxPriorityFeePerGas;
        args.onMessage?.(`gas estimated: ${gasLimit}`);
      } else {
        args.onMessage?.(`gas estimation inconclusive — using the ${gasLimit} default.`);
      }
    } catch (e: any) {
      // A revert is a verdict: the node has already said this will not succeed.
      // A transport fault is not, so that falls back to the default.
      if (isIndeterminateRpcError(e)) {
        args.onMessage?.(`gas estimation inconclusive (${e?.message ?? e}) — using the ${gasLimit} default.`);
      } else {
        result.status = "REFUSED";
        result.error = `gas estimation reverted: ${e?.message ?? e}`;
        return result;
      }
    }

    const nonce = await wallet.getNonce();

    const rawTx = await wallet.signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      type: 2,
      chainId,
    });
    const blast: PreparedBlast = prepareBlast(rawTx);

    const endpoints = parseRpcEndpoints(rpcUrls);
    const ranking = rankRpcEndpoints(rpcUrls);
    const ranked = await settleRanking(ranking, 5_000);
    const blastEndpoints: RankedEndpoint[] =
      ranked && ranked.length > 0 ? ranked : endpoints.map((e) => ({ ...e, latencyMs: null }));

    const { txHash, responsePromise } = blastToAll(blast, blastEndpoints, {
      firstWave: BLAST_FIRST_WAVE,
      escalateAfterMs: 350,
    });
    result.txHash = txHash;

    const results = await responsePromise;
    const alreadyKnown = /already known|known transaction|already exists|already have|duplicate transaction/i;
    const accepted = results.some((r) => r.txHash !== null || alreadyKnown.test(r.error ?? ""));
    if (!accepted) {
      const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
      result.status = "REJECTED";
      result.error = reasons.join(" | ") || "no endpoint accepted the transaction";
      return result;
    }

    const accepting = results.find((r) => r.txHash != null);
    let url = rpcUrls[0];
    if (accepting) {
      // Resolve by INDEX, never by label — a label lookup can return a
      // different endpoint than the one that accepted, and the receipt poll
      // then reports a landed mint as UNKNOWN.
      const ep = blastEndpoints[accepting.index];
      if (ep) url = ep.url;
    }
    const ordered = [url, ...rpcUrls.filter((u) => u !== url)];
    const receipt = await waitForReceipt(txHash, ordered, 60_000);
    if (!receipt) {
      result.status = "TIMEOUT";
      result.error = `no receipt in 60s — check: ${explorerTx(chainId, txHash)}`;
      return result;
    }
    result.receipt = receipt;
    result.status = receipt.status === "SUCCESS" ? "SUCCESS" : "REVERTED";
    if (receipt.status !== "SUCCESS") result.error = "the mint transaction reverted on-chain";
    return result;
  } finally {
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}

/** Human-readable summary of a plan, for the confirm prompt and the log. */
export function describeScatterPlan(plan: ScatterPlan): string {
  const price =
    plan.pricePerUnit != null
      ? formatEther(plan.pricePerUnit)
      : "unknown";
  const symbol = plan.currencySymbol || "native";
  const qty =
    plan.unitSize > 1
      ? `${plan.units} unit(s) × ${plan.unitSize} = ${plan.nfts} NFT(s)`
      : `${plan.nfts} NFT(s)`;
  const erc20 = plan.erc20s.length
    ? ` + ${plan.erc20s.map((e) => `${formatEther(e.amount)} via ${e.address.slice(0, 10)}…`).join(", ")}`
    : "";
  return `${plan.list.name}: ${qty} for ${price} ${symbol}${erc20}, sending ${formatEther(plan.value)} native`;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

export interface ScatterCliOptions {
  wallets?: string | null;
  chain?: string | null;
  quantity?: number | null;
  affiliate?: string | null;
}

/**
 * `npm start -- --scatter <slug>` — mint a Scatter collection directly.
 *
 * Mirrors runFcfsBranchCli: no interactive chain/gas prompts, so a missing
 * value is an error rather than a silent guess.
 */
export async function runScatterBranchCli(
  log: RunLogger,
  targetArg: string,
  opts: ScatterCliOptions = {}
): Promise<void> {
  const chainKey = (opts.chain || process.env.CHAIN || "").trim().toLowerCase();
  if (!chainKey) {
    throw new Error(
      "No chain given. Pass --chain <key> or set CHAIN in .env " +
        `(supported: ${CHAINS.map((c) => c.key).join(", ")}).`
    );
  }
  const chainProfile = resolveChain(chainKey);
  if (!chainProfile) throw new Error(`Unknown chain "${chainKey}"`);
  rememberChain(chainProfile.key);

  const envRpcs = (process.env[`RPC_URL_${chainKey.toUpperCase()}`] || "").split(",").filter(Boolean);
  const { urls: candidateRpcs } = await resolveRpcsForChain(chainKey, envRpcs);
  const rpcPlan = await planRpcs(candidateRpcs, chainProfile.chainId);
  let rpcUrls = rpcPlan.urls;
  if (rpcUrls.length === 0) throw new Error(`No usable RPC endpoints for ${chainProfile.name}`);

  const parsed = parseTarget(targetArg);
  // `--scatter` is an explicit platform choice, so resolve through Scatter rather
  // than the OpenSea-first slug path: a bare slug can resolve on BOTH platforms
  // (verified live — "nockmilio" resolves on OpenSea and on Scatter, to the same
  // contract), and the OpenSea-first rule would send it down the wrong branch.
  const slug =
    parsed.platform === "scatter"
      ? parsed.slug
      : !parsed.contract && parsed.slug
        ? parsed.slug
        : null;
  if (!slug) {
    throw new Error(
      `"${targetArg}" is not a Scatter collection slug. The Scatter API resolves by ` +
        `slug only — paste a scatter.art link or the collection slug.`
    );
  }
  const scatter = await getScatterCollection(slug);
  if (!scatter) throw new Error(`Could not resolve a Scatter collection called "${slug}".`);
  const scatterChainKey = chainKeyFromId(scatter.chainId);
  if (!scatterChainKey) {
    throw new Error(
      `${scatter.name} is on chain id ${scatter.chainId}, which this build does not serve. ` +
        `Supported: ${CHAINS.map((c) => c.key).join(", ")}.`
    );
  }
  const resolved: ResolvedTarget = {
    platform: "scatter",
    contract: scatter.address,
    chainKey: scatterChainKey,
    slug,
    scatter,
    amount: parsed.amount,
    resolvedViaFallback: false,
  };

  // A Scatter link can name a different chain than the one on the CLI. Minting
  // through the wrong chain's endpoints is a guaranteed failure, so switch.
  if (resolved.chainKey !== chainKey) {
    const alt = resolveChain(resolved.chainKey);
    if (!alt) throw new Error(`Target is on unknown chain "${resolved.chainKey}".`);
    const altEnv = (process.env[`RPC_URL_${alt.key.toUpperCase()}`] || "").split(",").filter(Boolean);
    const { urls: altCandidates } = await resolveRpcsForChain(alt.key, altEnv);
    const altPlan = await planRpcs(altCandidates, alt.chainId);
    if (altPlan.urls.length === 0) {
      throw new Error(
        `Target is on ${alt.name}, but no RPC endpoints are configured for it. ` +
          `Set RPC_URL_${alt.key.toUpperCase()} or pass --chain ${alt.key}.`
      );
    }
    console.log(chalk.yellow(`\n  ⚠ Target is on ${alt.name} — switching chains and endpoints.`));
    rpcUrls = altPlan.urls;
  }

  // The collection's own chain id is authoritative for the mint call; a
  // mismatch means the RPC set and the collection disagree, and the API would
  // build a transaction for the wrong network.
  if (scatter.chainId !== resolveChain(resolved.chainKey)!.chainId) {
    throw new Error(
      `${scatter.name} reports chain id ${scatter.chainId}, but ${resolved.chainKey} is chain ` +
        `${resolveChain(resolved.chainKey)!.chainId}. Refusing — the mint would be built for the wrong network.`
    );
  }

  const keys = await promptKeys(log, opts.wallets);
  if (keys.length === 0) throw new Error("No wallet keys provided.");
  const wallets = keys.map((k) => new Wallet(k));

  const quantity = Math.max(1, Math.floor(opts.quantity ?? 1));
  log.field("quantity", quantity);
  log.field("wallet_count", wallets.length);
  log.field("chain", resolved.chainKey);
  log.field("scatter_slug", scatter.slug);

  console.log(chalk.bold.white(`\n${scatter.name} (Scatter)`));
  console.log(chalk.gray(`  ${scatter.numItems ?? "?"}/${scatter.maxItems ?? "?"} minted · chain ${resolved.chainKey}`));

  let ok = 0;
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(chalk.bold.white(`\n[W${i}] ${wallet.address}`));

    const provider = new JsonRpcProvider(rpcUrls[0], scatter.chainId, { staticNetwork: true });
    let planned: Awaited<ReturnType<typeof planScatterMint>>;
    try {
      planned = await planScatterMint({
        slug: scatter.slug,
        collection: scatter,
        wallet,
        quantity,
        affiliate: opts.affiliate ?? undefined,
        provider,
      });
    } finally {
      try { provider.destroy(); } catch { /* already destroyed */ }
    }
    if (!planned.plan) {
      console.log(chalk.yellow(`  ✗ ${planned.reason}`));
      log.warn(`W${i} refused: ${planned.reason}`);
      continue;
    }
    const p = planned.plan;
    console.log(chalk.green(`  ✓ ${describeScatterPlan(p)}`));
    if (p.quoteMismatch) {
      console.log(chalk.yellow(`  ⚠ quote mismatch: ${p.quoteMismatch}`));
    }

    const result = await executeScatterMint({
      plan: p,
      walletIndex: i,
      rpcUrls,
      chainId: scatter.chainId,
      onMessage: (m) => console.log(chalk.gray(`  ${m}`)),
    });

    if (result.status === "SUCCESS") {
      ok++;
      console.log(chalk.green(`  ✓ minted — ${result.txHash}`));
      console.log(chalk.gray(`    block ${result.receipt?.block} · gas ${result.receipt?.gasUsed}`));
    } else {
      console.log(chalk.red(`  ✗ ${result.status}: ${result.error ?? "no detail"}`));
      log.warn(`W${i} ${result.status}: ${result.error ?? "no detail"}`);
    }
  }

  console.log(chalk.bold.white(`\n===== SCATTER MINT COMPLETE — ${ok}/${wallets.length} succeeded =====`));
  log.field("succeeded", ok);
  log.field("failed", wallets.length - ok);
}
