"use strict";
/* RED harness: ERC20-priced listings approve the exact payment token/spender. */
const { AbiCoder, Interface, JsonRpcProvider, Wallet } = require("ethers");
const B = require("/home/anon/minter/dist/buy-listings.js");

const KEY = "0x" + "11".repeat(32);
const BUYER = new Wallet(KEY).address;
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
const CONDUIT = "0x2222222222222222222222222222222222222222";
const CONDUIT_KEY = "0x" + "ab".repeat(32);
const coder = new AbiCoder();
const ERC20 = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const CONTROLLER = new Interface([
  "function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)",
]);
const basic = {
  considerationToken: TOKEN, considerationIdentifier: "0", considerationAmount: "23000000",
  offerer: "0x3333333333333333333333333333333333334444",
  zone: "0x0000000000000000000000000000000000000000",
  offerToken: "0x5555555555555555555555555555555555556666",
  offerIdentifier: "1877", offerAmount: "1", basicOrderType: "0",
  startTime: "1795580669", endTime: "1811132669",
  zoneHash: "0x" + "00".repeat(32), salt: "0x3d958fe200000000000000000000000000000000000006315f65100116bb4",
  offererConduitKey: "0x" + "00".repeat(32), fulfillerConduitKey: CONDUIT_KEY,
  totalOriginalAdditionalRecipients: "0", additionalRecipients: [], signature: "0x",
};
const erc721Event = new Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
const enc = erc721Event.encodeEventLog(erc721Event.getEvent("Transfer"), [
  "0x3333333333333333333333333333333333334444", BUYER, 1877,
]);
const receipt = { status: 1, logs: [{ address: basic.offerToken, topics: enc.topics, data: enc.data }] };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

function stub({ allowance = 0n, conduitExists = true, paymentToken = TOKEN, currency = "USDG" } = {}) {
  const sent = [];
  const realFetch = globalThis.fetch;
  const realCall = JsonRpcProvider.prototype.call;
  const realEstimate = JsonRpcProvider.prototype.estimateGas;
  const realFee = JsonRpcProvider.prototype.getFeeData;
  const realBalance = JsonRpcProvider.prototype.getBalance;
  const realWait = JsonRpcProvider.prototype.waitForTransaction;
  const realSend = Wallet.prototype.sendTransaction;
  globalThis.fetch = async (url, init) => {
    const tx = {
      function: "fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))",
      chain: 4663, to: SEAPORT, value: "0", value_hex: "0x0",
      input_data: { parameters: basic }, calldata_suffix: "0xcdb44011",
    };
    return { ok: true, status: 200, text: async () => JSON.stringify({ fulfillment_data: { transaction: tx } }) };
  };
  JsonRpcProvider.prototype.call = async (req) => {
    const sel = String(req.data).slice(0, 10);
    if (sel === ERC20.getFunction("allowance").selector) return coder.encode(["uint256"], [allowance]);
    if (sel === CONTROLLER.getFunction("getConduit").selector) return coder.encode(["address", "bool"], [CONDUIT, conduitExists]);
    throw new Error(`unexpected call ${sel}`);
  };
  JsonRpcProvider.prototype.estimateGas = async () => 50_000n;
  JsonRpcProvider.prototype.getFeeData = async () => ({ gasPrice: 1n, maxFeePerGas: 1n });
  JsonRpcProvider.prototype.getBalance = async () => 10n ** 18n;
  JsonRpcProvider.prototype.waitForTransaction = async () => receipt;
  Wallet.prototype.sendTransaction = async (t) => { sent.push(t); return { hash: "0x" + sent.length }; };
  const listing = {
    tokenId: "1877", orderHash: "0x" + "ab".repeat(32), chain: "robinhood",
    protocolAddress: SEAPORT, maker: null, currency, value: "23000000", decimals: 6,
    price: 23, error: null, collection: basic.offerToken, paymentToken,
  };
  const restore = () => {
    globalThis.fetch = realFetch;
    JsonRpcProvider.prototype.call = realCall;
    JsonRpcProvider.prototype.estimateGas = realEstimate;
    JsonRpcProvider.prototype.getFeeData = realFee;
    JsonRpcProvider.prototype.getBalance = realBalance;
    JsonRpcProvider.prototype.waitForTransaction = realWait;
    Wallet.prototype.sendTransaction = realSend;
  };
  const run = () => B.executeListingBuy({ listing, buyerKey: KEY, apiKey: "test", rpcUrl: "http://127.0.0.1:1", chainId: 4663, yes: true });
  return { sent, run, restore };
}

(async () => {
  try {
    let s = stub();
    let out;
    try { out = await s.run(); } finally { s.restore(); }
    const approve = ERC20.parseTransaction({ data: s.sent[0]?.data });
    ok("approval targets the payment token", String(s.sent[0]?.to).toLowerCase() === TOKEN, JSON.stringify(s.sent.map((x) => x.to)));
    ok("approval is exact amount to resolved spender", approve?.name === "approve" && approve.args[0] === CONDUIT && approve.args[1] === 23000000n, `${approve?.name} ${approve?.args}`);
    ok("buy sends zero native value", s.sent.length === 2 && BigInt(s.sent[1]?.value ?? 0) === 0n, JSON.stringify(s.sent.map((x) => String(x.value))));
    ok("buy is confirmed after approval", out.sent === true && out.verification?.status === "confirmed");

    s = stub({ allowance: 23000000n });
    try { out = await s.run(); } finally { s.restore(); }
    ok("existing allowance sends only the buy", s.sent.length === 1 && out.sent === true, `sends=${s.sent.length}`);

    s = stub({ paymentToken: null });
    try { out = await s.run(); } finally { s.restore(); }
    ok("unstated payment token refuses before send", out.sent === false && s.sent.length === 0 && /payment token/.test(out.reason || ""), out.reason || "");

    s = stub({ conduitExists: false });
    try { out = await s.run(); } finally { s.restore(); }
    ok("unregistered conduit refuses before send", out.sent === false && s.sent.length === 0 && /conduit/.test(out.reason || ""), out.reason || "");

    console.log(`\n--- ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } catch (e) { console.error(e); process.exit(1); }
})();
