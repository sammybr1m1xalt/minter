// Where does the T-0 critical path actually spend its time?
// Times each call the fire block makes, N trials, against a real public RPC.
const { JsonRpcProvider, Wallet } = require("/home/anon/minter/node_modules/ethers");
const { simulateTx } = require("/home/anon/minter/dist/simulate.js");
const { autoGasBounded } = require("/home/anon/minter/dist/auto-gas.js");

const RPC = process.env.MEASURE_RPC;
const CHAIN = Number(process.env.MEASURE_CHAIN || 1);
const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FROM = "0x1111111111111111111111111111111111111111";
// mintPublic(address,uint256) — a real SeaDrop entry point; the call reverts for
// this sender, which is the realistic shape (a revert still costs a round trip).
const DATA = "0x8c99b723" + "0".repeat(64) + "0".repeat(64);
const VALUE = 0n;

const N = Number(process.env.N || 20);
const p = new JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, pollingInterval: 4000 });
const w = new Wallet("0x" + "11".repeat(32));

const t = async (label, fn) => {
  const s = Date.now();
  try { await fn(); } catch { /* revert/timing out is a normal outcome */ }
  return Date.now() - s;
};
const pct = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), max: s[s.length - 1], min: s[0] };
};

(async () => {
  const rows = {};
  const all = [];
  for (let i = 0; i < N; i++) {
    rows.sim = rows.sim || [];
    rows.estimate = rows.estimate || [];
    rows.fee = rows.fee || [];
    rows.nonce = rows.nonce || [];
    rows.gasFull = rows.gasFull || [];
    rows.sign = rows.sign || [];
    rows.allThree = rows.allThree || [];

    rows.sim.push(await t("sim", () => simulateTx(p, { to: SEADROP, from: FROM, data: DATA, value: VALUE }, 2000)));
    rows.estimate.push(await t("est", () => p.estimateGas({ to: SEADROP, from: FROM, data: DATA, value: VALUE })));
    rows.fee.push(await t("fee", () => p.getFeeData()));
    rows.nonce.push(await t("nonce", () => p.getTransactionCount(FROM, "pending")));
    rows.gasFull.push(await t("gas", () => autoGasBounded(p, { to: SEADROP, from: FROM, data: DATA, value: VALUE }, 2000)));
    rows.sign.push(await t("sign", () => w.signTransaction({ to: SEADROP, data: DATA, value: VALUE, gasLimit: 400000, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1500000000n, nonce: 1, chainId: CHAIN })));
    rows.allThree.push(await t("all", async () => {
      await Promise.all([
        simulateTx(p, { to: SEADROP, from: FROM, data: DATA, value: VALUE }, 2000),
        autoGasBounded(p, { to: SEADROP, from: FROM, data: DATA, value: VALUE }, 2000),
        p.getTransactionCount(FROM, "pending"),
      ]);
    }));
  }
  console.log("chain", CHAIN, "rpc", RPC.replace(/\/\/.*@/, "//<redacted>@"), "trials", N);
  for (const k of Object.keys(rows)) {
    const r = pct(rows[k]);
    console.log(`${k.padEnd(10)} p50=${String(r.p50).padStart(5)}ms  p90=${String(r.p90).padStart(5)}ms  max=${String(r.max).padStart(5)}ms  min=${String(r.min).padStart(4)}ms`);
  }
  const sum = ["sim", "estimate", "fee", "nonce"].reduce((a, k) => a + pct(rows[k]).p50, 0);
  console.log(`\nsum of the four sequential p50s = ${sum}ms   vs parallel allThree p50 = ${pct(rows.allThree).p50}ms`);
})().catch((e) => { console.error(e); process.exit(1); });
