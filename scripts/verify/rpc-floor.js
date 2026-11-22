// Is the T-0 cost the number of calls, or the RPC itself?
const { JsonRpcProvider, Wallet } = require("/home/anon/minter/node_modules/ethers");
const RPC = process.env.MEASURE_RPC;
const CHAIN = 1;
const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FROM = "0x1111111111111111111111111111111111111111";
const DATA = "0x8c99b723" + "0".repeat(64) + "0".repeat(64);

const p = new JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, pollingInterval: 4000 });
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const run = async (label, fn, n = 15) => {
  const xs = [];
  for (let i = 0; i < n; i++) { const s = Date.now(); try { await fn(); } catch {} xs.push(Date.now() - s); }
  console.log(`${label.padEnd(34)} p50=${String(med(xs)).padStart(5)}ms  min=${String(Math.min(...xs)).padStart(4)}ms`);
  return med(xs);
};

// A raw batch: one HTTP request carrying all three calls.
async function batch3() {
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SEADROP, from: FROM, data: DATA }, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_estimateGas", params: [{ to: SEADROP, from: FROM, data: DATA }] },
    { jsonrpc: "2.0", id: 3, method: "eth_getTransactionCount", params: [FROM, "pending"] },
  ]);
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  await r.json();
}

(async () => {
  console.log("rpc", RPC.replace(/\/\/.*@/, "//<redacted>@"));
  // Cold: a brand-new provider, first request pays TCP+TLS.
  const cold = new JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, pollingInterval: 4000 });
  const cs = Date.now(); try { await cold.getTransactionCount(FROM, "pending"); } catch {}
  console.log(`${"cold first call (new provider)".padEnd(34)} ${Date.now() - cs}ms`);
  cold.destroy();

  const warm = await run("warm single call (nonce)", () => p.getTransactionCount(FROM, "pending"));
  await run("nonce pending", () => p.getTransactionCount(FROM, "pending"));
  await run("nonce latest", () => p.getTransactionCount(FROM, "latest"));
  await run("eth_call (sim shape)", () => p.call({ to: SEADROP, from: FROM, data: DATA }));
  await run("eth_estimateGas", () => p.estimateGas({ to: SEADROP, from: FROM, data: DATA }));
  await run("getFeeData (ethers)", () => p.getFeeData());
  await run("BATCH of the same 3 calls", batch3, 15);
  await run("3 separate, sequential", async () => {
    await p.call({ to: SEADROP, from: FROM, data: DATA });
    await p.estimateGas({ to: SEADROP, from: FROM, data: DATA });
    await p.getTransactionCount(FROM, "pending");
  }, 10);
  console.log(`\nsingle warm call p50 = ${warm}ms — that is the floor. Everything else is either parallel with it or a multiple of it.`);
})().catch((e) => { console.error(e); process.exit(1); });
