// Rarity from a PUBLISHED id -> metadata mapping.
//
// This does not discover anything. It reads only what the contract already
// points at, the same public data `--reveal-scan` resolves. It exists because a
// PUBLIC finding is only actionable if you know WHICH ids are worth having:
// token ids are sequential, so rarity turns the mapping into a target.
//
// Honesty rules this module follows:
//   - A token that could not be read is NOT counted as common and NOT scored.
//   - Coverage is always reported. "Rarest" means rarest among the tokens that
//     were actually read, which is a lower bound when coverage is partial.
//   - Rarity is a property of the metadata. It is not a market value and is not
//     a prediction of what anyone will pay.
import fs from "fs";
import path from "path";
import { DEFAULT_GATEWAYS } from "./reveal-scan";

// Scored tokens are cached per directory CID. The gateways throttle a single IP
// hard, so a full table is usually several runs' worth; without a cache every
// attempt pays for the tokens it already read.
const RARITY_CACHE_DIR = path.resolve(__dirname, "..", ".minter-cache", "rarity");

interface RarityCache {
  cid: string;
  updatedAt: string;
  tokens: TokenTraits[];
}

function cacheFile(cid: string): string {
  return path.join(RARITY_CACHE_DIR, `${cid.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

export function loadRarityCache(cid: string): TokenTraits[] {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(cid), "utf-8")) as RarityCache;
    if (raw?.cid !== cid || !Array.isArray(raw.tokens)) return [];
    return raw.tokens.filter((t) => Number.isInteger(t.tokenId) && Array.isArray(t.traits));
  } catch {
    // No cache, unreadable cache, or a foreign shape: start empty rather than
    // trusting a file we cannot read.
    return [];
  }
}

export function saveRarityCache(cid: string, tokens: TokenTraits[]): void {
  try {
    fs.mkdirSync(RARITY_CACHE_DIR, { recursive: true, mode: 0o700 });
    const existing = loadRarityCache(cid);
    const byId = new Map<number, TokenTraits>();
    for (const t of [...existing, ...tokens]) byId.set(t.tokenId, t);
    const merged = [...byId.values()].sort((a, b) => a.tokenId - b.tokenId);
    const tmp = cacheFile(cid) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ cid, updatedAt: new Date().toISOString(), tokens: merged }), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmp, cacheFile(cid));
  } catch {
    // A cache write failure must not fail the run.
  }
}

export interface TokenTraits {
  tokenId: number;
  traits: { type: string; value: string }[];
}

export interface TraitFrequency {
  /** How many of the SCORED tokens carry this value. */
  count: number;
  /** count / scored, as a percentage. */
  pct: number;
}

export interface RarityRow {
  tokenId: number;
  /**
   * Sum over the token's traits of (scored / count). Higher = rarer. This is the
   * statistical-rarity sum most tools use; it is a relative score, not a price.
   */
  score: number;
  rarest: { type: string; value: string; pct: number } | null;
  traits: { type: string; value: string; pct: number }[];
}

export interface RarityReport {
  scored: number;
  /** Trait type -> value -> frequency, over the scored set only. */
  frequencies: Record<string, Record<string, TraitFrequency>>;
  rows: RarityRow[];
}

/**
 * Score a set of tokens. `scored` is the denominator: frequencies are computed
 * over the tokens actually read, never over the collection's total supply —
 * mixing the two would make a partial crawl look like a complete one.
 */
export function computeRarity(tokens: TokenTraits[]): RarityReport {
  const scored = tokens.length;
  const counts = new Map<string, Map<string, number>>();
  for (const t of tokens) {
    for (const tr of t.traits) {
      if (!counts.has(tr.type)) counts.set(tr.type, new Map());
      const m = counts.get(tr.type)!;
      m.set(tr.value, (m.get(tr.value) ?? 0) + 1);
    }
  }

  const frequencies: Record<string, Record<string, TraitFrequency>> = {};
  for (const [type, m] of counts) {
    frequencies[type] = {};
    for (const [value, count] of m) {
      frequencies[type][value] = { count, pct: scored > 0 ? (count / scored) * 100 : 0 };
    }
  }

  const rows: RarityRow[] = tokens.map((t) => {
    const traits = t.traits.map((tr) => {
      const f = frequencies[tr.type]?.[tr.value];
      return { type: tr.type, value: tr.value, pct: f?.pct ?? 0 };
    });
    const score = scored > 0
      ? t.traits.reduce((acc, tr) => acc + scored / (frequencies[tr.type]?.[tr.value]?.count ?? 1), 0)
      : 0;
    const rarest = traits.length > 0 ? traits.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    return { tokenId: t.tokenId, score, rarest, traits };
  });

  rows.sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);
  return { scored, frequencies, rows };
}

export interface CrawlOptions {
  /** Directory CID, bare, as ipfs://<cid> or a bare CID. */
  cid: string;
  gateways?: string[];
  concurrency?: number;
  /** Stop after this many tokens. */
  limit?: number;
  /** Overall wall-clock budget. */
  timeoutMs?: number;
  /** Reuse `.minter-cache/rarity/<cid>.json` (default true). */
  useCache?: boolean;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  onProgress?: (done: number, ok: number) => void;
}

export interface CrawlResult {
  tokens: TokenTraits[];
  /** Entries the directory index listed. */
  listed: number;
  /** Entry names that were not numeric or .json. */
  skipped: number;
  /** Requests that failed outright (429/403/timeout). */
  failed: number;
  truncated: boolean;
  elapsedMs: number;
  /** Tokens carried over from the cache rather than fetched this run. */
  fromCache: number;
}

/** Parse the trait list out of a metadata JSON document, tolerating shapes. */
export function traitsOf(doc: any): { type: string; value: string }[] {
  const list = Array.isArray(doc?.attributes)
    ? doc.attributes
    : Array.isArray(doc?.traits)
      ? doc.traits
      : [];
  const out: { type: string; value: string }[] = [];
  for (const a of list) {
    const type = a?.trait_type ?? a?.type ?? a?.name;
    const value = a?.value;
    if (type == null || value == null) continue;
    const v = typeof value === "string" ? value : String(value);
    if (v === "") continue;
    out.push({ type: String(type), value: v });
  }
  return out;
}

/** Pick `limit` ids spread evenly across the sorted list. */
function spreadPick(ids: number[], limit: number): number[] {
  if (limit <= 0 || limit >= ids.length) return ids;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) out.push(ids[Math.floor((i * ids.length) / limit)]);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Read a directory index and return its numeric entry names. */
export async function listDirectoryEntries(
  cid: string,
  gateways: string[] = DEFAULT_GATEWAYS,
  timeoutMs = 60_000
): Promise<{ entries: string[]; truncated: boolean; gateway: string | null }> {
  const bare = cid.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "").replace(/\/+$/, "");
  for (const gateway of gateways) {
    const base = gateway.replace(/\/+$/, "");
    try {
      const r = await fetch(`${base}/${bare}/`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (!r.ok) continue;
      const text = await r.text();
      const hrefs = [...text.matchAll(/href=["']?([^"'\s>]+)["']?/g)].map((m) => m[1]);
      const names = hrefs
        .map((h) => (h.split("/").pop() ?? "").split("?")[0])
        .filter((n) => /^\d+(?:\.json)?$/i.test(n));
      return { entries: [...new Set(names)], truncated: false, gateway: base };
    } catch {
      // Next gateway.
    }
  }
  return { entries: [], truncated: false, gateway: null };
}

/**
 * Fetch metadata for a directory of tokens.
 *
 * Gateways rate-limit a single IP hard (measured: Pinata 429s after a handful
 * of small requests, ipfs.io 403s, cloudflare unreachable), so this rotates
 * gateways, retries 429/403 with a backoff, and reports exactly how much it
 * managed to read. A partial read is a result, not a failure — but it must be
 * visible as one.
 */
export async function crawlTraits(opts: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const gateways = opts.gateways ?? DEFAULT_GATEWAYS;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 6));
  const requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  const deadline = started + (opts.timeoutMs ?? 180_000);

  const listed = await listDirectoryEntries(opts.cid, gateways);
  const bare = opts.cid.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "").replace(/\/+$/, "");
  const numeric = listed.entries
    .map((n) => Number(n.replace(/\.json$/i, "")))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const skipped = listed.entries.length - numeric.length;

  // A contiguous prefix (ids 0..499) is a strange target set and is biased if a
  // collection ever mints in trait order. Spread the sample evenly across the
  // whole range instead: same statistical value, better spread of targets.
  // limit 0 means "no limit".
  const cached = opts.useCache === false ? [] : loadRarityCache(opts.cid);
  const cachedIds = new Set(cached.map((t) => t.tokenId));
  const fresh = numeric.filter((id) => !cachedIds.has(id));
  // limit 0 means "no limit".
  const targets =
    opts.limit != null && opts.limit > 0 ? spreadPick(fresh, opts.limit) : fresh;
  const tokens: TokenTraits[] = [...cached];
  let failed = 0;
  let gi = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = next++;
      if (i >= targets.length) return;
      const id = targets[i];
      let got: TokenTraits | null = null;
      // Rotate gateways per attempt; a gateway that 429s is not retried
      // immediately, the next worker takes the following one.
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        const gateway = gateways[gi++ % gateways.length].replace(/\/+$/, "");
        const url = `${gateway}/${bare}/${id}`;
        for (let retry = 0; retry < 2; retry++) {
          if (Date.now() > deadline) return;
          try {
            const r = await fetch(url, {
              headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(requestTimeoutMs),
              redirect: "follow",
            });
            if (r.status === 429 || r.status === 403) {
              // Back off, then let another gateway have a turn.
              // Exponential with jitter: a fixed backoff makes every worker
              // retry in lockstep, which keeps the throttle hot.
              await new Promise((res) =>
                setTimeout(res, Math.min(8000, 800 * 2 ** retry) + Math.random() * 400)
              );
              break;
            }
            if (!r.ok) {
              await r.body?.cancel().catch(() => {});
              break;
            }
            const doc = JSON.parse(await r.text());
            got = { tokenId: id, traits: traitsOf(doc) };
            break;
          } catch {
            // Timeout or network: try once more, then give up on this token.
          }
        }
      }
      if (got) tokens.push(got);
      else failed++;
      opts.onProgress?.(Math.min(next, targets.length), tokens.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));

  tokens.sort((a, b) => a.tokenId - b.tokenId);
  return {
    tokens,
    listed: listed.entries.length,
    skipped,
    failed,
    truncated: opts.limit != null && opts.limit > 0 && numeric.length > opts.limit,
    elapsedMs: Date.now() - started,
    fromCache: cached.length,
  };
}
