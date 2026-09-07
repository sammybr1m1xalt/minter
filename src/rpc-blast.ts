// Detailed dispatch logging layer — used by both public and FCFS paths.
// Logs: per-endpoint dispatch latency, acceptance/rejection, receipt tracking,
// per-wallet blast summary, and timing breakdowns.

import chalk from "chalk";
import { keccak256 } from "ethers";

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface BlastResult {
  label: string;
  txHash: string | null;
  error: string | null;
}

export function parseRpcEndpoints(rpcUrls: string[]): RpcEndpoint[] {
  return rpcUrls.map((url, i) => ({
    url,
    label: labelFromUrl(url, i),
  }));
}

function labelFromUrl(url: string, index: number): string {
  const lower = url.toLowerCase();
  if (lower.includes("sequencer.base.org")) return "mainnet-sequencer.base.org";
  if (lower.includes("sequencer.mainnet.chain.robinhood.com")) return "robinhood-sequencer";
  if (lower.includes("rpc.mainnet.chain.robinhood.com")) return "robinhood-public";
  if (lower.includes("alchemy")) return "ALCHEMY";
  if (lower.includes("flashbots")) return "FLASHBOTS-PROTECT";
  if (lower.includes("llamarpc")) {
    try { return new URL(url).hostname; } catch { return "llamarpc"; }
  }
  if (lower.includes("quicknode")) return "QUICKNODE";
  if (lower.includes("infura")) return "INFURA";
  if (lower.includes("ankr")) return "ANKR";
  if (lower.includes("publicnode")) return "PUBLICNODE";
  if (lower.includes("cloudflare")) return "CLOUDFLARE";
  try {
    return new URL(url).hostname;
  } catch {
    return `RPC[${index}]`;
  }
}

// Pre-serialized blast body — ready to fire with zero work on the hot path.
export interface PreparedBlast {
  txHash: string;   // local keccak of the raw tx (computed before fire)
  body: string;     // JSON.stringify already done — just write bytes at T-0
  rawTx: string;    // original raw tx for keccak recomputation if needed
}

export function prepareBlast(rawTx: string): PreparedBlast {
  return {
    txHash: keccak256(rawTx) as string,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [rawTx],
      id: 1,
    }),
    rawTx,
  };
}

// Fire-and-forget blast to all endpoints, returns immediately.
// Used by the public path (local-mint.ts).
export function blastToAll(
  rawTxOrPrepared: string | PreparedBlast,
  endpoints: RpcEndpoint[]
): { txHash: string; responsePromise: Promise<BlastResult[]> } {
  const prepared: PreparedBlast =
    typeof rawTxOrPrepared === "string"
      ? prepareBlast(rawTxOrPrepared)
      : rawTxOrPrepared;

  const { txHash, body } = prepared;

  // Fire all requests and time each one individually
  const firePromises = endpoints.map((ep) => {
    const t0 = Date.now();
    return fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .then((res) => {
        const latencyMs = Date.now() - t0;
        return res.json().then((json) => ({ json, latencyMs }));
      })
      .catch((err) => {
        const latencyMs = Date.now() - t0;
        return { err, latencyMs };
      });
  });

  const responsePromise = Promise.allSettled(firePromises).then(async (settled) => {
    const results: BlastResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const ep = endpoints[i];
      const s = settled[i];
      if (s.status === "fulfilled") {
        const { json, latencyMs } = (s as any).value;
        if (json.result) {
          console.log(chalk.green(`  [${ep.label}] ACCEPTED ${latencyMs}ms — tx ${json.result}`));
          results.push({ label: ep.label, txHash: json.result, error: null });
        } else if (json.error) {
          const errMsg = json.error.message || JSON.stringify(json.error);
          console.log(chalk.red(`  [${ep.label}] REJECTED ${latencyMs}ms — ${errMsg}`));
          results.push({ label: ep.label, txHash: null, error: errMsg });
        }
      } else {
        const reason = (s as any).reason?.message || String(s);
        const latencyMs = (s as any).value?.latencyMs ?? 0;
        console.log(chalk.yellow(`  [${ep.label}] FAILED ${latencyMs}ms — ${reason}`));
        results.push({ label: ep.label, txHash: null, error: reason });
      }
    }
    return results;
  });

  return { txHash, responsePromise };
}

// Poll for a receipt with timeout. Used by both paths.
export async function waitForReceipt(
  txHash: string,
  rpcUrl: string,
  timeoutMs: number = 60000
): Promise<{ block: number; position: number; gasUsed: number; status: string; actualGasPrice?: bigint } | null> {
  const start = Date.now();
  let lastError: string | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [txHash],
          id: 1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const json = (await res.json()) as any;
      const receipt = json.result;
      if (receipt) {
        const gasUsed = parseInt(receipt.gasUsed, 16);
        const effectiveGasPrice = receipt.effectiveGasPrice
          ? BigInt(receipt.effectiveGasPrice)
          : undefined;
        return {
          block: parseInt(receipt.blockNumber, 16),
          position: parseInt(receipt.transactionIndex, 16),
          gasUsed,
          status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
          actualGasPrice: effectiveGasPrice,
        };
      }
      // Receipt not found — check if the tx itself exists (pending/dropped)
      const txRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionByHash",
          params: [txHash],
          id: 1,
        }),
      });
      const txJson = (await txRes.json()) as any;
      const tx = txJson.result;
      if (tx && tx.blockNumber === null) {
        // Still pending — keep polling
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // Not found at all
      lastError = "tx not found";
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err: any) {
      lastError = err.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.log(chalk.yellow(`  [${txHash.slice(0, 10)}…] TIMEOUT after ${timeoutMs/1000}s — no receipt, last error: ${lastError}`));
  // Return partial info: timed out but we know the txHash
  return null;
}
