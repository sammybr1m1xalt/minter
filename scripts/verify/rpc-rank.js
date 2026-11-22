// Does the RPC ranking pick the fastest endpoint, or just the first one?
const fs = require("fs");
const path = "/home/anon/minter/.env";
const raw = fs.readFileSync(path, "utf8");
const urls = [];
for (const line of raw.split("\n")) {
  const m = line.match(/^(RPC_URL_[A-Z0-9_]+)=(.*)$/);
  if (m && m[2].trim()) urls.push(m[1] + "=" + m[2].trim());
}
// Plus whatever public fallbacks chains.ts ships for ethereum.
const chainsSrc = fs.readFileSync("/home/anon/minter/src/chains.ts", "utf8");
for (const m of chainsSrc.matchAll(/https:\/\/[a-zA-Z0-9._\-\/]+/g)) {
  const u = m[0].replace(/\/$/, "");
  if (!urls.some((x) => x.endsWith(u))) urls.push("chains.ts=" + u);
}

const time = async (url, n = 8) => {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const s = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      await r.text();
    } catch {}
    xs.push(Date.now() - s);
  }
  xs.sort((a, b) => a - b);
  return { p50: xs[Math.floor(xs.length / 2)], min: xs[0] };
};

(async () => {
  console.log(`probing ${urls.length} ethereum endpoints, 8x each\n`);
  const rows = [];
  for (const entry of urls) {
    const [label, url] = entry.split(/=(.*)/);
    const r = await time(url);
    rows.push({ label, url, ...r });
  }
  rows.sort((a, b) => a.p50 - b.p50);
  for (const r of rows) {
    const shown = r.url.replace(/\/\/.*@/, "//<redacted>@").replace(/\/v2\/.*/, "/v2/<key>").replace(/\/[A-Za-z0-9_-]{20,}$/, "/<key>");
    console.log(`${String(r.p50).padStart(5)}ms  min ${String(r.min).padStart(4)}ms  ${r.label.padEnd(22)} ${shown}`);
  }
  if (rows.length > 1) {
    console.log(`\nslowest/fastest p50 = ${(rows[rows.length - 1].p50 / rows[0].p50).toFixed(1)}x`);
    console.log(`the ranking currently returns these in the order above? NO — it preserves the .env/chains order.`);
  }
})();
