// Test harness for the minter audit fixes.
// Run: node tests/calldata.test.mjs
// Uses ethers to CONSTRUCT calldata and decode it — the decoder is the oracle,
// per api-conformance-audit's wire-format-verification rule.
import { Interface } from "ethers";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; failures.push(name); }
}

// ── Ground truth: build real calldata with ethers ────────────────────────────
const MP = "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients)";
const SEADROP_ABI = [
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MP} mintParams, uint256 salt, bytes signature) payable`,
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MP} mintParams, bytes32[] proof) payable`,
];
const WALLET = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x9999999999999999999999999999999999999999";
const NFT = "0x2222222222222222222222222222222222222222";
const FEE = "0x3333333333333333333333333333333333333333";
const MP_VALS = [1000000000000000n, 5n, 1700000000n, 1700003600n, 3n, 10000n, 250n, true];

const iface = new Interface(SEADROP_ABI);
const signedData = iface.encodeFunctionData("mintSigned", [NFT, FEE, WALLET, 2n, MP_VALS, 12345n, "0xabcdef"]);
const allowData = iface.encodeFunctionData("mintAllowList", [NFT, FEE, WALLET, 2n, MP_VALS, ["0x" + "ab".repeat(32)]]);

// ── Load the module under test ──────────────────────────────────────────────
// opensea-gql.ts is TypeScript; compile the single file to a temp .mjs and import.
const TMP_DIR = "tests/.compiled";
execSync(
  `npx tsc src/opensea-gql.ts src/fcfs-drops.ts src/fcfs-mint.ts --outDir ${TMP_DIR} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --esModuleInterop`,
  { cwd: process.cwd(), stdio: "pipe" },
);
const gql = await import(`./.compiled/opensea-gql.js?t=${Date.now()}`);

console.log("\nopensea-gql: isPayloadBoundToWallet");
test("accepts calldata bound to the wallet (mintSigned)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: signedData }, WALLET), true);
});
test("rejects calldata bound to a different wallet (mintSigned)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: signedData }, WALLET_B), false);
});
test("accepts calldata bound to the wallet (mintAllowList)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: allowData }, WALLET), true);
});
test("rejects calldata bound to a different wallet (mintAllowList)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: allowData }, WALLET_B), false);
});
test("fails OPEN on undecodable input (null mintData)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: null }, WALLET), true);
});
test("fails OPEN on garbage hex", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: "0xdeadbeef" }, WALLET), true);
});
test("fails OPEN on non-SeaDrop calldata (unknown selector)", () => {
  assert.equal(gql.isPayloadBoundToWallet({ mintData: "0xa9059cbb" + "00".repeat(64) }, WALLET), true);
});

console.log("\nopensea-gql: decodeStageIndex");
test("decodes dropStageIndex from mintSigned calldata", () => {
  assert.equal(gql.decodeStageIndex(signedData), 3);
});
test("decodes dropStageIndex from mintAllowList calldata", () => {
  assert.equal(gql.decodeStageIndex(allowData), 3);
});
test("returns null for a public-sale selector (no stage index)", () => {
  assert.equal(gql.decodeStageIndex("0x161ac21f" + "00".repeat(32)), null);
});
test("returns null on short calldata", () => {
  assert.equal(gql.decodeStageIndex("0x4b61cd6f"), null);
});

console.log("\nfcfs-drops: isPublicStage classification");
const { classifyStageType } = await import(`./.compiled/fcfs-drops.js?t=${Date.now()}`);
test("PUBLIC_SALE (SCREAMING, GQL) is public", () => {
  assert.equal(classifyStageType("PUBLIC_SALE"), true);
});
test("public_sale (snake, REST) is public", () => {
  assert.equal(classifyStageType("public_sale"), true);
});
test("public is public", () => {
  assert.equal(classifyStageType("public"), true);
});
test("PUBLIC is public (case-insensitive)", () => {
  assert.equal(classifyStageType("PUBLIC"), true);
});
test("ALLOWLIST is not public", () => {
  assert.equal(classifyStageType("ALLOWLIST"), false);
});
test("FCFS is not public", () => {
  assert.equal(classifyStageType("FCFS"), false);
});
test("null is not public", () => {
  assert.equal(classifyStageType(null), false);
});

console.log("\nfcfs-mint: classifyMintMode");
const fcfs = await import(`./.compiled/fcfs-mint.js?t=${Date.now()}`);
function mkDrop(over) {
  return Object.assign({
    dropId: "d1", nftContract: NFT, name: "x", type: null,
    startTime: 1, endTime: 2, mintPrice: 1000n, maxTotalMintableByWallet: 0,
    maxTotalMintable: 0, totalMinted: 0, feeBps: 0, feeRecipient: null,
    mintData: null, mintSignature: null, gasLimit: null, maxFeePerGas: null,
    maxPriorityFeePerGas: null, eligible: null, eligibleCount: null,
    totalAllocated: null, eligiblePrice: null, allowlistedAddresses: [],
    allowlistHash: null, isPublicStage: false, raw: {},
  }, over);
}
test("public stage is fireable locally with no pre-fetch", () => {
  const r = fcfs.classifyMintMode(mkDrop({ isPublicStage: true, mintPrice: 1000n }));
  assert.deepEqual(r, { mode: "public", fireableLocally: true, preFetchNeeded: false });
});
test("GQL PUBLIC_SALE stage reaches the public path", () => {
  const r = fcfs.classifyMintMode(mkDrop({ type: "PUBLIC_SALE", isPublicStage: true, mintPrice: 1000n }));
  assert.equal(r.mode, "public");
  assert.equal(r.preFetchNeeded, false);
});
test("OVR (SCREAMING, GQL) is classified allowlist", () => {
  const r = fcfs.classifyMintMode(mkDrop({ type: "OVR" }));
  assert.equal(r.mode, "allowlist");
});
test("ovr (lowercase) is classified allowlist", () => {
  const r = fcfs.classifyMintMode(mkDrop({ type: "ovr" }));
  assert.equal(r.mode, "allowlist");
});
test("TOKEN_GATED (SCREAMING, GQL) is classified token-gated", () => {
  const r = fcfs.classifyMintMode(mkDrop({ type: "TOKEN_GATED" }));
  assert.equal(r.mode, "token-gated");
});
test("token-gated (lowercase) is classified token-gated", () => {
  const r = fcfs.classifyMintMode(mkDrop({ type: "token-gated" }));
  assert.equal(r.mode, "token-gated");
});
test("signed data present → signed mode", () => {
  const r = fcfs.classifyMintMode(mkDrop({ mintData: "0x1234", mintSignature: "0xabcd" }));
  assert.equal(r.mode, "signed");
});

console.log("\nfcfs-mint: isPayloadBoundToWallet (must agree with opensea-gql)");
test("accepts calldata bound to the wallet", () => {
  assert.equal(fcfs.isPayloadBoundToWallet({ mintData: signedData }, WALLET), true);
});
test("rejects calldata bound to a different wallet", () => {
  assert.equal(fcfs.isPayloadBoundToWallet({ mintData: signedData }, WALLET_B), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:", failures.join(", ")); process.exit(1); }
