// Verify the opensea-key fixes: NaN-safe quota headers, and a probe timeout
// preserving the last known quota instead of erasing it.
const realFetch = globalThis.fetch;
const RealResponse = Response;

let mode = "nan"; // nan | zero | ok | hang
globalThis.fetch = (url, opts) => {
  if (mode === "hang") {
    // honour the AbortSignal, the way undici does — a blackholed endpoint
    return new Promise((_, reject) => {
      const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
      if (opts && opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return Promise.resolve().then(() => {
  if (mode === "nan") {
    return new RealResponse("{}", { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "abc", "x-ratelimit-reset": "xyz" } });
  }
  if (mode === "zero") {
    return new RealResponse("{}", { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" } });
  }
  return new RealResponse("{}", { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "42", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } });
  });
};

const lines = [];
const check = (n, ok, d) => lines.push(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);

async function main() {
  const key = require("/home/anon/minter/dist/opensea-key.js");

  mode = "nan";
  const p1 = await key.probeKey("k", 2000);
  check("N1 non-numeric remaining reads as unknown (-1), not NaN", p1.remaining === -1, String(p1.remaining));
  check("N2 non-numeric reset reads as 0", p1.resetAt === 0, String(p1.resetAt));
  const scored = key.computeScore({ api_key: "k", name: "n", expires_at: "", minted_at: new Date().toISOString(), times_used: 0, last_probe: p1.status, last_probe_at: new Date().toISOString(), probe_latency_ms: 1, score: 0, remaining_calls: p1.remaining, rate_limit_reset: p1.resetAt });
  check("N3 score stays finite", Number.isFinite(scored), String(scored));

  mode = "zero";
  const p2 = await key.probeKey("k", 2000);
  check("N4 remaining 0 is classified alive_but_exhausted", p2.status === "alive_but_exhausted", p2.status);

  mode = "ok";
  const p3 = await key.probeKey("k", 2000);
  check("N5 numeric headers survive", p3.remaining === 42 && p3.resetAt > 0, `${p3.remaining}/${p3.resetAt}`);

  // a probe timeout must not erase the cached quota
  mode = "hang";
  const entry = {
    api_key: "k", name: "n", expires_at: "", minted_at: new Date().toISOString(),
    times_used: 0, last_probe: "alive", last_probe_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    probe_latency_ms: 12, score: 1000, remaining_calls: 37, rate_limit_reset: Math.floor(Date.now() / 1000) + 3600,
  };
  const t0 = Date.now();
  const { pool, best } = await key.probeAndRankPool([entry], () => 900);
  const took = Date.now() - t0;
  const after = pool.find((e) => e.api_key === "k");
  check("N6 probe timeout bounded by the caller budget", took < 3000, `${took}ms`);
  check("N7 timeout preserves the cached remaining_calls", after.remaining_calls === 37, String(after.remaining_calls));
  check("N8 timeout preserves the cached reset time", after.rate_limit_reset === entry.rate_limit_reset, String(after.rate_limit_reset));
  check("N9 timeout preserves the last real verdict", after.last_probe === "alive", after.last_probe);

  require("fs").writeFileSync(__dirname + "/key-fix-out.txt", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n${lines.length - failed}/${lines.length} passed`);
  globalThis.fetch = realFetch;
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
