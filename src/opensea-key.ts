// ── OpenSea free API key POOL management ─────────────────────────────────
//
// Manages MULTIPLE free-tier keys (minted via POST /api/v2/auth/keys).
// Before the FCFS mint fires, probes all keys in parallel and picks the
// best one — alive, responsive, least-used — so a rate-limited or dead
// key never blocks the mint at T-0.
//
// Keys are cached to disk. New keys are minted on demand (subject to
// OpenSea's rate limit: max 2 keys/day for free tier).
//
// ⚠ DOCUMENTED LIMITATION (verified against docs.opensea.io/reference/api-keys,
//   2026-11-06): "All API keys under the same account share a single rate limit
//   bucket. Creating multiple API keys will not increase your overall rate
//   limit." and "Minting extra keys is not a way to get more throughput."
//
// So the pool does NOT buy extra quota. What it does buy:
//   - failover when one key is throttled or dead (the bucket is shared, but a
//     dead/expired key is still unusable while a live one works)
//   - continuity across the 7-day key expiry
// It does NOT raise the ceiling. For more throughput the only documented path
// is upgrading to a full key at opensea.io/settings/developer.
//
// Free-tier documented rates: 600/h read, 30/h write, 5/m fulfillment.
// Live probe returned X-RateLimit-Limit: 120 — the docs also warn that "some
// endpoint groups are metered more tightly than the headline read rate", so
// always read the headers rather than assuming a number.

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// Resolved from this module's own location, so the pool lands inside the
// project regardless of the caller's cwd — dist/index.js can be invoked from
// anywhere and the secrets must not move with it.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

const KEY_CACHE_DIR = (() => {
  // OPENSEA_KEY_DIR is the honest name. OPENSEA_SESSION_DIR is still honoured
  // for back-compat — older builds pointed a variable called "session" at the
  // key pool, and silently moving the pool would orphan every cached key.
  const explicit =
    process.env.OPENSEA_KEY_DIR?.trim() || process.env.OPENSEA_SESSION_DIR?.trim();
  if (explicit) return explicit;
  // Project-local by default. .gitignore already excludes .minter-cache/, and
  // keeping it beside the code makes it obvious where the plaintext keys live.
  const d = path.join(PACKAGE_ROOT, ".minter-cache");
  try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {}
  return d;
})();

// Older builds kept the pool in the home directory. Imported once, on the
// first load, so an existing key is not orphaned by the move.
const LEGACY_POOL_FILE = (() => {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".nft-public-mint", "opensea_key_pool.json") : "";
})();

// Set to "0" to stop the tool rewriting OPENSEA_API_KEY in .env.
const ENV_KEY_SYNC = process.env.OPENSEA_KEY_SYNC !== "0";

const KEY_POOL_FILE = path.join(KEY_CACHE_DIR, "opensea_key_pool.json");
// Records that today's free-key creation attempt already failed, so we don't
// burn a request re-POSTing on every run. Keyed by local-midnight timestamp.
const QUOTA_FILE = path.join(KEY_CACHE_DIR, "opensea_quota.json");
const OPENSEA_BASE = "https://api.opensea.io";
const FREE_KEY_ENDPOINT = `${OPENSEA_BASE}/api/v2/auth/keys`;

// ── Key pool entry ────────────────────────────────────────────────────────

export interface KeyPoolEntry {
  api_key: string;
  name: string;
  expires_at: string;
  minted_at: string;
  times_used: number;
  last_probe: "alive" | "throttled" | "dead" | "timeout" | "unknown" | "alive_but_exhausted" | "server_error";
  last_probe_at: string;
  probe_latency_ms: number;
  score: number;
  remaining_calls: number; // X-RateLimit-Remaining from last probe/response
  rate_limit_reset: number; // X-RateLimit-Reset (unix epoch) — when window resets
  /** Last time this key was actually used for a run. Diagnostic only. */
  last_used_at?: string;
}

// ── Key lifecycle helpers ──────────────────────────────────────────────────

/**
 * A non-reversible label for a pool entry, for logs.
 *
 * The key prefix used here previously (`api_key.slice(0, 12)`) put roughly a
 * third of a live credential into every run log. The name is stable and
 * human-readable; the fingerprint distinguishes two same-named keys without
 * revealing key material.
 */
export function keyLabel(entry: { api_key: string; name?: string }): string {
  const name = entry.name?.trim();
  const fp = require("node:crypto")
    .createHash("sha256")
    .update(entry.api_key)
    .digest("hex")
    .slice(0, 8);
  return name ? `${name} [${fp}]` : `key-${fp}`;
}

/** How old a key is, in days, from its minted_at timestamp. */
function daysOld(entry: KeyPoolEntry): number {
  if (!entry.minted_at) return Infinity;
  const born = new Date(entry.minted_at).getTime();
  if (isNaN(born)) return Infinity;
  return (Date.now() - born) / 86_400_000;
}

/** UNIX ms for the start of today (midnight local). */
function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * ⚠ The daily key-creation quota does NOT reset at midnight.
 *
 * OPENSEA_API_LAYOUT.txt claims "Quota state (QUOTA_FILE) resets at UTC
 * midnight (not 24h from 429)". That is wrong. Verified live 2026-11-06:
 * X-RateLimit-Reset was 1794036334 = 07:25:34 UTC, i.e. a ROLLING window that
 * had already expired a minute before the probe. The window slides; it is not
 * anchored to any midnight.
 *
 * Consequence: the local-midnight marker below is an approximation. It is still
 * useful (it stops us re-POSTing every run within a day) but it can block a
 * legitimate mint if the rolling window has already recovered while the local
 * day has not. Callers that need certainty should re-probe rather than trust
 * this marker.
 */

/** How many keys in the pool were created today (local midnight). */
function keysCreatedToday(pool: KeyPoolEntry[]): number {
  const todayStart = todayMidnightMs();
  return pool.filter((e) => {
    const born = e.minted_at ? new Date(e.minted_at).getTime() : 0;
    return born >= todayStart;
  }).length;
}

// ── Daily quota marker ──────────────────────────────────────────────────────
// OpenSea allows 2 free key creations per day per IP. Once an attempt fails
// with 429, retrying on every run wastes a request and produces the same 429.
// Persist the failure so the code can skip the POST until the next local day.

interface QuotaState {
  rate_limited_today: boolean;
  last_429_at: number;
  /** Retry-After from the last 429, in seconds. Authoritative when present. */
  retry_after_seconds: number;
  cached_keys_created_today: number;
}

function readQuota(): QuotaState {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) as QuotaState;
  } catch {
    return {
      rate_limited_today: false,
      last_429_at: 0,
      retry_after_seconds: 0,
      cached_keys_created_today: 0,
    };
  }
}

function writeQuota(state: QuotaState): void {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {}
}

/**
 * True when the creation quota is still exhausted.
 *
 * Prefers Retry-After from the last 429 — that is the server's own statement of
 * when the window opens. Falls back to local midnight only when no Retry-After
 * was recorded. Verified live: a 429 returned Retry-After: 41550 (~11.5 hours),
 * which is neither 1 hour nor 24 hours, so no fixed period is correct.
 */
function quotaExhaustedToday(): boolean {
  const q = readQuota();
  if (!q.rate_limited_today) return false;
  if (q.retry_after_seconds > 0 && q.last_429_at > 0) {
    return Date.now() < q.last_429_at + q.retry_after_seconds * 1000;
  }
  // No Retry-After recorded — approximate with the local day boundary.
  return q.last_429_at >= todayMidnightMs();
}

function markQuotaExhausted(retryAfterSeconds = 0): void {
  writeQuota({
    rate_limited_today: true,
    last_429_at: Date.now(),
    retry_after_seconds: retryAfterSeconds,
    cached_keys_created_today: keysCreatedToday(loadKeyPool()),
  });
}

/** Strip stale keys: expired (expires_at past) or older than 7 days. */
export function pruneStaleKeys(pool: KeyPoolEntry[]): KeyPoolEntry[] {
  const now = Date.now();
  return pool.filter((e) => {
    // Expired key — but see the warning below before trusting this.
    if (e.expires_at) {
      const exp = new Date(e.expires_at).getTime();
      if (!isNaN(exp) && exp < now) {
        // OpenSea's expires_at is NOT enforced. Verified 2026-11-06: a key with
        // expires_at 2026-10-17 (21 days past) still returns HTTP 200 on
        // /api/v2/collections. Pruning on this field alone would discard keys
        // that work. Only drop the key if it has also been probed dead — the
        // probe is the authoritative signal, the timestamp is not.
        if (e.last_probe === "dead") return false;
      }
    }
    // Older than 7 days. Same caveat: age alone is not proof of death. Keep
    // the key if it was recently probed alive; the next probe will retire it
    // if it has actually stopped working.
    if (daysOld(e) > 7 && e.last_probe === "dead") return false;
    return true;
  });
}

// In-memory mirror of the pool file. loadKeyPool() is called several times per
// run — and each call used to re-read + re-parse the file. Writes go through to
// disk so the two never diverge.
let poolCache: KeyPoolEntry[] | null = null;
let legacyMigrated = false;

/**
 * One-time import of a pool written by an older build in the home directory.
 * Runs only when the project-local file is absent, so it can never overwrite a
 * newer pool.
 */
function migrateLegacyPool(): void {
  if (legacyMigrated || !LEGACY_POOL_FILE) return;
  legacyMigrated = true;
  if (fs.existsSync(KEY_POOL_FILE)) return;
  if (!fs.existsSync(LEGACY_POOL_FILE)) return;
  try {
    const pool = JSON.parse(fs.readFileSync(LEGACY_POOL_FILE, "utf-8")) as KeyPoolEntry[];
    if (!Array.isArray(pool) || pool.length === 0) return;
    fs.writeFileSync(KEY_POOL_FILE, JSON.stringify(pool, null, 2), { encoding: "utf-8", mode: 0o600 });
    console.log(chalk.gray(`  OpenSea: imported ${pool.length} key(s) from ${LEGACY_POOL_FILE}`));
  } catch {}
}

export function loadKeyPool(): KeyPoolEntry[] {
  if (poolCache) return [...poolCache];
  migrateLegacyPool();
  try {
    const raw = fs.readFileSync(KEY_POOL_FILE, "utf-8");
    const pool = JSON.parse(raw) as KeyPoolEntry[];
    // Auto-prune stale keys on every load — expired or older than 7 days
    poolCache = pruneStaleKeys(pool);
  } catch {
    poolCache = [];
  }
  // Return a copy: callers push/filter/mutate freely without corrupting the cache.
  return [...poolCache];
}

export function saveKeyPool(pool: KeyPoolEntry[]): void {
  // Store a copy so a caller mutating its own array afterwards cannot change
  // the cache behind our back.
  poolCache = [...pool];
  // Contains plaintext API keys — owner-only. A failed write must not crash a
  // mint; the in-memory copy still serves this run.
  try {
    fs.writeFileSync(KEY_POOL_FILE, JSON.stringify(pool, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {}
}

export function clearKeyPool(): void {
  poolCache = [];
  try { fs.unlinkSync(KEY_POOL_FILE); } catch {}
}

// ── Probe a single key ────────────────────────────────────────────────────

export async function probeKey(
  apiKey: string,
  // 5s, not 3s. Measured live against the collections endpoint: 860ms typical,
  // 2139ms observed, and an occasional >3s stall. A 3s budget turned a slow-but-
  // healthy key into a "timeout", which then made the key unusable and forced a
  // fresh mint — burning the 2/day quota on a key that was working fine.
  timeoutMs = 5000
): Promise<{ status: "alive" | "throttled" | "dead" | "alive_but_exhausted" | "timeout" | "server_error"; latencyMs: number; remaining: number; resetAt: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${OPENSEA_BASE}/api/v2/collections?limit=1`, {
      signal: controller.signal,
      headers: { accept: "application/json", "X-API-KEY": apiKey.trim() },
    });
    clearTimeout(timer);
    const latencyMs = Math.round(Date.now() - t0);
    // Read rate-limit headers from every response — even 429 tells us where we stand.
    // An absent header means "unknown", not "zero". Treating a missing header
    // as 0 marks every healthy key exhausted when a proxy strips it.
    const remainingRaw = res.headers.get("x-ratelimit-remaining");
    const remaining = remainingRaw != null ? parseInt(remainingRaw, 10) : -1;
    const resetRaw = res.headers.get("x-ratelimit-reset");
    const resetAt = resetRaw != null ? parseInt(resetRaw, 10) : 0;
    if (res.status === 200) {
      // If remaining is exactly 0, we're exhausted even though this call went
      // through. Mark as "alive_but_exhausted" so scoring deprioritizes it.
      if (remaining === 0) return { status: "alive_but_exhausted" as const, latencyMs, remaining, resetAt };
      return { status: "alive", latencyMs, remaining, resetAt };
    }
    if (res.status === 429) return { status: "throttled", latencyMs, remaining, resetAt };
    // 5xx is a dead API, not a dead key. The key is still valid and should stay
    // in the pool — probing it again later is cheap and it may well work then.
    // Collapsing this into "dead" would permanently discard a good key because
    // OpenSea had a bad minute.
    if (res.status >= 500) return { status: "server_error" as const, latencyMs, remaining, resetAt };

    // Cloudflare bot-block pages (Error 1010/1020, "Access denied") are about
    // the CLIENT, not the key. Observed 2026-11-09: every key in the pool,
    // including one known to work, returned 403 Error 1010 for a few minutes and
    // then 200 again with no change on our side. Classifying that as "dead"
    // retires working keys and burns a mint, so treat it as server-side.
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      if (/cloudflare|error\s*10\d\d|access denied|cf-error/i.test(body)) {
        return { status: "server_error" as const, latencyMs, remaining, resetAt };
      }
    }

    // 401/403/404 and anything else: the key itself is the problem.
    return { status: "dead", latencyMs, remaining, resetAt };
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") return { status: "timeout", latencyMs: timeoutMs, remaining: -1, resetAt: 0 };
    // A transport failure (DNS, ECONNREFUSED, TLS, socket hangup) says nothing
    // about the KEY — the request never reached OpenSea. Scoring it "dead"
    // retires a working credential because the host had a bad minute; the file
    // already returns "server_error" for 5xx and a Cloudflare 403, which is the
    // same class of "not the key's fault".
    return { status: "server_error", latencyMs: Date.now() - t0, remaining: -1, resetAt: 0 };
  }
}

// ── Score a pool entry after probing ──────────────────────────────────────

export function computeScore(entry: KeyPoolEntry): number {
  const now = Date.now();
  // Higher = better.
  if (entry.last_probe === "dead") return -10000;
  if (entry.last_probe === "timeout") return 5;
  // The API was unreachable or erroring, not the key. Worth far more than a
  // timeout (the key is untested, not slow) but less than a confirmed-alive
  // key, because we have no evidence it works right now.
  if (entry.last_probe === "server_error") return 20;
  if (entry.last_probe === "throttled") {
    // 429 — actively rate-limited, can't use this call. Low score but keep
    // it in the pool; if reset time is recorded and in the future, it'll
    // recover and become useful again.
    // X-RateLimit-Reset is a UNIX SECONDS epoch; Date.now() is milliseconds.
    // Comparing them directly is always false, which silently disabled this tier.
    const resetMs = entry.rate_limit_reset > 0 ? entry.rate_limit_reset * 1000 : 0;
    if (resetMs > now) {
      return 50; // will recover, but useless right now
    }
    return 30; // reset passed but still getting 429 — server hasn't caught up
  }
  if (entry.last_probe === "alive_but_exhausted") {
    // Got a 200 but remaining is 0 or 1. Still usable for THIS call (one
    // more shot before the window closes). Don't abandon it.
    const resetMs = entry.rate_limit_reset > 0 ? entry.rate_limit_reset * 1000 : 0;
    if (resetMs > now) {
      return 150; // one more call then it resets — valuable
    }
    return 100; // reset already passed but still at 0 — might recover, still try
  }
  // alive: base 1000 + remaining calls bonus - latency penalty - usage penalty
  return 1000 + Math.max(0, entry.remaining_calls) * 10 - Math.min(entry.probe_latency_ms, 2000) * 0.5 - entry.times_used * 20;
}

// ── Probe ALL keys in parallel, re-score, return sorted best→worst ──────

export async function probeAndRankPool(
  pool: KeyPoolEntry[],
  budget: () => number = () => 5000
): Promise<{ pool: KeyPoolEntry[]; best: KeyPoolEntry | null }> {
  if (pool.length === 0) return { pool: [], best: null };

  // The probe below OVERWRITES last_probe and remaining_calls. A timeout erases
  // the evidence that a key was ever confirmed alive, and the fallback needs
  // that evidence to decide whether a key that merely failed to answer is worth
  // using. Without this snapshot one transient network fault makes every good
  // key look unusable — and the next re-probe finds them alive, which is exactly
  // the contradiction the run then reports.
  const prior = new Map(pool.map((e) => [e.api_key, e]));

  // Probe all in parallel — each bounded by timeoutMs, but all at once, so the
  // whole pass costs one timeout rather than one per key.
  const probed = await Promise.all(
    pool.map(async (entry) => {
      // Every attempt draws on the SAME remaining budget. Retries used to get a
      // fresh full timeout each, so a key that hit server_error and then timeout
      // could spend 3x the caller's whole budget on its own and the caller's
      // deadline became meaningless.
      const attempt = async () => {
        const remaining = budget();
        if (remaining < 500) return null;
        return probeKey(entry.api_key, Math.min(remaining, 5000));
      };
      let result = (await attempt()) ?? ({ status: "timeout", latencyMs: 0, remaining: -1, resetAt: 0 } as const);
      // A server_error means the API was unreachable or erroring — nothing about
      // the key. Observed live: the same key returned server_error at 1112ms and
      // alive at 860ms seconds later. One retry separates a transient hiccup
      // from a key that genuinely cannot be validated, without paying for it on
      // every probe.
      if (result.status === "server_error") {
        const retry = await attempt();
        if (retry && retry.status !== "server_error") result = retry;
      }
      // Same class of fault: a timeout means the request never completed, so it
      // says nothing about the key either. Retrying once keeps a slow minute
      // from retiring a working credential.
      if (result.status === "timeout") {
        const retry = await attempt();
        if (retry && retry.status !== "timeout") result = retry;
      }
      // Persist the fresh quota numbers. Without this the entry keeps whatever
      // remaining_calls it had before — a stale value that can exceed the real
      // limit (observed: 598 stored vs 114 actual) and inflates the score by
      // thousands of points, letting a bad key outrank a good one.
      const refreshed: KeyPoolEntry = {
        ...entry,
        last_probe: result.status,
        last_probe_at: new Date().toISOString(),
        probe_latency_ms: result.latencyMs,
        remaining_calls: result.remaining,
        rate_limit_reset: result.resetAt,
      };
      refreshed.score = computeScore(refreshed);
      return refreshed;
    })
  );

  // Mark dead keys for removal (don't delete them, just deprioritize).
  //
  // "timeout" is NOT usable. A timeout means the request never completed, so we
  // have no evidence the key works — and the caller is about to spend a mint on
  // it. Treating it as usable let a timed-out key win selection and be reported
  // as "Key ready: timeout", then fail at the first real API call. A timeout is
  // a network fault, not a property of the key, so it is scored low (below a
  // confirmed-alive key) but it must not be selected while any key with a real
  // answer exists.
  //
  // "server_error" stays usable: a 5xx or Cloudflare 403 is the API's fault, and
  // the key is known-valid from earlier probes.
  const usable = probed
    .filter((e) => e.last_probe === "alive" || e.last_probe === "alive_but_exhausted" || e.last_probe === "throttled" || e.last_probe === "server_error")
    .sort((a, b) => b.score - a.score);

  // Only fall back to a timed-out key when nothing with a real answer exists —
  // and even then, only if it was confirmed alive the last time we actually
  // reached the API. A key that has never been confirmed is not worth a mint.
  //
  // The check is against the probe result from BEFORE this pass, not against
  // remaining_calls: a timeout reads no headers, so it stores -1 and would
  // disqualify every key that ever timed out — including one that has been
  // serving mints for days.
  const best = usable.length > 0
    ? usable[0]
    : probed
        .filter((e) => {
          if (e.last_probe !== "timeout") return false;
          const before = prior.get(e.api_key);
          return before?.last_probe === "alive" || before?.last_probe === "alive_but_exhausted";
        })
        .sort((a, b) => b.score - a.score)[0] ?? null;
  return { pool: probed, best };
}

// ── Pick the best key (probes pool, returns winner) ──────────────────────

export async function pickBestKey(
  pool: KeyPoolEntry[],
  budget?: () => number
): Promise<{ api_key: string; source: string; entry: KeyPoolEntry } | null> {
  const { pool: ranked, best } = await probeAndRankPool(pool, budget);
  saveKeyPool(ranked); // persist scores

  if (!best) return null;

  // If best is throttled, note it but still use it (better than nothing).
  // Report remaining calls so the user knows if the key is near exhaustion.
  const remainingInfo = best.remaining_calls > 0
    ? `, ${best.remaining_calls} call(s) remaining`
    : best.last_probe === "alive_but_exhausted"
    ? ", EXHAUSTED (0 remaining)"
    : "";
  const source = best.last_probe === "alive"
    ? `alive (${best.probe_latency_ms}ms, used ${best.times_used}x${remainingInfo})`
    : best.last_probe === "alive_but_exhausted"
    ? `alive but exhausted${remainingInfo}`
    : best.last_probe === "throttled"
    ? `throttled (${best.probe_latency_ms}ms)${remainingInfo} — use with caution`
    : best.last_probe === "timeout"
    ? `unconfirmed — probe timed out, no evidence this key works`
    : best.last_probe === "server_error"
    ? `api error (${best.probe_latency_ms}ms) — key untested this pass`
    : `probe: ${best.last_probe}`;

  return { api_key: best.api_key, source, entry: best };
}

// ── Add a freshly minted key to the pool ────────────────────────────────

export function addKeyToPool(
  meta: { api_key: string; name: string; expires_at: string }
): KeyPoolEntry {
  const pool = loadKeyPool();
  const entry: KeyPoolEntry = {
    api_key: meta.api_key,
    name: meta.name,
    expires_at: meta.expires_at,
    minted_at: new Date().toISOString(),
    times_used: 0,
    last_probe: "unknown",
    last_probe_at: "",
    probe_latency_ms: 0,
    score: 500,
    remaining_calls: -1, // unknown until first probe
    rate_limit_reset: 0,
  };
  pool.push(entry);
  saveKeyPool(pool);
  return entry;
}

// ── Pool freshness ────────────────────────────────────────────────────────

/** Keys older than this are replaced with fresh ones, even if they probe alive. */
export const KEY_MAX_AGE_DAYS = 3;
const KEY_MAX_AGE_MS = KEY_MAX_AGE_DAYS * 86_400_000;

/** True when a single key has outlived KEY_MAX_AGE_DAYS. */
export function isKeyStale(entry: KeyPoolEntry): boolean {
  const born = entry.minted_at ? new Date(entry.minted_at).getTime() : NaN;
  return isNaN(born) || Date.now() - born > KEY_MAX_AGE_MS;
}

/**
 * True when the pool is non-empty and EVERY key is older than KEY_MAX_AGE_DAYS.
 * A single fresh key means the pool is still serviceable.
 */
export function poolIsStale(pool: KeyPoolEntry[]): boolean {
  return pool.length > 0 && pool.every(isKeyStale);
}

// ── .env integration ──────────────────────────────────────────────────────

/**
 * Pull OPENSEA_API_KEY from the environment into the pool.
 *
 * Without this, a key set in .env was invisible to every path that resolves a
 * key through getValidApiKey() — --fcfs and the wizard silently used a pooled
 * key instead, while --eligibility used the .env one.
 */
export function seedEnvKeyIntoPool(): KeyPoolEntry | null {
  const envKey = process.env.OPENSEA_API_KEY?.trim();
  if (!envKey) return null;
  const existing = loadKeyPool().find((e) => e.api_key === envKey);
  if (existing) return existing;
  console.log(chalk.gray("  OpenSea: importing OPENSEA_API_KEY from the environment into the pool."));
  return addKeyToPool({
    api_key: envKey,
    name: "env_pasted",
    // OpenSea does not report expires_at on creation; the field is not
    // enforced anyway (verified: a key 21 days past expires_at still works).
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
}

/**
 * Mirror the active key back into .env so the file always names a key that was
 * alive recently. Rewrites only the OPENSEA_API_KEY line, preserving comments
 * and every other variable; writes only when the value actually changes.
 */
export function syncEnvKey(apiKey: string): void {
  if (!ENV_KEY_SYNC || !apiKey) return;

  const envPath = path.join(PACKAGE_ROOT, ".env");
  let text = "";
  try { text = fs.readFileSync(envPath, "utf-8"); } catch {}

  // Compare against the FILE, not process.env — the shell may export a
  // different value, and the point is to keep the file itself current.
  const m = text.match(/^OPENSEA_API_KEY=(.*)$/m);
  if (m && m[1].trim() === apiKey) return;

  const line = `OPENSEA_API_KEY=${apiKey}`;
  const next = m
    ? text.replace(/^OPENSEA_API_KEY=.*$/m, line)
    : (text === "" || text.endsWith("\n") ? text : text + "\n") + line + "\n";

  try {
    fs.writeFileSync(envPath, next, { encoding: "utf-8", mode: 0o600 });
    process.env.OPENSEA_API_KEY = apiKey;
    console.log(chalk.gray("  OpenSea: wrote the active key back to .env (OPENSEA_API_KEY)."));
  } catch {}
}

// ── Mint fresh keys (shared by the refresh and the empty-pool path) ───────

/**
 * Mint up to `count` fresh free keys, stopping at the first failure.
 * Honors the server's own quota state and the documented 2/day cap.
 */
async function mintFreshKeys(count: number): Promise<KeyPoolEntry[]> {
  const added: KeyPoolEntry[] = [];
  if (count <= 0) return added;

  if (quotaExhaustedToday()) {
    console.log(chalk.yellow("  ⚠ Free key creation was rate-limited recently — skipping the request until Retry-After elapses."));
    return added;
  }

  const createdToday = keysCreatedToday(loadKeyPool());
  const allowed = Math.max(0, Math.min(count, 2 - createdToday));
  if (allowed === 0) {
    console.log(chalk.yellow(`  ⚠ ${createdToday} key(s) already created today — the documented cap is 2/day.`));
    return added;
  }

  console.log(chalk.gray(`  OpenSea: minting ${allowed} fresh free key(s)...`));
  for (let i = 0; i < allowed; i++) {
    const fresh = await mintFreeKey(8000);
    if (!fresh) break;
    const entry = addKeyToPool(fresh);
    const probe = await probeKey(fresh.api_key, 3000);
    entry.last_probe = probe.status;
    entry.last_probe_at = new Date().toISOString();
    entry.probe_latency_ms = probe.latencyMs;
    entry.remaining_calls = probe.remaining;
    entry.rate_limit_reset = probe.resetAt;
    entry.score = computeScore(entry);
    saveKeyPool(loadKeyPool().map((e) => (e.api_key === fresh.api_key ? entry : e)));
    added.push(entry);
    console.log(chalk.green(`  ✓ New key minted: ${fresh.name || "agent_free"} (probe: ${probe.status}, ${probe.latencyMs}ms)`));
  }
  return added;
}

// ── Remove a dead key from the pool ──────────────────────────────────────

export function removeKeyFromPool(apiKey: string): void {
  const pool = loadKeyPool();
  const filtered = pool.filter((e) => e.api_key !== apiKey);
  saveKeyPool(filtered);
}

// ── Mint a fresh free key (ONE attempt, no retry) ────────────────────────

const mintFreeKey = async (
  timeoutMs = 8000
): Promise<{ api_key: string; name: string; expires_at: string } | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(FREE_KEY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Documented success is 201 Created. The previous code required exactly 200,
    // so every successfully minted key was discarded and the pool could never
    // refill itself. Accept any 2xx.
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 429) {
        // Remember the failure so subsequent runs skip the POST entirely.
        // Retry-After is the server's own statement of when the window opens —
        // verified live as ~11.5 hours, which no fixed period would guess.
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        markQuotaExhausted(retryAfter);
        console.log(
          chalk.yellow(
            `  OpenSea: free key creation rate-limited — try again later.${
              retryAfter > 0 ? ` (retry after ${Math.round(retryAfter / 3600)}h)` : ""
            }`
          )
        );
      }
      return null;
    }
    const body = (await res.json()) as any;
    if (!body?.api_key) return null;
    return {
      api_key: body.api_key,
      name: body.name || "agent_free",
      expires_at: body.expires_at || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch {
    return null;
  }
};

// ── Main entry point: get a valid key, probing pool first ────────────────

export async function getValidApiKey(
  opts?: { timeoutMs?: number },
): Promise<{ api_key: string; source: string } | null> {
  // Honour the caller's deadline. The parameter was previously ignored (_opts),
  // so a caller asking for an 8s budget could wait far longer when the pool
  // needed a refresh or a mint — both of which run BEFORE the probe. Derive the
  // per-probe timeout from what is left of the budget rather than a fixed value.
  const budgetMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const deadline = Date.now() + budgetMs;
  const probeTimeout = () => Math.max(1000, Math.min(5000, deadline - Date.now()));

  // A key pasted into .env must join the pool, or every path that resolves a
  // key through here would silently use a different one.
  seedEnvKeyIntoPool();

  let pool = loadKeyPool();

  // 0. Refresh an aged pool before probing. A key older than KEY_MAX_AGE_DAYS
  //    is replaced rather than trusted, even if it still probes alive — an old
  //    key can carry an exhausted quota that remaining_calls no longer reflects.
  //    If the mint fails the old keys stay as a fallback, so this can never
  //    leave the pool empty.
  if (poolIsStale(pool)) {
    console.log(
      chalk.yellow(
        `  ⚠ Pool keys are all older than ${KEY_MAX_AGE_DAYS} days — minting fresh key(s) to replace them.`
      )
    );
    const fresh = await mintFreshKeys(2);
    if (fresh.length > 0) {
      // Re-read rather than trust the pre-mint snapshot: minting mutates the
      // pool, and a snapshot would let the same key appear twice.
      const freshKeys = new Set(fresh.map((e) => e.api_key));
      const kept = loadKeyPool().filter((e) => !isKeyStale(e) && !freshKeys.has(e.api_key));
      saveKeyPool([...fresh, ...kept]);
      pool = loadKeyPool();
      console.log(chalk.green(`  ✓ Pool refreshed: ${fresh.length} new key(s), ${kept.length} retained.`));
    } else {
      console.log(chalk.yellow("  ⚠ Refresh failed (quota or network) — keeping the existing keys as fallback."));
    }
  }

  // 1. If pool has keys, probe and pick the best — NON-BLOCKING (≤3s)
  if (pool.length > 0) {
    console.log(chalk.gray(`  OpenSea: probing ${pool.length} key(s) in pool...`));
    const result = await pickBestKey(pool, probeTimeout);
    if (result) {
      // Increment usage counter for the chosen key
      const updated = result.entry;
      updated.times_used += 1;
      updated.last_used_at = new Date().toISOString();
      // Decrement remaining calls since we're about to use it
      if (updated.remaining_calls > 0) updated.remaining_calls -= 1;
      saveKeyPool(loadKeyPool().map((e) => (e.api_key === result.entry.api_key ? updated : e)));
      const remInfo = updated.remaining_calls > 0
        ? ` (${updated.remaining_calls} calls left before rate limit)`
        : ` -- EXHAUSTED, next mint will need a fresh key`;
      console.log(chalk.green(`  ✓ Using key: ${result.source}${remInfo}`));
      syncEnvKey(result.api_key);
      return { api_key: result.api_key, source: result.source };
    }
    // pickBestKey just re-ranked and saved the pool, so these are this pass's
    // verdicts. "Rejected by OpenSea" and "never answered" are different problems
    // with different fixes, and the old single line reported them all as dead.
    const ranked = loadKeyPool();
    const allDead = ranked.length > 0 && ranked.every((e) => e.last_probe === "dead");
    console.log(
      chalk.yellow(
        allDead
          ? "  ⚠ No usable key in pool — every key was rejected by OpenSea (dead)."
          : "  ⚠ No usable key in pool — none returned a usable verdict (timeouts or unconfirmed)."
      )
    );
  }

  // 2. Pool empty or all dead — try to mint a fresh one, if the server's own
  //    quota state allows it.
  //    The documented "2 keys/day" is an approximation: the real window is a
  //    rolling ~11.5h (verified live via Retry-After), not a local-midnight
  //    boundary. Only the server's own Retry-After hard-blocks; the local count
  //    is a warning, not a gate — gating on it can refuse a legitimate mint
  //    after the rolling window has already recovered.
  const freshEntries = await mintFreshKeys(1);
  if (freshEntries.length > 0) {
    const e = freshEntries[0];
    syncEnvKey(e.api_key);
    return { api_key: e.api_key, source: `new (probe: ${e.last_probe}, ${e.probe_latency_ms}ms)` };
  }
  console.log(chalk.gray(`    Re-trying cached keys instead...`));

  // 3. Couldn't mint — rate limited or network error.
  //    Re-probe cached keys: they may have recovered since last probe.
  console.log(chalk.gray("  OpenSea: can't mint new key — re-probing cached keys to check recovery..."));
  const cachedKeys = loadKeyPool();
  if (cachedKeys.length > 0) {
    const result = await pickBestKey(cachedKeys, probeTimeout);
    if (result && result.entry.last_probe !== "dead") {
      console.log(chalk.green(`  ✓ Re-using cached key: ${keyLabel(result.entry)} (status: ${result.entry.last_probe})`));
      const updated = result.entry;
      updated.times_used += 1;
      updated.last_used_at = new Date().toISOString();
      if (updated.remaining_calls > 0) updated.remaining_calls -= 1;
      // Read the pool back rather than mapping the pre-probe snapshot: pickBestKey
      // already saved this pass's verdicts, and writing the snapshot over them
      // discarded every other key's fresh status, score and remaining_calls.
      saveKeyPool(loadKeyPool().map((e) => (e.api_key === result.entry.api_key ? updated : e)));
      syncEnvKey(result.entry.api_key);
      return { api_key: result.entry.api_key, source: `cached (re-probed: ${result.entry.last_probe})` };
    }
  }

  // 4. Still nothing — give up with informative message
  console.log(chalk.yellow("\n  ⚠ Cannot mint a new OpenSea API key."));
  console.log(chalk.yellow("  → You've hit the free-tier rate limit (max 2 keys/day) or there's a network issue."));
  console.log(chalk.gray("  → Without a key, the FCFS signed-payload path won't work."));
  console.log(chalk.gray("  → The public mint path does NOT need an OpenSea key — try that instead."));

  // Show what we know about cached keys — their reset times if available
  const cached = loadKeyPool();
  if (cached.length > 0) {
    console.log(chalk.gray(`  → ${cached.length} key(s) cached from previous runs:`));
    for (const entry of cached) {
      const statusLabel = entry.last_probe === "alive" ? chalk.green("alive")
        : entry.last_probe === "alive_but_exhausted" ? chalk.yellow("exhausted")
        : entry.last_probe === "throttled" ? chalk.yellow("throttled")
        : entry.last_probe === "server_error" ? chalk.gray("api error")
        : entry.last_probe === "timeout" ? chalk.gray("timeout")
        : chalk.red("dead");
      const resetInfo = entry.rate_limit_reset > 0
        ? ` (resets ${new Date(entry.rate_limit_reset * 1000).toLocaleTimeString()})`
        : "";
      console.log(chalk.gray(`      • ${keyLabel(entry)} — ${statusLabel}${resetInfo}`));
    }
    console.log(chalk.gray("  → Keys with a future reset time will work again — try re-running then.\n"));
  } else {
    console.log(chalk.gray("  → No cached keys available.\n"));
  }

  console.log(chalk.gray("  → Wait until the rate-limit window resets, or paste an existing key.\n"));
  return null;
}

// ── Probe a key without touching the pool (standalone check) ────────────

export async function probeApiKey(
  apiKey: string,
  timeoutMs = 3000
): Promise<boolean> {
  const result = await probeKey(apiKey, timeoutMs);
  return result.status === "alive";
}
