"use strict";
/* Regression: SeaDrop plans target the singleton, and sold-out reverts are
 * named instead of "unknown custom error". */
require("dotenv").config({ quiet: true, path: "/home/anon/minter/.env" });
const { AbiCoder, JsonRpcProvider } = require("ethers");
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
  ok("public mint is priced free", plan?.value === 0n, `value=${String(plan?.value)}`);
  const raw = "0xe12d2314" + new AbiCoder().encode(["uint256", "uint256"], [3000n, 3000n]).slice(2);
  ok("decoder names sold-out revert", /MintQuantityExceedsMaxSupply\(3000,3000\)/.test(M.decodeMintRevert({ data: raw })), `decoded=${M.decodeMintRevert({ data: raw })}`);
  const err = plan?.simulationError || "";
  ok("revert is decoded, not unknown", plan?.simulationReverted === false || /MintQuantityExceedsMaxSupply|mint quantity exceeds max supply/i.test(err), `err=${err}`);
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e?.shortMessage || e?.message || e); process.exit(1); });
