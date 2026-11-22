// End-to-end send-path test for the Scatter mint, driven against a fake JSON-RPC.
// The PLAN is built from the LIVE Scatter API; only the chain is fake, so no
// real transaction is broadcast.
import { createRequire } from "module";
import http from "http";
import fs from "fs";
const require = createRequire("/home/anon/minter/");
const { Wallet, Interface, AbiCoder, Transaction, id } = require("ethers");

const sc = await import("/home/anon/minter/dist/scatter.js");
const sm = await import("/home/anon/minter/dist/scatter-mint.js");

const erc20Iface = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const coder = AbiCoder.defaultAbiCoder();

let sendCount = 0;
const sent = [];
let allowanceMode = "zero"; // zero | enough
const MINT_TX = "0x" + "aa".repeat(32);
let lastHash = "0x" + "bb".repeat(32);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const handle = (r) => {
      const send = (result) => ({ jsonrpc: "2.0", id: r.id, result });
      const fail = (message) => ({ jsonrpc: "2.0", id: r.id, error: { code: 3, message } });
      if (r.method === "eth_chainId") return send("0x2105"); // 8453 Base
      if (r.method === "eth_blockNumber") return send("0x1");
      if (r.method === "eth_getBlockByNumber") {
        return send({ number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", hash: "0x" + "00".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x", logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), mixHash: "0x" + "00".repeat(32), uncles: [], transactions: [], size: "0x0", totalDifficulty: "0x0" });
      }
      if (r.method === "eth_getTransactionReceipt") {
        const want = String((r.params || [])[0] || "").toLowerCase();
        return send({ blockNumber: "0x1", blockHash: "0x" + "00".repeat(32), transactionHash: want, transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", effectiveGasPrice: "0x3b9aca00", type: "0x2" });
      }
      if (r.method === "eth_sendRawTransaction") {
        sendCount++;
        try { lastHash = Transaction.from(String(r.params[0])).hash; } catch { /* ignore */ }
        sent.push(lastHash);
        return send(lastHash);
      }
      if (r.method === "eth_getTransactionCount") return send("0x0");
      if (r.method === "eth_estimateGas") return send("0x5208");
      if (r.method === "eth_call") {
        const sel = String(r.params[0].data).slice(0, 10);
        if (sel === erc20Iface.getFunction("allowance").selector) {
          return send(coder.encode(["uint256"], [allowanceMode === "enough" ? 10n ** 30n : 0n]));
        }
        return fail("no mock for " + sel);
      }
      return fail("no mock for " + r.method);
    };
    const r = JSON.parse(body);
    const out = Array.isArray(r) ? r.map(handle) : handle(r);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

const lines = [];
const check = (n, ok, d) => lines.push(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? " — " + d : ""}`);

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const wallet = new Wallet("0x" + "88".repeat(32));

  const collection = await sc.getScatterCollection("nockmilio");
  check("S1 live collection", !!collection, collection && collection.name);
  if (!collection) return finish();

  const planned = await sm.planScatterMint({ slug: "nockmilio", collection, wallet, quantity: 1 });
  check("S2 plan built from the live API", !!planned.plan, planned.reason);
  if (!planned.plan) return finish();
  const plan = planned.plan;
  check("S3 plan wants an ERC20 approval", plan.erc20s.length === 1, `${plan.erc20s.length}`);

  allowanceMode = "zero";
  sendCount = 0;
  sent.length = 0;
  const r1 = await sm.executeScatterMint({
    plan, walletIndex: 0, rpcUrls: [url], chainId: collection.chainId,
    onMessage: () => {},
  });
  check("S4 mint succeeded", r1.status === "SUCCESS", `${r1.status} ${r1.error || ""}`);
  check("S5 two transactions sent (approval + mint)", sendCount === 2, `${sendCount}`);
  check("S6 approval hash reported", !!r1.approvalTxHash, String(r1.approvalTxHash));
  check("S7 receipt block present", !!r1.receipt?.block, String(r1.receipt?.block));

  allowanceMode = "enough";
  sendCount = 0;
  sent.length = 0;
  const r2 = await sm.executeScatterMint({
    plan, walletIndex: 0, rpcUrls: [url], chainId: collection.chainId,
    onMessage: () => {},
  });
  check("S8 sufficient allowance -> only the mint is sent", sendCount === 1, `${sendCount}`);
  check("S9 ...and no approval hash", !r2.approvalTxHash, String(r2.approvalTxHash));
  check("S10 still succeeds", r2.status === "SUCCESS", `${r2.status} ${r2.error || ""}`);

  finish();
}

function finish() {
  fs.writeFileSync(import.meta.dirname + "/scatter-send-out.txt", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n${lines.length - failed}/${lines.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
