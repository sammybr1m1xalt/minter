"use strict";
/*
 * RED harness for todo item 13.
 * The buy path reported "gas estimate failed: invalid address ... value=null".
 * The failing call can be a null address INSIDE the fulfillment tuple, not the
 * gas estimate itself. Feed nulls at the API seam and require an honest reason
 * that names the field, before any RPC call happens.
 */
const assert = require("node:assert/strict");
const B = require("/home/anon/minter/dist/buy-listings.js");

const KEY = "0x" + "11".repeat(32); // throwaway, not a funded wallet
const RPC = "http://127.0.0.1:1"; // unreachable on purpose: no send may happen

const params = {
  considerationToken: "0x0000000000000000000000000000000000000000",
  considerationIdentifier: "0",
  considerationAmount: "1",
  offerer: "0x" + "22".repeat(20),
  zone: "0x0000000000000000000000000000000000000000",
  offerToken: "0x" + "33".repeat(20),
  offerIdentifier: "1",
  offerAmount: "1",
  basicOrderType: 1,
  startTime: "1",
  endTime: "2",
  zoneHash: "0x" + "00".repeat(32),
  salt: "1",
  offererConduitKey: "0x" + "00".repeat(32),
  fulfillerConduitKey: "0x" + "00".repeat(32),
  totalOriginalAdditionalRecipients: "0",
  additionalRecipients: [],
  signature: "0x",
};

function stubFulfillment(overrides = {}) {
  const p = { ...params, ...overrides };
  const body = JSON.stringify({
    fulfillment_data: {
      transaction: {
        function: "fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))",
        chain: 1,
        to: "0x0000000000000068f116a894984e2db1123eb395",
        value: "1",
        input_data: { parameters: p },
      },
    },
  });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => body });
  return () => { globalThis.fetch = real; };
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail}`); }
  };
  const listing = {
    tokenId: "1", orderHash: "0xabc", chain: "ethereum",
    protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
    maker: null, currency: "ETH", value: "1", decimals: 18, price: 1, error: null,
  };

  for (const field of ["offerer", "zone", "offerToken", "offererConduitKey", "fulfillerConduitKey", "zoneHash"]) {
    const restore = stubFulfillment({ [field]: null });
    let out;
    try {
      out = await B.executeListingBuy({
        listing, buyerKey: KEY, apiKey: "x", rpcUrl: RPC, chainId: 1, yes: true,
      });
    } finally { restore(); }
    check(
      `null ${field} is named before gas estimation`,
      out.sent === false && /null/i.test(out.reason || "") && (out.reason || "").includes(field) && !/gas estimate failed/.test(out.reason || ""),
      JSON.stringify(out)
    );
  }

  const restoreTo = stubFulfillment({});
  // Override the whole tx with a null `to` by patching the stub body directly.
  restoreTo();
  const nullToBody = JSON.stringify({
    fulfillment_data: { transaction: {
      function: params.function, chain: 1, to: null, value: "1",
      input_data: { parameters: params },
    } },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => nullToBody });
  let toOut;
  try {
    toOut = await B.executeListingBuy({
      listing, buyerKey: KEY, apiKey: "x", rpcUrl: RPC, chainId: 1, yes: true,
    });
  } finally { globalThis.fetch = realFetch; }
  check(
    "null tx.to is named, not hidden as a gas error",
    toOut.sent === false && /to\b/i.test(toOut.reason || "") && /null/i.test(toOut.reason || "") && !/gas estimate failed/.test(toOut.reason || ""),
    JSON.stringify(toOut)
  );

  // A vended tx with no parameters is refused with a useful shape, not a gas error.
  const missingBody = JSON.stringify({
    fulfillment_data: { transaction: {
      function: "unknownFunction", chain: 1,
      to: "0x0000000000000068f116a894984e2db1123eb395", value: "1",
      input_data: {},
    } },
  });
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => missingBody });
  let missingOut;
  try {
    missingOut = await B.executeListingBuy({
      listing, buyerKey: KEY, apiKey: "x", rpcUrl: RPC, chainId: 1, yes: true,
    });
  } finally { globalThis.fetch = realFetch2; }
  check(
    "missing parameters names the function and key set",
    missingOut.sent === false && /input_data\.parameters/.test(missingOut.reason || "") &&
      /unknownFunction/.test(missingOut.reason || "") && /keys: none/.test(missingOut.reason || "") &&
      !/gas estimate failed/.test(missingOut.reason || ""),
    JSON.stringify(missingOut)
  );

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
