// --hot: window validation, distinct-minter ranking, labelled cost, RPC walking.
const H = require("/home/anon/minter/dist/hot-cli.js");

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

// ── parseHotArgs ────────────────────────────────────────────────────────────
const parsed = H.parseHotArgs([
  "--window", "5m,1h", "--chain", "ethereum,ink", "--top", "7", "--target", "3", "--new", "2", "--yes",
]);
ok("windows parsed", parsed.windows.join(",") === "5m,1h", parsed.windows.join(","));
ok("chains parsed", parsed.chains.join(",") === "ethereum,ink", parsed.chains.join(","));
ok("top parsed", parsed.top === 7, String(parsed.top));
ok("target parsed", parsed.target === 3, String(parsed.target));
ok("new parsed", parsed.newHours === 2, String(parsed.newHours));
ok("yes parsed", parsed.yes === true);

for (const w of ["6h", "12h"]) {
  let threw = false;
  try {
    H.parseHotArgs(["--window", w]);
  } catch (e) {
    threw = /not served|silently truncated/.test(e.message);
  }
  ok(`--window ${w} refused with a reason`, threw);
}
let badTarget = false;
try {
  H.parseHotArgs(["--target", "0"]);
} catch {
  badTarget = true;
}
ok("--target 0 refused", badTarget);
let badTop = false;
try {
  H.parseHotArgs(["--top", "0"]);
} catch {
  badTop = true;
}
ok("--top 0 refused", badTop);

// ── rankLogs: distinct minters, not event count ─────────────────────────────
const T721 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const m = (n) => "0x" + n.toString(16).padStart(64, "0");
const logs = [];
// A: 20 events, ONE minter (batch/airdrop shape)
for (let i = 0; i < 20; i++) {
  logs.push({ address: "0x" + "aa".repeat(20), topics: [T721, m(0), m(1), m(i)], blockNumber: 100, shape: "erc721" });
}
// B: 3 events, THREE minters
for (let i = 1; i <= 3; i++) {
  logs.push({ address: "0x" + "bb".repeat(20), topics: [T721, m(0), m(i), m(i)], blockNumber: 101, shape: "erc721" });
}
const ranked = H.rankLogs(logs);
ok("ranked by distinct minters, not event count", ranked[0].address === "0x" + "bb".repeat(20), ranked[0].address);
ok("minter count is distinct", ranked[0].minters.size === 3, String(ranked[0].minters.size));
ok("event count retained for display", ranked[1].mintEvents === 20, String(ranked[1].mintEvents));

// ── cost is labelled ────────────────────────────────────────────────────────
ok("unknown price stays unknown", H.formatCost(null, "ETH", false) === "unknown");
ok("authoritative zero is free", H.formatCost(0n, "ETH", true) === "free");
ok("authoritative price labelled", H.formatCost(10n ** 18n, "ETH", true) === "1.0 ETH", H.formatCost(10n ** 18n, "ETH", true));
const guess = H.formatCost(5n, "ETH", false, "mintPrice()");
ok("guessed getter is labelled", guess.includes("guess: mintPrice()") && guess.includes("ETH"), guess);

// ── pickReadableRpc walks the list ──────────────────────────────────────────
(async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = String(url).includes("good")
      ? { jsonrpc: "2.0", id: 1, result: "0x1" }
      : { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "dead" } };
    return { ok: true, json: async () => body };
  };
  try {
    const picked = await H.pickReadableRpc(["https://dead.example", "https://good.example"], 1);
    ok("skips the dead first RPC", picked === "https://good.example", String(picked));
    ok("probed both endpoints", seen.length === 2, String(seen.length));
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
