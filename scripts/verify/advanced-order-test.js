"use strict";
/*
 * Regression: OpenSea vends TWO fulfillment shapes. Collections with
 * criteria/resolvers use fulfillAdvancedOrder and carry `advancedOrder`, not
 * `parameters`. The old tool called that "missing input_data.parameters" and
 * refused every buy on those collections.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { id } = require("ethers");
const B = require("/home/anon/minter/dist/buy-listings.js");

const tx = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "advanced-fulfillment.json"), "utf8")
);
const KEY = "0x" + "11".repeat(32);
const RPC = "http://127.0.0.1:1";

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail}`); }
  };

  // encodeBuyInput takes the mapped BuyTransaction, not the raw API response.
const buyTx = {
  function: tx.function, chain: tx.chain, to: tx.to, value: tx.value,
  inputData: tx.input_data, raw: tx,
};
const encoded = B.encodeBuyInput(buyTx);
  const selector = id(tx.function).slice(0, 10);
  check("calldata selector matches the vended function", encoded.startsWith(selector), `${selector} vs ${encoded.slice(0, 10)}`);
  check("attribution suffix is trailing, not the selector", encoded.endsWith(tx.calldata_suffix.slice(2)), tx.calldata_suffix);
  check("advanced calldata is not the basic selector", !encoded.startsWith("0xcdb44011"));

  const listing = {
    tokenId: "58", orderHash: "0xabc", chain: "ethereum",
    protocolAddress: tx.to, maker: null, currency: "ETH", value: "1",
    decimals: 18, price: 0.0033, error: null,
  };
  const body = JSON.stringify({ fulfillment_data: { transaction: tx } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => body });
  let out;
  try {
    out = await B.executeListingBuy({
      listing, buyerKey: KEY, apiKey: "x", rpcUrl: RPC, chainId: 1, yes: true,
    });
  } finally { globalThis.fetch = realFetch; }
  check(
    "advanced order is not refused as missing parameters",
    out.sent === false && !/input_data\.parameters/.test(out.reason || "") && !/invalid address|null\/invalid/.test(out.reason || ""),
    JSON.stringify(out)
  );

  const broken = JSON.parse(JSON.stringify(tx));
  broken.input_data.advancedOrder.parameters.offerer = null;
  const brokenBody = JSON.stringify({ fulfillment_data: { transaction: broken } });
  globalThis.fetch = async () => ({ status: 200, text: async () => brokenBody });
  let badOut;
  try {
    badOut = await B.executeListingBuy({
      listing, buyerKey: KEY, apiKey: "x", rpcUrl: RPC, chainId: 1, yes: true,
    });
  } finally { globalThis.fetch = realFetch; }
  check(
    "null advanced field names itself",
    badOut.sent === false && /offerer/.test(badOut.reason || "") && /null\/invalid/.test(badOut.reason || ""),
    JSON.stringify(badOut)
  );

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
