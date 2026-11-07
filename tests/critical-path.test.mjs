// Tests for the T-0 critical-path fix and the error-code handling.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/critical-path.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { Interface, Wallet } from "ethers";

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; failures.push(name); }
}

execSync(
  `npx tsc src/opensea-gql.ts src/fcfs-drops.ts src/fcfs-mint.ts --outDir tests/.compiled --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --esModuleInterop`,
  { stdio: "pipe" },
);
const gql = await import(`./.compiled/opensea-gql.js?t=${Date.now()}`);
const fcfs = await import(`./.compiled/fcfs-mint.js?t=${Date.now()}`);

const MP = "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients)";
const iface = new Interface([
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MP} mintParams, uint256 salt, bytes signature) payable`,
]);
// A throwaway key ONLY — generated here, never a real wallet.
const testWallet = Wallet.createRandom();
const WALLET = testWallet.address;
const NFT = "0x2222222222222222222222222222222222222222";
const FEE = "0x3333333333333333333333333333333333333333";
const MP_VALS = [1000000000000000n, 5n, 1700000000n, 1700003600n, 3n, 10000n, 250n, true];
const calldata = iface.encodeFunctionData("mintSigned", [NFT, FEE, WALLET, 1n, MP_VALS, 1n, "0xabcd"]);

console.log("\nexecuteFcfsSnipe: pre-fetched payload path");

await test("uses the pre-fetched payload and makes ZERO OpenSea calls", async () => {
  let openseaCalled = false;
  const realFetch = globalThis.fetch;
  // Any request to api.opensea.io or gql.opensea.io fails the test. RPC calls
  // to the dead local endpoint are expected (and fail harmlessly).
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("opensea.io")) { openseaCalled = true; throw new Error("OpenSea must not be called"); }
    throw new Error("no node at " + u);
  };
  try {
    const results = await fcfs.executeFcfsSnipe({
      nftContract: NFT,
      quantity: 1,
      walletKeys: [testWallet.privateKey],
      rpcUrls: ["http://127.0.0.1:1"],
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
      gasLimit: 250000,
      targetStart: new Date(Date.now() - 60000), // past: no wait
      plan: { payload: null, quantity: 1, gasLimit: 250000, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n },
      payloads: [{
        seaDropAddress: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
        nftContract: NFT,
        feeRecipient: FEE,
        mintData: calldata,
        mintSignature: "0x",
        value: 1000000000000000n,
        drop: { mintPrice: 1000000000000000n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false },
      }],
    });
    assert.equal(openseaCalled, false, "OpenSea was called despite a pre-fetched payload");
    assert.ok(Array.isArray(results), "expected a results array");
    // The tx was signed and blasted to the (dead) endpoint, so no txHash.
    assert.equal(results.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("a payload bound to a DIFFERENT wallet is refused, not broadcast", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no node"); };
  try {
    const results = await fcfs.executeFcfsSnipe({
      nftContract: NFT,
      quantity: 1,
      walletKeys: [testWallet.privateKey],
      rpcUrls: ["http://127.0.0.1:1"],
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
      gasLimit: 250000,
      targetStart: new Date(Date.now() - 60000),
      plan: { payload: null, quantity: 1, gasLimit: 250000, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n },
      // calldata is bound to WALLET, but we pass a different wallet key.
      payloads: [{
        seaDropAddress: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
        nftContract: NFT,
        feeRecipient: FEE,
        mintData: iface.encodeFunctionData("mintSigned", [NFT, FEE, "0x9999999999999999999999999999999999999999", 1n, MP_VALS, 1n, "0xabcd"]),
        mintSignature: "0x",
        value: 1000000000000000n,
        drop: { mintPrice: 1000000000000000n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false },
      }],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].success, false, "must not report success");
    assert.match(results[0].error, /bound to a different wallet/, `unexpected error: ${results[0].error}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log("\npostMintTx: documented error codes are handled");
await test("all five documented 422 codes have a branch", () => {
  const documented = ["MINTER_NOT_ELIGIBLE", "MINT_LIMIT_EXCEEDED", "SUPPLY_EXHAUSTED", "INSUFFICIENT_BALANCE", "NO_PAYOUT_ADDRESS"];
  const src = execSync("grep -o 'case \"[A-Z_]*\"' src/opensea-gql.ts || true", { encoding: "utf8" });
  for (const c of documented) {
    assert.ok(src.includes(`case "${c}"`), `missing documented 422 code: ${c}`);
  }
});

await test("documented DropMintResponse fields are surfaced on the result", () => {
  const src = execSync("cat src/opensea-gql.ts", { encoding: "utf8" });
  for (const f of ["stageUuid", "stageType", "stageStart", "stageEnd"]) {
    assert.ok(src.includes(f), `PostMintTxResult missing field: ${f}`);
  }
  // The docs' stable error code must be read, not just the message.
  assert.ok(/errObj\?\.code|json\?\.code/.test(src), "error `code` is not read from the body");
});

await test("message-text matching is gone (docs say branch on code)", () => {
  const src = execSync("cat src/opensea-gql.ts", { encoding: "utf8" });
  assert.ok(!/msgLower\.includes/.test(src), "still string-matching the error message");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:", failures.join(", ")); process.exit(1); }
