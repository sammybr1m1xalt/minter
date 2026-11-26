"use strict";
/* Multi-token one-tx buy via cross_chain_fulfillment_data. */
const { Interface, JsonRpcProvider, Wallet } = require("ethers");
const B = require("/home/anon/minter/dist/buy-listings.js");

const KEY = "0x" + "11".repeat(32);
const BUYER = new Wallet(KEY).address;
const TO = "0x0000000000000068f116a894984e2db1123eb395";
const listings = [1, 2].map((id) => ({
  tokenId: String(id), orderHash: "0x" + id.toString(16).padStart(64, "0"),
  chain: "ethereum", protocolAddress: TO, maker: null, currency: "ETH",
  value: "50", decimals: 18, price: 0.00005, error: null,
  collection: "0x5555555555555555555555555555555555556666", paymentToken: null,
}));

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
  };
  const realFetch = globalThis.fetch;
  const realEstimate = JsonRpcProvider.prototype.estimateGas;
  const realFee = JsonRpcProvider.prototype.getFeeData;
  const realBalance = JsonRpcProvider.prototype.getBalance;
  const realSend = Wallet.prototype.sendTransaction;
  const realWait = JsonRpcProvider.prototype.waitForTransaction;
  const erc721 = new Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
  const SELLER = "0x3333333333333333333333333333333333334444";
  const COLLECTION = "0x5555555555555555555555555555555555556666";
  const receipt = { status: 1, logs: [1, 2].map((id) => {
    const enc = erc721.encodeEventLog(erc721.getEvent("Transfer"), [SELLER, BUYER, id]);
    return { address: COLLECTION, topics: enc.topics, data: enc.data };
  }) };
  let body = null, estimate = null, sent = null, sendCount = 0;
  let txCount = 1;

  const stubFetch = async (url, init) => {
    body = JSON.parse(init.body);
    const txs = Array.from({ length: txCount }, () => ({
      chain: "ethereum", to: TO, data: "0x87201b41" + "11".repeat(16),
      value: "100", gas_limit: null,
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ transactions: txs }) };
  };
  const stubProvider = () => {
    globalThis.fetch = stubFetch;
    JsonRpcProvider.prototype.estimateGas = async (r) => { estimate = r; return 21_000n; };
    JsonRpcProvider.prototype.getFeeData = async () => ({ gasPrice: 1n, maxFeePerGas: 1n });
    JsonRpcProvider.prototype.getBalance = async () => 10n ** 18n;
    Wallet.prototype.sendTransaction = async (t) => { sent = t; sendCount++; return { hash: "0xdead" }; };
    JsonRpcProvider.prototype.waitForTransaction = async () => receipt;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
    JsonRpcProvider.prototype.estimateGas = realEstimate;
    JsonRpcProvider.prototype.getFeeData = realFee;
    JsonRpcProvider.prototype.getBalance = realBalance;
    Wallet.prototype.sendTransaction = realSend;
    JsonRpcProvider.prototype.waitForTransaction = realWait;
  };

  try {
    stubProvider();
    const out = await B.executeBatchListingBuy({
      listings, buyerKey: KEY, apiKey: "x", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: true,
    });
    ok("one tx was sent", out.sent === true && sendCount === 1 && out.txHash === "0xdead", JSON.stringify(out));
    ok("exact listing hashes were sent", body.listings.length === 2 && body.listings[1].hash === listings[1].orderHash, JSON.stringify(body.listings));
    ok("same-chain native payment", body.payment.chain === "ethereum" && body.payment.token_address === "0x0000000000000000000000000000000000000000", JSON.stringify(body.payment));
    ok("estimate carries buyer and vended tx", estimate?.from === BUYER && estimate?.to === TO && BigInt(estimate?.value ?? 0) === 100n, `${estimate?.from} ${estimate?.to} ${String(estimate?.value)}`);
    ok("send uses the vended calldata verbatim", sent?.data === "0x87201b41" + "11".repeat(16));
    ok("receipt verification confirms both tokens", out.verification?.status === "confirmed" && out.verification.receivedTokenIds.join(",") === "1,2", JSON.stringify(out.verification));
  } finally { restore(); }

  try {
    stubProvider();
    sendCount = 0;
    JsonRpcProvider.prototype.waitForTransaction = async () => ({ status: 1, logs: receipt.logs.slice(0, 1) });
    const out = await B.executeBatchListingBuy({
      listings, buyerKey: KEY, apiKey: "test", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: true,
    });
    ok("skipped order is not reported as success", out.sent === true && out.verification?.status === "failed" && /token 2/.test(out.reason || ""), JSON.stringify(out));
  } finally { restore(); }

  try {
    stubProvider();
    sendCount = 0;
    txCount = 2;
    const out = await B.executeBatchListingBuy({
      listings, buyerKey: KEY, apiKey: "x", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: true,
    });
    ok("multi-tx response is refused, not half-sent", out.sent === false && /2 transactions/.test(out.reason || "") && sendCount === 0, JSON.stringify(out));
  } finally { restore(); txCount = 1; }

  try {
    stubProvider();
    sendCount = 0;
    JsonRpcProvider.prototype.getBalance = async () => 1n;
    const out = await B.executeBatchListingBuy({
      listings, buyerKey: KEY, apiKey: "x", rpcUrl: "http://127.0.0.1:1", chainId: 1, yes: true,
    });
    ok("underfunded wallet refuses before send", out.sent === false && /insufficient ETH balance/.test(out.reason || "") && sendCount === 0, JSON.stringify(out));
  } finally { restore(); }

  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
