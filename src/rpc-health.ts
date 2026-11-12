// On-chain confirmation sweep — polls RPC endpoints for tx receipts
// and summarizes results. Used by fcfs-mint.ts:executeFcfsSnipe.

import chalk from "chalk";
import { parseHexQuantity, parseGasPrice } from "./rpc-blast";

// ── On-chain confirmation sweep ───────────────────────────────────────────────

export interface ConfirmedTx {
  address: string;
  txHash: string;
  block: number | null;
  position: number | null;
  status: "SUCCESS" | "REVERTED" | "PENDING" | "NOT_FOUND" | "TIMEOUT";
  gasUsed: number | null;
  actualGasPrice: bigint | null;
  blockTimeMs: number | null; // time from dispatch to block inclusion
  /** Why a TIMEOUT occurred — the two causes call for different action. */
  detail?: "sweep budget expired" | "no endpoint answered";
}

export async function sweepOnChain(
  firedTxs: { address: string; txHash: string; dispatchedAt: number }[],
  rpcUrls: string[],
  timeoutMs = 120_000,
): Promise<ConfirmedTx[]> {
  const results: ConfirmedTx[] = [];

  // `timeoutMs` is the budget for the WHOLE sweep. It was applied per request,
  // so N transactions could take N × 2 × min(timeoutMs, 5s) — twenty wallets
  // against a 120-second budget is 200 seconds, and the sell-after-mint step
  // waits on all of it.
  const sweepDeadline = Date.now() + timeoutMs;

  for (const tx of firedTxs) {
    if (Date.now() >= sweepDeadline) {
      // Out of budget. Say so rather than skipping silently: the tx may have
      // landed, so "not checked" is not a verdict.
      console.log(
        chalk.yellow(`  ⚠ Confirmation sweep budget expired — ${tx.txHash.slice(0, 10)}… was not checked.`)
      );
      results.push({
        address: tx.address,
        txHash: tx.txHash,
        block: null,
        position: null,
        gasUsed: null,
        actualGasPrice: null,
        status: "TIMEOUT",
        blockTimeMs: null,
        detail: "sweep budget expired",
      });
      continue;
    }

    let status: ConfirmedTx["status"] = "PENDING";
    let block: number | null = null;
    let position: number | null = null;
    let gasUsed: number | null = null;
    let actualGasPrice: bigint | null = null;
    let timeoutDetail: ConfirmedTx["detail"];

    // Each individual request must be bounded independently of the overall
    // sweep budget. Reusing `timeoutMs` per request meant one sweep could run
    // ~3× longer than asked (3 receipt polls + 2 existence checks in parallel).
    const perRequestMs = Math.max(500, Math.min(5_000, sweepDeadline - Date.now()));

    // Poll EVERY RPC in parallel for the receipt. Polling only the first three
    // meant a tx landed while those three were slow or dead was reported as not
    // found, even though the caller had working endpoints beyond them.
    const pollPromises = rpcUrls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perRequestMs);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [tx.txHash],
            id: 1,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json()) as any;
        const receipt = json.result;
        if (receipt) {
          return {
            block: parseHexQuantity(receipt.blockNumber),
            position: parseHexQuantity(receipt.transactionIndex),
            gasUsed: parseHexQuantity(receipt.gasUsed),
            // A missing status is a pre-Byzantium receipt: the tx was included,
            // so it succeeded. Only an explicit 0x0 is a revert.
            status: receipt.status === "0x0" ? "REVERTED" : "SUCCESS",
            effectiveGasPrice: parseGasPrice(receipt.effectiveGasPrice),
          };
        }
      } catch {
        // This RPC couldn't answer — try another
      }
      return null;
    });

    const pollResults = await Promise.all(pollPromises);
    const best = pollResults.find((r) => r !== null);

    if (best) {
      block = best.block;
      position = best.position;
      gasUsed = best.gasUsed;
      actualGasPrice = best.effectiveGasPrice;
      status = best.status as ConfirmedTx["status"];
    } else {
      // No receipt found — check if the TX exists at all
      const existenceChecks = await Promise.all(
        rpcUrls.map(async (url) => {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "eth_getTransactionByHash",
                params: [tx.txHash],
                id: 1,
              }),
              signal: AbortSignal.timeout(perRequestMs),
            });
            const json = (await res.json()) as any;
            return { answered: true, result: json.result ?? null };
          } catch {
            return { answered: false, result: null };
          }
        })
      );
      // Separate "the endpoint answered" from "the endpoint had the tx".
      // `result: null` is a real answer (the tx is not there); a thrown fetch is
      // not. Reporting the latter as NOT_FOUND turns an unreachable RPC into a
      // false negative about whether the mint landed.
      const answers = existenceChecks.filter((c) => c.answered);
      if (answers.length === 0) {
        status = "TIMEOUT";
        timeoutDetail = "no endpoint answered";
      } else {
        const txExists = answers.find((c) => c.result !== null);
        if (txExists && txExists.result.blockNumber === null) {
          status = "PENDING";
        } else if (txExists && txExists.result.blockNumber !== null) {
          // Exists but in a block we didn't see a receipt for — odd, report what we have
          block = parseHexQuantity(txExists.result.blockNumber);
          status = "NOT_FOUND";
        } else {
          status = "NOT_FOUND";
        }
      }
    }

    results.push({
      address: tx.address,
      txHash: tx.txHash,
      block,
      position,
      status,
      gasUsed,
      actualGasPrice,
      blockTimeMs: block !== null ? Date.now() - tx.dispatchedAt : null,
      detail: timeoutDetail,
    });
  }

  return results;
}

export function summarizeOnChain(confirmed: ConfirmedTx[]): string {
  const lines: string[] = [];
  let success = 0;
  let reverted = 0;
  let pending = 0;
  let notFound = 0;
  let timeout = 0;

  for (const c of confirmed) {
    const short = c.address.length > 12 ? `${c.address.slice(0, 6)}…${c.address.slice(-4)}` : c.address;
    const hashShort = c.txHash.slice(0, 10) + "…";
    switch (c.status) {
      case "SUCCESS":
        success++;
        lines.push(
          `[OK]   ${short.padEnd(12)} ${hashShort.padEnd(14)} block ${c.block !== null ? c.block.toString().padStart(8) : "?"} pos ${c.position !== null ? c.position.toString().padStart(3) : "?"} gas ${c.gasUsed !== null ? c.gasUsed.toString().padStart(5) : "?"} ${c.blockTimeMs !== null ? `(${c.blockTimeMs}ms)` : ""}`
        );
        break;
      case "REVERTED":
        reverted++;
        lines.push(
          `[!!]   ${short.padEnd(12)} ${hashShort.padEnd(14)} REVERTED gas ${c.gasUsed !== null ? c.gasUsed.toString() : "?"}`
        );
        break;
      case "PENDING":
        pending++;
        lines.push(`[--]   ${short.padEnd(12)} ${hashShort.padEnd(14)} still pending`);
        break;
      case "NOT_FOUND":
        notFound++;
        lines.push(`[??]   ${short.padEnd(12)} ${hashShort.padEnd(14)} not found on chain`);
        break;
      case "TIMEOUT":
        // Either the sweep budget expired or no endpoint could be reached. In
        // both cases the tx may have landed, so it is neither a success nor a
        // failure — and it must be counted, not silently dropped from the
        // summary line.
        timeout++;
        lines.push(`[--]   ${short.padEnd(12)} ${hashShort.padEnd(14)} not checked — ${c.detail ?? "unknown reason"}`);
        break;
      default:
        lines.push(`[??]   ${short.padEnd(12)} ${hashShort.padEnd(14)} unknown status`);
        break;
    }
  }

  const total = confirmed.length;
  lines.unshift(
    `╔══ ON-CHAIN CONFIRMATION (${total} txs) ═══════════════════════════════════╗`
  );
  lines.push(
    `║  SUCCESS: ${success}  REVERTED: ${reverted}  PENDING: ${pending}  NOT_FOUND: ${notFound}  TIMEOUT: ${timeout}  ║`
  );
  lines.push(`╚════${"═".repeat(Math.max(0, 58 - 2))}══╝`);
  return lines.join("\n");
}
