// Probe the SeaDrop singleton for a per-contract stage array.
const fs = require("fs");
const { id } = require("/home/anon/minter/node_modules/ethers");
const SINGLE = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const COLL = "0x0d08b807fec2e80dd40edbc4137e4542dc9c45bc";
const DROP = "0x2957e11e2acd231894308c8fa44a4e8132db93ed";

const env = fs.readFileSync("/home/anon/minter/.env", "utf8");
const rpc = env.split("\n").find((l) => l.startsWith("RPC_URL_ETHEREUM=")).split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

(async () => {
  console.log("rpc host:", rpc.replace(/^https?:\/\//, "").split("/")[0]);
  for (const sig of ["getDropStages(address)", "getDropPhases(address)", "getPublicDrop(address)"]) {
    const sel = id(sig).slice(0, 10);
    for (const [nm, arg] of [["collection", COLL], ["drop", DROP]]) {
      const data = sel + arg.slice(2).padStart(64, "0");
      try {
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SINGLE, data }, "latest"] }),
        });
        const j = await r.json();
        console.log(sig, nm, "=>", j.result ? j.result.slice(0, 200) : JSON.stringify(j.error || j).slice(0, 200));
      } catch (e) {
        console.log(sig, nm, "ERR", e.message);
      }
    }
  }
})();
