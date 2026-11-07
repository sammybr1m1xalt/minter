// Prove the two highest-impact findings by construction.
import assert from "node:assert/strict";

// ── Finding A: GQL price unit is ETH, code treats it as wei ─────────────────
// Live GQL for collectr returned: price.token.unit = 0.0056, symbol ETH
// Live on-chain getPublicDrop returned mintPrice = 5600000000000000 wei
const gqlUnit = 0.0056;          // ETH, as returned by GQL
const onChainWei = 5600000000000000n;

console.log("=== Finding A: GQL price unit ===");
console.log("GQL unit (ETH):", gqlUnit);
console.log("on-chain wei  :", onChainWei.toString());
console.log("GQL in wei    :", BigInt(Math.round(gqlUnit * 1e18)).toString());
assert.equal(BigInt(Math.round(gqlUnit * 1e18)), onChainWei, "GQL unit is ETH, not wei");

// What the code does: BigInt(String(c.price)) where c.price = 0.0056
let threw = false;
try {
  BigInt(String(gqlUnit));
} catch (e) {
  threw = true;
  console.log("\nBigInt(String(0.0056)) THROWS:", e.message);
}
assert.ok(threw, "BigInt on a fractional ETH string must throw");
console.log("=> catalogueDrops throws; the throw is swallowed by the outer try/catch,");
console.log("   so the whole GQL inventory silently returns [] and the code falls");
console.log("   through to REST — or to nothing.");

// ── Finding B: 409 means NOT minting, code treats it as eligible ────────────
console.log("\n=== Finding B: 409 semantics ===");
const documented = {
  200: "Ready-to-sign transaction data",
  409: "Drop is not currently active for minting (not started, ended, or paused). Code NOT_MINTING.",
  422: "Minting precondition failed (MINTER_NOT_ELIGIBLE, ...)",
};
for (const [k, v] of Object.entries(documented)) console.log(`  ${k}: ${v}`);

// The code: const isEligible = res.status === 200 || res.status === 409;
const codeIsEligible = (s) => s === 200 || s === 409;
console.log("\ncode isEligible(200):", codeIsEligible(200), "(correct)");
console.log("code isEligible(409):", codeIsEligible(409), "(WRONG — 409 means NOT minting)");
console.log("code isEligible(422):", codeIsEligible(422), "(correct — 422 is the not-eligible case)");
assert.equal(codeIsEligible(409), true, "the bug is present");
console.log("\n=> A 409 (drop not live) is reported as ELIGIBLE. The wizard would");
console.log("   proceed to a mint that cannot succeed, and the real reason");
console.log("   (NOT_MINTING) is never surfaced.");

// ── Finding C: /api/v2/auth/keys returns 201, code requires 200 ─────────────
console.log("\n=== Finding C: key mint status code ===");
console.log("documented: POST /api/v2/auth/keys -> 201 Created");
console.log("code      : if (res.status !== 200 || !body?.api_key) return null;");
const keyMintOk = (s) => s !== 200; // true = rejected
console.log("code rejects 201?", keyMintOk(201), "(WRONG — a successful mint is discarded)");
assert.ok(keyMintOk(201));
console.log("=> Every successfully minted key is thrown away. The pool can never");
console.log("   refill itself, which is why the cached key expired and the bot");
console.log("   is now keyless.");

console.log("\nAll three findings proven.");
