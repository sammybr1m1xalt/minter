// Verify a GraphQL payload is tied to its stage by the window OpenSea signed
// into mintParams, with the stage index as the fallback when no window exists.
const { spawn } = require("child_process");
const { Wallet, Interface } = require("/home/anon/minter/node_modules/ethers");

const DIR = __dirname;
const KEY = "0x" + "11".repeat(32);
const WALLET = new Wallet(KEY).address;
const NFT = "0x2957e11e2acd231894308c8fa44a4e8132db93ed";
const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

const S1 = 1_800_000_000;
const E1 = 1_800_000_600;

const TUPLE =
  "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, " +
  "uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, " +
  "uint256 feeBps, bool restrictFeeRecipients)";
const iface = new Interface([
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${TUPLE} mintParams, uint256 salt, bytes signature) payable`,
]);

const calldata = iface.encodeFunctionData("mintSigned", [
  NFT,
  "0x0000000000000000000000000000000000000000",
  WALLET,
  1,
  {
    mintPrice: 5600000000000000n,
    maxTotalMintableByWallet: 2,
    startTime: S1,
    endTime: E1,
    dropStageIndex: 1,
    maxTokenSupplyForStage: 1000,
    feeBps: 0,
    restrictFeeRecipients: false,
  },
  1,
  "0x" + "00".repeat(65),
]);

// Sanity: the decoder must read back exactly what was encoded.
const { decodeMintParams } = require("/home/anon/minter/dist/seadrop-calldata.js");
const dec = decodeMintParams(calldata);
console.log("decode check:", dec && dec.startTime === S1 && dec.endTime === E1 && dec.dropStageIndex === 1 ? "PASS" : "FAIL " + JSON.stringify(dec));

function runCase(name, env) {
  return new Promise((resolve) => {
    const p = spawn("node", ["run.js", name, "1"], {
      cwd: DIR,
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => {
      const ls = out.split("\n");
      // run.js prints JSON.stringify({...}, null, 2) — find the opening brace of
      // the final pretty-printed object and parse from there.
      let start = -1;
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i] === "{") { start = i; break; }
      if (start >= 0) {
        try { return resolve(JSON.parse(ls.slice(start).join("\n"))); } catch {}
      }
      resolve({ ok: -1, refused: [{ err: out.slice(-300) }] });
    });
  });
}

const lines = [];
const check = (n, ok, d) => { lines.push(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? " — " + d : ""}`); };

(async () => {
  const base = { CALLDATA: calldata };

  let r = await runCase("window match", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE", EXPECTED_START: String(S1), EXPECTED_END: String(E1) });
  check("S1 window matches the payload's signed window", r.ok === 1, `ok=${r.ok}`);

  r = await runCase("start differs", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE", EXPECTED_START: String(S1 + 1), EXPECTED_END: String(E1) });
  check("S2 a different start is refused", r.ok === 0 && /stage opening/.test(r.refused?.[0]?.err || ""), r.refused?.[0]?.err);

  r = await runCase("end differs", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE", EXPECTED_START: String(S1), EXPECTED_END: String(E1 + 1) });
  check("S3 a different end is refused", r.ok === 0 && /stage closing/.test(r.refused?.[0]?.err || ""), r.refused?.[0]?.err);

  r = await runCase("type differs", { ...base, EXPECTED_TYPE: "PUBLIC_SALE", EXPECTED_START: String(S1), EXPECTED_END: String(E1) });
  check("S4 a public selection against a signed payload is refused", r.ok === 0 && /public sale stage/.test(r.refused?.[0]?.err || ""), r.refused?.[0]?.err);

  r = await runCase("index differs, no window", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE", EXPECTED_INDEX: "2" });
  check("S5 index arbitrates when no window is stated", r.ok === 0 && /stage index 1/.test(r.refused?.[0]?.err || ""), r.refused?.[0]?.err);

  r = await runCase("index matches, no window", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE", EXPECTED_INDEX: "1" });
  check("S6 a matching index is allowed", r.ok === 1, `ok=${r.ok}`);

  r = await runCase("nothing to compare", { ...base, EXPECTED_TYPE: "SIGNED_PRESALE" });
  check("S7 type-only cannot tell, so it allows", r.ok === 1, `ok=${r.ok}`);

  require("fs").writeFileSync(DIR + "/stage-window-out.txt", lines.join("\n") + "\n");
  console.log("\n" + lines.join("\n"));
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n${lines.length - failed}/${lines.length} passed`);
  process.exit(failed ? 1 : 0);
})();
