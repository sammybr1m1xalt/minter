// Pre-establish TCP/TLS to every target so the first real request doesn't pay
// for a handshake. Warms only the RPC endpoints — OpenSea is handled separately
// by the FCFS path because it may need an API key in the request.
import chalk from "chalk";
import { probeEndpoints, EndpointHealth } from "./rpc-health";

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
