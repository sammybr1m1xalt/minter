// Listings read + buy-calldata encoding.
// Needs a live OpenSea key; skipped when the pool has none usable.
const { getValidApiKey } = require("/home/anon/minter/dist/opensea-key.js");
const B = require("/home/anon/minter/dist/buy-listings.js");
const { keccak256, toUtf8Bytes, Interface } = require("/home/anon/minter/node_modules/ethers");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

(async () => {
  const key = await getValidApiKey({ timeoutMs: 15000 }).catch(() => null);
  if (!key) {
    console.log("SKIP listings-test.js — no usable OpenSea key in the pool");
    process.exit(0);
  }

  // A token that is listed, and one that is not. Both verified live.
  const listed = await B.fetchBestListing("boredapeyachtclub", "9627", key.api_key);
  ok("listed token parses a price", listed.price != null && listed.price > 0, `${listed.price} ${listed.currency}`);
  ok("listed token carries an order hash", !!listed.orderHash);
  ok("listed token carries the seller", !!listed.maker && listed.maker.startsWith("0x"));
  ok("price uses the stated decimals", listed.decimals === 18, `decimals=${listed.decimals}`);

  const notListed = await B.fetchBestListing("boredapeyachtclub", "1", key.api_key);
  ok("unlisted token says not listed", /not listed/i.test(notListed.error || ""), notListed.error);

  // A read failure must never read as "not listed".
  const badKey = await B.fetchBestListing("boredapeyachtclub", "9627", "0".repeat(32));
  ok("a rejected key is not reported as not-listed", !/not listed/i.test(badKey.error || ""), badKey.error);

  // The buy transaction: re-encode from input_data and check it round-trips.
  const tx = await B.fetchListingBuyTransaction(listed, "0x1111111111111111111111111111111111111111", key.api_key);
  ok("buy transaction vended", !!tx, tx ? `${tx.function.slice(0, 34)}…` : "null");

  if (tx) {
    const calldata = B.encodeBuyInput(tx);
    const p = tx.inputData.parameters;
    const iface = new Interface([`function ${tx.function}`]);
    const decoded = iface.decodeFunctionData("fulfillBasicOrder_efficient_6GL6yc", calldata);
    const t = decoded[0];
    ok("calldata round-trips: offerIdentifier", t[6].toString() === String(p.offerIdentifier), t[6].toString());
    ok("calldata round-trips: salt", t[12].toString() === String(p.salt));
    ok("calldata round-trips: signature", t[17] === p.signature);
    ok(
      "calldata round-trips: additionalRecipients",
      t[16].length === (p.additionalRecipients || []).length,
      `${t[16].length} recipient(s)`
    );

    // calldata_suffix is the attribution suffix, not the selector.
    const suffix = tx.raw.calldata_suffix;
    ok(
      "suffix is keccak256('api.opensea.io')",
      "0x" + keccak256(toUtf8Bytes("api.opensea.io")).slice(2, 10) === suffix.toLowerCase(),
      suffix
    );
    // The suffix is appended as raw bytes, so the "0x" prefix is not part of it.
    ok(
      "suffix is appended as trailing bytes",
      calldata.toLowerCase().endsWith(suffix.toLowerCase().slice(2))
    );
    ok("suffix is not the selector", calldata.slice(0, 10) !== suffix.toLowerCase());
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("THREW:", e?.message || e);
  process.exit(1);
});
