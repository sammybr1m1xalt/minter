// Pre-establish TCP/TLS to every target so the first real request doesn't pay
// for a handshake. Warms only the RPC endpoints — OpenSea is handled separately
// by the FCFS path because it may need an API key in the request.
import chalk from "chalk";
import { parseRpcEndpoints, type RpcEndpoint } from "./rpc-blast";

export interface RankedEndpoint extends RpcEndpoint {
  latencyMs: number | null; // null = unmeasured (timed out or errored)
}

/**
 * Measure every endpoint in parallel and return them fastest-first.
 *
 * Unmeasured endpoints sort last rather than being dropped: a timed-out probe
 * is "we could not tell", not "this endpoint is broken", and dropping it would
 * remove a working inclusion path. Callers decide how many of the front of the
 * list to fire at before escalating to the rest.
 *
 * Parallel, not sequential — a sequential loop costs N round trips, which is
 * the entire T-0 budget on a slow endpoint.
 */
export async function rankRpcEndpoints(
  rpcUrls: string[],
  timeoutMs = 1500
): Promise<RankedEndpoint[]> {
  const endpoints = parseRpcEndpoints(rpcUrls);
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const t0 = performance.now();
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = (await res.json()) as any;
        if (json.result) {
          return { ...ep, latencyMs: Math.round(performance.now() - t0) };
        }
        return { ...ep, latencyMs: null };
      } catch {
        return { ...ep, latencyMs: null };
      }
    })
  );
  return results.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
}

/**
 * Resolve a ranking that is already in flight, waiting at most `budgetMs`.
 *
 * The ranking only orders the blast — it must never delay a mint, so a ranking
 * that has not finished in time yields null and the caller fires against its
 * original endpoint order instead. Callers should start the ranking well before
 * T-0 (during the wait, or during signing) so this budget is only a safety net.
 */
export async function settleRanking(
  ranking: Promise<RankedEndpoint[]>,
  budgetMs = 250
): Promise<RankedEndpoint[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ranking,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } finally {
    // Whichever side wins the race, the other side's timer must not stay live.
    // Both fire paths call this with a zero budget, where the timer is the
    // winning side — an un-cleared handle holds the event loop open.
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Minimal liveness check: eth_chainId + eth_blockNumber on each RPC.
// This is cheaper than the full probeEndpoints() (no chainId verification,
// no block-by-number fetch) but enough to ensure the socket+TLS+JSONRPC
// round-trip works before T-0.
export async function warmConnections(rpcUrls: string[]): Promise<void> {
  if (rpcUrls.length === 0) return;
  console.log(chalk.gray("  Warming RPC connections..."));

  const results = await Promise.allSettled(
    rpcUrls.map(async (url) => {
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
          signal: AbortSignal.timeout(5000),
        });
        const json = (await res.json()) as any;
        const latency = Math.round(performance.now() - t0);
        if (json.result) {
          return { url, ok: true, latency };
        }
        return { url, ok: false, error: json.error?.message || "no result" };
      } catch (err: any) {
        return { url, ok: false, error: err.message || String(err) };
      }
    })
  );

  let ok = 0;
  let fail = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      ok++;
    } else {
      fail++;
      const v = (r as PromiseFulfilledResult<any>).value;
      console.log(chalk.yellow(`    ⚠ ${v?.url || "?"} — ${v?.error || "failed"}`));
    }
  }
  console.log(chalk.green(`  Warmed: ${ok}/${ok + fail} RPC(s) alive.`));
}

/**
 * Silent keep-alive poll for the wait between preparation and T-0.
 *
 * Deliberately separate from warmConnections(), which reports: this runs every
 * couple of seconds and must not spam the console. Failures are ignored — a
 * failed ping is irrelevant and must never delay the wake-up.
 */
export async function pingRpcs(rpcUrls: string[]): Promise<void> {
  await Promise.allSettled(
    rpcUrls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
        signal: AbortSignal.timeout(3000),
      }).then(() => undefined)
    )
  );
}
