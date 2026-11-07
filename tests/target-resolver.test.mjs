// Tests for the unified target resolver and the universal mint adapter.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/target-resolver.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseTarget, chainSlug, resolveTarget } = await import(
  "../tests/.compiled/target-resolver.js"
);
const { explainFailure } = await import("../tests/.compiled/universal-mint.js");

// ── chainSlug ───────────────────────────────────────────────────────────────

test("chainSlug maps the common aliases", () => {
  assert.equal(chainSlug("eth"), "ethereum");
  assert.equal(chainSlug("mainnet"), "ethereum");
  assert.equal(chainSlug("matic"), "polygon");
  assert.equal(chainSlug("arb"), "arbitrum");
  assert.equal(chainSlug("op"), "optimism");
  assert.equal(chainSlug("avax"), "avalanche");
  assert.equal(chainSlug("bnb"), "bsc");
  assert.equal(chainSlug("rhoc"), "robinhood");
  assert.equal(chainSlug("circle"), "arc");
});

test("chainSlug passes unknown values through lowercased", () => {
  assert.equal(chainSlug("SomeNewChain"), "somenewchain");
});

test("chainSlug defaults to ethereum for empty input", () => {
  assert.equal(chainSlug(null), "ethereum");
  assert.equal(chainSlug(""), "ethereum");
});

// ── parseTarget: OpenSea ─────────────────────────────────────────────────────

test("parses an OpenSea collection URL into a slug", () => {
  const t = parseTarget("https://opensea.io/collection/de-bots");
  assert.equal(t.platform, "opensea");
  assert.equal(t.slug, "de-bots");
  assert.equal(t.amount, 1);
});

test("parses an OpenSea assets URL with a tokenId", () => {
  const t = parseTarget("https://opensea.io/assets/base/0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb/1234");
  assert.equal(t.platform, "opensea");
  assert.equal(t.contract, "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(t.chain, "base");
  assert.equal(t.tokenId, "1234");
});

test("parses an OpenSea URL with an xN amount", () => {
  const t = parseTarget("https://opensea.io/collection/de-bots x3");
  assert.equal(t.amount, 3);
});

// ── parseTarget: Scatter ─────────────────────────────────────────────────────

test("parses a Scatter collection URL", () => {
  const t = parseTarget("https://scatter.art/collection/my-drop");
  assert.equal(t.platform, "scatter");
  assert.equal(t.slug, "my-drop");
});

test("parses a Scatter short-link URL", () => {
  const t = parseTarget("https://scatter.art/c/my-drop");
  assert.equal(t.platform, "scatter");
  assert.equal(t.slug, "my-drop");
});

// ── parseTarget: Manifold ────────────────────────────────────────────────────

test("parses a Manifold claim URL", () => {
  const t = parseTarget("https://manifold.xyz/c/some-claim");
  assert.equal(t.platform, "manifold");
  assert.equal(t.claimId, "some-claim");
});

test("Manifold claims are never resolved to an invented contract", async () => {
  const t = parseTarget("https://manifold.xyz/c/some-claim");
  const r = await resolveTarget(t);
  // A claim slug is not a contract address. Resolving one would mean minting
  // against an address we made up.
  assert.equal(r, null);
});

// ── parseTarget: Zora ────────────────────────────────────────────────────────

test("parses a Zora collect URL", () => {
  const t = parseTarget("https://zora.co/collect/base:0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(t.platform, "zora");
  assert.equal(t.contract, "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(t.chain, "base");
});

// ── parseTarget: direct ──────────────────────────────────────────────────────

test("parses a bare contract address with no chain", () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(t.platform, "direct");
  assert.equal(t.contract, "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  // Chain is left unset so the caller's preferredChain can apply. Defaulting to
  // ethereum here would silently override an explicit --chain.
  assert.equal(t.chain, undefined);
  assert.equal(t.amount, 1);
});

test("resolveTarget defaults a chain-less direct target to ethereum", async () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  const r = await resolveTarget(t);
  assert.equal(r.chainKey, "ethereum");
});

test("parses a contract with a chain and amount in any order", () => {
  const a = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb base 3");
  assert.equal(a.chain, "base");
  assert.equal(a.amount, 3);

  const b = parseTarget("3 0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb on base");
  assert.equal(b.chain, "base");
  assert.equal(b.amount, 3);
});

test("parses a contract with an xN amount", () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb x5");
  assert.equal(t.amount, 5);
});

test("a chain alias in the input is normalised", () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb matic");
  assert.equal(t.chain, "polygon");
});

// ── parseTarget: bare slug ───────────────────────────────────────────────────

test("parses a bare slug as an OpenSea target", () => {
  const t = parseTarget("de-bots");
  assert.equal(t.platform, "opensea");
  assert.equal(t.slug, "de-bots");
});

test("parses a slug followed by a chain alias", () => {
  const t = parseTarget("de-bots matic");
  assert.equal(t.platform, "opensea");
  assert.equal(t.slug, "de-bots");
  assert.equal(t.chain, "polygon");
});

test("parses a slug with the 'on' filler and a chain", () => {
  const t = parseTarget("de-bots on arb");
  assert.equal(t.slug, "de-bots");
  assert.equal(t.chain, "arbitrum");
});

test("parses a slug with a chain and a quantity", () => {
  const a = parseTarget("de-bots base 3");
  assert.equal(a.chain, "base");
  assert.equal(a.amount, 3);

  const b = parseTarget("de-bots base x3");
  assert.equal(b.amount, 3);
});

test("rejects garbage input", () => {
  assert.throws(() => parseTarget(""));
  assert.throws(() => parseTarget("!!!not a target!!!"));
});

// ── resolveTarget ────────────────────────────────────────────────────────────

test("resolves a direct contract without any network call", async () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb base");
  const r = await resolveTarget(t);
  assert.equal(r.platform, "direct");
  assert.equal(r.contract, "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  assert.equal(r.chainKey, "base");
  assert.equal(r.resolvedViaFallback, false);
});

test("resolveTarget honours a preferred chain", async () => {
  const t = parseTarget("0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb");
  const r = await resolveTarget(t, "", "base");
  assert.equal(r.chainKey, "base");
});

// ── explainFailure ───────────────────────────────────────────────────────────

test("explainFailure returns an empty string when a plan exists", () => {
  assert.equal(explainFailure({ plan: { adapter: "generic-registry" }, attempts: [] }), "");
});

test("explainFailure lists every adapter that was tried", () => {
  const out = explainFailure({
    plan: null,
    attempts: [
      { adapter: "seadrop-public", ok: false, reason: "no public drop" },
      { adapter: "abi-driven", ok: false, reason: "sale inactive" },
    ],
  });
  assert.match(out, /seadrop-public: no public drop/);
  assert.match(out, /abi-driven: sale inactive/);
});

test("explainFailure handles an empty attempt list", () => {
  const out = explainFailure({ plan: null, attempts: [] });
  assert.match(out, /no mint mechanism detected/);
});

// ── Universal adapter: the EOA false positive ───────────────────────────────
// An eth_call to an EOA with arbitrary calldata SUCCEEDS — there is no code to
// revert, so the call is treated as a plain value transfer. Without an
// eth_getCode guard, every EOA "has a mint function" and simulation reports
// success, producing a signed transaction to an address that cannot mint.

test("an EOA is never reported as mintable", { skip: !process.env.LIVE_RPC }, async () => {
  const { findUniversalMint } = await import("../tests/.compiled/universal-mint.js");
  const { JsonRpcProvider } = await import("ethers");
  // The second argument is the network, the third is the options object — they
  // are easily swapped, and swapping them throws at construction.
  const provider = new JsonRpcProvider(process.env.LIVE_RPC, undefined, { staticNetwork: true });
  // A well-known EOA with no code.
  const eoa = "0x1111111111111111111111111111111111111111";
  const r = await findUniversalMint(eoa, provider, eoa, 1n, { rpcUrl: process.env.LIVE_RPC });
  assert.equal(r.plan, null, "an EOA must not produce a mint plan");
  assert.match(r.attempts[0].reason, /no bytecode/);
});
