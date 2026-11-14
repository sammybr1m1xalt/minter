#!/usr/bin/env node
/**
 * Regression checks for the site scanner, run against saved fixtures.
 *
 * No test framework by design (the project has none): each case states an
 * expectation and the runner reports which ones failed. `npm run test:scanner`
 * builds first, so this always exercises current code rather than a stale dist.
 *
 * Two kinds of case:
 *   - pure: a fixture file through a pure function (scanHtml, extractChunkUrls,
 *     extractWebpackChunkUrls, extractApiPaths);
 *   - live: a local HTTP server standing in for a site, used to test behaviour
 *     that only exists across requests — notably that the API scan does not
 *     stop on the first endpoint that answers.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scanner = require("../dist/site-scanner.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures", "scanner");
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const GLOOMBLES = "0x64c32eb3a4b4c33dc6cf94e89a5542dd30c99b3a";

const results = [];
function record(r) {
  results.push(r);
}
function check(name, fn) {
  try {
    fn();
    record({ name, ok: true });
  } catch (e) {
    record({ name, ok: false, error: e?.message ?? String(e) });
  }
}
const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }), (e) => ({ name, ok: false, error: e?.message ?? String(e) }))
  );
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
const topOf = (html) => scanner.scanHtml(html).candidates[0]?.address ?? null;
const has = (list, value, label) =>
  assert(list.some((x) => x === value), `${label}: ${value} not found in ${JSON.stringify(list)}`);

// ── Pure cases ──────────────────────────────────────────────────────────────

check("openSea html: the collection ranks first", () => {
  const scan = scanner.scanHtml(read("opensea-collection.html"));
  eq(topOf(read("opensea-collection.html")), GLOOMBLES, "top candidate");
  // The frequency signal must be live: the collection appears far more than
  // once. This was dead code until extractAddressOccurrences was introduced —
  // extractAddresses dedupes, so every count used to be 1.
  const top = scan.candidates[0];
  assert(top.occurrences > 1, `expected >1 occurrence, got ${top.occurrences}`);
});

check("openSea api json: the collection ranks first", () => {
  eq(topOf(read("opensea-collection.json")), GLOOMBLES, "top candidate");
});

check("currency sentinels are excluded", () => {
  const html = read("currency-noise.html");
  const scan = scanner.scanHtml(html);
  eq(topOf(html), "0x1111111111111111111111111111111111111111", "top candidate");
  const addresses = scan.candidates.map((c) => c.address);
  assert(!addresses.includes("0x0000000000000000000000000000000000000000"), "zero address must be excluded");
  assert(!addresses.includes("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), "WETH must be excluded");
});

check("key strength: contractAddress > address > stageAddress", () => {
  const scan = scanner.scanHtml(read("ambiguous-address.json"));
  const order = scan.candidates.map((c) => c.address);
  eq(order[0], "0x4444444444444444444444444444444444444444", "strongest");
  assert(
    order.indexOf("0x3333333333333333333333333333333333333333") <
      order.indexOf("0x2222222222222222222222222222222222222222"),
    "ambiguous 'address' must outrank weak 'stageAddress'"
  );
});

check("depth penalty: collection beats nested items", () => {
  eq(topOf(read("depth.json")), "0x5555555555555555555555555555555555555555", "top candidate");
});

check("vite: literal chunk paths are resolved", () => {
  const urls = scanner.extractChunkUrls(read("vite-entry.js"), "https://example.com/assets/entry.js");
  has(urls, "https://example.com/assets/chunk-abc123.js", "import()");
  has(urls, "https://example.com/assets/lazy-456.js", "absolute import()");
  has(urls, "https://example.com/assets/worker-789.js", "new URL()");
  has(urls, "https://example.com/assets/preload-def456.js", "quoted literal");
});

check("webpack: numeric chunk ids resolve via the runtime", () => {
  // The two halves are in different files; neither resolves alone.
  const runtime = read("webpack-runtime.js");
  const main = read("webpack-main.js");
  eq(scanner.extractWebpackChunkUrls(runtime, "https://example.com/launchpad/").length, 0, "runtime alone");
  eq(scanner.extractWebpackChunkUrls(main, "https://example.com/launchpad/").length, 0, "entry alone");
  const urls = scanner.extractWebpackChunkUrls(runtime + "\n" + main, "https://example.com/launchpad/");
  has(urls, "https://example.com/launchpad/static/js/480.cbafb9bda5d60fbc91da.js", "chunk 480");
  has(urls, "https://example.com/launchpad/static/js/544.04bb7c999e666224c668.js", "chunk 544");
});

check("api paths: literals, templates and the denylist", () => {
  const js = read("api-paths.js");
  const paths = scanner.extractApiPaths(js, "https://example.com/");
  has(paths, "/api/campaigns/drops/:slug", "template prefix");
  has(paths, "/api/collections/gloombles", "plain literal");
  assert(!paths.includes("/assets/logo.svg"), "static asset must be denylisted");
  const expanded = scanner.expandApiPaths(paths, "https://example.com/launchpad/gloombles");
  has(expanded, "/api/campaigns/drops/gloombles", "slug substitution");
});

check("spa shell: an empty page reports empty, not a guess", () => {
  const scan = scanner.scanHtml(read("fungolabs.html"));
  eq(scan.totalFound, 0, "totalFound");
  assert(scan.empty, "scan must be marked empty");
});

check("api paths are mined from the html shell too", () => {
  const paths = scanner.extractApiPaths(
    read("html-api-paths.html"),
    "https://example.com/launchpad/drop-1"
  );
  has(paths, "/api/drops/1", "data-api attribute");
  has(paths, "/api/collections/2", "data-endpoint attribute");
  has(paths, "/api/mint", "form action");
});

check("cross-domain api urls are discovered", () => {
  const paths = scanner.extractApiPaths(
    'fetch("https://api.other.com/v1/drops"); fetch("//cdn.other.com/v2/nfts");',
    "https://site.com/"
  );
  has(paths, "https://api.other.com/v1/drops", "absolute url");
  has(paths, "//cdn.other.com/v2/nfts", "protocol-relative url");
  // An absolute URL must still sort as a known data endpoint, or it loses its
  // place in the queue to arbitrary routes.
  assert(
    scanner.isHighConfidenceApiPath("https://api.other.com/v1/drops"),
    "absolute url should rank as high-confidence"
  );
  // Absolute URLs are complete: expandApiPaths must not try to substitute a slug.
  const expanded = scanner.expandApiPaths(paths, "https://site.com/drop-1");
  has(expanded, "https://api.other.com/v1/drops", "absolute url survives expansion");
});

check("cross-origin code references are followed", () => {
  const urls = scanner.extractChunkUrls(
    read("cross-origin-entry.js"),
    "https://example.com/entry.js"
  );
  has(urls, "https://cdn.example.com/chunk-xyz.js", "cross-origin import()");
  has(urls, "https://cdn.example.com/worker-1.js", "cross-origin new URL()");
  has(urls, "https://example.com/assets/local-2.js", "same-origin quoted path");
});

check("base64 payloads are decoded", () => {
  const html = read("base64-payload.html");
  // Sanity: the fixture must not carry a plaintext address, or the case proves
  // nothing.
  assert(!/0x[a-fA-F0-9]{40}/.test(html), "fixture must not contain a plaintext address");
  eq(topOf(html), "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", "top candidate");
});

check("shared infrastructure is demoted, not hidden", () => {
  const scan = scanner.scanHtml(read("shared-infrastructure.json"));
  const collection = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const seaport = "0x00000000000000adc04c56bf30ac9d3c0aaf14dc";
  eq(topOf(read("shared-infrastructure.json")), collection, "top candidate");
  // Seaport is a real contract, so it stays on the list — demoted, not dropped.
  const demoted = scan.candidates.find((c) => c.address === seaport);
  assert(demoted, "Seaport must remain a candidate");
  assert(demoted.score < scan.candidates[0].score, "Seaport must not outrank the collection");
});

check("an address inside a payment-token list is a token", () => {
  const json = read("weak-parent.json");
  const scan = scanner.scanHtml(json);
  eq(topOf(json), "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "top candidate");
  const token = scan.candidates.find(
    (c) => c.address === "0x80cb147fd86dc6dee3eee7e4cee33d1397d98071"
  );
  assert(token, "the payment token must still be listed");
  // Its own key is the ambiguous "address"; without the enclosing-key check it
  // scored 11 and beat everything on the page.
  assert(token.score <= 2, `payment token should be scored as weak, got ${token.score}`);
});

// ── Live case: the API scan must not stop on the first answer ────────────────
//
// A shared contract (a marketplace, a payment router) answers on most mint
// pages. The scan used to stop at the first endpoint that returned ANY address,
// so the collection itself was never fetched and the shared contract was
// reported as the answer. This case pins the fix.

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SHARED = "0x9999999999999999999999999999999999999999";
const COLLECTION = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

checkAsync("api scan: does not stop on the first endpoint that answers", () =>
  withServer(
    (req, res) => {
      const send = (body, type = "application/json") => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      };
      if (req.url === "/page") {
        // The shell carries no addresses; the bundle references the endpoints.
        send(
          '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
          "text/html"
        );
      } else if (req.url === "/bundle.js") {
        // Eight decoys plus the real endpoint. The paths are sorted shortest
        // first, so `/api/collection` is LAST — and with six workers and nine
        // paths it is never reached once any decoy has answered.
        const decoys = Array.from({ length: 8 }, (_, i) => `fetch("/api/s${i}");`).join(" ");
        send(`${decoys} fetch("/api/collection");`, "text/javascript");
      } else if (req.url === "/api/collection") {
        // The only strong signal on the page: a dedicated contracts list.
        send(`{"contracts":[{"address":"${COLLECTION}"}]}`);
      } else if (/^\/api\/s\d$/.test(req.url)) {
        // A shared contract (marketplace, payment router) that answers on
        // every mint page. Under the old rule this is where the scan stopped.
        send(`{"address":"${SHARED}"}`);
      } else {
        res.writeHead(404).end();
      }
    },
    async (base) => {
      const result = await scanner.scanWithBundles(`${base}/page`, 10000, 8, 40);
      assert(result !== null, "scan must return a result");
      const top = result.candidates[0]?.address ?? null;
      eq(top, COLLECTION, "top candidate");
      // The real endpoint must have been tried. Stopping early would have left
      // it unfetched and the shared contract would have won.
      const tried = result.apiCalls.map((c) => c.url);
      assert(
        tried.some((u) => u.endsWith("/api/collection")),
        `collection endpoint was never fetched; tried ${JSON.stringify(tried)}`
      );
    }
  )
);

checkAsync("api scan: duplicate bodies are not counted twice", () =>
  withServer(
    (req, res) => {
      const send = (body, type = "application/json") => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      };
      if (req.url === "/page") {
        send('<html><body><script src="/bundle.js"></script></body></html>', "text/html");
      } else if (req.url === "/bundle.js") {
        send(
          'fetch("/api/a");fetch("/api/b");fetch("/api/c");fetch("/api/collection");',
          "text/javascript"
        );
      } else if (req.url === "/api/collection") {
        send(`{"contracts":[{"address":"${COLLECTION}"}]}`);
      } else if (/^\/api\/[abc]$/.test(req.url)) {
        // Three endpoints, one identical body.
        send(`{"address":"${SHARED}"}`);
      } else {
        res.writeHead(404).end();
      }
    },
    async (base) => {
      const result = await scanner.scanWithBundles(`${base}/page`, 10000, 8, 40);
      const shared = result.candidates.find((c) => c.address === SHARED);
      assert(shared, "shared contract must be a candidate");
      // Occurrence is the strongest signal in the ranking. Counting the same body
      // three times would let a shared contract outrank the collection.
      eq(shared.occurrences, 1, "occurrences for a triplicated body");
    }
  )
);

checkAsync("api scan: a mounted api is found when the page never links to it", () =>
  withServer(
    (req, res) => {
      const send = (body, type = "application/json") => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      };
      if (req.url === "/") {
        send('<html><body><script src="/bundle.js"></script></body></html>', "text/html");
      } else if (req.url === "/bundle.js") {
        send('fetch("/api/config");', "text/javascript");
      } else if (req.url === "/api/config") {
        // Answers, but carries no addresses — the shape a site has when its API
        // actually lives under a mount the page never references.
        send('{"chains":[{"id":1}]}');
      } else if (req.url === "/launchpad/api/config") {
        send(`{"contracts":[{"address":"${COLLECTION}"}]}`);
      } else {
        res.writeHead(404).end();
      }
    },
    async (base) => {
      const result = await scanner.scanWithBundles(`${base}/`, 10000, 8, 20);
      assert(result !== null, "scan must return a result");
      eq(result.candidates[0]?.address ?? null, COLLECTION, "top candidate");
      const tried = result.apiCalls.map((c) => c.url);
      assert(
        tried.some((u) => u.endsWith("/launchpad/api/config")),
        `mounted endpoint was never tried: ${JSON.stringify(tried)}`
      );
    }
  )
);

// ── Report ──────────────────────────────────────────────────────────────────

results.push(...(await Promise.all(asyncChecks)));

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok   ${r.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${r.name}\n         ${r.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
