// Verify the Tier 1/2 fixes against a fake JSON-RPC endpoint + stubbed OpenSea.
const http = require("http");
const { Wallet, Interface, AbiCoder, id, Transaction } = require("/home/anon/minter/node_modules/ethers");

const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const CONDUIT_CONTROLLER = "0x00000000f9490004c11cef243f5400493c00ad63";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const WALLET = new Wallet("0x" + "88".repeat(32)).address;
const TOKEN_ID = 42;

const seadropIface = new Interface([
  "function getPublicDrop(address) view returns (uint80,uint48,uint48,uint16,uint16,bool)",
  "function getAllowedFeeRecipients(address) view returns (address[])",
  "function ownerOf(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
]);
const conduitIface = new Interface(["function getConduit(bytes32) view returns (address,bool)"]);

const coder = AbiCoder.defaultAbiCoder();

// ── behaviour switches ─────────────────────────────────────────────────────
let allowedRecipientsMode = "list"; // list | revert | empty
let conduitMode = "exists";         // exists | missing
let sendRawCount = 0;
let receiptStatus = "ok";           // ok | null
let listingPrice = "20000000000000000";
let approvalFails = false;
let approvedForAll = true;
const MINT_TX = "0x" + "aa".repeat(32);
let lastSentHash = "0x" + "bb".repeat(32);
const calls = [];

const MINT_TOPIC = id("Transfer(address,address,uint256)");
const fromTopic = "0x" + "00".repeat(12) + "00".repeat(20);
const toTopic = "0x" + "00".repeat(12) + WALLET.slice(2).toLowerCase();
const mintLog = {
  address: CONTRACT,
  topics: [MINT_TOPIC, fromTopic, toTopic],
  data: "0x" + TOKEN_ID.toString(16).padStart(64, "0"),
  blockNumber: "0x1",
  transactionIndex: "0x0",
  logIndex: "0x0",
  transactionHash: "0x" + "aa".repeat(32),
  blockHash: "0x" + "00".repeat(32),
  removed: false,
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let r;
    try { r = JSON.parse(body); } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad json: " + body.slice(0,80) } }));
    }
    // ethers batches concurrent requests into one JSON array; answer each item.
    const handleOne = (r) => {
    const send = (result) => ({ jsonrpc: "2.0", id: r.id, result });
    const fail = (message) => ({ jsonrpc: "2.0", id: r.id, error: { code: 3, message } });
    calls.push(r.method + ":" + String((r.params || [])[0] || "").slice(0, 10));

    if (r.method === "eth_chainId") return send("0x1");
    if (r.method === "eth_blockNumber") return send("0x1");
    if (r.method === "eth_getBlockByNumber") {
      return send({ number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", hash: "0x" + "00".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: WALLET, extraData: "0x", logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), mixHash: "0x" + "00".repeat(32), uncles: [], transactions: [], size: "0x0", totalDifficulty: "0x0" });
    }
    if (r.method === "eth_getTransactionReceipt") {
      const want = String((r.params || [])[0] || "");
      if (want.toLowerCase() !== MINT_TX) {
        // a sale receipt: echo the hash we were actually given
        if (receiptStatus === "null") return send(null);
        return send({ blockNumber: "0x1", blockHash: "0x" + "00".repeat(32), transactionHash: lastSentHash, transactionIndex: "0x0", from: WALLET, to: SEADROP, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", effectiveGasPrice: "0x3b9aca00", type: "0x2" });
      }
      return send({ blockNumber: "0x1", blockHash: "0x" + "00".repeat(32), transactionHash: MINT_TX, transactionIndex: "0x0", from: WALLET, to: SEADROP, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null, logs: [mintLog], logsBloom: "0x" + "00".repeat(256), status: "0x1", effectiveGasPrice: "0x3b9aca00", type: "0x2" });
    }
    if (r.method === "eth_sendRawTransaction") {
      sendRawCount++;
      try { lastSentHash = Transaction.from(String(r.params[0])).hash; } catch { lastSentHash = "0x" + "bb".repeat(32); }
      return send(lastSentHash);
    }
    if (r.method === "eth_getTransactionCount") return send("0x0");
    if (r.method === "eth_estimateGas") { if (approvalFails) return fail("approval rejected by rpc"); return send("0x5208"); }
    if (r.method === "eth_gasPrice") return send("0x3b9aca00");
    if (r.method === "eth_call") {
      const data = String(r.params[0].data);
      const sel = data.slice(0, 10);
      if (sel === seadropIface.getFunction("getPublicDrop").selector) {
        // price 0.01e, start now-60, end now+600, cap 5, feeBps 0, restricted
        return send(coder.encode(["uint80", "uint48", "uint48", "uint16", "uint16", "bool"], [10000000000000000n, Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) + 600, 5, 0, true]));
      }
      if (sel === seadropIface.getFunction("getAllowedFeeRecipients").selector) {
        if (allowedRecipientsMode === "revert") return fail("execution reverted");
        const list = allowedRecipientsMode === "list" ? [CONDUIT_CONTROLLER] : [];
        return send(coder.encode(["address[]"], [list]));
      }
      if (sel === seadropIface.getFunction("ownerOf").selector) return send(coder.encode(["address"], [WALLET]));
      if (sel === seadropIface.getFunction("isApprovedForAll").selector) return send(coder.encode(["bool"], [approvedForAll]));
      if (sel === conduitIface.getFunction("getConduit").selector) {
        return send(coder.encode(["address", "bool"], conduitMode === "exists" ? [CONDUIT_CONTROLLER, true] : [WALLET, false]));
      }
      return fail("no mock for " + sel);
    }
    return fail("no mock for " + r.method);
    };
    const out = Array.isArray(r) ? r.map(handleOne) : handleOne(r);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

// ── OpenSea stub ───────────────────────────────────────────────────────────
let openseaMode = "offers"; // offers | http500 | empty
const realFetch = globalThis.fetch;
const RealResponse = Response;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/offers/collection/")) {
    if (openseaMode === "http500") return new RealResponse("{}", { status: 500 });
    if (openseaMode === "empty") return new RealResponse(JSON.stringify({ offers: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const order = {
      order_hash: "0x" + "cc".repeat(32),
      chain: "ethereum",
      protocol_address: "0x0000000000000000000000000000000000000000",
      status: "ACTIVE",
      remaining_quantity: 1,
      price: { value: listingPrice, currency: "ETH", decimals: 18 },
      asset: { contract: CONTRACT, identifier: String(TOKEN_ID) },
      protocol_data: {
        parameters: {
          offerer: WALLET,
          conduitKey: "0x" + "00".repeat(32),
          offer: [{ itemType: 2, token: CONTRACT, identifierOrCriteria: String(TOKEN_ID), startAmount: "1", endAmount: "1" }],
          consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "20000000000000000", endAmount: "20000000000000000", recipient: WALLET }],
        },
        signature: "0x",
      },
    };
    return new RealResponse(JSON.stringify({ offers: [order] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("/fulfillment_data")) {
    return new RealResponse(JSON.stringify({
      fulfillment_data: {
        transaction: {
          function: "fulfillOrder",
          to: SEADROP,
          value: "0",
          input_data: {
            order: {
              parameters: {
                offerer: WALLET,
                zone: SEADROP,
                orderType: 0,
                startTime: "0",
                endTime: "0",
                zoneHash: "0x" + "00".repeat(32),
                salt: "0",
                conduitKey: "0x" + "11".repeat(32),
                totalOriginalConsiderationItems: "2",
                offer: [{ itemType: 2, token: CONTRACT, identifierOrCriteria: String(TOKEN_ID), startAmount: "1", endAmount: "1" }],
                consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "20000000000000000", endAmount: "20000000000000000", recipient: WALLET }],
              },
              signature: "0x",
            },
            fulfillerConduitKey: "0x" + "00".repeat(32),
          },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new RealResponse("{}", { status: 404 });
};

const lines = [];
const check = (name, ok, detail) => { lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sp = require("/home/anon/minter/dist/seadrop-public.js");
  const sam = require("/home/anon/minter/dist/sell-after-mint.js");

  // A. fee recipient: restricted drop, read REVERTS -> must report the read failure
  allowedRecipientsMode = "revert";
  let r = await sp.buildLocalMintPlanAttempt(url, CONTRACT, 1, 5000);
  check("A1 restricted + reverting read reports the read failure",
    !r.plan && /reading the allowed fee recipients .* failed/.test(r.reason), r.reason);
  check("A2 ...and NOT 'none is allowed'", !/none is allowed/.test(r.reason), r.reason);

  // B. restricted drop, genuinely empty list -> the real refusal
  allowedRecipientsMode = "empty";
  r = await sp.buildLocalMintPlanAttempt(url, CONTRACT, 1, 5000);
  check("B restricted + empty list still refuses as none-allowed",
    !r.plan && /restricts fee recipients and none is allowed/.test(r.reason), r.reason);

  // C. unrestricted drop, read reverts -> read failure, not a silent default
  //    (flip restricted off by using a non-restricting drop: reuse empty list + restricted=false
  //     is not reachable through the same mock, so assert the read-failed branch directly)
  allowedRecipientsMode = "revert";
  r = await sp.buildLocalMintPlanAttempt(url, CONTRACT, 1, 5000);
  check("C reverting read is never reported as a property of the drop",
    !r.plan && /failed/.test(r.reason) && !/none is allowed/.test(r.reason), r.reason);

  // D. allowed list -> uses allowed[0]
  allowedRecipientsMode = "list";
  r = await sp.buildLocalMintPlanAttempt(url, CONTRACT, 1, 5000);
  check("D allowed list is used", !!r.plan && String(r.plan.feeRecipient).toLowerCase() === CONDUIT_CONTROLLER.toLowerCase(), r.plan && r.plan.feeRecipient);

  // E. sweep budget: 4 blackhole endpoints must not cost 4x the budget
  const blackholes = ["http://127.0.0.1:1", "http://127.0.0.1:2", "http://127.0.0.1:3", "http://127.0.0.1:4"];
  const t0 = Date.now();
  const swept = await sp.buildLocalMintPlanOnAnyRpc(blackholes, CONTRACT, 1, 3000);
  const took = Date.now() - t0;
  check("E sweep budget bounds 4 dead endpoints", !swept.plan && took < 6000, `${took}ms (was up to 4x15s)`);

  // F. approvalOperator tri-state
  const { JsonRpcProvider } = require("/home/anon/minter/node_modules/ethers");
  const provider = new JsonRpcProvider(url, 1, { staticNetwork: true });
  const zeroKey = "0x" + "00".repeat(32);
  const a1 = await sam.approvalOperator(provider, zeroKey, SEADROP);
  conduitMode = "exists";
  const a2 = await sam.approvalOperator(provider, "0x" + "11".repeat(32), SEADROP);
  conduitMode = "missing";
  const a3 = await sam.approvalOperator(provider, "0x" + "11".repeat(32), SEADROP);
  provider.destroy();
  check("F1 zero conduit key -> Seaport itself", a1.operator === SEADROP && !a1.error, JSON.stringify(a1));
  check("F2 registered conduit -> its address", String(a2.operator).toLowerCase() === CONDUIT_CONTROLLER.toLowerCase() && !a2.error, JSON.stringify(a2));
  check("F3 unregistered conduit -> error, not silent null", a3.operator === null && !!a3.error, JSON.stringify(a3));

  // G. offer read failure is reported, not read as an empty book
  openseaMode = "http500";
  const g1 = await sam.fetchTokenOffersResult("slug", String(TOKEN_ID), "k");
  const g2 = await sam.fetchCollectionOffersResult("slug", "k");
  openseaMode = "empty";
  const g3 = await sam.fetchTokenOffersResult("slug", String(TOKEN_ID), "k");
  openseaMode = "offers";
  check("G1 HTTP 500 -> error", g1.error !== null && g1.offers.length === 0, String(g1.error));
  check("G2 collection HTTP 500 -> error", g2.error !== null, String(g2.error));
  check("G3 empty book -> NO error (a real empty book)", g3.error === null && g3.offers.length === 0, String(g3.error));

  // H. end-to-end: unregistered conduit -> no sale tx broadcast
  conduitMode = "missing";
  sendRawCount = 0;
  openseaMode = "offers";
  const h = await sam.executeSellAfterMint({
    walletKey: "0x" + "88".repeat(32), contract: CONTRACT, slug: "slug", chainKey: "ethereum",
    apiKey: "k", rpcUrl: url, chainId: 1, quantity: 1, gasMode: "fast",
    costWeiPerToken: 1n, symbol: "ETH", mintTxHash: MINT_TX,
  });
  console.log("H result:", JSON.stringify(h, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  check("H1 unregistered conduit -> no transaction sent", sendRawCount === 0, `${sendRawCount} sent`);
  check("H2 ...and the token is recorded unsold with the reason",
    h.sold.length === 1 && /approval target/.test(h.sold[0].error || ""), h.sold[0] && h.sold[0].error);

  // I. empty book -> "no offer clears the cost floor", not a read failure
  conduitMode = "exists";
  openseaMode = "empty";
  const i = await sam.executeSellAfterMint({
    walletKey: "0x" + "88".repeat(32), contract: CONTRACT, slug: "slug", chainKey: "ethereum",
    apiKey: "k", rpcUrl: url, chainId: 1, quantity: 1, gasMode: "fast",
    costWeiPerToken: 1n, symbol: "ETH", mintTxHash: MINT_TX,
  });
  console.log("I result:", JSON.stringify(i, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  check("I empty book is reported as an empty book", i.sold.length === 1 && /no offer clears the cost floor/.test(i.sold[0].error || ""), i.sold[0] && i.sold[0].error);

  // J. happy path: approved already, registered conduit -> exactly one sale tx,
  //    and net comes from the FULL order (singular `order`), not the listing.
  conduitMode = "exists";
  openseaMode = "offers";
  approvedForAll = true;
  approvalFails = false;
  listingPrice = "5000000000000000000"; // 5 ETH in the listing; the order says 0.02
  sendRawCount = 0;
  const j = await sam.executeSellAfterMint({
    walletKey: "0x" + "88".repeat(32), contract: CONTRACT, slug: "slug", chainKey: "ethereum",
    apiKey: "k", rpcUrl: url, chainId: 1, quantity: 1, gasMode: "fast",
    costWeiPerToken: 1n, symbol: "ETH", mintTxHash: MINT_TX,
  });
  check("J1 happy path sends exactly one sale tx", sendRawCount === 1, `${sendRawCount} sent`);
  check("J2 net comes from the full order (0.02 ETH), not the 5 ETH listing",
    j.sold.length === 1 && j.sold[0].netWei === 20000000000000000n, j.sold[0] && String(j.sold[0].netWei));
  check("J3 ...and it is recorded as sold with no error", !!j.sold[0] && !j.sold[0].error, j.sold[0] && j.sold[0].error);

  // K. approval needed but the tx fails -> skip, do not broadcast the sale
  approvedForAll = false;
  approvalFails = true;
  listingPrice = "20000000000000000";
  sendRawCount = 0;
  const k = await sam.executeSellAfterMint({
    walletKey: "0x" + "88".repeat(32), contract: CONTRACT, slug: "slug", chainKey: "ethereum",
    apiKey: "k", rpcUrl: url, chainId: 1, quantity: 1, gasMode: "fast",
    costWeiPerToken: 1n, symbol: "ETH", mintTxHash: MINT_TX,
  });
  check("K1 failed approval -> no sale tx", sendRawCount === 0, `${sendRawCount} sent`);
  check("K2 ...and the reason is recorded", k.sold.length === 1 && /approval failed/.test(k.sold[0].error || ""), k.sold[0] && k.sold[0].error);

  require("fs").writeFileSync(__dirname + "/audit-fix-out.txt", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n${lines.length - failed}/${lines.length} passed`);
  server.close();
  globalThis.fetch = realFetch;
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
