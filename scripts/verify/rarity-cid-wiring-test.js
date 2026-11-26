"use strict";
/* RED harness: rarity drops direct-CID documents whose bytes contradict the CID. */
const R = require("/home/anon/minter/dist/rarity.js");
const CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";
const DOC = JSON.stringify({ name: "tampered", attributes: [{ trait_type: "X", value: 1 }] });

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
  };
  const realFetch = globalThis.fetch;
  let urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    const body = u.endsWith("/") ? '<a href="1.json">1.json</a>' : DOC;
    return { status: 200, ok: true, text: async () => body };
  };
  try {
    const out = await R.crawlTraits({ cid: CID, verifyIpfs: true, limit: 1, concurrency: 1, requestTimeoutMs: 1000, timeoutMs: 5000 });
    ok("mismatched bytes are dropped", out.tokens.length === 0 && out.cidMismatched >= 1, JSON.stringify({ tokens: out.tokens.length, mismatch: out.cidMismatched }));
    ok("verification used no extra gateway calls", urls.length >= 1 && !urls.some((u) => u.includes("format=raw")), `calls=${urls.length}`);
  } finally { globalThis.fetch = realFetch; }
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
