"use strict";
/* Regression for todo 15: a dead gateway must not cost a 60s timeout each. */
const assert = require("node:assert/strict");
const R = require("/home/anon/minter/dist/rarity.js");

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail}`); }
  };

  const realFetch = globalThis.fetch;
  const bad = (signal) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("still waiting")), 500);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
  const stub = `<html><a href="/ipfs/cid/1">1</a><a href="/ipfs/cid/2">2</a></html>`;
  const full = `<html>${Array.from({ length: 12 }, (_, i) => `<a href="/ipfs/cid/${i + 1}">${i + 1}</a>`).join("")}</html>`;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (String(url).includes("partial")) {
      return { ok: true, status: 200, text: async () => stub, body: null };
    }
    if (String(url).includes("alive")) {
      return { ok: true, status: 200, text: async () => full, body: null };
    }
    return bad(init?.signal);
  };
  try {
    const t = Date.now();
    const got = await R.listDirectoryEntries(
      "bafytest",
      ["https://dead1", "https://partial", "https://alive", "https://dead3"],
      60_000
    );
    const ms = Date.now() - t;
    check("winning gateway is reported", got.gateway === "https://alive", JSON.stringify(got));
    check("fullest answer wins over a partial one", got.entries.length === 12, `${got.entries.length} entries`);
    check("all gateways probed together", calls === 4, String(calls));
    check("does not wait for the long per-gateway timeout", ms < 3000, `${ms}ms`);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
