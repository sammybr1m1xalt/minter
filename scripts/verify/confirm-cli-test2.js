// End-to-end test of `node dist/index.js --confirm <hash>` against a fake RPC.
//
// The child is spawned ASYNC on purpose: a fake server living in this process
// cannot answer while spawnSync blocks the event loop, and the child then
// reports NOT_FOUND for transactions the fake would have confirmed.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);

let fakeHits = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = JSON.parse(body);
    const hash = String((r.params || [])[0] || "").toLowerCase();
    fakeHits++;
    const send = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    if (r.method === "eth_getTransactionReceipt") {
      if (hash === HASH_A) {
        return send({ blockNumber: "0x2a", transactionIndex: "0x3", gasUsed: "0x5208", status: "0x1", effectiveGasPrice: "0x3b9aca00" });
      }
      if (hash === HASH_B) {
        return send({ blockNumber: "0x2a", transactionIndex: "0x4", gasUsed: "0x6000", status: "0x0", effectiveGasPrice: "0x3b9aca00" });
      }
      return send(null);
    }
    return send(null);
  });
});

function run(args, port) {
  return new Promise((resolve) => {
    const child = spawn("node", ["/home/anon/minter/dist/index.js"].concat(args), {
      cwd: __dirname + "/envtest",
      env: Object.assign({}, process.env, { RPC_URL_ETHEREUM: "http://127.0.0.1:" + port }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const cwd = __dirname + "/envtest";
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, ".env"), "CHAIN=ethereum\nRPC_URL_ETHEREUM=http://127.0.0.1:" + port + "\n");

  const r1 = await run(["--confirm", HASH_A, HASH_B], port);
  console.log("=== --confirm <two hashes>: exit " + r1.code + ", fake answers " + fakeHits);
  console.log(r1.stdout.split("\n").filter((l) => l.indexOf("block") >= 0 || l.indexOf("SUCCESS:") >= 0).join("\n"));

  const r2 = await run(["--confirm", "--last"], port);
  console.log("\n=== --confirm --last: exit " + r2.code + " (no tx hashes in the logs is expected)");
  console.log((r2.stdout + r2.stderr).trim().split("\n").slice(0, 2).join("\n"));

  const r3 = await run(["--confirm", "0x1234"], port);
  console.log("\n=== bad hash: exit " + r3.code);
  console.log((r3.stderr + r3.stdout).trim().split("\n").slice(0, 2).join("\n"));

  const ok = r1.code === 0
    && r1.stdout.indexOf("block") >= 0
    && r1.stdout.indexOf("REVERTED") >= 0
    && r1.stdout.indexOf("SUCCESS: 1") >= 0
    && r3.code === 1;
  console.log("\nASSERT: " + (ok ? "PASS" : "FAIL"));
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
