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
import { Interface, JsonRpcProvider } from "ethers";
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
  // Normalise the scheme away: `Qm…` and `ipfs://Qm…` are the same directory, and
  // without this they wrote two cache files and silently missed each other.
  const bare = cid
    .replace(/^ipfs:\/\//i, "")
    .replace(/^ar:\/\//i, "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "");
  return path.join(RARITY_CACHE_DIR, `${bare.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

interface RarityIndexCache {
  cid: string;
  updatedAt: string;
  entries: string[];
}

function indexCacheFile(cid: string): string {
  return cacheFile(cid).replace(/\.json$/, ".index.json");
}

/**
 * The directory index is a single large request (BAYC's is 8.3MB) and the
 * gateways throttle it like any other — measured: all four 429'd in the same
 * minute, and the run reported "listed: 0" and scored nothing. The entry list is
 * stable for a given CID, so it is cached alongside the tokens and a re-run does
 * not need to refetch it.
 */
export function loadRarityIndex(cid: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(indexCacheFile(cid), "utf-8")) as RarityIndexCache;
    if (raw?.cid !== cid || !Array.isArray(raw.entries)) return [];
    return raw.entries.filter((e: unknown): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

export function saveRarityIndex(cid: string, entries: string[]): void {
  try {
    fs.mkdirSync(RARITY_CACHE_DIR, { recursive: true, mode: 0o700 });
    const tmp = indexCacheFile(cid) + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ cid, updatedAt: new Date().toISOString(), entries }),
      { encoding: "utf-8", mode: 0o600 }
    );
    fs.renameSync(tmp, indexCacheFile(cid));
  } catch {
    // The cache is an optimisation, not a requirement.
  }
}

export function loadRarityCache(cid: string): TokenTraits[] {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(cid), "utf-8")) as RarityCache;
    if (raw?.cid !== cid || !Array.isArray(raw.tokens)) return [];
    // Entries written before trait classification have no `kind`/`displayType`.
    // They are re-read as categorical, which is the old behaviour, until the
    // token is fetched again.
    return raw.tokens
      .filter((t) => Number.isInteger(t.tokenId) && Array.isArray(t.traits))
      .map((t) => ({
        tokenId: t.tokenId,
        traits: t.traits.map((tr: any) => ({
          type: String(tr?.type ?? ""),
          value: String(tr?.value ?? ""),
          kind: (tr?.kind as TraitKind) ?? "categorical",
          maxValue: typeof tr?.maxValue === "number" ? tr.maxValue : undefined,
          displayType: typeof tr?.displayType === "string" ? tr.displayType : null,
        })),
      }));
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

/**
 * How a trait's value should be read, from ERC-8495's `display_type`.
 *
 * The schema says clients MUST treat a `display_type` they do not recognise as
 * absent, so anything outside the known set lands in `categorical` rather than
 * being dropped or guessed at.
 */
export type TraitKind = "categorical" | "numeric" | "date";

export interface Trait {
  type: string;
  value: string;
  kind: TraitKind;
  /** Only for numeric traits, and only when the collection published it. */
  maxValue?: number;
  /** The published `display_type`, lower-cased, or null when absent. */
  displayType: string | null;
}

export interface TokenTraits {
  tokenId: number;
  traits: Trait[];
}

/** What a metadata document's `attributes` array yielded. */
export interface ParsedTraits {
  traits: Trait[];
  /** Entries with no usable `value`. `value` is REQUIRED, so these are malformed. */
  missingValue: number;
  /** Entries with a value but no trait name. Valid per the schema, counted separately. */
  missingType: number;
  /** Entries whose `display_type` is not one the schema defines. */
  unknownDisplayType: number;
}

const NUMERIC_DISPLAY_TYPES = new Set(["number", "boost_number", "boost_percentage"]);
const KNOWN_DISPLAY_TYPES = new Set([
  "",
  "string",
  "text",
  "number",
  "boost_number",
  "boost_percentage",
  "date",
]);

export function traitKindOf(displayType: string | null): TraitKind {
  if (displayType == null || displayType === "") return "categorical";
  if (displayType === "date") return "date";
  if (NUMERIC_DISPLAY_TYPES.has(displayType)) return "numeric";
  return "categorical";
}

/**
 * Read the `attributes` array per ERC-8495.
 *
 * `value` is REQUIRED and may be a string or a number; `trait_type` SHOULD be
 * present. An earlier version required `trait_type` and dropped anything without
 * one, which silently skewed every frequency count.
 */
export function parseTraits(doc: any): ParsedTraits {
  const list = Array.isArray(doc?.attributes)
    ? doc.attributes
    : Array.isArray(doc?.traits)
      ? doc.traits
      : [];
  const traits: Trait[] = [];
  let missingValue = 0;
  let missingType = 0;
  let unknownDisplayType = 0;

  for (const a of list) {
    if (a == null || typeof a !== "object") {
      missingValue++;
      continue;
    }
    const raw = a.value;
    let value: string;
    if (typeof raw === "string") value = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) value = String(raw);
    else {
      missingValue++;
      continue;
    }
    if (value === "") {
      missingValue++;
      continue;
    }

    const rawType = a.trait_type ?? a.type ?? a.name;
    const type = rawType == null ? "" : String(rawType);
    if (type === "") missingType++;

    const displayType =
      typeof a.display_type === "string" && a.display_type !== ""
        ? a.display_type.toLowerCase()
        : null;
    if (displayType != null && !KNOWN_DISPLAY_TYPES.has(displayType)) unknownDisplayType++;

    const maxValue =
      typeof a.max_value === "number" && Number.isFinite(a.max_value) ? a.max_value : undefined;

    traits.push({ type: type || "(unnamed)", value, kind: traitKindOf(displayType), maxValue, displayType });
  }
  return { traits, missingValue, missingType, unknownDisplayType };
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
  traits: { type: string; value: string; kind: TraitKind; pct: number }[];
}

export interface RarityReport {
  scored: number;
  /** Trait type -> value -> frequency, over the scored set only. */
  frequencies: Record<string, Record<string, TraitFrequency>>;
  rows: RarityRow[];
  /** Date traits left out of the score, across all tokens. */
  excludedDateTraits: number;
  /** Tokens carrying at least one date trait. */
  tokensWithDateTraits: number;
}

/**
 * Score a set of tokens. `scored` is the denominator: frequencies are computed
 * over the tokens actually read, never over the collection's total supply —
 * mixing the two would make a partial crawl look like a complete one.
 */
export function computeRarity(tokens: TokenTraits[]): RarityReport {
  const scored = tokens.length;
  const counts = new Map<string, Map<string, number>>();
  let excludedDateTraits = 0;
  let tokensWithDateTraits = 0;

  for (const t of tokens) {
    let tokenHadDate = false;
    for (const tr of t.traits) {
      // A `date` trait is a timestamp, not a category. It is usually unique per
      // token, so scoring it by frequency would hand every token the maximum
      // possible score for the wrong reason.
      if (tr.kind === "date") {
        excludedDateTraits++;
        tokenHadDate = true;
        continue;
      }
      if (!counts.has(tr.type)) counts.set(tr.type, new Map());
      const m = counts.get(tr.type)!;
      m.set(tr.value, (m.get(tr.value) ?? 0) + 1);
    }
    if (tokenHadDate) tokensWithDateTraits++;
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
      const f = tr.kind === "date" ? undefined : frequencies[tr.type]?.[tr.value];
      return { type: tr.type, value: tr.value, kind: tr.kind, pct: f?.pct ?? 0 };
    });
    const scorable = t.traits.filter((tr) => tr.kind !== "date");
    const score = scored > 0
      ? scorable.reduce((acc, tr) => acc + scored / (frequencies[tr.type]?.[tr.value]?.count ?? 1), 0)
      : 0;
    const ranked = traits.filter((tr) => tr.kind !== "date");
    const rarest = ranked.length > 0 ? ranked.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    return { tokenId: t.tokenId, score, rarest, traits };
  });

  rows.sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);
  return { scored, frequencies, rows, excludedDateTraits, tokensWithDateTraits };
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
  /** Attribute entries ignored because they had no usable value, or an unknown display_type. */
  ignoredTraits: number;
  truncated: boolean;
  elapsedMs: number;
  /** Tokens carried over from the cache rather than fetched this run. */
  fromCache: number;
  /** True when the directory entry list came from the cache, not the network. */
  indexFromCache: boolean;
  /** Where the token metadata came from. */
  source: "directory" | "aggregate" | "onchain";
  /** The aggregate file used, when source is "aggregate". */
  aggregateFile: string | null;
}

/**
 * Flat trait list, for callers that only need type/value pairs.
 * @deprecated use {@link parseTraits}, which classifies and counts.
 */
export function traitsOf(doc: any): { type: string; value: string }[] {
  return parseTraits(doc).traits.map((t) => ({ type: t.type, value: t.value }));
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
  const parse = (text: string, gateway: string) => {
    const hrefs = [...text.matchAll(/href=["']?([^"'\s>]+)["']?/g)].map((m) => m[1]);
    const names = hrefs.map((h) => (h.split("/").pop() ?? "").split("?")[0]);
    // Every name is returned. Filtering to numeric ids here would hide the
    // aggregate-file case (a single metadata.json), which the caller needs to
    // see in order to try it.
    return { entries: [...new Set(names)], truncated: false, gateway };
  };

  // A serial walk of five gateways at a 60s timeout each was measured at
  // ~10 minutes for a large directory. Probe them together with a short
  // deadline; the first answer wins, and only a total miss falls back to the
  // long single-gateway read a large index may need.
  const probeMs = Math.min(timeoutMs, 8_000);
  const probes = await Promise.all(
    gateways.map(async (g) => {
      const base = g.replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/${bare}/`, {
          signal: AbortSignal.timeout(probeMs),
          redirect: "follow",
        });
        if (!r.ok) {
          try { await r.body?.cancel(); } catch { /* ignore */ }
          return null;
        }
        return { base, text: await r.text() };
      } catch {
        return null;
      }
    })
  );
  // First success is not enough: one gateway answered with a 2-entry HTML
  // stub while another held the real 11558-entry index. Pick the fullest
  // answer, never the fastest partial one.
  const answered = probes
    .filter((p): p is { base: string; text: string } => p != null)
    .map((p) => parse(p.text, p.base))
    .sort((a, b) => b.entries.length - a.entries.length);
  if (answered.length > 0) return answered[0];

  for (let round = 0; round < 3; round++) {
    for (const gateway of gateways) {
      const base = gateway.replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/${bare}/`, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        if (!r.ok) {
          try { await r.body?.cancel(); } catch { /* ignore */ }
          continue;
        }
        return parse(await r.text(), base);
      } catch {
        // Next gateway.
      }
    }
    if (round < 2) await new Promise((res) => setTimeout(res, 1000 * (round + 1)));
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
const AGGREGATE_ID_KEYS = ["tokenId", "token_id", "tokenID", "id", "identifier", "edition", "number"];
const AGGREGATE_LIST_KEYS = ["tokens", "metadata", "items", "nfts", "entries", "assets"];

function aggregateIdOf(item: any, key: string | null = null): number | null {
  for (const k of AGGREGATE_ID_KEYS) {
    const v = item?.[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  // Keyed-by-id shape: the id is the object key, not a field in the value.
  if (key != null && /^\d+$/.test(key)) return Number(key);
  return null;
}

/**
 * Pull the token list out of whichever aggregate shape a collection used.
 * Each entry carries the key it was found under, because a keyed-by-id object
 * stores the id in the key rather than in the value.
 */
function aggregateItemsOf(doc: any): { value: any; key: string | null }[] {
  if (Array.isArray(doc)) return doc.map((v) => ({ value: v, key: null }));
  for (const k of AGGREGATE_LIST_KEYS) {
    if (Array.isArray(doc?.[k])) return doc[k].map((v: any) => ({ value: v, key: null }));
  }
  if (doc && typeof doc === "object") {
    // Keyed by id: { "1": {...}, "2": {...} }. Require the values to look like
    // metadata, so a settings object is not mistaken for a token list.
    const entries = Object.entries(doc).filter(([, v]) => v != null && typeof v === "object");
    if (
      entries.length > 0 &&
      entries.some(([, v]) => aggregateIdOf(v) != null || traitsOf(v).length > 0)
    ) {
      return entries.map(([k, v]) => ({ value: v, key: k }));
    }
  }
  return [];
}

export interface AggregateMapping {
  tokens: TokenTraits[];
  file: string;
  shape: "array" | "object";
}

/**
 * Some collections publish ONE metadata file containing every token instead of a
 * directory of per-token files. The directory then has no numeric entries and a
 * per-id crawl would score nothing, so try the file.
 *
 * Refuses to guess: it returns null unless the document parses, yields at least
 * one token with an id, and at least one token carries a trait. A placeholder
 * file ("Unrevealed", no attributes) therefore reads as no data, not as a
 * collection with no traits.
 */
export async function readAggregateMapping(
  cid: string,
  gateways: string[] = DEFAULT_GATEWAYS,
  timeoutMs = 60_000,
  maxBytes = 32 * 1024 * 1024
): Promise<AggregateMapping | null> {
  const bare = cid.replace(/^ipfs:\/\//i, "").replace(/^ar:\/\//i, "").replace(/\/+$/, "");
  const { entries } = await listDirectoryEntries(cid, gateways, timeoutMs);
  const dirFiles = entries.filter((n) => /\.json$/i.test(n));
  // A directory with many .json files is not an aggregate; picking one would be
  // a guess.
  if (dirFiles.length > 12) return null;

  // Two shapes reach this function: a directory whose single .json file holds
  // every token, and a bare FILE CID (no directory at all). For the latter the
  // directory listing is empty, so the CID itself has to be tried as the file.
  const paths = [...dirFiles.map((f) => `${bare}/${f}`), bare];

  for (const p of paths) {
    const label = p === bare ? "(the CID itself)" : p.slice(bare.length + 1);
    for (const gateway of gateways) {
      const base = gateway.replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/${p}`, {
          headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        if (!r.ok) {
          await r.body?.cancel().catch(() => {});
          continue;
        }
        const text = await r.text();
        if (text.length > maxBytes) continue;
        const doc = JSON.parse(text);
        const items = aggregateItemsOf(doc);
        if (items.length === 0) continue;
        const tokens: TokenTraits[] = [];
        for (const { value, key } of items) {
          const id = aggregateIdOf(value, key);
          if (id == null) continue;
          tokens.push({ tokenId: id, traits: parseTraits(value).traits });
        }
        if (tokens.length === 0) continue;
        // No traits anywhere means a placeholder, not an aggregate mapping.
        if (!tokens.some((t) => t.traits.length > 0)) continue;
        tokens.sort((a, b) => a.tokenId - b.tokenId);
        return { tokens, file: label, shape: Array.isArray(doc) ? "array" : "object" };
      } catch {
        // Next gateway.
      }
    }
  }
  return null;
}

export async function crawlTraits(opts: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const gateways = opts.gateways ?? DEFAULT_GATEWAYS;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 6));
  const requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  const deadline = started + (opts.timeoutMs ?? 180_000);

  const cachedIndex = opts.useCache === false ? [] : loadRarityIndex(opts.cid);
  const listed =
    cachedIndex.length > 0
      ? { entries: cachedIndex, truncated: false, gateway: "cache" }
      : await listDirectoryEntries(opts.cid, gateways);
  // Only overwrite when the fetch found MORE than the cache holds, so a
  // throttled fetch (0 entries) cannot wipe a good index.
  if (listed.entries.length > cachedIndex.length) saveRarityIndex(opts.cid, listed.entries);
  const bare = opts.cid.replace(/^ipfs:\/\//, "").replace(/^ar:\/\//, "").replace(/\/+$/, "");
  const numeric = listed.entries
    .map((n) => Number(n.replace(/\.json$/i, "")))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const nonNumeric = listed.entries.filter((n) => !/^\d+(?:\.json)?$/i.test(n));
  const skipped = nonNumeric.length;

  // A contiguous prefix (ids 0..499) is a strange target set and is biased if a
  // collection ever mints in trait order. Spread the sample evenly across the
  // whole range instead: same statistical value, better spread of targets.
  // limit 0 means "no limit".
  const cached = opts.useCache === false ? [] : loadRarityCache(opts.cid);

  // No per-token files: try a single aggregate metadata file before declaring
  // the collection unscorable. This also covers a bare FILE CID, where the
  // directory listing is empty and the CID itself is the file.
  if (numeric.length === 0) {
    const agg = await readAggregateMapping(bare, gateways, requestTimeoutMs);
    if (agg) {
      const seen = new Set(cached.map((t) => t.tokenId));
      const merged = [...cached];
      for (const t of agg.tokens) {
        if (!seen.has(t.tokenId)) {
          seen.add(t.tokenId);
          merged.push(t);
        }
      }
      merged.sort((a, b) => a.tokenId - b.tokenId);
      saveRarityCache(opts.cid, merged);
      return {
        tokens: merged,
        listed: agg.tokens.length,
        skipped,
        failed: 0,
        ignoredTraits: 0,
        truncated: false,
        elapsedMs: Date.now() - started,
        fromCache: cached.length,
        indexFromCache: cachedIndex.length > 0,
        source: "aggregate",
        aggregateFile: agg.file,
      };
    }
  }

  const cachedIds = new Set(cached.map((t) => t.tokenId));
  const fresh = numeric.filter((id) => !cachedIds.has(id));
  // limit 0 means "no limit".
  const targets =
    opts.limit != null && opts.limit > 0 ? spreadPick(fresh, opts.limit) : fresh;
  const tokens: TokenTraits[] = [...cached];
  let failed = 0;
  let ignoredTraits = 0;
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
        // One retry per gateway is enough: another gateway is the real
        // fallback. Two retries here made a cold 2-token run spend 20s just
        // waiting on throttled endpoints.
        for (let retry = 0; retry < 1; retry++) {
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
            const parsed = parseTraits(doc);
            ignoredTraits += parsed.missingValue + parsed.unknownDisplayType;
            got = { tokenId: id, traits: parsed.traits };
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
    ignoredTraits,
    truncated: opts.limit != null && opts.limit > 0 && numeric.length > opts.limit,
    elapsedMs: Date.now() - started,
    fromCache: cached.length,
    indexFromCache: cachedIndex.length > 0,
    source: "directory",
    aggregateFile: null,
  };
}


// ── On-chain metadata (data: URIs) ───────────────────────────────────────────
// Some collections embed each token's JSON directly in tokenURI(id) as a
// data: URI. There is no CID to resolve and no directory to crawl, so the
// mapping is fully public but the CID-based path sees "nothing to score".
// This reads the same public tokenURI calls the reveal scan already made,
// spread across the supply and bounded like any other crawl.

export function decodeOnchainMetadata(uri: string | null | undefined): any | null {
  if (!uri) return null;
  let json: string | null = null;
  if (uri.startsWith("data:application/json;base64,")) {
    try { json = Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8"); }
    catch { return null; }
  } else if (uri.startsWith("data:application/json,")) {
    try { json = decodeURIComponent(uri.slice("data:application/json,".length)); }
    catch { return null; }
  }
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export interface OnchainCrawlOptions {
  contract: string;
  rpcUrls: string[];
  chainId: number;
  /** totalSupply() from the reveal scan. */
  totalSupply: number;
  /** 0 means every id; otherwise a spread sample. */
  limit: number;
  /** A token id known to answer tokenURI/uri, from the reveal scan. */
  probeTokenId?: number;
  /** Test seam: an already-resolved provider; production resolves rpcUrls. */
  provider?: JsonRpcProvider;
  /** Explicit ids (e.g. the listed tokens) instead of a spread sample. */
  ids?: number[];
  /** Extra ids appended to the spread sample, deduplicated. */
  extraIds?: number[];
  concurrency: number;
  timeoutMs: number;
  onProgress?: (done: number, ok: number) => void;
}

export async function crawlOnchainTraits(opts: OnchainCrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const out: CrawlResult = {
    tokens: [],
    listed: opts.totalSupply,
    skipped: 0,
    failed: 0,
    ignoredTraits: 0,
    truncated: false,
    elapsedMs: 0,
    fromCache: 0,
    indexFromCache: false,
    source: "onchain",
    aggregateFile: null,
  };
  if (opts.totalSupply <= 0) {
    out.failed = 0;
    out.elapsedMs = Date.now() - started;
    return out;
  }

  let provider: JsonRpcProvider | null = opts.provider ?? null;
  for (const url of provider ? [] : opts.rpcUrls) {
    try {
      const p = new JsonRpcProvider(url, opts.chainId, { staticNetwork: true });
      await p.getBlockNumber();
      provider = p;
      break;
    } catch {
      // Next endpoint: pinning [0] disables the redundancy.
    }
  }
  if (!provider) {
    out.failed = opts.totalSupply;
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const iface = new Interface([
    "function tokenURI(uint256) view returns (string)",
    "function uri(uint256) view returns (string)",
  ]);
  let fn = "tokenURI";
  let detected = false;
  // id 0 often reverts (many collections start at 1), so probing only 0 once
  // picked `uri()` and made every later call fail. Try both flavours over a
  // few real ids before choosing.
  for (const name of ["tokenURI", "uri"]) {
    for (const id of [opts.probeTokenId ?? 1, 1, 0, 2]) {
      try {
        const raw = await provider.call({ to: opts.contract, data: iface.encodeFunctionData(name, [id]) });
        const value = iface.decodeFunctionResult(name, raw)[0];
        if (typeof value === "string") {
          fn = name;
          detected = true;
          break;
        }
      } catch {
        // Next name / id.
      }
    }
    if (detected) break;
  }

  let targets: number[];
  if (opts.ids?.length) {
    targets = [...opts.ids];
  } else {
    const take = opts.limit > 0 ? Math.min(opts.limit, opts.totalSupply) : opts.totalSupply;
    targets = [];
    for (let i = 0; i < take; i++) {
      // ERC-721A ids start at 1; id 0 reverts on most collections.
      targets.push(
        take === opts.totalSupply ? i + 1 : Math.floor((i * opts.totalSupply) / take) + 1
      );
    }
  }
  if (opts.extraIds?.length) {
    const seen = new Set(targets);
    for (const id of opts.extraIds) {
      if (Number.isFinite(id) && id >= 1 && !seen.has(id)) {
        targets.push(id);
        seen.add(id);
      }
    }
  }
  out.truncated = targets.length < opts.totalSupply;

  const workers = Math.max(1, Math.min(16, opts.concurrency || 8));
  let next = 0;
  let done = 0;
  const perCall = Math.min(12_000, Math.max(1000, Math.floor(opts.timeoutMs / Math.max(1, targets.length)) * workers));
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = next++;
      if (i >= targets.length) return;
      const tokenId = targets[i];
      let uri: string | null = null;
      try {
        const raw = await Promise.race([
          provider!.call({ to: opts.contract, data: iface.encodeFunctionData(fn, [tokenId]) }),
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error("tokenURI timeout")), perCall)),
        ]);
        uri = iface.decodeFunctionResult(fn, raw)[0] as string;
      } catch {
        out.failed++;
        done++;
        opts.onProgress?.(done, out.tokens.length);
        continue;
      }
      const doc = decodeOnchainMetadata(uri);
      if (doc) {
        const parsed = parseTraits(doc);
        out.tokens.push({ tokenId, traits: parsed.traits });
        out.ignoredTraits += parsed.missingValue + parsed.unknownDisplayType + parsed.missingType;
      } else {
        out.failed++;
      }
      done++;
      opts.onProgress?.(done, out.tokens.length);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  out.tokens.sort((a, b) => a.tokenId - b.tokenId);
  out.elapsedMs = Date.now() - started;
  try { provider.destroy(); } catch { /* already gone */ }
  return out;
}
