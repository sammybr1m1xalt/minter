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
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan } from "./seadrop-public";
import { simulateTx, classifyRevert, type SimulateResult } from "./simulate";
import { assertPriceProtection } from "./price-protection";

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
   * price is asserted against it before signing. Ported from price.js —
   * without it a drop that raised its price between planning and firing would
   * be minted at the new price with no warning.
   */
  maxPriceWei?: bigint | null;
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan, maxPriceWei,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0]);
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
  // Reading from rpcUrls[0] only and blasting to all is the bug the nonce-cross-check
  // exists to fix: if another endpoint has a higher pending nonce, every signed tx
  // lands as stale-nonce or is rejected. We resolve the highest nonce that a
  // majority of endpoints agree on. Endpoints that disagree are still used for
  // blasting (redundancy), but the signed nonce is the safe one.
  const nonceChecks = await Promise.all(
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
            perEndpoint.push({ url, nonce: json.result != null ? parseInt(json.result, 16) : null });
          } catch {
            perEndpoint.push({ url, nonce: null });
          }
        })
      );
      const readable = perEndpoint.filter((p) => p.nonce != null);
      const nonces = readable.map((p) => p.nonce!);
      // Highest AGREED nonce: the largest value that at least two endpoints
      // report. A lone endpoint claiming a higher nonce is the one most likely
      // to be ahead (it saw a tx the others haven't), and signing against it
      // leaves every other endpoint rejecting the tx as a stale nonce.
      const counts = new Map<number, number>();
      for (const n of nonces) counts.set(n, (counts.get(n) ?? 0) + 1);
      const agreed = [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([n]) => n);
      const highest = agreed.length > 0
        ? Math.max(...agreed)
        : (nonces.length > 0 ? Math.max(...nonces) : 0);
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

  const nonces = nonceChecks.map((c) => c.nonce);
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  // ── Price protection ────────────────────────────────────────────────────
  // Ported from price.js assertPriceProtection. The plan's value was read from
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
  // Ported from mint.js, which simulates before every broadcast. The public
  // path signs everything ahead of T-0, so the simulation must happen BEFORE
  // signing — otherwise we sign bytes we already know will revert.
  //
  // Simulating every wallet is wasteful: the calldata is identical for all of
  // them (minterIfNotPayer = 0x0), so one wallet's verdict applies to all. We
  // simulate the first wallet and, if it reverts, refuse the whole batch.
  const simProvider = new JsonRpcProvider(rpcUrls[0]);
  const firstWallet = wallets[0];
  let sim: SimulateResult;
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

  // An INDETERMINATE result (timeout, network error) is not evidence the tx
  // reverts — it means we could not tell. Fail OPEN: blocking a good mint
  // because a public RPC had a bad moment is worse than sending a tx that
  // might revert. A definitive revert still blocks.
  if (!sim.ok && sim.reverted) {
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
    return;
  }
  if (!sim.ok && sim.indeterminate) {
    console.log(
      chalk.yellow(
        `\n  ⚠ Simulation inconclusive (${sim.reason}) — proceeding; the tx may still revert.`
      )
    );
  } else if (sim.ok) {
    console.log(chalk.green(`  ✓ Simulation passed — the mint transaction will succeed.`));
  }

  // ── Sign everything now, well before the stage opens ──
  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: gasLimit || 250_000,
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

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired = prepared.map(({ idx, address, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
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

  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
    }
  }

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
    return;
  }

  // ── Receipts (only for txs an endpoint actually accepted) ──
  console.log(chalk.gray("\n  Waiting for receipts..."));

  // We know which wallet fired which txHash. The blast results are matched by
  // index to `fired`, and `accepted` carries the `idx` so we can find the
  // endpoint that accepted each tx. Poll that endpoint first; fall back to
  // rpcUrls[0] if the poll fails or times out.
  const receiptPolls = await Promise.all(
    accepted.map(async ({ idx, txHash }) => {
      const firing = fired[idx];
      let url = rpcUrls[0];
      if (firing) {
        const blastResults = await firing.responsePromise;
        const accepting = blastResults.find((r: any) => r.txHash != null);
        if (accepting) {
          const ep = endpoints.find((e) => e.label === accepting.label);
          if (ep) url = ep.url;
        }
      }
      return waitForReceipt(txHash, url, 60_000);
    })
  );

  for (let i = 0; i < accepted.length; i++) {
    const receipt = receiptPolls[i];
    const { idx } = accepted[i];
    if (!receipt) {
      console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, accepted[i].txHash)}`));
      continue;
    }
    const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
    console.log(
      color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
    );
    console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, accepted[i].txHash!)}`));
  }

  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
}
