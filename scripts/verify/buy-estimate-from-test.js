"use strict";
/*
 * Regression: eth_estimateGas without `from` runs as the zero address.
 * Seaport checks msg.sender against the fulfiller in the order, so a valid
 * advanced-order fill reverted with "execution reverted (unknown custom
 * error)" before any send. The buyer address must be passed explicitly.
 */
const fs = require("node:fs");
const path = require("node:path");
const { JsonRpcProvider, Wallet } = require("ethers");
const B = require("/home/anon/minter/dist/buy-listings.js");

const tx = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "advanced-fulfillment.json"), "utf8")
);
const KEY = "0x" + "11".repeat(32);
const BUYER = new Wallet(KEY).address;

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail}`); }
  };

  const realFetch = globalThis.fetch;
  const realEstimate = JsonRpcProvider.prototype.estimateGas;
  const realFee = JsonRpcProvider.prototype.getFeeData;
  const realBalance = JsonRpcProvider.prototype.getBalance;
  let captured = null;
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ fulfillment_data: { transaction: tx } }),
  });
  JsonRpcProvider.prototype.estimateGas = async function (request) {
    captured = request;
    return 21_000n;
  };
  JsonRpcProvider.prototype.getFeeData = async () => ({ gasPrice: 1n, maxFeePerGas: 1n });
  JsonRpcProvider.prototype.getBalance = async () => 10n ** 18n;
  try {
    const out = await B.executeListingBuy({
      listing: {
        tokenId: "58", orderHash: "0xabc", chain: "ethereum", protocolAddress: tx.to,
        maker: null, currency: "ETH", value: "1", decimals: 18, price: 0.0033, error: null,
      },
      buyerKey: KEY, apiKey: "x", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: false,
    });
    check("stops without confirmation", out.sent === false && /not confirmed/.test(out.reason || ""), JSON.stringify(out));
    check("estimateGas was called", captured != null);
    check("estimateGas uses the buyer as from", captured?.from === BUYER, `${captured?.from} vs ${BUYER}`);
    check("estimateGas keeps to/value/data", captured?.to === tx.to && BigInt(captured?.value ?? 0) === BigInt(tx.value) && String(captured?.data || "").startsWith("0xe7acab24"));
  } finally {
    globalThis.fetch = realFetch;
    JsonRpcProvider.prototype.estimateGas = realEstimate;
    JsonRpcProvider.prototype.getFeeData = realFee;
    JsonRpcProvider.prototype.getBalance = realBalance;
  }

  // Underfunded wallets must be refused with the shortfall, not a cryptic RPC error.
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ fulfillment_data: { transaction: tx } }),
  });
  JsonRpcProvider.prototype.estimateGas = async (request) => { captured = request; return 21_000n; };
  JsonRpcProvider.prototype.getFeeData = async () => ({ gasPrice: 1n, maxFeePerGas: 1n });
  JsonRpcProvider.prototype.getBalance = async () => 1n;
  let broke;
  try {
    broke = await B.executeListingBuy({
      listing: {
        tokenId: "58", orderHash: "0xabc", chain: "ethereum", protocolAddress: tx.to,
        maker: null, currency: "ETH", value: tx.value, decimals: 18, price: 0.0033, error: null,
      },
      buyerKey: KEY, apiKey: "x", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: true,
    });
  } finally {
    globalThis.fetch = realFetch;
    JsonRpcProvider.prototype.estimateGas = realEstimate;
    JsonRpcProvider.prototype.getFeeData = realFee;
    JsonRpcProvider.prototype.getBalance = realBalance;
  }
  check(
    "underfunded wallet reports shortfall before send",
    broke.sent === false && /insufficient ETH balance/.test(broke.reason || "") && /nothing was sent/.test(broke.reason || ""),
    JSON.stringify(broke)
  );

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
