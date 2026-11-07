// Tests for the contextual-audit fixes: GQL schema conformance, price units,
// status-code semantics, and key minting.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/contract.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; failures.push(name); }
}

execSync(
  `npx tsc src/opensea-gql.ts src/fcfs-drops.ts src/fcfs-mint.ts src/opensea-key.ts --outDir tests/.compiled --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --esModuleInterop`,
  { stdio: "pipe" },
);
const gql = await import(`./.compiled/opensea-gql.js?t=${Date.now()}`);
const drops = await import(`./.compiled/fcfs-drops.js?t=${Date.now()}`);
const key = await import(`./.compiled/opensea-key.js?t=${Date.now()}`);

// ── 1. Price unit conversion ────────────────────────────────────────────────
console.log("\nprice units");
const { parsePriceToWei, isWholeWei } = gql;

await test("ETH float converts to wei", () => {
  assert.equal(parsePriceToWei(0.0056), 5600000000000000n);
});
await test("whole-wei decimal string passes through", () => {
  assert.equal(parsePriceToWei("5600000000000000"), 5600000000000000n);
});
await test("integer number passes through", () => {
  assert.equal(parsePriceToWei(1000), 1000n);
});
await test("zero stays zero", () => {
  assert.equal(parsePriceToWei(0), 0n);
  assert.equal(parsePriceToWei("0"), 0n);
});
await test("null/undefined -> 0n (never throws)", () => {
  assert.equal(parsePriceToWei(null), 0n);
  assert.equal(parsePriceToWei(undefined), 0n);
});
await test("garbage -> 0n (never throws)", () => {
  assert.equal(parsePriceToWei("not-a-number"), 0n);
});
await test("isWholeWei distinguishes wei strings from ETH floats", () => {
  assert.equal(isWholeWei("5600000000000000"), true);
  assert.equal(isWholeWei(0.0056), false);
  assert.equal(isWholeWei(1000), true);
});

// ── 2. GQL query conformance ────────────────────────────────────────────────
console.log("\nGQL query conformance (live-verified schema)");
await test("CollectionDropsQuery no longer selects fields absent from CollectionResult", () => {
  const q = gql.GQL_QUERY_TEXTS.CollectionDropsQuery;
  // These were all proven MISSING on the live schema.
  for (const bad of ["CollectionDropStage", "mintData", "mintSignature", "allowlistHash", "feeRecipient"]) {
    assert.ok(!q.includes(bad), `query still references '${bad}'`);
  }
});
await test("CollectionDropsQuery uses the working dropBySlug root", () => {
  assert.ok(gql.GQL_QUERY_TEXTS.CollectionDropsQuery.includes("dropBySlug"), "must use dropBySlug");
});
await test("CollectionDropsQuery selects price with its token subfield", () => {
  const q = gql.GQL_QUERY_TEXTS.CollectionDropsQuery;
  assert.ok(/price\s*\{\s*token\s*\{/.test(q), "price must select token { ... }");
});
await test("no query references the nonexistent collectionBySlug fields", () => {
  for (const [name, q] of Object.entries(gql.GQL_QUERY_TEXTS)) {
    assert.ok(!/collectionBySlug[^}]*?\{\s*slug/.test(q), `${name} still queries collectionBySlug.slug`);
  }
});

// ── 3. Status-code semantics ────────────────────────────────────────────────
console.log("\nstatus-code semantics");
const { isEligibleStatus } = gql;

await test("200 is eligible", () => assert.equal(isEligibleStatus(200), true));
await test("409 is NOT eligible (drop not minting)", () => assert.equal(isEligibleStatus(409), false));
await test("422 is NOT eligible (precondition failed)", () => assert.equal(isEligibleStatus(422), false));
await test("400 is NOT eligible", () => assert.equal(isEligibleStatus(400), false));

// ── 4. Key minting ──────────────────────────────────────────────────────────
console.log("\nkey minting");
await test("mintFreeKey accepts 201 (documented) and any 2xx", () => {
  const src = execSync("cat src/opensea-key.ts", { encoding: "utf8" });
  // The documented success is 201 Created; the old code required exactly 200.
  assert.ok(
    /res\.status\s*<\s*200\s*\|\|\s*res\.status\s*>=\s*300/.test(src),
    "must accept the whole 2xx range, not just 200",
  );
  assert.ok(!/res\.status\s*!==\s*200/.test(src), "must not require exactly 200");
});
await test("mintFreeKey handles 429 explicitly", () => {
  const src = execSync("cat src/opensea-key.ts", { encoding: "utf8" });
  assert.ok(/429/.test(src), "must handle the documented 429");
});

// ── 5. catalogueDrops no longer throws on fractional ETH ───────────────────
console.log("\ncatalogueDrops robustness");
await test("a fractional-ETH price does not throw", () => {
  const src = execSync("cat src/fcfs-drops.ts", { encoding: "utf8" });
  assert.ok(!/BigInt\(String\(c\.price/.test(src), "raw BigInt(String(price)) must be gone");
  assert.ok(/parsePriceToWei/.test(src), "must use parsePriceToWei");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:", failures.join(", ")); process.exit(1); }
