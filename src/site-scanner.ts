// ── Site scanner: extract candidate contract addresses from a web page ──────
//
// Given the HTML of any mint page, produce a ranked list of candidate contract
// addresses. This is the first stage of the scan → verify → mint pipeline.
//
// Design constraints, learned from the OpenSea scrape (slug-resolver.ts):
//
//   1. A page contains MANY 40-hex strings — OpenSea collection pages carry
//      ~154 (WETH, USDC, staked tokens, other collections). Returning the first
//      one is luck, not design. We return all of them, ranked.
//
//   2. The address is often NOT in the visible HTML. React/Next apps embed it
//      in a JSON payload inside a <script> tag, or fetch it after hydration.
//      We scan both the raw HTML and the script bodies.
//
//   3. A plain fetch cannot execute JavaScript. Addresses loaded by a
//      client-side API call after page load are simply not visible to us. We
//      report what we found and say so — we do not guess.
//
// This module is pure: no network, no chain calls. Verification happens in
// contract-verify.ts, which is the gate that makes these candidates trustworthy.

// ── Types ───────────────────────────────────────────────────────────────────

export interface AddressCandidate {
  address: string;
  /** 0–100. Higher = more likely to be the collection contract. */
  score: number;
  /** Where it was found — surfaced in the UI so the user can judge. */
  source: "json-key" | "contracts-block" | "script-blob" | "html-text" | "mint-button";
  /** The JSON key it appeared under, when known (e.g. "contractAddress"). */
  key?: string;
  /** How many times it appeared on the page. */
  occurrences: number;
}

export interface ScanResult {
  candidates: AddressCandidate[];
  /** Total distinct addresses found, before ranking. */
  totalFound: number;
  /** True when the page yielded nothing — the caller should say so. */
  empty: boolean;
}

// ── Extraction ──────────────────────────────────────────────────────────────

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;

/** Keys that strongly suggest the value is a collection contract. */
const STRONG_KEYS = [
  "contractaddress",
  "nftcontract",
  "nftcontractaddress",
  "collectionaddress",
  "contract",
  "collection",
];

/**
 * Keys that are ambiguous: "address" is used both for the collection AND for
 * stage/payment/allowlist contracts. It earns a moderate score, not a strong
 * one — otherwise a drop's stage address outranks its own collection.
 *
 * It is still worth more than an unknown key, because a page that labels a
 * value plainly "address" usually means THE address of the thing being viewed.
 */
const AMBIGUOUS_KEYS = ["address"];

/** Keys that suggest the value is NOT the collection we want. */
const WEAK_KEYS = [
  "feerecipient",
  "payoutaddress",
  "creator",
  "owner",
  "tokenaddress",
  "currency",
  "paymenttoken",
  "royaltypayout",
  "factory",
  "passsigner",
  "underlying",
  "stageaddress",
  "stageaddresses",
];

export function extractAddresses(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(ADDR_RE)) {
    found.add(m[0]);
  }
  return [...found];
}

/** Pull out the bodies of every <script> tag. */
export function scriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1];
    // Skip obviously empty or pure-src scripts.
    if (body && body.trim().length > 0) bodies.push(body);
  }
  return bodies;
}

/** Find addresses that appear under a recognisable JSON key. */
function extractKeyedAddresses(
  text: string
): { address: string; key: string }[] {
  const out: { address: string; key: string }[] = [];
  // "key":"0x…" — the shape used by virtually every embedded JSON payload.
  const re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g;
  for (const m of text.matchAll(re)) {
    out.push({ address: m[2], key: m[1] });
  }
  return out;
}

/**
 * Find addresses that appear under a recognisable JSON key, tagged with the
 * nesting depth of the object that holds them.
 *
 * Depth matters: an OpenSea collection page embeds ITEM payloads alongside the
 * COLLECTION payload. An item's "contractAddress" is a different token on the
 * same collection — scoring it as strongly as the collection's own "address"
 * field ranks the wrong contract first. The collection-level object is shallower
 * than the item objects nested inside it.
 *
 * Single pass: the depth is tracked as we walk the text, so an 868KB page does
 * not become O(n²).
 */
function extractKeyedAddressesWithDepth(
  text: string
): { address: string; key: string; depth: number }[] {
  const out: { address: string; key: string; depth: number }[] = [];
  const re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g;

  let depth = 0;
  let cursor = 0;
  for (const m of text.matchAll(re)) {
    // Walk from the last match to this one, counting braces.
    for (let i = cursor; i < m.index; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    cursor = m.index;
    out.push({ address: m[2], key: m[1], depth: Math.max(0, depth) });
  }
  return out;
}

/** Find addresses inside a "contracts":[…] block. */
function extractContractsBlockAddresses(text: string): string[] {
  const out: string[] = [];
  const re = /"contracts"\s*:\s*\[([^\]]{0,4000})\]/g;
  for (const m of text.matchAll(re)) {
    for (const a of m[1].matchAll(ADDR_RE)) out.push(a[0]);
  }
  return out;
}

/** Find addresses referenced by a mint-style button or link. */
function extractMintButtonAddresses(html: string): string[] {
  const out: string[] = [];
  const re = /(?:data-[a-z-]*address|data-contract|href)\s*=\s*"(0x[a-fA-F0-9]{40})"/gi;
  for (const m of html.matchAll(re)) out.push(m[1]);
  return out;
}

// ── Ranking ─────────────────────────────────────────────────────────────────

/**
 * The address marketplaces use to identify a chain's native currency when that
 * currency has no contract of its own (ETH on Ethereum, Base, Soneium, …).
 */
const NATIVE_IDENTIFIER = "0x0000000000000000000000000000000000000000";

/**
 * Arc's gas token is USDC, which DOES have a contract — so Arc is the one
 * supported chain where the native currency has an address of its own.
 */
const AR_USDC = "0x3600000000000000000000000000000000000000";

/**
 * Native-token sentinel per supported chain.
 *
 * These are the addresses a marketplace or launch platform uses to mean "this
 * chain's currency". They repeat across a page's payloads under a plain
 * "address" key, so they outscore the real collection unless excluded — but
 * they are never a collection contract.
 *
 * Curated against OpenSea on 2026-11-10 (`GET /api/v2/chain/{chain}/token/{addr}`
 * and each collection's `pricing_currencies`). Two findings worth recording:
 *
 *  - The zero address is the native-token IDENTIFIER on every EVM chain OpenSea
 *    supports — verified against all 28 chains it lists. It is not
 *    Ethereum-specific, and it is not the same thing as the native token's
 *    contract.
 *  - Arc is the exception to "the native token has no contract": its gas token
 *    is USDC at 0x3600…0000, so both the identifier and the contract apply.
 *
 * `robinhood` carries the identifier only: OpenSea prices its collections in
 * USDG, and the chain's native ETH has no contract of its own (Robinhood Chain
 * is an Arbitrum Orbit chain). Its wrapped native is recorded separately below.
 */
export const NATIVE_TOKEN_SENTINELS: Readonly<Record<string, readonly string[]>> = {
  // Chains the tool can serve (src/chains.ts).
  ethereum: [NATIVE_IDENTIFIER],
  base: [NATIVE_IDENTIFIER],
  robinhood: [NATIVE_IDENTIFIER],
  arc: [NATIVE_IDENTIFIER, AR_USDC],
  soneium: [NATIVE_IDENTIFIER],
  // Chains the tool can target but not serve (src/chains.ts OS_CHAIN).
  polygon: [NATIVE_IDENTIFIER],
  arbitrum: [NATIVE_IDENTIFIER],
  optimism: [NATIVE_IDENTIFIER],
  "zora-network": [NATIVE_IDENTIFIER],
  avalanche: [NATIVE_IDENTIFIER],
};

/**
 * Wrapped-native token per supported chain.
 *
 * A different currency address that is likewise never a collection contract and
 * likewise repeated across payloads. This set previously held 0x4200…0006 under
 * the WRONG label — "Base native token placeholder". It is WETH ("Wrapped
 * Ethereum", confirmed on Base and Soneium), which is not the native token at
 * all. Recorded here as what it actually is.
 */
export const WRAPPED_NATIVE_TOKENS: Readonly<Record<string, readonly string[]>> = {
  ethereum: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  base: ["0x4200000000000000000000000000000000000006"],
  robinhood: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73"], // L2 Weth (aeWETH)
  soneium: ["0x4200000000000000000000000000000000000006"],
  polygon: ["0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"],
  arbitrum: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1"],
  optimism: ["0x4200000000000000000000000000000000000006"],
  "zora-network": ["0x4200000000000000000000000000000000000006"],
  avalanche: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"],
};

function flattenSentinels(groups: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const list of Object.values(groups)) out.push(...list);
  return out;
}

/**
 * Every known currency sentinel, flattened. The default exclusion set for
 * callers that do not know which chain they are looking at.
 */
export const CURRENCY_SENTINELS: ReadonlySet<string> = new Set([
  ...flattenSentinels(NATIVE_TOKEN_SENTINELS),
  ...flattenSentinels(WRAPPED_NATIVE_TOKENS),
]);

/**
 * Rank candidates by evidence. The ordering reflects how trustworthy each
 * signal is:
 *
 *   mint-button attribute  → the page itself links this address to minting
 *   strong JSON key        → "contractAddress" is unambiguous
 *   contracts block        → a dedicated contracts list
 *   repeated occurrence    → the collection address usually appears many times
 *   script blob            → embedded config, better than visible text
 *   bare html text         → weakest; could be anything
 *
 * Deductions apply for known-bad keys (fee recipient, payout, currency).
 */
export function rankCandidates(
  keyed: { address: string; key: string }[],
  contractsBlock: string[],
  scriptHits: string[],
  buttonHits: string[],
  allAddresses: string[],
  /** Optional per-address nesting depth, from extractKeyedAddressesWithDepth. */
  depths?: Map<string, number>,
  /**
   * Currency sentinels to exclude. Defaults to CURRENCY_SENTINELS — every
   * supported chain's native and wrapped-native token. Pass a chain-specific
   * set when the caller knows the network.
   */
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS
): AddressCandidate[] {
  const occurrences = new Map<string, number>();
  for (const a of allAddresses) {
    occurrences.set(a, (occurrences.get(a) ?? 0) + 1);
  }

  const score = new Map<string, number>();
  const source = new Map<string, AddressCandidate["source"]>();
  const keyName = new Map<string, string>();

  const bump = (addr: string, pts: number, src: AddressCandidate["source"], key?: string) => {
    const a = addr.toLowerCase();
    score.set(a, (score.get(a) ?? 0) + pts);
    // Keep the strongest source we have seen for this address.
    if (!source.has(a)) source.set(a, src);
    if (key) keyName.set(a, key);
  };

  // Addresses that are never a collection contract. Two independent rules:
  //   1. an all-zero address is not a contract on ANY chain;
  //   2. a native-token sentinel (see NATIVE_TOKEN_SENTINELS) is a per-chain
  //      convention meaning "this chain's currency", never a contract.
  // Both repeat across marketplace payloads under a plain "address" key and so
  // outscore the real collection unless they are excluded.
  const isPlaceholder = (addr: string): boolean => {
    const a = addr.toLowerCase();
    if (/^0x0+$/.test(a)) return true;
    return currencySentinels.has(a);
  };

  // Dedupe keyed hits by (address, key). The same address appears under the
  // same key many times on a real page (OpenSea: 161 occurrences of one
  // address), and scoring each hit separately would multiply the bonus by the
  // occurrence count — a frequency signal would masquerade as a key signal.
  const keyedSeen = new Set<string>();
  const keyedDeduped: { address: string; key: string }[] = [];
  for (const k of keyed) {
    const id = k.address.toLowerCase() + "|" + k.key.toLowerCase();
    if (keyedSeen.has(id)) continue;
    keyedSeen.add(id);
    keyedDeduped.push(k);
  }

  for (const { address, key } of keyedDeduped) {
    const lowerKey = key.toLowerCase();
    // Nesting depth is a tiebreaker: a shallower object is closer to the page's
    // top-level payload, which describes the thing being viewed. An item nested
    // inside a collection page is deeper than the collection itself.
    const depth = depths?.get(address.toLowerCase()) ?? 0;
    const depthPenalty = Math.min(depth, 10);

    if (WEAK_KEYS.includes(lowerKey)) {
      bump(address, 2, "json-key", key);
    } else if (STRONG_KEYS.includes(lowerKey)) {
      bump(address, Math.max(5, 40 - depthPenalty), "json-key", key);
    } else if (AMBIGUOUS_KEYS.includes(lowerKey)) {
      // "address" is used for collections AND for stage/payment contracts.
      // Scoring it as strong lets a stage address outrank the collection.
      bump(address, Math.max(5, 12 - Math.floor(depthPenalty / 2)), "json-key", key);
    } else {
      bump(address, Math.max(5, 15 - Math.floor(depthPenalty / 2)), "json-key", key);
    }
  }

  // Same dedupe for the contracts block — an address listed twice in a
  // contracts array is one signal, not two.
  const contractsSeen = new Set<string>();
  for (const a of contractsBlock) {
    const lower = a.toLowerCase();
    if (contractsSeen.has(lower)) continue;
    contractsSeen.add(lower);
    bump(a, 30, "contracts-block");
  }

  const buttonSeen = new Set<string>();
  for (const a of buttonHits) {
    const lower = a.toLowerCase();
    if (buttonSeen.has(lower)) continue;
    buttonSeen.add(lower);
    bump(a, 50, "mint-button");
  }

  const scriptSeen = new Set<string>();
  for (const a of scriptHits) {
    const lower = a.toLowerCase();
    if (scriptSeen.has(lower)) continue;
    scriptSeen.add(lower);
    bump(a, 10, "script-blob");
  }

  // Repeated occurrence is a real signal, and on real pages it is the strongest
  // one: the collection address appears dozens of times, while stage and
  // payment addresses appear once or twice. Capped so a page that repeats one
  // address hundreds of times cannot run away with the ranking.
  for (const [addr, count] of occurrences) {
    if (count > 1) bump(addr, Math.min(count, 20), source.get(addr) ?? "html-text");
  }

  const out: AddressCandidate[] = [];
  for (const [addr, pts] of score) {
    if (isPlaceholder(addr)) continue;
    out.push({
      address: addr,
      score: pts,
      source: source.get(addr) ?? "html-text",
      key: keyName.get(addr),
      occurrences: occurrences.get(addr) ?? 1,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Scan a page and return ranked candidate addresses.
 *
 * Pure function — the caller fetches the HTML. Keeping this separate from the
 * network means it can be tested against saved fixtures.
 *
 * `currencySentinels` defaults to CURRENCY_SENTINELS; pass a chain-specific
 * set when the caller knows the network, or an empty set to disable the
 * exclusion entirely.
 */
export function scanHtml(
  html: string,
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS
): ScanResult {
  const all = extractAddresses(html);
  if (all.length === 0) {
    return { candidates: [], totalFound: 0, empty: true };
  }

  const keyedWithDepth = extractKeyedAddressesWithDepth(html);
  const keyed = keyedWithDepth.map(({ address, key }) => ({ address, key }));
  const depths = new Map<string, number>();
  for (const k of keyedWithDepth) {
    const a = k.address.toLowerCase();
    // Keep the SHALLOWEST depth seen for each address — an address that
    // appears both at collection level and inside an item should be scored as
    // the collection-level hit.
    const prev = depths.get(a);
    if (prev === undefined || k.depth < prev) depths.set(a, k.depth);
  }
  const contractsBlock = extractContractsBlockAddresses(html);
  const buttons = extractMintButtonAddresses(html);

  const scripts = scriptBodies(html);
  const scriptHits = new Set<string>();
  for (const body of scripts) {
    for (const a of extractAddresses(body)) scriptHits.add(a);
  }

  const candidates = rankCandidates(
    keyed,
    contractsBlock,
    [...scriptHits],
    buttons,
    all,
    depths,
    currencySentinels
  );

  return { candidates, totalFound: all.length, empty: candidates.length === 0 };
}

// ── JS bundle following ─────────────────────────────────────────────────────
//
// A client-rendered app (Vite/Next/CRA) ships a shell HTML page with an empty
// #root and loads its data from a JSON API. The address is in neither the HTML
// nor the visible text — it is behind an API call the page makes after load.
//
// The bundle contains that API path as a plain string. So we read the bundle,
// extract the paths, and call them. This is what makes fungolabs.org work: the
// shell has zero addresses, but the bundle references `/api/campaigns/drops/…`
// and that endpoint returns the contract.
//
// We do NOT execute JavaScript. We read the bundle as text and follow the
// strings — which is enough for the common case where the API path is a literal.

/**
 * Prefixes that mark a path as a data endpoint with high confidence.
 *
 * These are tried FIRST, but they are not the only thing looked for: a site
 * whose endpoints live under an unusual prefix is still covered by the general
 * pass below. The scanner is not specific to any one platform.
 */
const API_PREFIXES = [
  "/api/",
  "/v1/",
  "/v2/",
  "/graphql",
  "/public/",
  "/mint/",
  "/drops/",
  "/campaigns/",
  "/collections/",
  "/nfts/",
];

/**
 * Paths that are never a data endpoint: static assets and site chrome.
 *
 * This is a DENYLIST, not an allowlist — a denylist is what lets the scanner
 * work on a site nobody has categorised. The cost of a wrong entry here is one
 * extra HTTP call; the cost of a wrong allowlist entry is a site that can never
 * be scanned at all.
 */
const NON_DATA_PATH: RegExp[] = [
  // Static assets by extension.
  /\.(m?js|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|map|json|txt|xml|pdf|mp4|webm|wasm)$/i,
  // Static asset directories.
  /^\/(assets?|static|images?|img|fonts?|media|css|js|dist|build)\//i,
  // Framework internals that never carry app data.
  /^\/_next\/(static\/css|image|media)/i,
  // Site chrome — pages that exist on every site and hold no contract.
  /^\/(about|faq|help|support|contact|terms|tos|privacy|legal|login|log-in|signin|sign-in|signup|sign-up|register|account|profile|settings|search|cart|checkout|blog|news|docs?|careers|press|favicon)/i,
];

export function isHighConfidenceApiPath(p: string): boolean {
  return API_PREFIXES.some((pre) => p.startsWith(pre));
}

/** Extract candidate data-endpoint paths referenced in a JS bundle. */
export function extractApiPaths(js: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const keep = (p: string): boolean =>
    p.length >= 3 && !NON_DATA_PATH.some((re) => re.test(p));

  // "/api/..." — absolute path from the app root.
  for (const m of js.matchAll(/["'`](\/[a-zA-Z][a-zA-Z0-9_\-\/]{2,60})["'`]/g)) {
    if (keep(m[1])) out.add(m[1]);
  }
  // Template literals: `/api/campaigns/drops/${...}`. The regex above stops at
  // the `$`, so the captured path is the literal prefix — which is exactly what
  // we want. Record it with a marker so expandApiPaths knows to substitute.
  // The prefix may end with a "/" before the "${" — strip it so substitution
  // does not produce a double slash.
  for (const m of js.matchAll(/[`"'](\/[a-zA-Z0-9_\-\/]{2,50}\/?)\$\{[^}]+\}[`"']/g)) {
    const base = m[1].replace(/\/$/, "");
    if (keep(base)) out.add(base + "/:slug");
  }
  return [...out];
}

/**
 * Expand templated API paths into concrete candidates.
 *
 * Bundles build paths with template literals: `/api/campaigns/drops/${slug}`.
 * The literal prefix is the useful part — the variable part is usually a slug
 * the page already knows.
 *
 * This is generic: it substitutes whatever slug the page URL carries, and tries
 * every suffix of the path. A bundle's route naming does not have to match the
 * server's — the same endpoint is often reachable at several depths — so we
 * enumerate the possibilities rather than guessing one.
 */
export function expandApiPaths(
  paths: string[],
  pageUrl: string
): string[] {
  const out = new Set<string>();
  // The last path segment of the page URL is the most likely slug.
  let pageSlug: string | null = null;
  try {
    const segs = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      const last = segs[segs.length - 1];
      if (/^[a-zA-Z0-9._-]+$/.test(last)) pageSlug = last;
    }
  } catch {
    // Malformed URL — no slug substitution.
  }

  for (const p of paths) {
    out.add(p);
    if (!pageSlug) continue;

    const segs = p.split("/").filter(Boolean);
    const last = segs[segs.length - 1];
    const isPlaceholder =
      last === ":slug" || last === "[slug]" || last === "{" || last.includes("$");

    if (!isPlaceholder) continue;
    segs[segs.length - 1] = pageSlug;

    // Try the full path and every suffix of it. A bundle may name a resource
    // differently from the route that serves it, and the same data is often
    // reachable at more than one depth. Enumerating suffixes costs one extra
    // HTTP call each and removes the need to know the server's routing.
    for (let i = 0; i < segs.length; i++) {
      out.add("/" + segs.slice(i).join("/"));
    }
  }
  return [...out];
}

/**
 * Derive the app root from a page URL.
 *
 * A bundle's `/api/...` strings resolve against the app root, which is not
 * necessarily the site root. A site may serve its app from a subpath
 * (/launchpad/, /app/, /mint/), so `/api/drops/x` must be re-anchored to
 * `<appRoot>/api/drops/x`.
 *
 * Heuristic: the first path segment is the app mount when it is a bare word
 * (not a file, not a common file-extension). This is deliberately broad — a
 * wrong guess costs one extra HTTP call, while a missed mount means the API is
 * never found at all.
 */
function deriveAppRoot(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const first = segments[0];
    if (/^[a-z0-9_\-]+$/i.test(first) && !/\.[a-z0-9]+$/i.test(first)) {
      return `/${first}/`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract <script src> and modulepreload href URLs from a shell page. */
export function extractScriptUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const base = new URL(baseUrl);
  const re = /<(?:script[^>]*src|link[^>]*href)\s*=\s*"([^"]+)"/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1];
    try {
      const u = new URL(raw, base);
      // Only same-origin JS.
      if (u.origin !== base.origin) continue;
      if (!/\.m?js$/i.test(u.pathname)) continue;
      out.add(u.toString());
    } catch {
      // Malformed URL — skip.
    }
  }
  return [...out];
}

export interface BundleScanResult {
  candidates: AddressCandidate[];
  /** API endpoints that were tried, with the outcome. */
  apiCalls: { url: string; ok: boolean; addressesFound: number }[];
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 *
 * The scanner's work is fan-out (bundles, API paths), and the fan-out is the
 * whole cost: eight bundles serially at a 15s timeout each is two minutes of
 * waiting for work that is completely independent.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Extract JS chunk references from a bundle.
 *
 * A Vite/Next/webpack app ships an entry bundle that loads the rest lazily, and
 * the mint data is often behind a chunk the entry never mentions in the HTML.
 * Following `<script src>` alone therefore misses exactly the pages that need
 * the scanner most.
 *
 * Only string-literal references are resolved — `import("./chunk-x.js")`,
 * `new URL("./x.js", import.meta.url)`, and quoted paths ending in .js/.mjs.
 * Webpack's numeric chunk ids (`__webpack_require__.e("chunk-3")`) cannot be
 * resolved without the runtime's filename template, so they are skipped rather
 * than guessed.
 */
export function extractChunkUrls(js: string, bundleUrl: string): string[] {
  const out = new Set<string>();
  const base = new URL(bundleUrl);
  const patterns = [
    // import("./chunk-x.js") / import("/abs/chunk.js")
    /import\s*\(\s*["']([^"']+\.m?js)["']\s*\)/g,
    // new URL("./chunk-x.js", import.meta.url)
    /new\s+URL\s*\(\s*["']([^"']+\.m?js)["']/g,
    // Quoted path literals: "/_next/static/chunks/x.js", "/assets/index-abc.js"
    /["']((?:\.{0,2}\/|\/)[a-zA-Z0-9_\-\/.]+\.m?js)["']/g,
  ];
  for (const re of patterns) {
    for (const m of js.matchAll(re)) {
      try {
        const u = new URL(m[1], base);
        // Same-origin only: a CDN bundle is a different host with its own rules.
        if (u.origin !== base.origin) continue;
        // Skip the bundle we are already reading.
        if (u.toString() === base.toString()) continue;
        out.add(u.toString());
      } catch {
        // Malformed reference — skip.
      }
    }
  }
  return [...out];
}

/**
 * Fetch a page's bundles breadth-first, following chunk references.
 *
 * Returns the concatenated bundle text, or "" when nothing could be read. A
 * bundle that fails is skipped, not fatal: the next one may carry the data.
 */
async function fetchBundlesBfs(
  entryUrls: string[],
  deadline: number,
  maxBundles: number
): Promise<string> {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const seen = new Set<string>();
  const queue = [...entryUrls];
  const chunks: string[] = [];

  while (queue.length > 0 && seen.size < maxBundles) {
    const batch = queue.splice(0, Math.min(4, maxBundles - seen.size));
    const texts = await mapLimit(batch, 4, async (u) => {
      if (seen.has(u)) return "";
      seen.add(u);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "";
      try {
        const r = await fetch(u, {
          headers: { "user-agent": userAgent },
          signal: AbortSignal.timeout(Math.max(500, remaining)),
        });
        return r.ok ? await r.text() : "";
      } catch {
        return "";
      }
    });
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!text) continue;
      chunks.push(text);
      // Chunk references are resolved against the bundle they appear in.
      for (const ref of extractChunkUrls(text, batch[i])) queue.push(ref);
    }
  }
  return chunks.join("\n");
}

/**
 * Follow a shell page's JS bundles and their API calls.
 *
 * Order: shell HTML → script bundles (and the chunks they reference) → API
 * endpoints discovered in the bundles. Each stage is scanned with the same
 * ranking as the raw HTML.
 *
 * `timeoutMs` is an OVERALL budget for the whole scan, not a per-request
 * timeout: a scan that can take eight bundles × two endpoints × 15s each has no
 * natural bound, and an unbounded scan is worse than a partial one. Returns null
 * when the page itself cannot be retrieved — a 403 or a bot wall is "we could
 * not look", which must never be reported as "this page has no contract".
 */
export async function scanWithBundles(
  url: string,
  timeoutMs = 15000,
  maxBundles = 8,
  maxApiCalls = 40,
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS
): Promise<(ScanResult & { apiCalls: BundleScanResult["apiCalls"] }) | null> {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml",
  };

  const deadline = Date.now() + timeoutMs;

  let html: string;
  try {
    const remaining = deadline - Date.now();
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(500, remaining)),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  // Stage 1: the shell itself.
  const shell = scanHtml(html, currencySentinels);

  // Stage 2: follow the bundles, breadth-first through their chunk references.
  const scriptUrls = extractScriptUrls(html, url).slice(0, maxBundles);
  const bundleText = await fetchBundlesBfs(scriptUrls, deadline, maxBundles);
  const bundleScan = bundleText
    ? scanHtml(bundleText, currencySentinels)
    : { candidates: [], totalFound: 0, empty: true };

  // Stage 3: follow the API endpoints the bundles reference.
  //
  // The bundle's paths are relative to the APP root, not the site root. On
  // fungolabs.org the app lives at /launchpad/, so the bundle says `/api/drops/x`
  // but the real endpoint is `/launchpad/api/drops/x`. Resolving against the
  // site root returns 404. We try the site root first, then re-anchor at the
  // app root derived from the page URL.
  const base = new URL(url);
  const appRoot = deriveAppRoot(url);
  const apiPaths = expandApiPaths(extractApiPaths(bundleText, url), url)
    // Known data-endpoint prefixes first — a path we recognise is far more
    // likely to answer than an arbitrary route the bundle happens to link.
    // Then concrete slug-substituted paths before raw placeholders, then
    // shortest (most likely route) first.
    .sort((a, b) => {
      const aH = isHighConfidenceApiPath(a) ? 1 : 0;
      const bH = isHighConfidenceApiPath(b) ? 1 : 0;
      if (aH !== bH) return bH - aH;
      const aC = !a.includes(":slug");
      const bC = !b.includes(":slug");
      if (aC !== bC) return aC ? -1 : 1;
      return a.length - b.length;
    })
    .slice(0, maxApiCalls);

  const apiCalls: BundleScanResult["apiCalls"] = [];
  let apiText = "";
  // Set as soon as any path yields addresses. Every later call would be spent
  // on a question already answered — the old code broke only the INNER loop and
  // kept walking every remaining path.
  let foundAny = false;

  const workers = Array.from(
    { length: Math.min(6, apiPaths.length) },
    async () => {
      while (apiPaths.length > 0 && !foundAny) {
        const p = apiPaths.shift()!;
        const candidates = [new URL(p, base).toString()];
        if (appRoot) {
          const alt = new URL(appRoot + p.replace(/^\//, ""), base).toString();
          if (alt !== candidates[0]) candidates.push(alt);
        }
        for (const apiUrl of candidates) {
          if (foundAny) return;
          try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            const r = await fetch(apiUrl, {
              headers: { "user-agent": headers["user-agent"], accept: "application/json" },
              signal: AbortSignal.timeout(Math.max(500, remaining)),
            });
            if (!r.ok) {
              apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
              continue;
            }
            const body = await r.text();
            const found = extractAddresses(body).length;
            apiCalls.push({ url: apiUrl, ok: true, addressesFound: found });
            if (found > 0) {
              apiText += "\n" + body;
              foundAny = true;
              return;
            }
          } catch {
            apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
          }
        }
      }
    }
  );
  await Promise.all(workers);

  const apiScan = apiText
    ? scanHtml(apiText, currencySentinels)
    : { candidates: [], totalFound: 0, empty: true };

  // Merge and re-rank.
  const merged = mergeScans([shell, bundleScan, apiScan]);
  return { ...merged, apiCalls };
}

/** Merge several scan results, keeping the highest score per address. */
function mergeScans(scans: ScanResult[]): ScanResult {
  const byAddr = new Map<string, AddressCandidate>();
  let totalFound = 0;
  for (const s of scans) {
    totalFound += s.totalFound;
    for (const c of s.candidates) {
      const existing = byAddr.get(c.address);
      if (!existing) {
        byAddr.set(c.address, { ...c });
      } else {
        // Keep the strongest evidence: highest score, and the most specific
        // source we have seen.
        existing.score = Math.max(existing.score, c.score);
        existing.occurrences = Math.max(existing.occurrences, c.occurrences);
        if (c.key && !existing.key) existing.key = c.key;
        if (sourceRank(c.source) > sourceRank(existing.source)) existing.source = c.source;
      }
    }
  }
  const candidates = [...byAddr.values()].sort((a, b) => b.score - a.score);
  return { candidates, totalFound, empty: candidates.length === 0 };
}

function sourceRank(s: AddressCandidate["source"]): number {
  const order: AddressCandidate["source"][] = [
    "html-text",
    "script-blob",
    "json-key",
    "contracts-block",
    "mint-button",
  ];
  return order.indexOf(s);
}

/**
 * Fetch and scan a URL. Returns null when the page cannot be retrieved —
 * a 403/429/Cloudflare challenge is reported as "no result", never as a
 * wrong address.
 */
export async function scanUrl(
  url: string,
  timeoutMs = 15000,
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS
): Promise<ScanResult | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let html: string;
  try {
    html = await res.text();
  } catch {
    return null;
  }

  // A bot wall or consent page is still a 200 with HTML. If it contains no
  // addresses we return empty — which is honest, unlike inventing one.
  return scanHtml(html, currencySentinels);
}
