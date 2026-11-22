// Serve a fixture page and run the real --scan CLI against it. Async spawn:
// spawnSync blocks the parent's event loop, so an in-process HTTP server could
// never answer the child's request.
const http = require("http");
const { spawn } = require("child_process");

const HTML = `<html><head><title>test drop</title></head><body>
<div data-contract-address="0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"></div>
<script>const cfg = {"contractAddress":"0xBC4CA0EdA7647A8aB7C2061c2E118a18a936f13D","chain":"ethereum"};</script>
<script>const noise = "0x0000000000000000000000000000000000000001";</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});

server.listen(8731, "127.0.0.1", () => {
  const child = spawn("node", ["/home/anon/minter/dist/index.js", "--scan", "http://127.0.0.1:8731/", "--no-bundles"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("close", (code) => {
    console.log(out);
    if (err) console.error(err);
    console.log("exit:", code);
    server.close();
    process.exit(0);
  });
});
