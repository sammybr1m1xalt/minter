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
  "address",
];

/** Keys that suggest the value is NOT the collection we want. */
const WEAK_KEYS = [
  "feerecipient",
  "payoutaddress",
  "creator",
  "owner",
  "tokenaddress",
  "currency",
  "paymenttoken",
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
  allAddresses: string[]
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

  // Addresses that are never a collection contract. The zero address is a
  // placeholder used throughout OpenSea's payloads; 0x4200…06 is Base's
  // native-token placeholder. Both scored above the real collection because
  // they appear under an "address" key, so they must be excluded outright.
  const isPlaceholder = (addr: string): boolean => {
    const a = addr.toLowerCase();
    if (/^0x0+$/.test(a)) return true;
    // Base native token placeholder.
    if (a === "0x4200000000000000000000000000000000000006") return true;
    return false;
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
    if (WEAK_KEYS.includes(lowerKey)) {
      bump(address, 2, "json-key", key);
    } else if (STRONG_KEYS.includes(lowerKey)) {
      bump(address, 40, "json-key", key);
    } else {
      bump(address, 15, "json-key", key);
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

  // Repeated occurrence is a weak but real signal.
  for (const [addr, count] of occurrences) {
    if (count > 1) bump(addr, Math.min(count, 5), source.get(addr) ?? "html-text");
  }

  const seen = new Set<string>();
  const out: AddressCandidate[] = [];
  for (const [addr, pts] of score) {
    if (seen.has(addr)) continue;
    if (isPlaceholder(addr)) continue;
    seen.add(addr);
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
 */
export function scanHtml(html: string): ScanResult {
  const all = extractAddresses(html);
  if (all.length === 0) {
    return { candidates: [], totalFound: 0, empty: true };
  }

  const keyed = extractKeyedAddresses(html);
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
    all
  );

  return { candidates, totalFound: all.length, empty: candidates.length === 0 };
}

/**
 * Fetch and scan a URL. Returns null when the page cannot be retrieved —
 * a 403/429/Cloudflare challenge is reported as "no result", never as a
 * wrong address.
 */
export async function scanUrl(
  url: string,
  timeoutMs = 15000
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
  return scanHtml(html);
}
