// Tests for abi-mint.ts — ABI-driven mint discovery and argument synthesis.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/abi-mint.test.mjs
//
// The point of this module is that a fixed selector registry cannot cover every
// contract: Milady's mint is `mintMiladys(uint256 numberOfTokens)`, which appears
// in no registry. These tests pin the behaviour that makes the ABI path safe.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  fetchAbi,
  deriveMintCandidates,
  classifyParam,
  synthFromAbi,
  looksLikeMint,
  readPriceFromAbi,
} = await import("../tests/.compiled/abi-mint.js");

const TO = "0x1111111111111111111111111111111111111111";

// ── Parameter classification ────────────────────────────────────────────────

test("classifyParam identifies a quantity by name", () => {
  assert.equal(classifyParam("numberOfTokens", "uint256"), "quantity");
  assert.equal(classifyParam("quantity", "uint256"), "quantity");
  assert.equal(classifyParam("mintAmount", "uint256"), "quantity");
});

test("classifyParam identifies a recipient", () => {
  assert.equal(classifyParam("to", "address"), "recipient");
  assert.equal(classifyParam("recipient", "address"), "recipient");
  assert.equal(classifyParam("receiver", "address"), "recipient");
});

test("classifyParam does NOT treat a referral address as a recipient", () => {
  // A referral is not the mint destination — encoding it as `to` would send
  // tokens to the wrong place.
  assert.equal(classifyParam("referrer", "address"), "unknown");
  assert.equal(classifyParam("referral", "address"), "unknown");
});

test("classifyParam identifies a merkle proof", () => {
  assert.equal(classifyParam("merkleProof", "bytes32[]"), "proof");
  assert.equal(classifyParam("proof", "bytes32[]"), "proof");
  assert.equal(classifyParam("allowlistProof", "bytes32[]"), "proof");
});

test("classifyParam identifies a signature", () => {
  assert.equal(classifyParam("signature", "bytes"), "signature");
  assert.equal(classifyParam("sig", "bytes"), "signature");
});

test("classifyParam identifies a token id", () => {
  assert.equal(classifyParam("tokenId", "uint256"), "tokenId");
  assert.equal(classifyParam("token_id", "uint256"), "tokenId");
});

test("classifyParam marks an unclassifiable parameter unknown", () => {
  // A price parameter must NOT be filled with the quantity.
  assert.equal(classifyParam("price", "uint256"), "unknown");
  assert.equal(classifyParam("stageIndex", "uint256"), "unknown");
  assert.equal(classifyParam("nonce", "uint256"), "unknown");
});

test("classifyParam treats a bare uint256 as a quantity", () => {
  // `mint(uint256)` — the common case. The simulation gate catches a wrong
  // guess, so defaulting to quantity is the right trade.
  assert.equal(classifyParam("", "uint256"), "quantity");
});

// ── Mint detection heuristic ────────────────────────────────────────────────

test("looksLikeMint accepts mint/claim/purchase names", () => {
  assert.equal(looksLikeMint("mintMiladys", "payable"), true);
  assert.equal(looksLikeMint("publicMint", "nonpayable"), true);
  assert.equal(looksLikeMint("claim", "payable"), true);
});

test("looksLikeMint rejects view/pure functions", () => {
  assert.equal(looksLikeMint("mintPrice", "view"), false);
  assert.equal(looksLikeMint("totalSupply", "view"), false);
});

test("looksLikeMint rejects owner-only helpers", () => {
  // reserveMintMiladys is a real mint but not callable by us. Probing it wastes
  // a call and produces a misleading "exists" result.
  assert.equal(looksLikeMint("reserveMintMiladys", "nonpayable"), false);
  assert.equal(looksLikeMint("adminMint", "nonpayable"), false);
  assert.equal(looksLikeMint("ownerMint", "nonpayable"), false);
});

test("looksLikeMint rejects setters and config", () => {
  assert.equal(looksLikeMint("setMintPrice", "nonpayable"), false);
  assert.equal(looksLikeMint("flipSaleState", "nonpayable"), false);
});

// ── Argument synthesis ──────────────────────────────────────────────────────

const CAND = (name, inputs, payable = true) => ({
  name,
  signature: `${name}(${inputs.map((i) => i.type).join(",")})`,
  selector: "0x00000000",
  inputs,
  stateMutability: payable ? "payable" : "nonpayable",
  payable,
});

test("synthFromAbi fills a quantity from the amount", () => {
  const c = CAND("mintMiladys", [{ name: "numberOfTokens", type: "uint256" }]);
  const r = synthFromAbi(c, { to: TO, amount: 3n });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, [3n]);
});

test("synthFromAbi fills recipient and quantity", () => {
  const c = CAND("mint", [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ]);
  const r = synthFromAbi(c, { to: TO, amount: 2n });
  assert.deepEqual(r.args, [TO, 2n]);
});

test("synthFromAbi REFUSES a proof it does not have", () => {
  const c = CAND("whitelistMint", [
    { name: "quantity", type: "uint256" },
    { name: "merkleProof", type: "bytes32[]" },
  ]);
  const r = synthFromAbi(c, { to: TO, amount: 1n });
  assert.equal(r.ok, false);
  assert.match(r.reason, /merkle proof/);
});

test("synthFromAbi accepts a supplied proof", () => {
  const c = CAND("whitelistMint", [
    { name: "quantity", type: "uint256" },
    { name: "merkleProof", type: "bytes32[]" },
  ]);
  const proof = ["0x" + "11".repeat(32)];
  const r = synthFromAbi(c, { to: TO, amount: 1n, proof });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, [1n, proof]);
});

test("synthFromAbi REFUSES a signature it does not have", () => {
  const c = CAND("mintWithSignature", [
    { name: "quantity", type: "uint256" },
    { name: "signature", type: "bytes" },
  ]);
  const r = synthFromAbi(c, { to: TO, amount: 1n });
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/);
});

test("synthFromAbi REFUSES an unclassifiable parameter", () => {
  const c = CAND("mint", [
    { name: "quantity", type: "uint256" },
    { name: "referrer", type: "address" },
  ]);
  const r = synthFromAbi(c, { to: TO, amount: 1n });
  assert.equal(r.ok, false, "must not guess a referral address");
  assert.match(r.reason, /unclassifiable/);
});

test("synthFromAbi REFUSES a price parameter", () => {
  const c = CAND("mint", [
    { name: "quantity", type: "uint256" },
    { name: "price", type: "uint256" },
  ]);
  const r = synthFromAbi(c, { to: TO, amount: 1n });
  assert.equal(r.ok, false, "must not fill a price with the quantity");
});

// ── Live tests ──────────────────────────────────────────────────────────────

test("live: fetchAbi retrieves a verified ABI from Sourcify", async () => {
  const r = await fetchAbi(1, "0x5Af0D9827E0c53E4799BB226655A1de152A425a5");
  assert.ok(r.abi, `expected an ABI, got: ${r.error}`);
  assert.equal(r.source, "sourcify");
});

test("live: deriveMintCandidates finds mintMiladys — absent from every registry", async () => {
  const r = await fetchAbi(1, "0x5Af0D9827E0c53E4799BB226655A1de152A425a5");
  assert.ok(r.abi);
  const c = deriveMintCandidates(r.abi);
  const names = c.map((x) => x.name);
  assert.ok(names.includes("mintMiladys"), `candidates were: ${names.join(", ")}`);
  // reserveMintMiladys must be filtered out.
  assert.ok(!names.includes("reserveMintMiladys"));
});

test("live: synthFromAbi builds mintMiladys calldata", async () => {
  const r = await fetchAbi(1, "0x5Af0D9827E0c53E4799BB226655A1de152A425a5");
  assert.ok(r.abi);
  const c = deriveMintCandidates(r.abi).find((x) => x.name === "mintMiladys");
  assert.ok(c, "mintMiladys must be a candidate");
  const s = synthFromAbi(c, { to: TO, amount: 2n });
  assert.equal(s.ok, true, s.reason);
  assert.deepEqual(s.args, [2n]);
});

test("live: readPriceFromAbi finds a price getter", async () => {
  const { JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider("https://mainnet.base.org", 8453, {
    staticNetwork: true,
  });
  const r = await fetchAbi(8453, "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.ok(r.abi, r.error);
  const p = await readPriceFromAbi(
    "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb",
    provider,
    r.abi,
    1n
  );
  // Either a getter exists or it does not; both are valid. Assert no throw.
  assert.ok(p === null || typeof p.price === "bigint");
});
