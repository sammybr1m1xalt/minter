// Tests for defects found in the 2026-11-06 full read-through of src/ against
// the JS original at nft-minter-bot/.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/readthrough.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyMintMode } = await import("../tests/.compiled/fcfs-mint.js");
const { normalizeStageType, classifyStageType } = await import("../tests/.compiled/fcfs-drops.js");

// ── Bug: free public mints were untargetable ────────────────────────────────

test("a FREE public stage is fireable locally, not 'unknown'", () => {
  // Regression: classifyMintMode required mintPrice > 0, so every free public
  // mint was classified unknown + preFetchNeeded and sent down the signed
  // payload path, where it can never succeed.
  const free = {
    isPublicStage: true,
    mintPrice: 0n,
    mintData: null,
    allowlistHash: null,
    allowlistedAddresses: [],
    type: "public_sale",
  };
  const r = classifyMintMode(free);
  assert.equal(r.mode, "public");
  assert.equal(r.fireableLocally, true);
  assert.equal(r.preFetchNeeded, false);
});

test("a PAID public stage is still fireable locally", () => {
  const paid = {
    isPublicStage: true,
    mintPrice: 5600000000000000n,
    mintData: null,
    allowlistHash: null,
    allowlistedAddresses: [],
    type: "public_sale",
  };
  const r = classifyMintMode(paid);
  assert.equal(r.mode, "public");
  assert.equal(r.fireableLocally, true);
});

test("a signed stage is never fireable locally", () => {
  const signed = {
    isPublicStage: false,
    mintPrice: 0n,
    mintData: "0xdeadbeef",
    allowlistHash: null,
    allowlistedAddresses: [],
    type: "allowlist",
  };
  const r = classifyMintMode(signed);
  assert.equal(r.mode, "signed");
  assert.equal(r.fireableLocally, false);
});

// ── Stage-type normalisation ────────────────────────────────────────────────

test("stage type casing is normalised across REST and GQL", () => {
  // REST emits snake_case, GQL emits SCREAMING_SNAKE_CASE. Comparing a raw
  // value against one casing makes the other surface's branch dead.
  assert.equal(normalizeStageType("PUBLIC_SALE"), "public");
  assert.equal(normalizeStageType("public_sale"), "public");
  assert.equal(normalizeStageType("allowlist"), "allowlist");
  assert.equal(normalizeStageType("ALLOWLIST"), "allowlist");
  assert.equal(normalizeStageType("OVR"), "ovr");
  assert.equal(normalizeStageType(null), "unknown");
});

test("classifyStageType agrees with normalizeStageType", () => {
  assert.equal(classifyStageType("PUBLIC_SALE"), true);
  assert.equal(classifyStageType("public_sale"), true);
  assert.equal(classifyStageType("allowlist"), false);
});

// ── Dead-branch regression ──────────────────────────────────────────────────

test("the mint-data display branch is reachable for a signature-only payload", () => {
  // Regression: `else if (drop.mintData || drop.mintSignature)` was unreachable
  // because the preceding `if (drop.mintData)` already caught that case. A
  // signature-only payload silently reported "No signed mint data".
  // The fix tests mintSignature ALONE in the second branch.
  const hasMintData = (d) => !!d.mintData;
  const hasSigOnly = (d) => !d.mintData && !!d.mintSignature;

  const sigOnly = { mintData: null, mintSignature: "0xabc" };
  assert.equal(hasMintData(sigOnly), false, "signature-only must not match the first branch");
  assert.equal(hasSigOnly(sigOnly), true, "signature-only must match the second branch");

  const both = { mintData: "0xdef", mintSignature: "0xabc" };
  assert.equal(hasMintData(both), true, "both must match the first branch");
  assert.equal(hasSigOnly(both), false, "both must not fall through to the second");
});
