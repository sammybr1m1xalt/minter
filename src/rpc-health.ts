// On-chain confirmation sweep — polls RPC endpoints for tx receipts
// and summarizes results. Used by fcfs-mint.ts:executeFcfsSnipe.

import { parseHexQuantity } from "./rpc-blast";

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
}

export async function sweepOnChain(
  firedTxs: { address: string; txHash: string; dispatchedAt: number }[],
  rpcUrls: string[],
  timeoutMs = 120_000,
): Promise<ConfirmedTx[]> {
  const results: ConfirmedTx[] = [];

  for (const tx of firedTxs) {
    const _t0 = Date.now();
    let status: ConfirmedTx["status"] = "PENDING";
    let block: number | null = null;
    let position: number | null = null;
    let gasUsed: number | null = null;
    let actualGasPrice: bigint | null = null;

    // Each individual request must be bounded independently of the overall
    // sweep budget. Reusing `timeoutMs` per request meant one sweep could run
    // ~3× longer than asked (3 receipt polls + 2 existence checks in parallel).
    const perRequestMs = Math.min(timeoutMs, 5_000);

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
            effectiveGasPrice: receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : null,
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
            return json.result;
          } catch {
            return null;
          }
        })
      );
      const txExists = existenceChecks.find((r) => r !== null);
      if (txExists && txExists.blockNumber === null) {
        status = "PENDING";
      } else if (txExists && txExists.blockNumber !== null) {
        // Exists but in a block we didn't see a receipt for — odd, report what we have
        block = parseHexQuantity(txExists.blockNumber);
        status = "NOT_FOUND";
      } else {
        status = "NOT_FOUND";
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
    `║  SUCCESS: ${success}  REVERTED: ${reverted}  PENDING: ${pending}  NOT_FOUND: ${notFound}  ║`
  );
  lines.push(`╚════${"═".repeat(Math.max(0, 58 - 2))}══╝`);
  return lines.join("\n");
}
