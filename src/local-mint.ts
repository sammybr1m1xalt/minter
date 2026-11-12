// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.

import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections, rankRpcEndpoints, settleRanking, type RankedEndpoint } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan, buildLocalMintPlan } from "./seadrop-public";
import { simulateTx, classifyRevert, isIndeterminateRpcError, type SimulateResult } from "./simulate";
import { autoGasBounded } from "./auto-gas";
import { assertPriceProtection } from "./price-protection";

/** How many of the fastest endpoints to fire at before escalating to the rest. */
const BLAST_FIRST_WAVE = 2;

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
  /**
   * Maximum total price (wei) the user will accept. When set, the observed
   * price is asserted against it before signing —
   * without it a drop that raised its price between planning and firing would
   * be minted at the new price with no warning.
   */
  maxPriceWei?: bigint | null;
}


interface NonceCheck {
  address: string;
  nonce: number | null;
  agreed: boolean;
  mismatched: string[];
}

/**
 * Read the chain id from EVERY endpoint and take the majority value.
 *
 * `provider.getNetwork()` was used here, which pins the whole snipe to
 * rpcUrls[0] with no timeout: a dead first endpoint hangs the run, and an
 * ethers provider constructed with no network of its own throws instead of
 * answering. The chainId is the one value every signed transaction depends
 * on, so it must come from more than one source and the run must refuse when
 * none of them answer.
 */
async function resolveChainId(rpcUrls: string[], timeoutMs = 4000): Promise<number | null> {
  const values = await Promise.all(
    rpcUrls.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = (await res.json()) as any;
        if (json.result == null) return null;
        const id = parseInt(json.result, 16);
        return Number.isFinite(id) ? id : null;
      } catch {
        return null;
      }
    })
  );
  const readable = values.filter((v): v is number => v != null);
  if (readable.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of readable) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Most-reported wins; a tie goes to the higher value, because a chainId
  // disagreement means at least one endpoint is pointed at the wrong network
  // and signing against the minority is the failure this avoids.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

/**
 * Read each wallet's pending nonce from EVERY endpoint and resolve the highest
 * value a majority agree on.
 *
 * Reading from rpcUrls[0] only is the bug this exists to fix: if another endpoint
 * has a higher pending nonce, every signed tx lands as stale-nonce or is
 * rejected. A lone endpoint claiming a higher nonce is the one most likely to be
 * ahead (it saw a tx the others have not), and signing against it leaves every
 * other endpoint rejecting the tx as a stale nonce.
 */
async function resolveNonces(wallets: Wallet[], rpcUrls: string[]): Promise<NonceCheck[]> {
  return Promise.all(
    wallets.map(async (w) => {
      const perEndpoint: { url: string; nonce: number | null }[] = [];
      await Promise.all(
        rpcUrls.map(async (url) => {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [w.address, "pending"], id: 1 }),
              signal: AbortSignal.timeout(4000),
            });
            const json = (await res.json()) as any;
            const parsed = json.result != null ? parseInt(json.result, 16) : null;
            perEndpoint.push({
              url,
              nonce: parsed != null && Number.isFinite(parsed) ? parsed : null,
            });
          } catch {
            perEndpoint.push({ url, nonce: null });
          }
        })
      );
      const readable = perEndpoint.filter((p) => p.nonce != null);
      const nonces = readable.map((p) => p.nonce!);
      // Highest AGREED nonce: the largest value that at least two endpoints
      // report. A lone endpoint claiming a higher nonce is the one most likely
      // to be ahead, and signing against it leaves every other endpoint rejecting
      // the tx as a stale nonce.
      //
      // No readable endpoint is NOT a nonce of 0: a wallet that has transacted
      // before signed with 0 is rejected as "nonce too low" everywhere, and a
      // guessed nonce can also collide with an in-flight tx. The caller refuses
      // instead of signing it.
      const counts = new Map<number, number>();
      for (const n of nonces) counts.set(n, (counts.get(n) ?? 0) + 1);
      const agreed = [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([n]) => n);
      const highest = agreed.length > 0
        ? Math.max(...agreed)
        : (nonces.length > 0 ? Math.max(...nonces) : null);
      // "agreed" is true only when every readable endpoint reported the same value.
      const unanimous = nonces.length > 0 && new Set(nonces).size === 1;
      return {
        address: w.address,
        nonce: highest,
        agreed: unanimous,
        mismatched: readable.filter((p) => p.nonce !== highest).map((p) => p.url),
      };
    })
  );
}

export interface LocalSnipeResult {
  walletIndex: number;
  address: string;
  txHash: string | null;
  status: "SUCCESS" | "REVERTED" | "PENDING" | "REJECTED" | "TIMEOUT";
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<LocalSnipeResult[]> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan, maxPriceWei,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });
  // Per-wallet outcome, so a caller can act on exactly the wallets whose mint
  // succeeded (the sell-after-mint flow must not sell for a failed mint).
  const outcomes: LocalSnipeResult[] = [];
  try {
    const endpoints = parseRpcEndpoints(rpcUrls);
    const wallets = walletKeys.map((k) => new Wallet(k, provider));

    console.log(chalk.bold.magenta("\n── LOCAL PUBLIC MINT (no OpenSea) ──"));
    console.log(chalk.gray(`  SeaDrop:       ${plan.to}`));
    console.log(chalk.gray(`  NFT:           ${nftContract}`));
    console.log(chalk.gray(`  Fee recipient: ${plan.feeRecipient}`));
    console.log(
      chalk.gray(
        `  Price:         ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} per wallet`
      )
    );
    console.log(chalk.gray(`  Calldata:      ${(plan.data.length - 2) / 2} bytes (identical for every wallet)`));

    // ── Warm sockets and pre-fetch everything the signature depends on ──
    await warmConnections(rpcUrls);

    // ── Nonce strategy: read from EVERY endpoint, use highest agreed nonce ──
    // See resolveNonces for why a single-endpoint read is not enough.
    const nonceChecks = await resolveNonces(wallets, rpcUrls);

    const unknownNonce = nonceChecks.filter((c) => c.nonce == null);
    if (unknownNonce.length > 0) {
      console.log(
        chalk.bold.red(
          `\n  ✗ No RPC would answer eth_getTransactionCount for ${unknownNonce.length} wallet(s) — refusing to sign.`
        )
      );
      console.log(
        chalk.gray(
          "    A guessed nonce is rejected as \"nonce too low\" everywhere, or collides with a tx already in flight."
        )
      );
      return wallets.map((w, i) => ({
        walletIndex: i,
        address: w.address,
        txHash: null,
        status: "REJECTED" as const,
      }));
    }

    // If endpoints disagree, warn but proceed with highest nonce — the blast will
    // tell us which endpoints accepted. We do NOT refuse to fire, because refusing
    // loses the mint; the blast + receipt poll is the real signal.
    const mismatchedWallets = nonceChecks.filter((c) => !c.agreed);
    if (mismatchedWallets.length > 0) {
      console.log(chalk.yellow(`\n  ⚠ Nonce mismatch on ${mismatchedWallets.length} wallet(s) — using highest agreed nonce per wallet.`));
      for (const c of mismatchedWallets) {
        console.log(chalk.gray(`    [${c.address.slice(0, 6)}…${c.address.slice(-4)}] nonce ${c.nonce} | mismatched endpoints: ${c.mismatched.join(", ")}`));
      }
      console.log(chalk.gray(`  If your txs are rejected as "nonce too low", a wallet was active on another endpoint.` + "\n"));
    }

    const nonces = nonceChecks.map((c) => c.nonce!);
    const chainId = await resolveChainId(rpcUrls);
    if (chainId == null) {
      console.log(chalk.bold.red("\n  ✗ No RPC would answer eth_chainId — refusing to sign."));
      console.log(
        chalk.gray("    Signing without a chainId would put every transaction on the wrong network.")
      );
      return wallets.map((w, i) => ({
        walletIndex: i,
        address: w.address,
        txHash: null,
        status: "REJECTED" as const,
      }));
    }
    console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

    // ── Price protection ────────────────────────────────────────────────────
    // The plan's value was read from
    // the chain a moment ago; if the drop's price moved, refuse rather than pay
    // more than the user agreed to. Simulation alone does not catch this — a
    // higher price with the same msg.value would still revert, but a drop that
    // switched price AND the caller re-read it would silently mint at the new
    // rate. The assertion is the guard.
    if (maxPriceWei != null) {
      assertPriceProtection({
        actualPriceWei: plan.value,
        maxPriceWei,
        context: `public mint × ${quantity}`,
      });
      console.log(
        chalk.gray(`  ✓ Price protection: ${formatEther(plan.value)} ≤ ${formatEther(maxPriceWei)} ETH`)
      );
    }

    // ── Simulation gate ────────────────────────────────────────────────────
    // Simulates before every broadcast. The public path signs everything ahead of T-0
    // so the simulation must happen BEFORE signing — otherwise we sign bytes we already know will revert.
    //
    // Simulating every wallet is wasteful: the calldata is identical for all of
    // them (minterIfNotPayer = 0x0), so one wallet's verdict applies to all. We
    // simulate the first wallet and, if it reverts, refuse the whole batch.
    //
    // A stage that has NOT opened yet cannot be simulated: SeaDrop's mintPublic
    // reverts on block.timestamp < startTime, so simulating against 'latest'
    // would refuse a mint that is correctly scheduled for T-0. Skip the pre-flight
    // check in that case — the tx is signed and held, and the on-chain receipt is
    // the real verdict.
    const stageNotYetOpen = targetStart != null && targetStart.getTime() > Date.now();
    const firstWallet = wallets[0];
    let sim: SimulateResult | null = null;
    if (stageNotYetOpen) {
      console.log(
        chalk.yellow(
          `\n  ⚠ Stage opens at ${targetStart!.toISOString()} — skipping pre-flight simulation ` +
          `(mintPublic reverts before the stage opens). The tx will be broadcast at T-0.`
        )
      );
    } else {
      const simProvider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });
      try {
        sim = await simulateTx(simProvider, {
          to: plan.to,
          from: firstWallet.address,
          data: plan.data,
          value: plan.value,
        });
      } finally {
        // ethers keeps a polling timer alive on every provider. Without an explicit
        // destroy the process never exits — the work is done but the event loop
        // stays busy forever.
        try {
          simProvider.destroy();
        } catch {
          // Already destroyed.
        }
      }
    }

    // An INDETERMINATE result (timeout, network error) is not evidence the tx
    // reverts — it means we could not tell. Fail OPEN: blocking a good mint
    // because a public RPC had a bad moment is worse than sending a tx that
    // might revert. A definitive revert still blocks.
    if (sim && !sim.ok && sim.reverted) {
      const classified = classifyRevert(sim.reason);
      const label = classified ? `[${classified.label}] ` : "";
      console.log(
        chalk.bold.red(
          `\n  ✗ Simulation refused to sign: ${label}${sim.reason ?? "unknown revert"}`
        )
      );
      console.log(
        chalk.gray(
          `    The transaction would revert on-chain. Nothing was signed or broadcast.`
        )
      );
      if (classified?.retryable) {
        console.log(
          chalk.yellow(
            `    This looks timing-related — the sale may not be open yet. Re-run when it is.`
          )
        );
      }
      return outcomes;
    }
    if (sim && !sim.ok && sim.indeterminate) {
      console.log(
        chalk.yellow(
          `\n  ⚠ Simulation inconclusive (${sim.reason}) — proceeding; the tx may still revert.`
        )
      );
    } else if (sim && sim.ok) {
      console.log(chalk.green(`  ✓ Simulation passed — the mint transaction will succeed.`));
    }

    // Rank the endpoints concurrently with gas estimation and signing below, so
    // the ordering is in hand well before T-0. Started here rather than at fire
    // time on purpose: measuring at T-0 would delay the fire by the measurement
    // itself. The fire path never waits for this (see settleRanking).
    const ranking = rankRpcEndpoints(rpcUrls);

    // ── Sign everything now, well before the stage opens ──
    const signStart = performance.now();
    const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

    // ── Gas estimation ───────────────────────────────────────────────────────
    // The static 250k default fails silently in both directions: too low and the
    // tx reverts on-chain with out-of-gas after broadcast; too high and the fee
    // cap (maxFeePerGas × gasLimit) can exceed what the wallet can cover when the
    // base fee moves, so the tx never mines. Estimate once — the calldata is
    // identical for every wallet, so one estimate covers the batch.
    //
    // Skipped entirely while the stage is still closed: the call would revert
    // for "stage not active", which says nothing about the calldata. Same reason
    // the simulation gate above is skipped.
    let estimatedGasLimit = gasLimit || 250_000;
    let estimatedMaxFee = maxFeePerGas;
    let estimatedPriority = maxPriorityFee;

    if (stageNotYetOpen) {
      console.log(
        chalk.gray(
          `  … Stage not open yet — skipping the gas estimate (it would revert for "stage not active"); using the ${estimatedGasLimit} default.`
        )
      );
    } else {
      const gasProvider = new JsonRpcProvider(rpcUrls[0], undefined, {
        staticNetwork: true,
        pollingInterval: 1000,
      });
      try {
        const est = await autoGasBounded(
          gasProvider,
          { to: plan.to, from: wallets[0].address, data: plan.data, value: plan.value },
          8_000
        );
        if (est) {
          estimatedGasLimit = Number(est.gasLimit);
          if (est.maxFeePerGas) estimatedMaxFee = est.maxFeePerGas;
          if (est.maxPriorityFeePerGas) estimatedPriority = est.maxPriorityFeePerGas;
          console.log(
            chalk.gray(
              `  ✓ Gas estimated: ${estimatedGasLimit} (was the ${gasLimit || 250_000} default)`
            )
          );
        } else {
          console.log(
            chalk.yellow(`  ⚠ Gas estimation inconclusive — using the ${estimatedGasLimit} default.`)
          );
        }
      } catch (e: any) {
        // autoGasBounded returns null ONLY on timeout and RETHROWS a failed
        // estimate. A failed estimate is almost always a revert, and
        // broadcasting a tx the node already said will revert only burns gas.
        // An indeterminate transport error is not a verdict, so that falls back
        // to the default — same predicate the simulation gate uses.
        if (isIndeterminateRpcError(e)) {
          console.log(
            chalk.yellow(`  ⚠ Gas estimation inconclusive (${e?.message ?? e}) — using the ${estimatedGasLimit} default.`)
          );
        } else {
          console.log(chalk.red(`  ✗ Gas estimation reverted: ${e?.message ?? e}`));
          console.log(chalk.red(`  ✗ Refusing to broadcast — the node says this transaction will not succeed.`));
          return wallets.map((w, i) => ({
            walletIndex: i,
            address: w.address,
            txHash: null,
            status: "REJECTED" as const,
          }));
        }
      } finally {
        try {
          gasProvider.destroy();
        } catch {
          // Already destroyed.
        }
      }
    }

    for (let i = 0; i < wallets.length; i++) {
      const rawTx = await wallets[i].signTransaction({
        to: plan.to,
        data: plan.data,
        value: plan.value,
        nonce: nonces[i],
        maxFeePerGas: estimatedMaxFee,
        maxPriorityFeePerGas: estimatedPriority,
        gasLimit: estimatedGasLimit,
        type: 2,
        chainId,
      });
      prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
    }

    console.log(
      chalk.green(
        `  ✓ ${prepared.length} tx(s) signed and serialised in ${(performance.now() - signStart).toFixed(1)}ms — nothing left to compute at fire time`
      )
    );

    // ── Wait for the stage, then blast pre-built bytes ──
    if (targetStart) {
      await waitForMintTime(targetStart, 0);
    } else {
      console.log(chalk.bold.yellow("\n  🚀 Firing immediately..."));
    }

    // ── Re-read the per-wallet cap AFTER the wait ─────────────────────────
    // A drop's per-wallet limit can be edited in the last minutes before its
    // stage opens. The quantity is baked into the signed calldata, so firing the
    // originally planned quantity after a reduction would revert on-chain and
    // burn gas. Re-read it here and re-plan if it moved.
    //
    // This is a read, not a transaction, so it cannot disturb the nonce.
    let activePlan = plan;
    try {
      const freshPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
      if (freshPlan) {
        const limit = freshPlan.drop.maxTotalMintableByWallet;
        if (limit > 0 && quantity > limit) {
          const reduced = await buildLocalMintPlan(rpcUrls[0], nftContract, limit);
          if (reduced) {
            console.log(
              chalk.yellow(
                `  ⚠ Per-wallet limit is now ${limit} (planned ${quantity}) — minting ${limit} instead.`
              )
            );
            activePlan = reduced;
          }
        }
      }
    } catch (e: any) {
      // A failed re-read must not stop the fire — the original plan is still the
      // best information we have, and the on-chain revert is the backstop.
      console.log(chalk.gray(`  ⚠ Could not re-read the per-wallet limit: ${e?.message ?? e}`));
    }
    const planChanged = activePlan !== plan;

    // ── Re-read nonces AFTER the wait ─────────────────────────────────────
    // The nonce was read at planning time, which is only correct when the mint
    // is about to fire. For anything scheduled more than a few seconds out, any
    // intervening wallet activity (another mint, a transfer) advances it, and
    // every endpoint then rejects the signed tx as "nonce too low". The nonce is
    // the one value that cannot be precomputed — re-derive it here and re-sign
    // only the wallets whose nonce actually moved.
    //
    // This runs concurrently with the ranking above; neither sends a
    // transaction, so neither can advance the nonce.
    const freshChecks = await resolveNonces(wallets, rpcUrls);
    let reSigned = 0;
    for (let i = 0; i < freshChecks.length; i++) {
      const freshNonce = freshChecks[i].nonce;
      // A nonce we cannot read is not a nonce that moved. Keep the original
      // signature rather than signing against a guess.
      if (freshNonce == null) continue;
      const nonceMoved = freshNonce !== nonces[i];
      if (!planChanged && !nonceMoved) continue;
      const rawTx = await wallets[i].signTransaction({
        to: activePlan.to,
        data: activePlan.data,
        value: activePlan.value,
        nonce: freshNonce,
        maxFeePerGas: estimatedMaxFee,
        maxPriorityFeePerGas: estimatedPriority,
        gasLimit: estimatedGasLimit,
        type: 2,
        chainId,
      });
      prepared[i] = { idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) };
      reSigned++;
      if (nonceMoved) {
        console.log(chalk.yellow(`    [W${i}] nonce moved ${nonces[i]} → ${freshChecks[i].nonce} — re-signed.`));
      } else if (planChanged) {
        console.log(chalk.yellow(`    [W${i}] re-signed with the adjusted quantity.`));
      }
    }
    if (reSigned > 0) {
      console.log(chalk.gray(`  Re-signed ${reSigned} tx(s).`));
    }

    // Zero budget: the ranking is an optimisation and must never hold up the
    // fire. If it is not already finished, fire against the original order.
    const ranked = await settleRanking(ranking, 0);
    const blastEndpoints: RankedEndpoint[] =
      ranked && ranked.length > 0 ? ranked : endpoints.map((e) => ({ ...e, latencyMs: null }));
    if (blastEndpoints.length > 1) {
      console.log(
        chalk.gray(
          `  Fastest endpoints: ${blastEndpoints
            .slice(0, BLAST_FIRST_WAVE)
            .map((e) => `${e.label}${e.latencyMs != null ? ` ${e.latencyMs}ms` : ""}`)
            .join(", ")} — escalating to the rest if none accepts`
        )
      );
    }

    const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
    const dispatchStart = performance.now();

    const fired = prepared.map(({ idx, address, blast }) => {
      const { txHash, responsePromise } = blastToAll(blast, blastEndpoints, {
        firstWave: BLAST_FIRST_WAVE,
        // See fcfs-mint.ts: 350ms escalation, not the 600ms default.
        escalateAfterMs: 350,
      });
      return { idx, address, txHash, responsePromise };
    });

    const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
    const sinceStage = Math.max(0, Date.now() - stageStartMs);
    console.log(
      chalk.bold.green(`  DISPATCHED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`)
    );
    for (const f of fired) {
      console.log(chalk.gray(`    [W${f.idx}] ${f.txHash}`));
    }

    // Dispatch only means "bytes written". Find out whether any endpoint actually
    // took the transaction before promising a receipt that may never exist.
    const settled = await Promise.all(
      fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
    );

    // Nodes phrase "already in the mempool" several ways and expose no error
    // code here, so match the known phrasings rather than one exact string —
    // a miss sends the run down the "nothing was broadcast" path even though
    // an endpoint accepted the tx.
    const alreadyKnown = /already known|known transaction|already exists|already have|duplicate transaction/i;
    const accepted = settled.filter(({ results }) =>
      results.some((r) => r.txHash !== null || alreadyKnown.test(r.error ?? ""))
    );
    const rejected = settled.filter((s) => !accepted.includes(s));

    for (const { idx, results } of rejected) {
      const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
      outcomes.push({ walletIndex: idx, address: wallets[idx].address, txHash: null, status: "REJECTED" });
      console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
      for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
      if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
        console.log(chalk.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
      }
    }

    if (accepted.length === 0) {
      console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
      return outcomes;
    }

    // ── Receipts (only for txs an endpoint actually accepted) ──
    console.log(chalk.gray("\n  Waiting for receipts..."));

    // We know which wallet fired which txHash. The blast results are matched by
    // index to `fired`, and `accepted` carries the `idx` so we can find the
    // endpoint that accepted each tx. Poll that endpoint FIRST, then every
    // other one — the comment used to promise a fallback to rpcUrls[0] that the
    // code never performed, so a landed mint was reported UNKNOWN whenever the
    // single polled node fell over.
    const receiptPolls = await Promise.all(
      accepted.map(async ({ idx, txHash }) => {
        const firing = fired[idx];
        let url = rpcUrls[0];
        if (firing) {
          const blastResults = await firing.responsePromise;
          const accepting = blastResults.find((r: any) => r.txHash != null);
          if (accepting) {
            // Resolve by INDEX — never by label. labelFromUrl maps every URL
            // containing "alchemy" to "ALCHEMY", so a label lookup returns the
            // first match, not the endpoint that accepted; polling the receipt
            // there yields null and reports a landed mint as UNKNOWN.
            const ep = blastEndpoints[accepting.index];
            if (ep) url = ep.url;
          }
        }
        const ordered = [url, ...rpcUrls.filter((u) => u !== url)];
        return waitForReceipt(txHash, ordered, 60_000);
      })
    );

    for (let i = 0; i < accepted.length; i++) {
      const receipt = receiptPolls[i];
      const { idx } = accepted[i];
      if (!receipt) {
        outcomes.push({
          walletIndex: idx,
          address: wallets[idx].address,
          txHash: accepted[i].txHash,
          status: "TIMEOUT",
        });
        console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, accepted[i].txHash)}`));
        continue;
      }
      const status = receipt.status === "SUCCESS" ? "SUCCESS" : "REVERTED";
      outcomes.push({
        walletIndex: idx,
        address: wallets[idx].address,
        txHash: accepted[i].txHash,
        status,
      });
      const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
      console.log(
        color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
      );
      console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, accepted[i].txHash!)}`));
    }

    console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
    return outcomes;
  } finally {
    // ethers keeps a polling timer alive on every provider; without an explicit
    // destroy the mint finishes but the process never exits.
    try {
      provider.destroy();
    } catch {
      // Already destroyed.
    }
  }
}
