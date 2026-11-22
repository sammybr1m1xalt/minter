// Is the cold start real, and does it hit the T-0 path?
const { JsonRpcProvider } = require("/home/anon/minter/node_modules/ethers");
const RPC = process.env.MEASURE_RPC;
const FROM = "0x1111111111111111111111111111111111111111";

(async () => {
  console.log("rpc", RPC.replace(/\/\/.*@/, "//<redacted>@"));
  console.log("node", process.version);

  // A: one provider, many calls — the warm path.
  const a = new JsonRpcProvider(RPC, 1, { staticNetwork: true, pollingInterval: 4000 });
  for (let i = 0; i < 4; i++) {
    const s = Date.now(); await a.getTransactionCount(FROM, "pending");
    console.log(`provider A call ${i}: ${Date.now() - s}ms`);
  }

  // B: a brand-new provider per call, same origin — what the fire block does.
  for (let i = 0; i < 4; i++) {
    const b = new JsonRpcProvider(RPC, 1, { staticNetwork: true, pollingInterval: 4000 });
    const s = Date.now(); await b.getTransactionCount(FROM, "pending");
    console.log(`fresh provider B ${i}: ${Date.now() - s}ms`);
    b.destroy();
  }

  // C: fresh provider, but warmed by a throwaway request first.
  const c = new JsonRpcProvider(RPC, 1, { staticNetwork: true, pollingInterval: 4000 });
  let s = Date.now(); await c.getTransactionCount(FROM, "pending");
  console.log(`C warm-up: ${Date.now() - s}ms`);
  s = Date.now(); await c.getTransactionCount(FROM, "pending");
  console.log(`C second:  ${Date.now() - s}ms`);

  // D: does an explicit eth_chainId (staticNetwork off) cost an extra round trip?
  const d = new JsonRpcProvider(RPC, 1, { staticNetwork: false, pollingInterval: 4000 });
  s = Date.now(); await d.getTransactionCount(FROM, "pending");
  console.log(`D no staticNetwork: ${Date.now() - s}ms`);
  d.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
