// Tests for contract-verify.ts — the on-chain verification gate.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/contract-verify.test.mjs
//
// Covers S3 from the to-do: eth_getCode, ERC165, fallback probes, known
// singletons, multi-chain scanning, and the EIP-7702 delegated-EOA case.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  verifyContract,
  verifyAcrossChains,
  isContract,
  isDelegatedEoaCode,
  isKnownToken,
  SEADROP_V2,
  SEADROP_V1,
  ERC721,
  ERC1155,
} = await import("../tests/.compiled/contract-verify.js");

// ── Pure-function tests (no network) ────────────────────────────────────────

test("EIP-7702 delegation designator is recognised", () => {
  // Verified live 2026-11-06 against vitalik.eth, which returns exactly this.
  assert.equal(isDelegatedEoaCode("0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"), true);
  assert.equal(isDelegatedEoaCode("0xEF0100" + "00".repeat(20)), true, "case-insensitive");
});

test("normal contract bytecode is NOT mistaken for a delegation", () => {
  assert.equal(isDelegatedEoaCode("0x60806040526004361061021a5760003560e01c"), false);
  assert.equal(isDelegatedEoaCode("0x"), false);
});

test("known token addresses are identified", () => {
  assert.equal(isKnownToken("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), "WETH");
  assert.equal(isKnownToken("0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2"), "WETH", "case-insensitive");
  assert.equal(isKnownToken("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb"), null);
});

test("ERC165 interface IDs are the canonical values", () => {
  assert.equal(ERC721, "0x80ac58cd");
  assert.equal(ERC1155, "0xd9b67a26");
});

test("SeaDrop singleton constants match the deployed addresses", () => {
  assert.equal(SEADROP_V2, "0x00005ea00ac477b1030ce78506496e8c2de24bf5");
  assert.equal(SEADROP_V1, "0x00000000006c3852cbef3e08e8df289169ede581");
});

// ── Live tests ──────────────────────────────────────────────────────────────
// These hit public RPCs. They assert only facts that are stable on-chain.

test("live: a real ERC721 on Ethereum is detected", async () => {
  // BAYC — a well-known ERC721.
  const r = await verifyContract("0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", 1);
  assert.equal(r.isContract, true);
  assert.equal(r.standard, "erc721");
  assert.equal(r.chainId, 1);
});

test("live: a real ERC721 on Base is detected", async () => {
  // Collectr — a Base collection. This is the chain-awareness case: the same
  // address is an EOA on Ethereum, so a scanner that assumes Ethereum fails.
  const r = await verifyContract("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb", 8453);
  assert.equal(r.isContract, true);
  assert.equal(r.standard, "erc721");
  assert.equal(r.chainId, 8453);
});

test("live: an EIP-7702 delegated EOA is NOT a contract", async () => {
  // vitalik.eth delegates execution, so eth_getCode returns 0xef0100…
  // A naive getCode check would call this a contract.
  const r = await verifyContract("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 1);
  assert.equal(r.isContract, false);
  assert.match(r.reason ?? "", /7702/i);
});

test("live: the SeaDrop singleton is identified as a platform", async () => {
  const r = await verifyContract(SEADROP_V2, 1);
  assert.equal(r.isContract, true);
  assert.equal(r.platform, "seadrop-v2");
});

test("live: verifyAcrossChains finds a Base-only contract", async () => {
  // No preferred chain given — the scanner must try them all and find Base.
  const r = await verifyAcrossChains("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(r.isContract, true);
  assert.equal(r.chainId, 8453, "must find it on Base, not assume Ethereum");
});

test("live: isContract agrees with verifyContract", async () => {
  const addr = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
  assert.equal(await isContract(addr, 1), true);
});
