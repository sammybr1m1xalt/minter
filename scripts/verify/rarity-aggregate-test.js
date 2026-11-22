// Aggregate-metadata fallback: a collection that publishes ONE metadata file
// instead of a directory of per-token files.
// Self-contained — serves its own fixtures on an ephemeral port.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("/home/anon/minter/dist/rarity.js");

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  }
};

function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split("?")[0]);
      const rel = (u.match(/^\/ipfs\/[^/]+\/(.*)$/) || [, ""])[1];
      const full = path.join(root, rel);
      if (u.endsWith("/") || rel === "") {
        try {
          const names = fs.readdirSync(full);
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<html><body>" +
              names.map((n) => `<a href="/ipfs/QmX/${n}">${n}</a>`).join("") +
              "</body></html>"
          );
        } catch {
          res.writeHead(404);
          res.end("no such directory");
        }
        return;
      }
      if (!fs.existsSync(full)) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(full));
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rarity-agg-"));
  const colors = ["Red", "Red", "Blue", "Green", "Green", "Green", "Green", "Blue", "Red", "Gold"];
  const tokens = colors.map((c, i) => ({
    tokenId: i + 1,
    name: `T${i + 1}`,
    attributes: [{ trait_type: "Color", value: c }],
  }));
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(tokens));
  fs.writeFileSync(
    path.join(dir, "hidden.json"),
    JSON.stringify([{ tokenId: 1, name: "Unrevealed", image: "ipfs://QmBlur" }])
  );

  const ph = fs.mkdtempSync(path.join(os.tmpdir(), "rarity-ph-"));
  fs.writeFileSync(
    path.join(ph, "hidden.json"),
    JSON.stringify([{ tokenId: 1, name: "Unrevealed", image: "ipfs://QmBlur" }])
  );

  const srv = await serve(dir, 0);
  const port = srv.address().port;
  const gw = `http://127.0.0.1:${port}/ipfs`;

  const crawl = await R.crawlTraits({
    cid: "QmX",
    gateways: [gw],
    limit: 0,
    useCache: false,
    timeoutMs: 20000,
  });
  ok("aggregate file is used", crawl.source === "aggregate", crawl.source);
  ok("aggregate file is named", crawl.aggregateFile === "metadata.json", String(crawl.aggregateFile));
  ok("all aggregate tokens are read", crawl.tokens.length === 10, `${crawl.tokens.length}`);
  ok("non-numeric entries are reported as skipped", crawl.skipped === 2, `${crawl.skipped}`);

  const rep = R.computeRarity(crawl.tokens);
  ok("all tokens scored", rep.scored === 10, `${rep.scored}`);
  ok("rarest token ranks first", rep.rows[0].tokenId === 10, `#${rep.rows[0].tokenId}`);
  ok("rarest score beats the common one", rep.rows[0].score > rep.rows[1].score, `${rep.rows[0].score} > ${rep.rows[1].score}`);
  ok("Gold is 10% of the scored set", rep.frequencies.Color.Gold.pct === 10, `${rep.frequencies.Color.Gold.pct}%`);

  // Keyed-by-id object shape.
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ 1: { attributes: [{ trait_type: "Color", value: "Red" }] }, 2: { attributes: [{ trait_type: "Color", value: "Blue" }] } })
  );
  const keyed = await R.crawlTraits({ cid: "QmY", gateways: [gw], limit: 0, useCache: false, timeoutMs: 20000 });
  ok("object-keyed-by-id shape is read", keyed.source === "aggregate" && keyed.tokens.length === 2, `${keyed.tokens.length}`);

  // A directory with only a placeholder must be refused, not scored as trait-less.
  const srv2 = await serve(ph, 0);
  const gw2 = `http://127.0.0.1:${srv2.address().port}/ipfs`;
  const refused = await R.readAggregateMapping("QmZ", [gw2], 10000);
  ok("placeholder-only is refused", refused === null);
  const phCrawl = await R.crawlTraits({ cid: "QmZ", gateways: [gw2], limit: 0, useCache: false, timeoutMs: 20000 });
  ok("placeholder-only scores nothing", phCrawl.tokens.length === 0 && phCrawl.source === "directory", `${phCrawl.tokens.length} token(s)`);

  srv.close();
  srv2.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(ph, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("THREW:", e?.message || e);
  process.exit(1);
});
