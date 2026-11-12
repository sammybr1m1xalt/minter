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
  /**
   * Position in the endpoint array the blast was fired at. This is the ONLY
   * reliable way to find the endpoint that accepted a transaction: `label` is
   * derived from the URL host (`labelFromUrl`) and is not injective — every
   * URL containing "alchemy" becomes "ALCHEMY", so with two Alchemy endpoints
   * a label lookup returns the FIRST one, which may not be the one that
   * accepted. Polling the receipt on the wrong endpoint yields a null receipt
   * and reports a landed mint as UNKNOWN.
   */
  index: number;
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
            results[index] = { index, label: ep.label, txHash: json.result, error: null };
          } else if (json.error) {
            const errMsg = json.error.message || JSON.stringify(json.error);
            console.log(chalk.red(`  [${ep.label}] REJECTED ${latencyMs}ms — ${errMsg}`));
            results[index] = { index, label: ep.label, txHash: null, error: errMsg };
          } else {
            // Neither result nor error.
            const msg = "empty JSON-RPC response (no result, no error)";
            console.log(chalk.yellow(`  [${ep.label}] UNKNOWN ${latencyMs}ms — ${msg}`));
            results[index] = { index, label: ep.label, txHash: null, error: msg };
          }
        })
        .catch((err) => {
          // A network failure lands here rather than rejecting the wave: one
          // dead endpoint must not turn into a crashed mint.
          const msg = err?.message || String(err);
          console.log(chalk.yellow(`  [${ep.label}] FAILED ${Date.now() - t0}ms — ${msg}`));
          results[index] = { index, label: ep.label, txHash: null, error: msg };
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
          index: i,
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
    // The escalation timer must not outlive the race. When the first wave
    // settles first, an un-cleared handle keeps the event loop open for the
    // whole escalateAfterMs — the same defect settleRanking had.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), escalateAfterMs);
    });
    let outcome: "settled" | "timeout";
    try {
      outcome = await Promise.race([first.then(() => "settled" as const), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

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

/**
 * Parse a hex quantity from a receipt. A missing or malformed field must not
 * become NaN: it flows into gas reporting and the confirmation summary, where
 * NaN renders as "NaN" and silently poisons any arithmetic done with it.
 * null means "the node did not supply it", which is honest.
 */
export function parseHexQuantity(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = parseInt(String(value), 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a hex gas-price field. A raw `BigInt(receipt.effectiveGasPrice)` throws
 * on anything malformed, and the throw discarded a perfectly good receipt —
 * turning a landed mint into UNKNOWN. null means "not usable".
 */
export function parseGasPrice(value: unknown): bigint | null {
  if (value == null || value === "") return null;
  try {
    return BigInt(value as string);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll for a receipt with timeout. Used by both paths.
//
// Accepts one URL or several. Polling a single endpoint meant a slow or dead
// node reported a landed mint as UNKNOWN even when the caller had other
// working endpoints; the confirmation sweep already polls all of them, and the
// two paths disagreed.
export async function waitForReceipt(
  txHash: string,
  rpcUrlOrUrls: string | string[],
  timeoutMs: number = 60000
): Promise<{ block: number | null; position: number | null; gasUsed: number | null; status: string; actualGasPrice?: bigint } | null> {
  const rpcUrls = (Array.isArray(rpcUrlOrUrls) ? rpcUrlOrUrls : [rpcUrlOrUrls]).filter(Boolean);
  if (rpcUrls.length === 0) return null;

  const start = Date.now();
  let lastError: string | undefined;
  // "Mined, but no node will hand us a receipt" is a real state (a node still
  // indexing its latest blocks). It is not a reason to keep polling for the
  // whole budget, so it gets a short grace of its own and then reports UNKNOWN.
  const MINED_GRACE_MS = 10_000;
  let minedNoReceiptSince: number | null = null;

  const post = (url: string, method: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    return {
      promise: fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: [txHash], id: 1 }),
        signal: controller.signal,
      }).then((r) => r.json() as any).catch(() => null),
      cancel: () => clearTimeout(timer),
    };
  };

  while (Date.now() - start < timeoutMs) {
    // Ask EVERY endpoint in parallel, then take the first receipt. A hung
    // endpoint cannot hold the poll: each request is bounded individually, and
    // the loop's own deadline is checked between iterations.
    const receiptCalls = rpcUrls.map((url) => post(url, "eth_getTransactionReceipt"));
    const receiptAnswers = await Promise.all(receiptCalls.map((c) => c.promise));
    for (const c of receiptCalls) c.cancel();
    const receipt = receiptAnswers.find((j) => j?.result != null)?.result;

    if (receipt) {
      const effectiveGasPrice = parseGasPrice(receipt.effectiveGasPrice);
      return {
        block: parseHexQuantity(receipt.blockNumber),
        position: parseHexQuantity(receipt.transactionIndex),
        gasUsed: parseHexQuantity(receipt.gasUsed),
        // A missing status is a pre-Byzantium receipt: the tx was included,
        // so it succeeded. Only an explicit 0x0 is a revert.
        status: receipt.status === "0x0" ? "REVERTED" : "SUCCESS",
        actualGasPrice: effectiveGasPrice ?? undefined,
      };
    }

    // No receipt anywhere. Is the tx mined, pending, or absent?
    const txCalls = rpcUrls.map((url) => post(url, "eth_getTransactionByHash"));
    const txAnswers = await Promise.all(txCalls.map((c) => c.promise));
    for (const c of txCalls) c.cancel();
    const tx = txAnswers.find((j) => j?.result != null)?.result;

    if (tx && tx.blockNumber === null) {
      // Still pending — keep polling.
      await sleep(1000);
      continue;
    }
    if (tx && tx.blockNumber !== null) {
      // Mined, but no receipt. UNKNOWN is the honest verdict — the tx may have
      // landed, so it must not be reported as a failure. Give a node that is
      // still indexing a short grace, then stop rather than burning the budget.
      if (minedNoReceiptSince == null) {
        minedNoReceiptSince = Date.now();
        lastError = `mined in block ${parseHexQuantity(tx.blockNumber) ?? "?"} but no receipt returned`;
      }
      if (Date.now() - minedNoReceiptSince < MINED_GRACE_MS) {
        await sleep(1000);
        continue;
      }
      console.log(
        chalk.yellow(
          `  [${txHash.slice(0, 10)}…] mined but no receipt after ${MINED_GRACE_MS / 1000}s — reporting UNKNOWN (last: ${lastError})`
        )
      );
      return null;
    }

    // Not found at all
    lastError = "tx not found";
    await sleep(1500);
  }

  console.log(chalk.yellow(`  [${txHash.slice(0, 10)}…] TIMEOUT after ${timeoutMs/1000}s — no receipt, last error: ${lastError}`));
  // Return partial info: timed out but we know the txHash
  return null;
}
