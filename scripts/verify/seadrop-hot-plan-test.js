"use strict";
/* Regression: a SeaDrop free drop must be planned against the SeaDrop
 * singleton, not by calling the collection's mintSeaDrop from an EOA. */
require("dotenv").config({ quiet: true, path: "/home/anon/minter/.env" });
const { JsonRpcProvider } = require("ethers");
const M = require("/home/anon/minter/dist/mint-generic.js");
const S = require("/home/anon/minter/dist/seadrop-public.js");

const ADDR = "0xcc5ae4a33520c98d9921fae17d3774c933373289";
const FROM = "0x1111111111111111111111111111111111112222";
const rpc = process.env.RPC_URL_ETHEREUM || process.env.RPC_URL;

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
  };
  if (!rpc) { console.log("  SKIP no RPC_URL_ETHEREUM"); process.exit(0); }
  const provider = new JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const plan = await M.buildGenericMintTx(ADDR, provider, FROM, 1n);
  provider.destroy();
  ok("targets SeaDrop singleton", plan?.to?.toLowerCase() === S.SEADROP_ADDRESS.toLowerCase(), `to=${plan?.to}`);
  ok("uses mintPublic entrypoint", /mintPublic/.test(plan?.selector || ""), `selector=${plan?.selector}`);
  ok("simulation passes from the buyer", plan?.simulationReverted === false, `err=${plan?.simulationError || "none"}`);
  ok("public mint is priced free", plan?.value === 0n, `value=${String(plan?.value)}`);
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e?.shortMessage || e?.message || e); process.exit(1); });
