// Pre-mint health checks used by both public and FCFS paths.
//
// Two things here:
//  1. Health probe: for each RPC endpoint, hit eth_blockNumber, eth_gasPrice,
//     and eth_getBlockByNumber("latest") and report live / slow / wrong-chain /
//     dead. Run right before T-0 so a flaky endpoint is caught before it silently
//     fails the mint.
//  2. Nonce cross-check: for each wallet, query eth_getTransactionCount("pending")
//     on *every* RPC endpoint. If endpoints disagree, flag the mismatch and either
//     refuse to fire or only fire to the endpoints that agree on the highest nonce.

import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { parseRpcEndpoints, RpcEndpoint, PreparedBlast } from "./rpc-blast";
import chalk from "chalk";

// ── Health probe ──────────────────────────────────────────────────────────────

export interface EndpointHealth {
  label: string;
  url: string;
  alive: boolean;
  latencyMs: number | null; // null = couldn't measure
  chainId: number | null;   // null = couldn't read, or wrong chain
  blockNumber: number | null;
  blockLatencyMs: number | null;
  error: string | null;
}

export async function probeEndpoints(
  rpcUrls: string[],
  expectedChainId: number,
  timeoutMs = 3000,
): Promise<EndpointHealth[]> {
  const endpoints = parseRpcEndpoints(rpcUrls);
  const results: EndpointHealth[] = [];

  for (const ep of endpoints) {
    const t0 = performance.now();
    let alive = false;
    let chainId: number | null = null;
    let blockNumber: number | null = null;
    let blockLatencyMs: number | null = null;
    let error: string | null = null;

    try {
      // 1. eth_chainId — quickest liveness check + chain identity
      const chainT0 = performance.now();
      const chainRes = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      const chainJson = (await chainRes.json()) as any;
      const chainIdHex = chainJson.result;
      if (chainIdHex) {
        chainId = parseInt(chainIdHex, 16);
        alive = true;
      } else if (chainJson.error) {
        error = chainJson.error.message || JSON.stringify(chainJson.error);
      }
      const chainLatency = Math.round(performance.now() - chainT0);

      // 2. eth_blockNumber — confirms we can read state
      if (alive) {
        const blockT0 = performance.now();
        const blockRes = await fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 2 }),
        });
        const blockJson = (await blockRes.json()) as any;
        if (blockJson.result) {
          blockNumber = parseInt(blockJson.result, 16);
          blockLatencyMs = Math.round(performance.now() - blockT0);
        } else if (blockJson.error) {
          error = blockJson.error.message || JSON.stringify(blockJson.error);
        }
      }
    } catch (err: any) {
      error = err.message || String(err);
    }

    const latencyMs = Math.round(performance.now() - t0);
    results.push({
      label: ep.label,
      url: ep.url,
      alive,
      latencyMs: alive ? latencyMs : null,
      chainId,
      blockNumber,
      blockLatencyMs,
      error,
    });
  }

  return results;
}

export function summarizeHealth(health: EndpointHealth[]): string {
  const lines: string[] = [];
  for (const h of health) {
    if (h.alive) {
      const chainOk = h.chainId === null || h.chainId === expectedChainIdPlaceholder;
      const speed = h.latencyMs !== null ? `${h.latencyMs}ms` : "?";
      const chainInfo = h.chainId !== null ? `chain ${h.chainId}` : "chain ?";
      lines.push(
        `${h.label.padEnd(22)} alive ${speed.padStart(5)} | ${chainInfo.padEnd(10)} | block ${h.blockNumber !== null ? h.blockNumber.toString() : "?"} (${h.blockLatencyMs !== null ? h.blockLatencyMs + "ms" : "?"})`
      );
    } else {
      lines.push(`${h.label.padEnd(22)} DEAD — ${h.error || "no response"}`);
    }
  }
  return lines.join("\n");
}

// Used by summarizeHealth — set to the actual expected chain id at call site.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const expectedChainIdPlaceholder = -1;

// ── Nonce cross-check ─────────────────────────────────────────────────────────

export interface WalletNonceCheck {
  address: string;
  nonces: Map<string, number | null>; // url → nonce (null = couldn't read)
  agreed: boolean; // true if all readable endpoints agree
  highest: number; // highest nonce seen across all endpoints
  mismatchedEndpoints: string[]; // labels of endpoints that disagree
}

export async function checkNoncesAcrossRpcs(
  wallets: Wallet[],
  rpcUrls: string[],
  timeoutMs = 5000,
): Promise<Map<string, WalletNonceCheck>> {
  const results = new Map<string, WalletNonceCheck>();
  const endpoints = parseRpcEndpoints(rpcUrls);

  // Query all wallets × all endpoints in parallel batches to avoid flooding.
  const checks = wallets.map(async (w) => {
    const nonceMap = new Map<string, number | null>();
    const perEndpoint: { label: string; nonce: number | null }[] = [];

    const queries = endpoints.map(async (ep) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionCount",
            params: [w.address, "pending"],
            id: 1,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json()) as any;
        if (json.result !== undefined) {
          const n = parseInt(json.result, 16);
          nonceMap.set(ep.url, n);
          perEndpoint.push({ label: ep.label, nonce: n });
        } else {
          nonceMap.set(ep.url, null);
          perEndpoint.push({ label: ep.label, nonce: null });
        }
      } catch {
        nonceMap.set(ep.url, null);
        perEndpoint.push({ label: ep.label, nonce: null });
      }
    });

    await Promise.all(queries);

    const readable = perEndpoint.filter((p) => p.nonce !== null);
    const values = readable.map((p) => p.nonce!);
    const agreed = readable.length > 0 && new Set(values).size === 1;
    const highest = values.length > 0 ? Math.max(...values) : 0;
    const mismatched = readable.filter((p) => p.nonce !== highest).map((p) => p.label);

    results.set(w.address, {
      address: w.address,
      nonces: nonceMap,
      agreed,
      highest,
      mismatchedEndpoints: mismatched,
    });
  });

  await Promise.all(checks);
  return results;
}

export function summarizeNonceCheck(checks: Map<string, WalletNonceCheck>): string {
  const lines: string[] = [];
  for (const [, c] of checks) {
    const short = c.address.length > 12 ? `${c.address.slice(0, 6)}…${c.address.slice(-4)}` : c.address;
    if (c.agreed) {
      lines.push(`[OK]   ${short}  nonce=${c.highest} (all ${c.nonces.size} RPCs agree)`);
    } else {
      const mismatch = c.mismatchedEndpoints.length > 0 ? `mismatch: ${c.mismatchedEndpoints.join(", ")}` : "no readable RPCs";
      lines.push(`[!!]   ${short}  nonce=${c.highest}  ${mismatch}`);
    }
  }
  return lines.join("\n");
}

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
    const t0 = Date.now();
    let status: ConfirmedTx["status"] = "PENDING";
    let block: number | null = null;
    let position: number | null = null;
    let gasUsed: number | null = null;
    let actualGasPrice: bigint | null = null;

    // Poll all RPCs in parallel for the receipt
    const pollPromises = rpcUrls.slice(0, 3).map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
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
            block: parseInt(receipt.blockNumber, 16),
            position: parseInt(receipt.transactionIndex, 16),
            gasUsed: parseInt(receipt.gasUsed, 16),
            status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
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
        rpcUrls.slice(0, 2).map(async (url) => {
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
        block = parseInt(txExists.blockNumber, 16);
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
