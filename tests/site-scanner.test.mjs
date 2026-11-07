// Tests for site-scanner.ts — candidate extraction and ranking.
// Run: node --experimental-loader ./tests/ts-resolve-loader.mjs tests/site-scanner.test.mjs
//
// Covers S1/S2 from the to-do. The ranking tests use a saved fixture from a
// real OpenSea collection page so the assertions reflect actual page structure
// rather than an idealised one.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const {
  scanHtml,
  extractAddresses,
  scriptBodies,
  rankCandidates,
} = await import("../tests/.compiled/site-scanner.js");

// ── Extraction ──────────────────────────────────────────────────────────────

test("extractAddresses finds every 40-hex string and dedupes", () => {
  const html = `
    "address":"0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb"
    "address":"0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb"
    "other":"0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"
  `;
  const found = extractAddresses(html);
  assert.equal(found.length, 2, "deduped to two distinct addresses");
});

test("extractAddresses returns nothing for a page with no addresses", () => {
  assert.deepEqual(extractAddresses("<html><body>no contracts here</body></html>"), []);
});

test("scriptBodies pulls the contents of script tags", () => {
  const html = `<html><script>var a = "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb";</script></html>`;
  const bodies = scriptBodies(html);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /0x8ed81e/);
});

test("scanHtml reports empty (not a wrong address) for an address-free page", () => {
  const r = scanHtml("<html><body>nothing</body></html>");
  assert.equal(r.empty, true);
  assert.equal(r.candidates.length, 0);
});

// ── Ranking ─────────────────────────────────────────────────────────────────

test("a mint-button address outranks a bare address-key hit", () => {
  const keyed = [{ address: "0x1111111111111111111111111111111111111111", key: "address" }];
  const buttons = ["0x2222222222222222222222222222222222222222"];
  const all = [...keyed.map((k) => k.address), ...buttons];
  const ranked = rankCandidates(keyed, [], [], buttons, all);
  assert.equal(ranked[0].address, "0x2222222222222222222222222222222222222222");
  assert.equal(ranked[0].source, "mint-button");
});

test("a strong key outranks a weak key", () => {
  const keyed = [
    { address: "0x1111111111111111111111111111111111111111", key: "feeRecipient" },
    { address: "0x2222222222222222222222222222222222222222", key: "contractAddress" },
  ];
  const all = keyed.map((k) => k.address);
  const ranked = rankCandidates(keyed, [], [], [], all);
  assert.equal(ranked[0].address, "0x2222222222222222222222222222222222222222");
  assert.equal(ranked[0].key, "contractAddress");
});

test("the zero address is never a candidate", () => {
  const keyed = [{ address: "0x0000000000000000000000000000000000000000", key: "address" }];
  const ranked = rankCandidates(keyed, [], [], [], [keyed[0].address]);
  assert.equal(ranked.length, 0, "zero address must be excluded");
});

test("repeated identical key hits do not multiply the score", () => {
  // A real page repeats the same address under the same key 161 times. That is
  // one key signal, not 161 of them.
  const one = rankCandidates(
    [{ address: "0x1111111111111111111111111111111111111111", key: "address" }],
    [],
    [],
    [],
    ["0x1111111111111111111111111111111111111111"]
  );
  const many = rankCandidates(
    Array.from({ length: 161 }, () => ({
      address: "0x1111111111111111111111111111111111111111",
      key: "address",
    })),
    [],
    [],
    [],
    Array.from({ length: 161 }, () => "0x1111111111111111111111111111111111111111")
  );
  assert.equal(many.length, 1);
  // The score may grow with occurrence (that IS a real signal), but it must not
  // scale with the number of identical key hits.
  assert.ok(
    many[0].score <= one[0].score + 20,
    `161 identical hits scored ${many[0].score}, one hit scored ${one[0].score}`
  );
  assert.ok(many[0].score > one[0].score, "occurrence should still add something");
});

test("candidates are returned best-first", () => {
  const keyed = [
    { address: "0x1111111111111111111111111111111111111111", key: "address" },
    { address: "0x2222222222222222222222222222222222222222", key: "contractAddress" },
  ];
  const all = keyed.map((k) => k.address);
  const ranked = rankCandidates(keyed, [], [], [], all);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, "must be sorted descending");
  }
});

// ── Fixture test against a real page ────────────────────────────────────────

const FIXTURE = "/tmp/collectr.html";

test("fixture: the real collection address ranks first on a real OpenSea page", { skip: !fs.existsSync(FIXTURE) }, () => {
  const html = fs.readFileSync(FIXTURE, "utf-8");
  const r = scanHtml(html);
  assert.ok(r.candidates.length > 0, "the page must yield candidates");
  assert.equal(
    r.candidates[0].address.toLowerCase(),
    "0x8ed81e8146f5c38d19d63e8b2124c9ce9aa8ffeb",
    "the collection contract must rank first"
  );
});

test("fixture: placeholders are excluded from a real page", { skip: !fs.existsSync(FIXTURE) }, () => {
  const html = fs.readFileSync(FIXTURE, "utf-8");
  const r = scanHtml(html);
  assert.ok(!r.candidates.some((c) => /^0x0+$/.test(c.address)), "zero address excluded");
  assert.ok(
    !r.candidates.some((c) => c.address.toLowerCase() === "0x4200000000000000000000000000000000000006"),
    "Base native-token placeholder excluded"
  );
});
