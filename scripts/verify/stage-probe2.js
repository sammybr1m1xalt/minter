// Does the drop contract expose its stage array? And what is the singleton's
// current signed phase for it?
const fs = require("fs");
const { id } = require("/home/anon/minter/node_modules/ethers");
const SINGLE = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const DROP = "0x2957e11e2acd231894308c8fa44a4e8132db93ed";
const COLL = "0x0d08b807fec2e80dd40edbc4137e4542dc9c45bc";

const env = fs.readFileSync("/home/anon/minter/.env", "utf8");
const rpc = env.split("\n").find((l) => l.startsWith("RPC_URL_ETHEREUM=")).split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

async function call(to, data) {
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  return j.result ?? ("ERR " + JSON.stringify(j.error || j).slice(0, 120));
}

(async () => {
  // Stage array on the drop contract itself?
  for (const sig of ["getDropStages()", "getDropPhases()", "getDropStage(uint256)"]) {
    const sel = id(sig).slice(0, 10);
    const arg = sig.includes("uint256") ? "0".repeat(64) : "";
    console.log("DROP", sig, "=>", (await call(DROP, sel + arg)).slice(0, 160));
  }
  // Singleton signed phase for both candidate keys.
  for (const [nm, key] of [["drop", DROP], ["collection", COLL]]) {
    const sel = id("getSignedMintValidationParams(address,address)").slice(0, 10);
    const data = sel + key.slice(2).padStart(64, "0") + "0".repeat(64);
    console.log("SINGLE signed", nm, "=>", (await call(SINGLE, data)).slice(0, 200));
  }
  // What is 0x2957e11e? Try ERC165 / name / symbol.
  for (const sig of ["name()", "symbol()"]) {
    console.log("DROP", sig, "=>", (await call(DROP, id(sig).slice(0, 10))).slice(0, 160));
  }
})();
