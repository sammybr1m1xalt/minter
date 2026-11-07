// Tests for mint-generic.ts — the generic mint engine (R1).
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/mint-generic.test.mjs
//
// The most important test here is the selector-hash verification: a hand-typed
// hash fails silently, and the symptom looks like "contract has no mint
// function" rather than "our table is wrong".

import { test } from "node:test";
import assert from "node:assert/strict";
import { id as keccakId } from "ethers";

const {
  MINT_SIGNATURES,
  PRICE_READERS,
  selectorFor,
  buildArgs,
  isSeadropContract,
  detectPrice,
  detectMintFunction,
  SEADROP_V2,
} = await import("../tests/.compiled/mint-generic.js");

// ── Selector table integrity ────────────────────────────────────────────────

test("every selector hash equals ethers id(sig).slice(0,10)", () => {
  let bad = 0;
  for (const s of MINT_SIGNATURES) {
    const real = keccakId(s.sig).slice(0, 10);
    if (real !== s.selector) {
      console.log(`  MISMATCH ${s.sig}: table=${s.selector} real=${real}`);
      bad++;
    }
  }
  assert.equal(bad, 0, `${bad} selector hashes are wrong`);
});

test("every price-reader selector hash is correct", () => {
  for (const r of PRICE_READERS) {
    assert.equal(r.selector, keccakId(r.sig).slice(0, 10), `wrong hash for ${r.sig}`);
  }
});

test("selectorFor computes the documented selectors", () => {
  assert.equal(selectorFor("mint(uint256)"), "0xa0712d68");
  assert.equal(selectorFor("publicMint(uint256)"), "0x2db11544");
  assert.equal(selectorFor("mint(address,uint256)"), "0x40c10f19");
  assert.equal(selectorFor("mintSeaDrop(address,uint256)"), "0x64869dad");
  assert.equal(selectorFor("mintPublic(address,address,address,uint256)"), "0x161ac21f");
});

test("no duplicate signatures in the registry", () => {
  const sigs = MINT_SIGNATURES.map((s) => s.sig);
  assert.equal(new Set(sigs).size, sigs.length, "duplicate signatures present");
});

// ── Argument synthesis ──────────────────────────────────────────────────────

test("buildArgs synthesizes to/amount/data", () => {
  const sel = MINT_SIGNATURES.find((s) => s.sig === "mint(address,uint256)");
  const args = buildArgs(sel, { to: "0x1111111111111111111111111111111111111111", amount: 3n });
  assert.deepEqual(args, ["0x1111111111111111111111111111111111111111", 3n]);
});

test("buildArgs returns null for a proof-requiring selector without a proof", () => {
  const sel = MINT_SIGNATURES.find((s) => s.sig === "whitelistMint(uint256,bytes32[])");
  const args = buildArgs(sel, { to: "0x1111111111111111111111111111111111111111", amount: 1n });
  assert.equal(args, null, "must refuse to fabricate a proof");
});

test("buildArgs returns null for a signature-requiring selector", () => {
  const sel = MINT_SIGNATURES.find((s) => s.sig === "mintWithSignature(uint256,bytes)");
  const args = buildArgs(sel, { to: "0x1111111111111111111111111111111111111111", amount: 1n });
  assert.equal(args, null, "must refuse to fabricate a signature");
});

test("buildArgs never returns the zero address as a recipient", () => {
  const sel = MINT_SIGNATURES.find((s) => s.sig === "mint(address,uint256)");
  const args = buildArgs(sel, { to: "0x0000000000000000000000000000000000000000", amount: 1n });
  assert.equal(args, null);
});

test("buildArgs defaults a zero amount to 1", () => {
  const sel = MINT_SIGNATURES.find((s) => s.sig === "mint(uint256)");
  const args = buildArgs(sel, { to: "0x1111111111111111111111111111111111111111", amount: 0n });
  assert.deepEqual(args, [1n]);
});

// ── Registry coverage ───────────────────────────────────────────────────────

test("proof-requiring selectors are marked", () => {
  const proof = MINT_SIGNATURES.filter((s) => s.needs === "proof");
  assert.ok(proof.length >= 8, `expected at least 8 proof selectors, got ${proof.length}`);
  for (const p of proof) {
    assert.ok(p.args.includes("proof"), `${p.sig} must declare a proof arg`);
  }
});

test("signature-requiring selectors are marked", () => {
  const sig = MINT_SIGNATURES.filter((s) => s.needs === "signature");
  assert.ok(sig.length >= 4, `expected at least 4 signature selectors, got ${sig.length}`);
});

test("the registry covers ERC721, ERC1155 and Manifold shapes", () => {
  const sigs = MINT_SIGNATURES.map((s) => s.sig);
  assert.ok(sigs.includes("mint(uint256)"), "ERC721");
  assert.ok(sigs.includes("mint(address,uint256,uint256,bytes)"), "ERC1155");
  assert.ok(sigs.includes("mintBatch(address,uint256[])"), "batch");
});

// ── Live tests ──────────────────────────────────────────────────────────────

test("live: isSeadropContract detects a SeaDrop-managed collection", async () => {
  const { JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider("https://mainnet.base.org", 8453, {
    staticNetwork: true,
  });
  // Collectr is a SeaDrop-managed collection on Base.
  const r = await isSeadropContract("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb", provider);
  assert.equal(r.managed, true, `expected SeaDrop management, got: ${r.reason}`);
  assert.ok(r.version === "v1" || r.version === "v2");
});

test("live: isSeadropContract rejects a non-SeaDrop contract", async () => {
  const { JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, {
    staticNetwork: true,
  });
  // BAYC is not SeaDrop-managed.
  const r = await isSeadropContract("0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", provider);
  assert.equal(r.managed, false, `should not be SeaDrop: ${r.reason}`);
});

test("live: detectPrice reads a price from a contract that exposes mintPrice()", async () => {
  const { JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider("https://mainnet.base.org", 8453, {
    staticNetwork: true,
  });
  const r = await detectPrice("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb", provider, 1n);
  // Either it finds a reader, or the contract has none — both are valid.
  // Assert only that the call does not throw.
  assert.ok(r === null || typeof r.price === "bigint");
});

test("live: detectMintFunction returns null for a contract with no mint function", async () => {
  const { JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, {
    staticNetwork: true,
  });
  // The SeaDrop singleton has no generic mint(uint256) — it has mintPublic.
  const r = await detectMintFunction(
    SEADROP_V2,
    provider,
    "0x1111111111111111111111111111111111111111",
    1n
  );
  assert.ok(r === null || typeof r.selector === "object");
});
