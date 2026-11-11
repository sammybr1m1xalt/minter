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
  if (lower.includes("rpc.soneium.org")) return "soneium-public";
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

export interface BlastOptions {
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /**
   * Fire at only the first N endpoints, then escalate to the rest only if none
   * of them accepts. Pass a latency-ranked list so the fastest go first.
   * 0 (default) fires at every endpoint at once — the original behaviour.
   */
  firstWave?: number;
  /** How long to wait for the first wave before firing the rest. Default 600ms. */
  escalateAfterMs?: number;
}

// Fire-and-forget blast to all endpoints, returns immediately.
// Used by the public path (local-mint.ts).
export function blastToAll(
  rawTxOrPrepared: string | PreparedBlast,
  endpoints: RpcEndpoint[],
  opts: BlastOptions = {}
): { txHash: string; responsePromise: Promise<BlastResult[]> } {
  const { timeoutMs = 10_000, firstWave = 0, escalateAfterMs = 600 } = opts;

  const prepared: PreparedBlast =
    typeof rawTxOrPrepared === "string"
      ? prepareBlast(rawTxOrPrepared)
      : rawTxOrPrepared;

  const { txHash, body } = prepared;

  // Pre-sized so results stay index-aligned with `endpoints` no matter which
  // wave fills them — a caller indexing by endpoint must never read a
  // neighbouring endpoint's verdict.
  const results: BlastResult[] = new Array(endpoints.length);

  const fire = (
    targets: Array<{ index: number; ep: RpcEndpoint }>
  ): Promise<void> => {
    const promises = targets.map(({ index, ep }) => {
      const t0 = Date.now();
      return fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        // A hung endpoint must not hold responsePromise open forever — both
        // callers await it, so one stalled RPC would hang the whole mint.
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then(async (res) => {
          const latencyMs = Date.now() - t0;
          const json = (await res.json()) as any;
          return { json, latencyMs };
        })
        .then(({ json, latencyMs }) => {
          if (json.result) {
            console.log(chalk.green(`  [${ep.label}] ACCEPTED ${latencyMs}ms — tx ${json.result}`));
            results[index] = { label: ep.label, txHash: json.result, error: null };
          } else if (json.error) {
            const errMsg = json.error.message || JSON.stringify(json.error);
            console.log(chalk.red(`  [${ep.label}] REJECTED ${latencyMs}ms — ${errMsg}`));
            results[index] = { label: ep.label, txHash: null, error: errMsg };
          } else {
            // Neither result nor error.
            const msg = "empty JSON-RPC response (no result, no error)";
            console.log(chalk.yellow(`  [${ep.label}] UNKNOWN ${latencyMs}ms — ${msg}`));
            results[index] = { label: ep.label, txHash: null, error: msg };
          }
        })
        .catch((err) => {
          // A network failure lands here rather than rejecting the wave: one
          // dead endpoint must not turn into a crashed mint.
          const msg = err?.message || String(err);
          console.log(chalk.yellow(`  [${ep.label}] FAILED ${Date.now() - t0}ms — ${msg}`));
          results[index] = { label: ep.label, txHash: null, error: msg };
        });
    });
    return Promise.all(promises).then(() => undefined);
  };

  const indexed = endpoints.map((ep, index) => ({ index, ep }));
  const wave1 = firstWave > 0 ? indexed.slice(0, firstWave) : indexed;
  const wave2 = firstWave > 0 ? indexed.slice(firstWave) : [];

  // Endpoints the escalation never reached must still occupy their slot: the
  // array is documented as index-aligned with `endpoints`, and a hole would read
  // as `undefined` to any caller indexing by position.
  const finalize = (): BlastResult[] => {
    for (let i = 0; i < results.length; i++) {
      if (results[i] == null) {
        results[i] = {
          label: endpoints[i].label,
          txHash: null,
          error: "not fired — an earlier endpoint accepted the transaction",
        };
      }
    }
    return results;
  };

  const responsePromise = (async () => {
    if (wave2.length === 0) {
      await fire(wave1);
      return finalize();
    }

    // First wave goes out now; the rest only if it produces no acceptance
    // within escalateAfterMs. A slow tail must not delay the endpoints most
    // likely to include the transaction.
    const first = fire(wave1);
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), escalateAfterMs)
    );
    const outcome = await Promise.race([
      first.then(() => "settled" as const),
      timer,
    ]);

    if (outcome === "settled") {
      if (results.some((r) => r != null && r.txHash != null)) return finalize();
      await fire(wave2);
      return finalize();
    }

    // The timer won while the first wave is still in flight. Fire the rest now
    // rather than waiting for it — waiting is exactly the delay this avoids.
    await Promise.all([first, fire(wave2)]);
    return finalize();
  })();

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
          // A missing status is a pre-Byzantium receipt: the tx was included,
          // so it succeeded. Only an explicit 0x0 is a revert.
          status: receipt.status === "0x0" ? "REVERTED" : "SUCCESS",
          actualGasPrice: effectiveGasPrice,
        };
      }
      // Receipt not found — check if the tx itself exists (pending/dropped).
      // This fetch MUST be bounded too. The loop's `timeoutMs` is checked
      // between iterations; a fetch that hangs inside an iteration bypasses it
      // entirely, so an RPC that accepts the connection and then stalls would
      // hang the receipt poll forever.
      const txController = new AbortController();
      const txTimer = setTimeout(() => txController.abort(), 3000);
      let txJson: any;
      try {
        const txRes = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionByHash",
            params: [txHash],
            id: 1,
          }),
          signal: txController.signal,
        });
        txJson = (await txRes.json()) as any;
      } catch {
        // Treat a failed lookup as "not found yet" and keep polling.
        txJson = null;
      } finally {
        clearTimeout(txTimer);
      }
      const tx = txJson?.result;
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
