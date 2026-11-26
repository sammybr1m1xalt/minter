"use strict";
/* Targeted --snipe --token-id N: one metadata JSON + one listing GET. */
const B = require("/home/anon/minter/dist/buy-listings.js");
const T = require("/home/anon/minter/dist/snipe-target.js");

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
  };
  const realFetch = globalThis.fetch;
  let metadataCalls = 0, listingCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.opensea.io")) {
      listingCalls++;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          order_hash: "0xabc", chain: "ethereum", protocol_address: "0xdef",
          protocol_data: { parameters: { offerer: "0x" + "aa".repeat(20) } },
          asset: { identifier: "58" },
          price: { current: { currency: "ETH", decimals: 18, value: "500000000000000000" } },
        }),
      };
    }
    metadataCalls++;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        attributes: [{ trait_type: "Background", value: "Blue" }, { trait_type: "Eyes", value: "Green" }],
      }),
    };
  };
  try {
    const got = await T.scrapeOne({
      contract: null,
      cid: "bafytest",
      tokenId: "58",
      chainKey: "ethereum",
      rpcs: [],
      gateway: "https://gw.example",
      slug: "test-collection",
      apiKey: "key",
    });
    ok("traits parsed from the single file", got.traits.length === 2, JSON.stringify(got.traits));
    ok("metadata source named", /gw\.example/.test(got.source), got.source);
    ok("listing fetched for that one id", listingCalls === 1 && got.listing.price === 0.5, `${listingCalls} / ${got.listing.price}`);
    ok("no directory crawl was needed", metadataCalls === 1, String(metadataCalls));
    ok("rarity percentile is not invented", !("percentile" in got));
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
