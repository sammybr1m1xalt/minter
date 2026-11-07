// Tests for the modules ported from nft-minter-bot during the 2026-11-06
// read-through: schedule (parseWhen), price-protection, allowlist-onchain,
// scatter, simulate.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/ported-modules.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, formatEther } from "ethers";

const { parseWhen, isValidWhen, formatWait } = await import("../tests/.compiled/schedule.js");
const {
  parsePriceSpec,
  extractMaxPriceSpec,
  assertPriceProtection,
  isPriceProtected,
} = await import("../tests/.compiled/price-protection.js");
const { toMintParams, isNativeList, pickBestList } = await import(
  "../tests/.compiled/scatter.js"
);
const { parseRevert, classifyRevert, REVERT_PATTERNS } = await import(
  "../tests/.compiled/simulate.js"
);

// ── parseWhen (Bug K) ───────────────────────────────────────────────────────

test("parseWhen handles unix seconds", () => {
  assert.equal(parseWhen("1700000000"), 1700000000);
});

test("parseWhen handles unix MILLISECONDS (Bug K)", () => {
  // 13-digit input must be divided by 1000. Reading it as seconds would give a
  // date ~50,000 years out and the wait would never fire.
  const ms = 1700000000000;
  assert.equal(parseWhen(String(ms)), 1700000000);
});

test("parseWhen handles relative specs", () => {
  const now = Date.now();
  assert.equal(parseWhen("30s", now), Math.floor(now / 1000) + 30);
  assert.equal(parseWhen("5m", now), Math.floor(now / 1000) + 300);
  assert.equal(parseWhen("2h", now), Math.floor(now / 1000) + 7200);
  assert.equal(parseWhen("1d", now), Math.floor(now / 1000) + 86400);
  assert.equal(parseWhen("in 10m", now), Math.floor(now / 1000) + 600);
});

test("parseWhen handles HH:MM as the next occurrence", () => {
  const now = Date.now();
  const t = parseWhen("23:59", now);
  assert.ok(t > Math.floor(now / 1000), "must be in the future");
  // Must be within the next 24h.
  assert.ok(t - Math.floor(now / 1000) <= 86400);
});

test("parseWhen handles ISO 8601", () => {
  const iso = "2026-11-07T18:30:00Z";
  assert.equal(parseWhen(iso), Math.floor(Date.parse(iso) / 1000));
});

test("parseWhen rejects garbage", () => {
  assert.throws(() => parseWhen("not a time"));
  assert.equal(isValidWhen("not a time"), false);
  assert.equal(isValidWhen("5m"), true);
});

test("formatWait renders a duration", () => {
  const now = Date.now();
  assert.equal(formatWait(Math.floor(now / 1000) - 1, now), "now");
  // Use a value far enough from a rounding boundary that the assertion cannot
  // flake: the function floors, so a target 90s out can render as 1m 29s if a
  // millisecond ticks between computing `now` and the call.
  const out = formatWait(Math.floor(now / 1000) + 90, now);
  assert.ok(/1m 2[89]s|1m 30s/.test(out), `unexpected duration: ${out}`);
});

// ── price protection ────────────────────────────────────────────────────────

test("parsePriceSpec handles a plain ETH amount", () => {
  const r = parsePriceSpec("0.05", 2);
  assert.equal(r.maxPriceWei, parseEther("0.1")); // per-unit × quantity
  assert.equal(r.isUnlimited, false);
});

test("parsePriceSpec distinguishes /unit from total", () => {
  const unit = parsePriceSpec("0.05/unit", 3);
  const total = parsePriceSpec("0.05total", 3);
  assert.equal(unit.maxPriceWei, parseEther("0.15"));
  assert.equal(total.maxPriceWei, parseEther("0.05"));
});

test("parsePriceSpec handles free and unlimited", () => {
  assert.equal(parsePriceSpec("free").maxPriceWei, 0n);
  assert.equal(parsePriceSpec("0").maxPriceWei, 0n);
  assert.equal(parsePriceSpec("any").isUnlimited, true);
  assert.equal(parsePriceSpec("unlimited").maxPriceWei, null);
});

test("parsePriceSpec rejects a negative or malformed spec", () => {
  assert.throws(() => parsePriceSpec("abc"));
  assert.throws(() => parsePriceSpec("-1"));
});

test("assertPriceProtection throws when the price moved up", () => {
  assert.throws(
    () =>
      assertPriceProtection({
        actualPriceWei: parseEther("0.1"),
        maxPriceWei: parseEther("0.05"),
        context: "test",
      }),
    /price protection/
  );
});

test("assertPriceProtection passes when the price is at or below the cap", () => {
  assert.doesNotThrow(() =>
    assertPriceProtection({ actualPriceWei: parseEther("0.05"), maxPriceWei: parseEther("0.05") })
  );
  assert.doesNotThrow(() =>
    assertPriceProtection({ actualPriceWei: parseEther("0.01"), maxPriceWei: parseEther("0.05") })
  );
});

test("assertPriceProtection is a no-op when no cap is set", () => {
  assert.doesNotThrow(() =>
    assertPriceProtection({ actualPriceWei: parseEther("100"), maxPriceWei: null })
  );
});

test("isPriceProtected is the non-throwing variant", () => {
  assert.equal(isPriceProtected(parseEther("0.1"), parseEther("0.05")), false);
  assert.equal(isPriceProtected(parseEther("0.05"), parseEther("0.05")), true);
  assert.equal(isPriceProtected(parseEther("1"), null), true);
});

test("extractMaxPriceSpec pulls the spec out of a command string", () => {
  const r = extractMaxPriceSpec("0xabc max:0.05");
  assert.equal(r.spec, "0.05");
  assert.equal(r.rest, "0xabc");
});

test("extractMaxPriceSpec handles --max-price and p=", () => {
  assert.equal(extractMaxPriceSpec("--max-price 0.1 0xabc").spec, "0.1");
  assert.equal(extractMaxPriceSpec("p=0.2 0xabc").spec, "0.2");
});

test("extractMaxPriceSpec returns null when there is no spec", () => {
  const r = extractMaxPriceSpec("0xabc");
  assert.equal(r.spec, null);
  assert.equal(r.rest, "0xabc");
});

// ── scatter ─────────────────────────────────────────────────────────────────

test("isNativeList treats the zero address and a missing field as native", () => {
  assert.equal(isNativeList({ currency_address: "0x0000000000000000000000000000000000000000" }), true);
  assert.equal(isNativeList({ currency_address: null }), true);
  assert.equal(isNativeList({ currency_address: "0xabc" }), false);
});

test("pickBestList prefers native and cheapest", () => {
  const lists = [
    { id: "erc20", token_price: 0, currency_address: "0xusdc", start_time: "2026-01-01" },
    { id: "paid", token_price: 1, currency_address: null, start_time: "2026-01-01" },
    { id: "free", token_price: 0, currency_address: null, start_time: "2026-01-02" },
  ];
  // Native first, then cheapest, then earliest start.
  assert.equal(pickBestList(lists).id, "free");
});

test("pickBestList tie-breaks on earliest start", () => {
  const lists = [
    { id: "later", token_price: 0, currency_address: null, start_time: "2026-02-01" },
    { id: "sooner", token_price: 0, currency_address: null, start_time: "2026-01-01" },
  ];
  assert.equal(pickBestList(lists).id, "sooner");
});

test("pickBestList returns null for an empty list", () => {
  assert.equal(pickBestList([]), null);
});

// ── simulate ────────────────────────────────────────────────────────────────

test("parseRevert extracts the reason from an ethers-shaped error", () => {
  const { reason } = parseRevert({ reason: "sale not active" });
  assert.equal(reason, "sale not active");
});

test("parseRevert unwraps the nested provider error shape", () => {
  const { data } = parseRevert({ info: { error: { data: "0xdeadbeef" } } });
  assert.equal(data, "0xdeadbeef");
});

test("parseRevert never throws on a malformed error", () => {
  assert.deepEqual(parseRevert(null), {});
  assert.deepEqual(parseRevert(undefined), {});
  assert.deepEqual(parseRevert("a string"), {});
});

test("classifyRevert recognises the known patterns", () => {
  assert.equal(classifyRevert("sale not active").label, "sale not active");
  assert.equal(classifyRevert("Invalid merkle proof").label, "wallet not eligible");
  assert.equal(classifyRevert("insufficient funds for gas").label, "insufficient funds for gas");
});

test("classifyRevert marks timing failures retryable and permanent ones not", () => {
  assert.equal(classifyRevert("sale has not started").retryable, true);
  assert.equal(classifyRevert("sale has ended").retryable, false);
  assert.equal(classifyRevert("wallet not eligible").retryable, false);
});

test("classifyRevert returns null for an unknown reason", () => {
  assert.equal(classifyRevert("something entirely novel"), null);
  assert.equal(classifyRevert(undefined), null);
});

test("every revert pattern has a label and a retryable flag", () => {
  assert.ok(REVERT_PATTERNS.length >= 8);
  for (const p of REVERT_PATTERNS) {
    assert.ok(p.pattern instanceof RegExp);
    assert.ok(typeof p.label === "string" && p.label.length > 0);
    assert.ok(typeof p.retryable === "boolean");
  }
});
