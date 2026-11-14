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

/** Non-global form for one-off tests. A global regex carries `lastIndex`, so
 *  calling .test() on it is stateful and alternates between matches. */
const ADDR_TEST_RE = /0x[a-fA-F0-9]{40}/;

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

/**
 * Count address occurrences in the raw text, REPEATS INCLUDED.
 *
 * Separate from extractAddresses because that one dedupes: a page that mentions
 * the collection 161 times and a stage address once must not look identical to
 * the ranking. Keys are lowercased so `0xABC…` and `0xabc…` count together.
 */
export function extractAddressOccurrences(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(ADDR_RE)) {
    const a = m[0].toLowerCase();
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return counts;
}

// ── Embedded base64 payloads ────────────────────────────────────────────────

/**
 * Decode base64 to UTF-8 text.
 *
 * Uses the globals (atob + TextDecoder) rather than Buffer so this module stays
 * environment-agnostic — it is pure and imports nothing.
 */
function base64ToUtf8(b64: string): string | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Find embedded base64 JSON payloads and decode them.
 *
 * Some sites ship their config as a data: URI rather than plain JSON. Base64
 * never contains the characters of a 0x address, so those payloads are
 * invisible to a text scan until decoded.
 *
 * Only `data:application/json;base64,…` is recognised — an unambiguous marker.
 * A bare base64-looking string is NOT decoded: guessing would turn every hash
 * and every PNG on the page into candidate text.
 */
function extractBase64Json(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/data:application\/json;base64,([A-Za-z0-9+/=\s]{40,40000})/g)) {
    const decoded = base64ToUtf8(m[1]);
    // Only keep payloads that actually carry an address — decoding a megabyte
    // of unrelated data to find nothing is pure cost.
    if (decoded && ADDR_TEST_RE.test(decoded)) out.push(decoded);
  }
  return out;
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
 * The key of the object that directly encloses a position, or null.
 *
 * Looks back to the nearest `{`, then reads the nearest `"key":` before it.
 * One level is enough for the case that matters: an address inside
 * `"paymentTokens":[{"address":"0x…"}]` is a token, whatever its own key says.
 */
function enclosingKey(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const brace = before.lastIndexOf("{");
  if (brace < 0) return null;
  const chunk = text.slice(Math.max(0, brace - 200), brace);
  const matches = [...chunk.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Keys whose contents are currencies or payment tokens — never the collection.
 *
 * The immediate key cannot tell these apart: both use a plain "address". The
 * enclosing key can, and an address under one of these is a token even when its
 * own key is the ambiguous "address".
 */
const WEAK_PARENT_KEYS = ["paymenttokens", "pricingcurrencies", "currencies", "paymenttoken"];

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
): { address: string; key: string; depth: number; parent: string | null }[] {
  const out: { address: string; key: string; depth: number; parent: string | null }[] = [];
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
    out.push({
      address: m[2],
      key: m[1],
      depth: Math.max(0, depth),
      parent: enclosingKey(text, m.index),
    });
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
 * Well-known shared infrastructure, per chain — the contracts a marketplace or
 * launch platform uses for EVERY drop.
 *
 * Different from the currency sentinels: these ARE contracts, so they are
 * DEMOTED rather than excluded. Dropping one outright would hide a genuine
 * candidate if a site ever did point at it; demoting keeps it on the list while
 * making clear it is not the collection being viewed.
 *
 * Only Ethereum mainnet is populated — those are addresses this project has
 * already verified from its own ABIs (src/seaport-abi.ts, src/mint-generic.ts,
 * src/sell-after-mint.ts). Other chains deploy their own copies at different
 * addresses; add them once verified rather than guessing.
 */
export const SHARED_INFRASTRUCTURE: Readonly<Record<string, readonly string[]>> = {
  ethereum: [
    // Seaport — the marketplace every OpenSea sale settles through.
    "0x00000000006c3852cbef3e08e8df289169ede581", // 1.1
    "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC", // 1.5
    "0x0000000000000068F116a894984e2DB1123eB395", // 1.6
    // Seaport conduit controller.
    "0x00000000f9490004c11cef243f5400493c00ad63",
    // OpenSea's fee recipient — repeated across every drop on the platform.
    "0x0000a26b00c1F0DF003000390027140000fAa719",
  ],
};

/** How far a shared-infrastructure address is demoted. Large enough to drop it
 *  below a real collection, small enough to keep it on the list. */
const SHARED_INFRASTRUCTURE_PENALTY = 25;

function flattenSharedInfrastructure(
  groups: Readonly<Record<string, readonly string[]>>
): string[] {
  const out: string[] = [];
  for (const list of Object.values(groups)) out.push(...list);
  return out;
}

/**
 * Every known shared-infrastructure address, flattened. The default demotion
 * set for callers that do not know which chain they are looking at.
 */
export const SHARED_INFRASTRUCTURE_SENTINELS: ReadonlySet<string> = new Set(
  // Normalised: ranking compares lowercased addresses, and the source ABIs
  // record these checksummed — an unnormalized entry would silently never match.
  flattenSharedInfrastructure(SHARED_INFRASTRUCTURE).map((a) => a.toLowerCase())
);

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
  /**
   * Occurrence counts from the RAW text, repeats included — build them with
   * extractAddressOccurrences.
   *
   * This is deliberately NOT extractAddresses' output: that function dedupes,
   * so feeding it here made every count 1 and silently disabled the frequency
   * signal the ranking is built around.
   */
  occurrences: Map<string, number>,
  /** Optional per-address nesting depth, from extractKeyedAddressesWithDepth. */
  depths?: Map<string, number>,
  /**
   * Currency sentinels to exclude. Defaults to CURRENCY_SENTINELS — every
   * supported chain's native and wrapped-native token. Pass a chain-specific
   * set when the caller knows the network.
   */
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS,
  /**
   * Shared-infrastructure addresses to demote. Defaults to
   * SHARED_INFRASTRUCTURE_SENTINELS; pass an empty set to disable demotion.
   */
  sharedInfrastructure: ReadonlySet<string> = SHARED_INFRASTRUCTURE_SENTINELS,
  /**
   * Addresses sitting inside a currency/payment-token list, from
   * extractKeyedAddressesWithDepth. Their own key is often the ambiguous
   * "address", so the enclosing key is what identifies them as tokens.
   */
  weakParents?: ReadonlySet<string>
): AddressCandidate[] {
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

    if (WEAK_KEYS.includes(lowerKey) || weakParents?.has(address.toLowerCase())) {
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
  for (const [addr, raw] of score) {
    if (isPlaceholder(addr)) continue;
    // Shared infrastructure is demoted, not excluded: it stays on the list so a
    // site that genuinely points at one is still reported, but it cannot outrank
    // the collection being viewed.
    const pts = sharedInfrastructure.has(addr)
      ? Math.max(0, raw - SHARED_INFRASTRUCTURE_PENALTY)
      : raw;
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
 * Pure function — the caller fetches the HTML. No network and no chain calls, so
 * the ranking can be exercised directly on any saved page.
 *
 * `currencySentinels` defaults to CURRENCY_SENTINELS; pass a chain-specific
 * set when the caller knows the network, or an empty set to disable the
 * exclusion entirely.
 */
export function scanHtml(
  html: string,
  currencySentinels: ReadonlySet<string> = CURRENCY_SENTINELS
): ScanResult {
  // Decode embedded base64 payloads and scan them alongside the markup: base64
  // never contains the characters of an address, so those payloads would
  // otherwise be invisible.
  const decoded = extractBase64Json(html);
  const text = decoded.length > 0 ? `${html}\n${decoded.join("\n")}` : html;

  const all = extractAddresses(text);
  if (all.length === 0) {
    return { candidates: [], totalFound: 0, empty: true };
  }

  const keyedWithDepth = extractKeyedAddressesWithDepth(text);
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
  const contractsBlock = extractContractsBlockAddresses(text);
  const buttons = extractMintButtonAddresses(text);

  // Addresses inside a currency/payment-token list: their own key is usually the
  // ambiguous "address", so the enclosing key is what gives them away.
  const weakParents = new Set<string>();
  for (const k of keyedWithDepth) {
    if (k.parent && WEAK_PARENT_KEYS.includes(k.parent.toLowerCase())) {
      weakParents.add(k.address.toLowerCase());
    }
  }

  const scripts = scriptBodies(text);
  const scriptHits = new Set<string>();
  for (const body of scripts) {
    for (const a of extractAddresses(body)) scriptHits.add(a);
  }

  const candidates = rankCandidates(
    keyed,
    contractsBlock,
    [...scriptHits],
    buttons,
    extractAddressOccurrences(html),
    depths,
    currencySentinels,
    SHARED_INFRASTRUCTURE_SENTINELS,
    weakParents
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
  const path = pathOf(p);
  return path !== null && API_PREFIXES.some((pre) => path.startsWith(pre));
}

/**
 * Reduce a path or URL to the path portion the denylist can test.
 *
 * Absolute and protocol-relative endpoints are allowed, so the denylist has to
 * look past the origin: `https://cdn.example.com/assets/x.js` should be denied
 * by the same rule as `/assets/x.js`.
 */
function pathOf(p: string): string | null {
  if (!/^(https?:)?\/\//i.test(p)) return p;
  try {
    return new URL(p, "https://placeholder.invalid").pathname;
  } catch {
    return null;
  }
}

/** Extract candidate data-endpoint paths referenced in a JS bundle or page. */
export function extractApiPaths(js: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const keep = (p: string): boolean => {
    if (p.length < 3) return false;
    const path = pathOf(p);
    return path !== null && !NON_DATA_PATH.some((re) => re.test(path));
  };

  // "/api/..." — absolute path from the app root.
  for (const m of js.matchAll(/["'`](\/[a-zA-Z][a-zA-Z0-9_\-\/]{2,60})["'`]/g)) {
    if (keep(m[1])) out.add(m[1]);
  }
  // Absolute and protocol-relative endpoints: "https://api.other.com/v1/drops".
  // Multi-domain setups — site on one host, API on api. — are common, and the
  // path-only pass above cannot see them.
  for (const m of js.matchAll(
    /["'`]((?:(?:https?:)?\/\/)[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9_\-\/]{0,60})?)["'`]/g
  )) {
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
    // Absolute and protocol-relative URLs are already complete: there is no
    // slug to substitute and no route suffix to walk.
    if (/^(https?:)?\/\//i.test(p)) continue;
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

/**
 * Derive the app root from the page's own URLs.
 *
 * `deriveAppRoot` guesses from the page URL's first segment. That is wrong for
 * a site whose app is mounted at a subpath but linked from the root:
 * fungolabs.org serves its launchpad at /launchpad/, and its bundle references
 * `/api/config` — which only answers at `/launchpad/api/config`. The URL guess
 * returns null, so the re-anchor never happens and the endpoint is missed.
 *
 * Same-origin URLs appear throughout the HTML (href/src) and the bundles. The
 * first path segment that repeats across them is the mount point. A single
 * mention is not evidence, so the winner has to appear at least twice.
 */
function deriveAppRootFromContent(
  html: string,
  bundleText: string,
  pageUrl: string
): string | null {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }

  const counts = new Map<string, number>();
  const re = /["']((?:\.{0,2}\/|\/)[a-zA-Z0-9_\-\/\.]{1,120})["']/g;
  for (const text of [html, bundleText]) {
    if (!text) continue;
    for (const m of text.matchAll(re)) {
      let u: URL;
      try {
        u = new URL(m[1], pageUrl);
      } catch {
        continue;
      }
      if (u.origin !== origin) continue;
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length === 0) continue;
      const first = segs[0];
      // Skip file-looking segments, single characters, and framework internals.
      if (first.length < 2 || !/^[a-z0-9_\-]+$/i.test(first) || /\.[a-z0-9]+$/i.test(first)) {
        continue;
      }
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return n >= 2 ? `/${best}/` : null;
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
  apiCalls: { url: string; ok: boolean; addressesFound: number; truncated?: boolean }[];
}

// ── Response reading ────────────────────────────────────────────────────────

/** Largest response body read into memory. Addresses live in the head of a
 *  payload; scanning a 50 MB file in full is cost without value. */
const MAX_BODY_BYTES = 5_000_000;

/**
 * Read a response body, stopping at `cap` bytes.
 *
 * `res.text()` buffers the whole body with no limit. Truncation is reported so
 * the caller can say the body was incomplete rather than implying it saw all of
 * it — an API that answers with a huge payload should not read as a complete
 * scan.
 */
async function readBodyWithCap(
  res: Response,
  cap: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total >= cap) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    // Release the connection instead of draining the rest of the body.
    reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * FNV-1a, 32-bit.
 *
 * Used only to recognise identical response bodies so the same payload is not
 * counted twice in the occurrence signal — several endpoints returning the same
 * shared contract would otherwise inflate its frequency. Not a security
 * mechanism, so a small non-cryptographic hash is the right tool.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
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
 * String-literal references are resolved here — `import("./chunk-x.js")`,
 * `new URL("./x.js", import.meta.url)`, and quoted paths ending in .js/.mjs.
 * Webpack's numeric ids are a separate mechanism with its own resolver; see
 * extractWebpackChunkUrls.
 */
export function extractChunkUrls(js: string, bundleUrl: string): string[] {
  const out = new Set<string>();
  const base = new URL(bundleUrl);
  // `import()` and `new URL(..., import.meta.url)` are code references: a bundle
  // that imports a CDN chunk is loading its own code, so cross-origin is
  // legitimate there. Bare quoted paths are more often arbitrary assets or
  // analytics scripts, so those stay same-origin only.
  const patterns: { re: RegExp; allowCrossOrigin: boolean }[] = [
    // import("./chunk-x.js") / import("/abs/chunk.js")
    { re: /import\s*\(\s*["']([^"']+\.m?js)["']\s*\)/g, allowCrossOrigin: true },
    // new URL("./chunk-x.js", import.meta.url)
    { re: /new\s+URL\s*\(\s*["']([^"']+\.m?js)["']/g, allowCrossOrigin: true },
    // Quoted path literals: "/_next/static/chunks/x.js", "/assets/index-abc.js"
    { re: /["']((?:\.{0,2}\/|\/)[a-zA-Z0-9_\-\/\.]+\.m?js)["']/g, allowCrossOrigin: false },
  ];
  for (const { re, allowCrossOrigin } of patterns) {
    for (const m of js.matchAll(re)) {
      try {
        const u = new URL(m[1], base);
        if (!allowCrossOrigin && u.origin !== base.origin) continue;
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

// ── Webpack numeric chunk ids ────────────────────────────────────────────────
//
// A webpack app loads lazy chunks by NUMBER — `__webpack_require__.e(480)` —
// which means nothing on its own. The runtime in the same app carries the
// filename function that maps it:
//
//   n.u = e => "static/js/" + e + "." + {480:"cbafb9", 544:"04bb7c"}[e] + ".js"
//   n.p = ""                                    // public path
//
// So the URL is computable rather than guessable. The runtime object is
// minified (`n`, `__webpack_require__`, anything at all), so this matches on
// the PROPERTY name, not the object.
//
// Verified against a real webpack 5.94.0 build (runtimeChunk: "single", two
// dynamic imports): the runtime object is minified, the hash map is inlined, and
// `.u` plus `.e(480)` land in different chunks.

/**
 * Read a JS expression starting at `start`, stopping at a top-level `,` or `;`,
 * or at the close of the bracket the expression opens. String literals are
 * skipped so a separator inside quotes does not end the read.
 */
function readJsExpression(js: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < js.length; i++) {
    const c = js[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{" || c === "(" || c === "[") {
      depth++;
    } else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) return js.slice(start, i);
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) {
      return js.slice(start, i);
    }
  }
  return null;
}

/**
 * Resolve webpack's numeric chunk ids to URLs using the runtime's own filename
 * function.
 *
 * Returns [] when the text is not a webpack runtime, or when the filename
 * function cannot be evaluated — a build that references the runtime object
 * itself instead of inlining its hash map is not resolvable from text alone.
 * Skipping is correct: an invented URL is worse than none.
 *
 * `baseUrl` should be the PAGE url, not the bundle url: webpack's publicPath is
 * page-relative.
 */
export function extractWebpackChunkUrls(js: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const uMatch = js.match(/(\w+)\.u\s*=\s*/);
  if (!uMatch || uMatch.index === undefined) return [];

  const expr = readJsExpression(js, uMatch.index + uMatch[0].length);
  if (!expr || expr.length === 0 || expr.length > 800) return [];

  // The public path the runtime prepends to every chunk filename.
  let publicPath = "";
  const pMatch = js.match(new RegExp(`${uMatch[1]}\\.p\\s*=\\s*("[^"]*"|'[^']*')`));
  if (pMatch) publicPath = pMatch[1].slice(1, -1);

  // Every numeric chunk id the text loads. `.e=` (the definition) does not
  // match, because the regex requires an opening parenthesis.
  const ids = new Set<string>();
  for (const m of js.matchAll(/\.e\s*\(\s*["']?(\d+)["']?\s*\)/g)) ids.add(m[1]);
  if (ids.size === 0) return [];

  let filenameFor: (id: string) => unknown;
  try {
    const fn = new Function(`return (${expr})`)();
    if (typeof fn !== "function") return [];
    filenameFor = fn;
  } catch {
    return [];
  }

  for (const id of ids) {
    let filename: unknown;
    try {
      filename = filenameFor(id);
    } catch {
      continue;
    }
    if (typeof filename !== "string" || filename.length === 0) continue;
    try {
      const ref = /^https?:\/\//.test(filename) ? filename : publicPath + filename;
      out.add(new URL(ref, baseUrl).toString());
    } catch {
      // Malformed reference — skip.
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
  maxBundles: number,
  pageUrl: string
): Promise<string> {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const seen = new Set<string>();
  const queue = [...entryUrls];
  const chunks: string[] = [];

  const drain = async (): Promise<void> => {
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
  };

  await drain();

  // Webpack resolves lazy chunks by number, and the two halves live in
  // DIFFERENT files: the filename function is in the runtime chunk, the
  // `.e(480)` calls are in the entry chunk. Neither is resolvable alone, so
  // this runs once over everything read so far and any chunks it reveals are
  // fetched in a second pass.
  //
  // Resolved against the PAGE, not a bundle: webpack's publicPath is
  // page-relative.
  for (const u of extractWebpackChunkUrls(chunks.join("\n"), pageUrl)) {
    if (!seen.has(u)) queue.push(u);
  }
  await drain();

  return chunks.join("\n");
}

/**
 * Whether a response body identifies the collection strongly enough to stop
 * scanning.
 *
 * "Any address" is not enough: shared contracts (Seaport, a marketplace, a
 * payment router) appear on most mint pages and would otherwise end the scan on
 * the first hit, before the collection itself is fetched. Three signals say a
 * body describes the thing being viewed:
 *
 *   - a dedicated `"contracts":[…]` list,
 *   - a mint control pointing at an address,
 *   - an address under an unambiguous key ("contractAddress", "nftContract", …).
 *
 * Deliberately cheap: this runs per response body, so it reuses the extractors
 * rather than running the full ranking.
 */
function isStrongSignal(body: string): boolean {
  if (extractContractsBlockAddresses(body).length > 0) return true;
  if (extractMintButtonAddresses(body).length > 0) return true;
  for (const { key } of extractKeyedAddresses(body)) {
    if (STRONG_KEYS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Whether a body is strong enough to end the scan on its own.
 *
 * A strong signal that names only shared infrastructure is NOT decisive — that
 * is exactly the case that used to end the scan on a marketplace contract. The
 * body has to describe something that is not a platform constant.
 */
function isDecisiveSignal(body: string, shared: ReadonlySet<string>): boolean {
  if (!isStrongSignal(body)) return false;
  const addresses = extractAddresses(body).map((a) => a.toLowerCase());
  return addresses.some((a) => !shared.has(a));
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
  maxApiCalls = 20,
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
    const body = await readBodyWithCap(res, MAX_BODY_BYTES);
    html = body.text;
  } catch {
    return null;
  }

  // Stage 1: the shell itself.
  const shell = scanHtml(html, currencySentinels);

  // Stage 2: follow the bundles, breadth-first through their chunk references.
  const scriptUrls = extractScriptUrls(html, url).slice(0, maxBundles);
  const bundleText = await fetchBundlesBfs(scriptUrls, deadline, maxBundles, url);
  const bundleScan = bundleText
    ? scanHtml(bundleText, currencySentinels)
    : { candidates: [], totalFound: 0, empty: true };

  // Stage 3: follow the API endpoints the page references.
  //
  // Paths come from BOTH the shell and the bundles. `data-api`, `<form
  // action>`, `data-endpoint` and friends live in the HTML; the bundle pass
  // below only ever saw the JS.
  //
  // Bundle paths are relative to the APP root, not the site root. On
  // fungolabs.org the app lives at /launchpad/, so the bundle says `/api/drops/x`
  // but the real endpoint is `/launchpad/api/drops/x`. Resolving against the
  // site root returns 404. We try the site root first, then re-anchor at the
  // app root derived from the page URL.
  const base = new URL(url);
  // The URL's first segment is the cheap guess; the page's own URLs are the
  // better one, and they are what make a root-linked subpath app discoverable.
  const appRoot =
    deriveAppRoot(url) ?? deriveAppRootFromContent(html, bundleText, url);
  const apiPaths = expandApiPaths(
    [...extractApiPaths(html, url), ...(bundleText ? extractApiPaths(bundleText, url) : [])],
    url
  )
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
  const apiBodies: string[] = [];
  const seenBodies = new Set<string>();
  // Stop early only on a DECISIVE signal.
  //
  // The previous rule stopped on the first path that returned ANY address. A
  // shared contract — Seaport, a marketplace, a payment router — answers on
  // most mint pages, so the scan ended on the first hit and the collection
  // itself was never fetched. Ranking cannot recover from data it never saw,
  // so this is a false positive no later stage can correct.
  //
  // "Decisive" means the body carries a strong signal AND names something that
  // is not platform infrastructure — a Seaport-only payload is not a reason to
  // stop. Continuing past a non-decisive body is bounded by maxApiCalls.
  let decisiveFound = false;

  /**
   * Subpath mounts an API can live under when the page never links to it.
   *
   * Generic app nouns only — the scanner is not tuned to any one site, so a
   * mount that belongs to a particular platform is not listed here. Only tried
   * for known data endpoints and only when the primary candidates answered
   * nothing, so a site that works never pays for it.
   */
  const COMMON_APP_MOUNTS = ["/app/", "/mint/", "/drops/", "/launch/", "/platform/"];

  /** Try one URL. Returns the number of addresses found (-1 = request failed). */
  const tryUrl = async (apiUrl: string): Promise<number> => {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return -1;
      const r = await fetch(apiUrl, {
        headers: { "user-agent": headers["user-agent"], accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(500, remaining)),
      });
      if (!r.ok) {
        apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
        return -1;
      }
      const { text: body, truncated } = await readBodyWithCap(r, MAX_BODY_BYTES);
      const found = extractAddresses(body).length;
      apiCalls.push({ url: apiUrl, ok: true, addressesFound: found, truncated });
      if (found > 0) {
        const hash = fnv1a(body);
        if (!seenBodies.has(hash)) {
          seenBodies.add(hash);
          apiBodies.push(body);
          if (isDecisiveSignal(body, SHARED_INFRASTRUCTURE_SENTINELS)) {
            decisiveFound = true;
          }
        }
      }
      return found;
    } catch {
      apiCalls.push({ url: apiUrl, ok: false, addressesFound: 0 });
      return -1;
    }
  };

  const workers = Array.from(
    { length: Math.min(4, apiPaths.length) },
    async () => {
      while (apiPaths.length > 0 && !decisiveFound) {
        const p = apiPaths.shift()!;
        const isAbsolute = /^(https?:)?\/\//i.test(p);
        const candidates = [new URL(p, base).toString()];
        // Absolute URLs are already complete — re-anchoring them at the app root
        // would mangle them.
        if (appRoot && !isAbsolute) {
          const alt = new URL(appRoot + p.replace(/^\//, ""), base).toString();
          if (alt !== candidates[0]) candidates.push(alt);
        }

        let best = 0;
        for (const apiUrl of candidates) {
          if (decisiveFound) return;
          best = Math.max(best, await tryUrl(apiUrl));
        }

        // Mount fallback: only when the primary candidates yielded nothing, and
        // only for a path we recognise as a data endpoint.
        if (best === 0 && !isAbsolute && isHighConfidenceApiPath(p)) {
          for (const mount of COMMON_APP_MOUNTS) {
            if (decisiveFound) return;
            if (deadline - Date.now() <= 0) return;
            const alt = new URL(mount + p.replace(/^\//, ""), base).toString();
            if ((await tryUrl(alt)) > 0) break;
          }
        }
      }
    }
  );
  await Promise.all(workers);

  const apiScan = apiBodies.length
    ? scanHtml(apiBodies.join("\n"), currencySentinels)
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
