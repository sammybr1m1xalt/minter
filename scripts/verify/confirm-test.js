// Verify sweepOnChain + recheckUnknownMints against a fake RPC.
const http = require("http");

const A = "0x" + "aa".repeat(32); // success
const B = "0x" + "bb".repeat(32); // reverted
const C = "0x" + "cc".repeat(32); // not found
const D = "0x" + "dd".repeat(32); // endpoint hangs -> TIMEOUT
const E = "0x" + "ee".repeat(32); // pending

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = JSON.parse(body);
    const hash = Array.isArray(r.params) && r.params[0] ? String(r.params[0]).toLowerCase() : "";
    const send = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    if (hash === D) return; // blackhole: never answer
    if (r.method === "eth_getTransactionReceipt") {
      if (hash === A) return send({ blockNumber: "0x2a", transactionIndex: "0x3", gasUsed: "0x5208", status: "0x1", effectiveGasPrice: "0x3b9aca00" });
      if (hash === B) return send({ blockNumber: "0x2a", transactionIndex: "0x4", gasUsed: "0x6000", status: "0x0", effectiveGasPrice: "0x3b9aca00" });
      return send(null);
    }
    if (r.method === "eth_getTransactionByHash") {
      if (hash === E) return send({ blockNumber: null });
      return send(null);
    }
    send(null);
  });
});

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { sweepOnChain, summarizeOnChain } = require("/home/anon/minter/dist/rpc-health.js");
  const { recheckUnknownMints } = require("/home/anon/minter/dist/wizard-fcfs-new.js");

  const txs = [A, B, C, D, E].map((txHash) => ({ address: "0xw" + txHash.slice(2, 6), txHash, dispatchedAt: Date.now() - 5000 }));
  const t0 = Date.now();
  const confirmed = await sweepOnChain(txs, [url], 20000);
  const out = confirmed.map((c) => ({ hash: c.txHash.slice(0, 6), status: c.status, detail: c.detail ?? null, block: c.block }));
  console.log("sweep ms:", Date.now() - t0);
  console.log(JSON.stringify(out, null, 1));
  console.log(summarizeOnChain(confirmed));

  // recheckUnknownMints: A and B were UNKNOWN, must be upgraded.
  const results = [
    { walletIndex: 0, walletAddress: "0xaaaa000000000000000000000000000000000001", success: false, status: "UNKNOWN", txHash: A, dispatchedAt: Date.now() - 5000 },
    { walletIndex: 1, walletAddress: "0xbbbb000000000000000000000000000000000002", success: false, status: "UNKNOWN", txHash: B, dispatchedAt: Date.now() - 5000 },
    { walletIndex: 2, walletAddress: "0xcccc000000000000000000000000000000000003", success: true, status: "SUCCESS", txHash: "0x" + "11".repeat(32), dispatchedAt: Date.now() - 5000 },
    { walletIndex: 3, walletAddress: "0xdddd000000000000000000000000000000000004", success: false, status: "UNKNOWN", txHash: D },
  ];
  await recheckUnknownMints(results, [url], 20000);
  console.log("\nafter recheck:", results.map((r) => `${r.walletAddress.slice(0, 6)}=${r.status}${r.success ? " (success)" : ""}`).join("  "));

  const ok =
    confirmed.find((c) => c.txHash === A)?.status === "SUCCESS" &&
    confirmed.find((c) => c.txHash === B)?.status === "REVERTED" &&
    confirmed.find((c) => c.txHash === C)?.status === "NOT_FOUND" &&
    confirmed.find((c) => c.txHash === E)?.status === "PENDING" &&
    confirmed.find((c) => c.txHash === D)?.status === "TIMEOUT" &&
    results[0].status === "SUCCESS" && results[0].success === true &&
    results[1].status === "REVERTED" && results[1].success === false &&
    results[2].status === "SUCCESS" && // untouched
    results[3].status === "UNKNOWN"; // a timeout is not a verdict, stays unknown
  console.log("\nASSERT:", ok ? "PASS" : "FAIL");
  server.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS FAIL", e); process.exit(1); });
